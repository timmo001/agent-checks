import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Command } from "effect/cli";
import { version } from "../package.json";
import { dispatch } from "./commands/dispatch";
import { open, picker } from "./commands/picker";
import { start, watch } from "./commands/watch";
import { RuntimeConfig, pluginId } from "./config";
import { reportError } from "./errors";
import { GitHub } from "./services/github";
import { ghLayer } from "./services/gh";
import { herdrLayer } from "./services/herdr";
import { Process } from "./services/process";

const platform = RuntimeConfig.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
);

const services = Layer.mergeAll(Process.layer, herdrLayer, ghLayer).pipe(
  Layer.provideMerge(platform),
);

const application = GitHub.layer.pipe(Layer.provideMerge(services));

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
  ]),
  Command.run({ version }),
  Effect.tapCause((cause) => reportError(cause)),
  Effect.annotateLogs({ plugin: pluginId }),
  Effect.provide(
    Layer.merge(NodeServices.layer, Logger.layer([Logger.consoleJson])),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
