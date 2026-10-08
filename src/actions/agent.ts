import { randomUUID } from "node:crypto";
import { HerdrSdk, type Pane, type PaneId } from "@timmo001/effect-herdr";
import { Effect, Option, Path, Schedule } from "effect";
import { Launcher, RuntimeConfig } from "../config";
import { ActionError } from "../errors";
import { Process } from "../services/process";

const resolveLauncher = Effect.fn("Actions.resolveLauncher")(function* (
  launcher: typeof Launcher.Type,
  cwd: string,
) {
  const process = yield* Process;

  const executable = (yield* Path.Path).resolve(
    cwd,
    yield* process.text(
      "bash",
      ["-lc", 'command -v -- "$1"', "agent-checks", launcher.argv[0]],
      cwd,
    ),
  );

  yield* process.text("test", ["-f", executable]);
  yield* process.text("test", ["-x", executable]);

  return executable;
});

export const availableLaunchers = Effect.fn("Actions.availableLaunchers")(
  function* (cwd: string) {
    const config = yield* RuntimeConfig;

    if (config.launchers.length === 0) return [];
    const integrations = yield* (yield* HerdrSdk).integrations.list();

    const installed = new Set<string>(
      integrations
        .filter((integration) => integration.state !== "notInstalled")
        .map((integration) => integration.target),
    );

    return yield* Effect.filter(
      config.launchers.filter((launcher) =>
        installed.has(launcher.integration ?? launcher.agent),
      ),
      (launcher) => resolveLauncher(launcher, cwd).pipe(Effect.isSuccess),
      { concurrency: 4 },
    );
  },
);

/** Insert a draft at the agent's cursor without submitting it. */
export const pasteDraft = Effect.fn("Actions.pasteDraft")(function* (
  paneId: PaneId,
  prompt: string,
) {
  const herdr = yield* HerdrSdk;
  const agent = yield* herdr.agents.get({ paneId });

  if (!["idle", "done"].includes(agent.status))
    return yield* new ActionError({
      message: `The agent in ${paneId} is ${agent.status}; paste when it is ready`,
    });

  yield* herdr.panes.sendText(agent.paneId, `\n${prompt}\n`);
});

/**
 * Start a configured agent beside `origin`, or in a new worktree from
 * `worktree.sha`, and submit the prompt once it is ready.
 */
export const launchAgent = Effect.fn("Actions.launchAgent")(
  function* (options: {
    readonly origin: Pane;
    readonly root: string;
    readonly launcherId: string;
    readonly prompt: string;
    readonly worktree: {
      readonly remote: string;
      readonly sha: string;
      readonly branch: string;
      readonly label: string;
    } | null;
  }) {
    const process = yield* Process;
    const herdr = yield* HerdrSdk;
    const { root, worktree } = options;

    const launcher = (yield* availableLaunchers(root)).find(
      (value) => value.id === options.launcherId,
    );

    if (!launcher)
      return yield* new ActionError({
        message: `${options.launcherId} is not an available launcher`,
      });

    const executable = yield* resolveLauncher(launcher, root);
    let pane: Pane;

    if (worktree) {
      const commit = yield* process.run(
        "git",
        ["cat-file", "-e", `${worktree.sha}^{commit}`],
        root,
      );

      if (commit.code !== 0)
        yield* process.text(
          "git",
          ["fetch", "--no-tags", "--", worktree.remote, worktree.sha],
          root,
        );
      yield* process.text(
        "git",
        ["cat-file", "-e", `${worktree.sha}^{commit}`],
        root,
      );
      pane = (yield* herdr.worktrees.create({
        cwd: root,
        branch: `${worktree.branch}-${randomUUID().slice(0, 8)}`,
        base: worktree.sha,
        label: worktree.label,
        focus: true,
      })).rootPane;
    } else {
      pane = yield* herdr.panes.split(options.origin.id, {
        workspaceId: options.origin.workspaceId,
        direction: "down",
        cwd: root,
        focus: true,
      });
    }

    let expected: string | undefined;

    if (launcher.verifyCommand) {
      const [verify, ...verifyArgs] = launcher.verifyCommand;
      expected = yield* process.text(
        verify,
        verifyArgs,
        Option.getOrUndefined(pane.cwd) ?? root,
      );

      if (!expected.startsWith("/") || expected.includes("\n"))
        return yield* new ActionError({
          message:
            "Launcher verification must return one absolute executable path",
        });
      yield* process.text("test", ["-f", expected]);
      yield* process.text("test", ["-x", expected]);
    }

    const command = [executable, ...launcher.argv.slice(1)]
      .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
      .join(" ");

    yield* herdr.panes.sendInput(pane.id, { text: command, keys: ["enter"] });
    yield* Effect.gen(function* () {
      const agent = yield* herdr.agents.get({ paneId: pane.id });

      const processes =
        (yield* herdr.panes.processInfo(pane.id)).foregroundProcesses ?? [];

      if (
        Option.getOrUndefined(agent.agent) !== launcher.agent ||
        !["idle", "done"].includes(agent.status) ||
        (expected !== undefined &&
          !processes.some((foreground) =>
            Option.getOrUndefined(foreground.argv)?.includes(expected),
          ))
      ) {
        return yield* new ActionError({
          message: `Waiting for ${launcher.agent} in ${pane.id}`,
        });
      }
    }).pipe(
      Effect.retry({ times: 60, schedule: Schedule.spaced(500) }),
      Effect.timeout(30_000),
    );
    yield* herdr.agents.prompt({ paneId: pane.id }, { text: options.prompt });
  },
);
