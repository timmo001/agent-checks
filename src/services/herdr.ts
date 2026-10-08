import {
  HerdrSdk,
  PaneId,
  WorkspaceId,
  herdrSdkLayerFromOptions,
  type Pane,
  type Workspace,
} from "@timmo001/effect-herdr";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import { RuntimeConfig, ciToken, lintToken, pluginId } from "../config";
import { ActionError } from "../errors";

export const herdrLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* RuntimeConfig;

    return herdrSdkLayerFromOptions({
      socketPath: config.socket,
      requestTimeout: Duration.millis(config.timeoutMs),
    });
  }),
);

export const enabled = Effect.gen(function* () {
  const plugins = yield* (yield* HerdrSdk).plugins.list({ pluginId });

  return plugins.some((plugin) => plugin.id === pluginId && plugin.enabled);
});

export const cleared = { [ciToken]: null, [lintToken]: null };

export const metadata = Effect.fn("Herdr.metadata")(function* (
  id: WorkspaceId,
  tokens: Readonly<Record<string, string | null>>,
) {
  const config = yield* RuntimeConfig;
  yield* (yield* HerdrSdk).workspaces
    .reportMetadata(id, {
      source: `plugin:${pluginId}`,
      tokens,
      ttlMs: Math.min(86_400_000, config.retryMs + config.pollMs * 2),
    })
    .pipe(
      Effect.catchTag("HerdrServerError", (error) =>
        error.serverCode === "workspace_not_found"
          ? Effect.void
          : Effect.fail(error),
      ),
    );
});

export function checkout(workspace: Workspace, panes: ReadonlyArray<Pane>) {
  return (
    Option.getOrUndefined(workspace.worktree)?.checkoutPath ??
    Option.getOrUndefined(
      panes.find((pane) => pane.workspaceId === workspace.id)?.cwd ??
        Option.none(),
    )
  );
}

/**
 * The pane a Herdr plugin action was invoked from, or outside an action the
 * pane focused in the session.
 */
export const focusedPane = Effect.gen(function* () {
  const herdr = yield* HerdrSdk;

  if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
    const context = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({ workspace_id: WorkspaceId, focused_pane_id: PaneId }),
      ),
    )(process.env.HERDR_PLUGIN_CONTEXT_JSON);

    return yield* herdr.panes.get(context.focused_pane_id);
  }

  const snapshot = yield* herdr.session.snapshot();

  const pane = snapshot.panes.find(
    (value) => value.id === Option.getOrNull(snapshot.focusedPaneId),
  );

  if (!pane)
    return yield* new ActionError({ message: "No Herdr pane is focused" });

  return pane;
});
