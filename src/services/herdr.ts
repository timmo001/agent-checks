import {
  HerdrSdk,
  PaneId,
  WorkspaceId,
  herdrSdkLayerFromOptions,
  type Pane,
  type Workspace,
} from "@timmo001/effect-herdr";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import {
  RuntimeConfig,
  ciToken,
  lintToken,
  pluginId,
  reviewsToken,
} from "../config";
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

export const cleared = {
  [ciToken]: null,
  [lintToken]: null,
  [reviewsToken]: null,
};

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

/**
 * Where a pane is working: its foreground process's directory, so an agent
 * that moved into another worktree counts there, as in dot's Herdr context.
 */
export function paneDirectory(pane: Pane) {
  return Option.getOrUndefined(
    Option.orElse(pane.foregroundCwd, () => pane.cwd),
  );
}

/**
 * A workspace's checkout: that of the active tab's focused pane, else its
 * agent or first pane, else the workspace's worktree.
 */
export function checkout(workspace: Workspace, panes: ReadonlyArray<Pane>) {
  const own = panes.filter((pane) => pane.workspaceId === workspace.id);
  const active = own.filter((pane) => pane.tabId === workspace.activeTabId);

  const pane =
    active.find((value) => value.focused) ??
    active.find((value) => Option.isSome(value.agent)) ??
    active[0] ??
    own[0];

  return (
    (pane ? paneDirectory(pane) : undefined) ??
    Option.getOrUndefined(workspace.worktree)?.checkoutPath
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
