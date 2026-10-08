import {
  HerdrConfigurationError,
  HerdrInvalidInput,
  HerdrInvalidResponse,
  HerdrRequestTimeout,
  HerdrSdk,
  HerdrServerError,
  HerdrTransportError,
  HerdrUnsupportedProtocol,
  HerdrUnsupportedResult,
  herdrSdkLayerFromOptions,
} from "@timmo001/effect-herdr";
import { Cause, Console, Duration, Effect, Schema } from "effect";
import { join } from "node:path";
import { ConfigError, pluginId, stateDirectory } from "./config";
import { GitHubError } from "./services/github";
import { GitError } from "./services/git";
import { ProcessError } from "./services/process";
import { plain } from "./text";

export class ActionError extends Schema.TaggedError<ActionError>()(
  "ActionError",
  {
    message: Schema.String,
  },
) {}

const isHerdrError = Schema.is(
  Schema.Union([
    HerdrConfigurationError,
    HerdrInvalidInput,
    HerdrInvalidResponse,
    HerdrRequestTimeout,
    HerdrServerError,
    HerdrTransportError,
    HerdrUnsupportedProtocol,
    HerdrUnsupportedResult,
  ]),
);

/**
 * Report a failure. `--json` callers (the Omarchy panel) get a one-line
 * summary on stderr; everything else logs it and shows a Herdr notification.
 */
export const reportError = Effect.fn("Errors.reportError")(function* (
  cause: Cause.Cause<unknown>,
  title = "Agent Checks failed",
) {
  if (Cause.hasInterruptsOnly(cause)) return;
  const error = Cause.squash(cause);
  const socket = process.env.HERDR_SOCKET_PATH;
  const state = process.env.HERDR_PLUGIN_STATE_DIR;
  const watching = process.argv[2] === "watch";

  const summary = plain(
    error instanceof HerdrServerError
      ? `${error.serverCode}: ${error.serverMessage}`
      : error instanceof ProcessError
        ? `${error.command}: ${error.message}`
        : error instanceof ConfigError ||
            error instanceof ActionError ||
            error instanceof GitHubError ||
            error instanceof GitError ||
            isHerdrError(error)
          ? error.message
          : String(error),
  ).replace(/\s+/g, " ");

  if (process.argv.includes("--json")) {
    yield* Console.error(summary);

    return;
  }

  const log =
    state && socket && watching
      ? join(stateDirectory(state, socket), "watch.log")
      : null;

  const home = process.env.HOME;

  const details = log
    ? `Log: ${home && log.startsWith(`${home}/`) ? `~${log.slice(home.length)}` : log}`
    : `Logs: herdr plugin log list --plugin ${pluginId}`;

  const recovery =
    error instanceof ConfigError
      ? "Fix the plugin config, then retry."
      : title === "Agent Checks failed" && watching
        ? `Restart: herdr plugin action invoke ${pluginId}.start`
        : error instanceof GitHubError
          ? "Check: gh auth status"
          : error instanceof ActionError
            ? "Open Agent Checks to retry."
            : "Inspect the log before retrying.";

  // Herdr limits desktop notification bodies to 240 characters.
  const budget = Math.max(0, 240 - recovery.length - details.length - 2);

  const message = [
    summary.length > budget
      ? `${summary.slice(0, Math.max(0, budget - 1))}…`
      : summary,
    recovery,
    details,
  ].join("\n");

  yield* Effect.logError(title, cause);

  if (!socket) return;

  yield* Effect.gen(function* () {
    yield* (yield* HerdrSdk).notifications.show({ title, body: message });
  }).pipe(
    Effect.provide(
      herdrSdkLayerFromOptions({
        socketPath: socket,
        requestTimeout: Duration.seconds(5),
      }),
    ),
    Effect.timeout(5_000),
    Effect.catchCause((notificationCause) =>
      Effect.logWarning(
        "Could not deliver the Herdr error notification",
        notificationCause,
      ),
    ),
  );
});
