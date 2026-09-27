import { randomUUID } from "node:crypto";
import { HerdrSdk, type Pane } from "@timmo001/effect-herdr";
import { Effect, Option, Path, Schedule, Schema } from "effect";
import { Launcher, RuntimeConfig } from "../config";
import type { Run, Target } from "../services/github";
import { Origin } from "../services/herdr";
import { Process } from "../services/process";
import { ActionError, type LaunchAction } from "./selection";

const resolveLauncher = Effect.fn("Actions.resolveLauncher")(function* (
  launcher: typeof Launcher.Type,
  cwd: string,
) {
  const process = yield* Process;

  const executable = (yield* Path.Path).resolve(
    cwd,
    yield* process.text(
      "bash",
      ["-lc", 'command -v -- "$1"', "workflow-watch", launcher.argv[0]],
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

export const pasteTarget = Effect.fn("Actions.pasteTarget")(function* (
  origin: Origin,
) {
  const herdr = yield* HerdrSdk;
  const agent = yield* herdr.agents.get({ paneId: origin.pane.id });

  const processes =
    (yield* herdr.panes.processInfo(agent.paneId)).foregroundProcesses ?? [];

  if (
    Option.isNone(origin.pane.agent) ||
    Option.getOrUndefined(agent.agent) !==
      Option.getOrUndefined(origin.pane.agent) ||
    agent.workspaceId !== origin.workspace ||
    agent.terminalId !== origin.pane.terminalId ||
    Option.getOrUndefined(agent.agentSession)?.value !==
      Option.getOrUndefined(origin.pane.agentSession)?.value ||
    !["idle", "done"].includes(agent.status) ||
    origin.processes.length === 0 ||
    origin.processes.some((process) => Option.isNone(process.argv)) ||
    !Schema.toEquivalence(Origin.fields.processes)(processes, origin.processes)
  ) {
    return yield* new ActionError({
      message: "The original agent is no longer ready for a draft",
    });
  }

  return agent;
});

export const pasteDraft = Effect.fn("Actions.pasteDraft")(function* (
  origin: Origin,
  prompt: string,
) {
  const agent = yield* pasteTarget(origin);
  yield* (yield* HerdrSdk).panes.sendText(agent.paneId, `\n${prompt}\n`);
});

export const launchAgent = Effect.fn("Actions.launchAgent")(function* (
  origin: Origin,
  target: Target,
  run: Run,
  action: typeof LaunchAction.Type,
  launcher: typeof Launcher.Type,
  prompt: string,
) {
  const config = yield* RuntimeConfig;
  const process = yield* Process;
  const herdr = yield* HerdrSdk;

  if (
    !config.launchers.some((value) =>
      Schema.toEquivalence(Launcher)(value, launcher),
    )
  )
    return yield* new ActionError({
      message: "The selected launcher changed; reopen Workflow Watch",
    });

  if (
    !(yield* availableLaunchers(target.root)).some(
      (value) => value.id === launcher.id,
    )
  )
    return yield* new ActionError({
      message: `${launcher.label} is no longer available; reopen Workflow Watch`,
    });
  const executable = yield* resolveLauncher(launcher, target.root);
  let pane: Pane;

  if (action === "worktree") {
    const commit = yield* process.run(
      "git",
      ["cat-file", "-e", `${run.head_sha}^{commit}`],
      target.root,
    );

    if (commit.code !== 0)
      yield* process.text(
        "git",
        ["fetch", "--no-tags", "--", target.remote, run.head_sha],
        target.root,
      );
    yield* process.text(
      "git",
      ["cat-file", "-e", `${run.head_sha}^{commit}`],
      target.root,
    );
    pane = (yield* herdr.worktrees.create({
      cwd: target.root,
      branch: `fix/workflow-${run.id}-${randomUUID().slice(0, 8)}`,
      base: run.head_sha,
      label: `Fix ${run.name ?? "workflow"}`,
      focus: true,
    })).rootPane;
  } else {
    pane = yield* herdr.panes.split(origin.pane.id, {
      workspaceId: origin.workspace,
      direction: "down",
      cwd: target.root,
      focus: true,
    });
  }

  let expected: string | undefined;

  if (launcher.verifyCommand) {
    const [verify, ...verifyArgs] = launcher.verifyCommand;
    expected = yield* process.text(
      verify,
      verifyArgs,
      Option.getOrUndefined(pane.cwd) ?? target.root,
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
  yield* herdr.agents.prompt({ paneId: pane.id }, { text: prompt });
});
