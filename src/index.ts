import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Command, Flag } from "effect/cli";
import { version } from "../package.json";
import { dispatch } from "./commands/dispatch";
import { failures } from "./commands/failures";
import { open, picker } from "./commands/picker";
import { start, watch } from "./commands/watch";
import { ClientConfig, RuntimeConfig, pluginId } from "./config";
import { reportError } from "./errors";
import { GitHub } from "./services/github";
import { ghLayer } from "./services/gh";
import { herdrLayer } from "./services/herdr";
import { Process } from "./services/process";

const platform = RuntimeConfig.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
);

const services = Layer.mergeAll(Process.layer, herdrLayer, ghLayer).pipe(
  Layer.provideMerge(ClientConfig.layer),
  Layer.provideMerge(platform),
);

const application = GitHub.layer.pipe(Layer.provideMerge(services));

// Runs outside Herdr, so it must not depend on RuntimeConfig or the socket.
const standalone = GitHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Process.layer, ghLayer)),
  Layer.provideMerge(ClientConfig.standalone),
  Layer.provideMerge(NodeServices.layer),
);

Command.make("herdr-workflow-watch").pipe(
  Command.withDescription(
    "GitHub workflow failure indicators for Herdr workspaces",
  ),
  Command.withSubcommands([
    Command.make("start", {}, () => start.pipe(Effect.provide(application))),
    Command.make("watch", {}, () => watch.pipe(Effect.provide(application))),
    Command.make("open", {}, () => open.pipe(Effect.provide(application))),
    Command.make("picker", {}, () => picker.pipe(Effect.provide(application))),
    Command.make("dispatch", {}, () =>
      dispatch.pipe(Effect.provide(application)),
    ),
    Command.make(
      "failures",
      {
        cwd: Flag.String("cwd").pipe(
          Flag.withDescription("Checkout to inspect"),
          Flag.withDefault("."),
        ),
        logDir: Flag.String("log-dir").pipe(
          Flag.withDescription(
            "Directory for large failed-step logs (default: $XDG_STATE_HOME/herdr-workflow-watch/logs)",
          ),
          Flag.optional,
        ),
        json: Flag.Boolean("json").pipe(
          Flag.withDescription("Print the failures as JSON"),
          Flag.withDefault(false),
        ),
      },
      (options) => failures(options).pipe(Effect.provide(standalone)),
    ).pipe(
      Command.withDescription(
        "Print the failed workflow runs on a checkout's pushed branch, without Herdr",
      ),
    ),
  ]),
  Command.run({ version }),
  Effect.tapCause((cause) => reportError(cause)),
  Effect.annotateLogs({ plugin: pluginId }),
  Effect.provide(
    Layer.merge(NodeServices.layer, Logger.layer([Logger.consoleJson])),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
