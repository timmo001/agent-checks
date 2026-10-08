import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Command, Flag } from "effect/cli";
import { version } from "../package.json";
import {
  browser,
  ciLogs,
  launch,
  launchers,
  lintRun,
  open,
  paste,
  paths,
  status,
} from "./commands/checks";
import { start, watch } from "./commands/watch";
import { RuntimeConfig, pluginId } from "./config";
import { reportError } from "./errors";
import { GitHub } from "./services/github";
import { ghLayer } from "./services/gh";
import { herdrLayer } from "./services/herdr";
import { Process } from "./services/process";

const application = GitHub.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Process.layer, herdrLayer, ghLayer)),
  Layer.provideMerge(RuntimeConfig.layer),
  Layer.provideMerge(NodeServices.layer),
);

const cwd = Flag.String("cwd").pipe(
  Flag.withDescription("Checkout to inspect"),
  Flag.withDefault("."),
);

// Herdr actions omit these and use the pane they were invoked from.
const origin = {
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription("Checkout (default: the invoking pane's checkout)"),
    Flag.optional,
  ),
  pane: Flag.String("pane").pipe(
    Flag.withDescription("Agent pane (default: the invoking pane)"),
    Flag.optional,
  ),
};

const kind = Flag.Literals("kind", ["ci", "lint"]).pipe(
  Flag.withDescription("Which check to act on"),
);

const run = Flag.Int("run").pipe(
  Flag.withDescription("Only this workflow run (default: every failed run)"),
  Flag.optional,
);

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON, and errors as one line on stderr"),
  Flag.withDefault(false),
);

const command = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof application>>,
) => effect.pipe(Effect.provide(application));

Command.make("agent-checks").pipe(
  Command.withDescription("CI and lint status for Herdr workspaces"),
  Command.withSubcommands([
    Command.make("start", {}, () => command(start)).pipe(
      Command.withDescription("Start the watcher unless one is running"),
    ),
    Command.make("watch", {}, () => command(watch)).pipe(
      Command.withDescription("Run the watcher in the foreground"),
    ),
    Command.make("open", { kind }, (options) =>
      command(open(options.kind)),
    ).pipe(
      Command.withDescription(
        "Open the Omarchy panel for the invoking Herdr pane",
      ),
    ),
    Command.make("paths", { json }, () => command(paths)).pipe(
      Command.withDescription("Print the status file location"),
    ),
    Command.make("status", { cwd, json }, (options) =>
      command(status(options.cwd)),
    ).pipe(Command.withDescription("Print the published CI and lint status")),
    Command.make("ci").pipe(
      Command.withDescription("GitHub Actions results"),
      Command.withSubcommands([
        Command.make("logs", { cwd, run, json }, (options) =>
          command(ciLogs(options)),
        ).pipe(
          Command.withDescription(
            "Print the failed runs on the pushed branch, with their logs",
          ),
        ),
      ]),
    ),
    Command.make("lint").pipe(
      Command.withDescription("Agent lint results"),
      Command.withSubcommands([
        Command.make(
          "check",
          {
            cwd,
            json,
            force: Flag.Boolean("force").pipe(
              Flag.withDescription("Run even if the working tree is unchanged"),
              Flag.withDefault(false),
            ),
          },
          (options) => command(lintRun(options)),
        ).pipe(
          Command.withDescription(
            "Lint the checkout unless its working tree is unchanged",
          ),
        ),
      ]),
    ),
    Command.make("paste", { kind, json, ...origin }, (options) =>
      command(paste(options)),
    ).pipe(
      Command.withDescription(
        "Paste the CI or lint draft into a ready agent without submitting it",
      ),
    ),
    Command.make("launchers", { cwd, json }, (options) =>
      command(launchers(options.cwd)),
    ).pipe(Command.withDescription("Print the agents that can be launched")),
    Command.make(
      "launch",
      {
        kind,
        json,
        run,
        ...origin,
        launcher: Flag.String("launcher").pipe(
          Flag.withDescription("Launcher ID from the launchers command"),
        ),
        worktree: Flag.Boolean("worktree").pipe(
          Flag.withDescription(
            "Start from the pushed commit in a new worktree (CI only)",
          ),
          Flag.withDefault(false),
        ),
      },
      (options) => command(launch(options)),
    ).pipe(
      Command.withDescription(
        "Start an agent beside the pane and submit the CI or lint draft",
      ),
    ),
    Command.make("browser", { cwd, run, json }, (options) =>
      command(browser(options)),
    ).pipe(
      Command.withDescription(
        "Open a run, or the Actions page, in the browser",
      ),
    ),
  ]),
  Command.run({ version }),
  Effect.tapCause((cause) => reportError(cause)),
  Effect.annotateLogs({ plugin: pluginId }),
  Effect.provide(
    Layer.merge(
      NodeServices.layer,
      Logger.layer([Logger.withConsoleError(Logger.formatJson)]),
    ),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
