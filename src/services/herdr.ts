import {
  HerdrSdk,
  Pane,
  PaneProcess,
  WorkspaceId,
  herdrSdkLayerFromOptions,
  type Workspace,
} from "@timmo001/effect-herdr";
import { Duration, Effect, Layer, Option, Schema } from "effect";
import { RuntimeConfig, pluginId, token } from "../config";

export const Origin = Schema.Struct({
  workspace: WorkspaceId,
  pane: Pane,
  processes: Schema.Array(
    Schema.Struct({
      pid: PaneProcess.fields.pid,
      argv: PaneProcess.fields.argv,
    }),
  ),
});

export type Origin = typeof Origin.Type;

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

export const metadata = Effect.fn("Herdr.metadata")(function* (
  id: WorkspaceId,
  value: string | null,
) {
  const config = yield* RuntimeConfig;
  yield* (yield* HerdrSdk).workspaces
    .reportMetadata(id, {
      source: `plugin:${pluginId}`,
      tokens: { [token]: value },
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
