import { randomUUID } from "node:crypto";
import {
  HerdrSdk,
  PaneId,
  PluginId,
  WorkspaceId,
} from "@timmo001/effect-herdr";
import {
  Cause,
  Console,
  Effect,
  FileSystem,
  Path,
  Result,
  Schema,
  Terminal,
} from "effect";
import { Prompt } from "effect/unstable/cli";
import { availableLaunchers, pasteTarget } from "../actions/agent";
import { handoff } from "../actions/prompt";
import { Action, ActionError, Selection } from "../actions/selection";
import { Launcher, RuntimeConfig, pluginId } from "../config";
import { reportError } from "../errors";
import { indicator } from "../indicator";
import { GitHub, attention, type Run } from "../services/github";
import { Origin, checkout } from "../services/herdr";
import { Process } from "../services/process";
import { plain } from "../text";
import { start } from "./watch";

export const open = Effect.gen(function* () {
  const herdr = yield* HerdrSdk;

  const context = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        workspace_id: WorkspaceId,
        focused_pane_id: PaneId,
      }),
    ),
  )(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");

  const pane = yield* herdr.panes.get(context.focused_pane_id);

  if (pane.workspaceId !== context.workspace_id)
    return yield* new ActionError({
      message: "The originating workspace changed",
    });

  const origin: Origin = {
    workspace: context.workspace_id,
    pane,
    processes:
      (yield* herdr.panes.processInfo(pane.id)).foregroundProcesses ?? [],
  };

  yield* start;
  yield* herdr.plugins.panes.open(PluginId.make(pluginId), {
    entrypoint: "picker",
    placement: "popup",
    focus: true,
    env: {
      WORKFLOW_WATCH_ORIGIN: yield* Schema.encodeEffect(
        Schema.fromJsonString(Origin),
      )(origin),
    },
  });
});

export const picker = Effect.gen(function* () {
  const origin = yield* Schema.decodeEffect(Schema.fromJsonString(Origin))(
    process.env.WORKFLOW_WATCH_ORIGIN ?? "{}",
  );

  const config = yield* RuntimeConfig;
  const herdr = yield* HerdrSdk;
  const github = yield* GitHub;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const snapshot = yield* herdr.session.snapshot();

  const workspace = snapshot.workspaces.find(
    (value) => value.id === origin.workspace,
  );

  const cwd = workspace && checkout(workspace, snapshot.panes);
  const target = cwd ? yield* github.discover(cwd) : null;

  const status = target
    ? yield* github.status(target, config.showPrevious)
    : null;

  const failures =
    status?.runs.filter((run) => attention(run.conclusion)) ?? [];

  if (!target) {
    yield* Prompt.Select({
      message: "No pushed GitHub branch to watch",
      choices: [{ title: "Close", value: "close" }],
    });

    return;
  }

  const run = yield* Prompt.Select<Run | "actions" | null>({
    message: plain(
      [
        target.repository,
        target.branch,
        status ? status.sha.slice(0, 8) : "No pushed GitHub branch to watch",
        status?.runs.length === 0
          ? "No runs for the latest commit"
          : status && failures.length === 0
            ? "No workflow failures"
            : null,
        status?.previous
          ? (indicator(status, config) ??
            "Previous runs have no pass/fail result")
          : null,
      ]
        .filter((value) => value !== null)
        .join(" / "),
    ),
    choices: [
      ...failures.map((value) => ({
        title: plain(
          `${value.name ?? value.display_title} (${value.conclusion}, attempt ${value.run_attempt})`,
        ),
        value,
      })),
      { title: "Open all Actions in browser", value: "actions" },
      { title: "Close", value: null },
    ],
  });

  if (!run) return;
  let selection: typeof Selection.Type;

  if (run === "actions") {
    selection = { origin, target, action: "actions" };
  } else {
    const paste = yield* pasteTarget(origin).pipe(Effect.result);

    const launchers = yield* availableLaunchers(target.root).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Console.error(
            yield* reportError(Cause.fail(cause), "Agent discovery failed"),
          );

          return [];
        }),
      ),
    );

    const action = yield* Prompt.Select<typeof Action.Type | "copy" | null>({
      message: "What next?",
      choices: [
        { title: "Open failure in browser", value: "browser" },
        { title: "Copy failure to clipboard", value: "copy" },
        {
          title: "Paste draft into original agent",
          value: "paste",
          disabled: Result.isFailure(paste),
          description:
            "Insert without submitting; requires the same ready agent",
        },
        {
          title: "New agent in this checkout",
          value: "checkout",
          disabled: launchers.length === 0,
        },
        {
          title: "New agent in a new worktree",
          value: "worktree",
          disabled: launchers.length === 0,
        },
        { title: "Close", value: null },
      ],
    });

    if (!action) return;

    if (action === "copy") {
      // Clipboard output must go through the popup's terminal, not dispatch's log.
      yield* (yield* Terminal.Terminal).display(
        `\u001b]52;c;${Buffer.from(yield* handoff(target, run)).toString("base64")}\u0007`,
      );
      yield* Prompt.Select({
        message: "Failure sent to clipboard",
        choices: [{ title: "Close", value: "close" }],
      });

      return;
    }

    if (action === "checkout" || action === "worktree") {
      const launcher = yield* Prompt.Select<typeof Launcher.Type | null>({
        message: "Which agent?",
        choices: [
          ...launchers.map((value) => ({ title: plain(value.label), value })),
          { title: "Close", value: null },
        ],
      });

      if (!launcher) return;
      selection = { origin, target, run, action, launcher };
    } else {
      selection = { origin, target, run, action };
    }
  }

  const id = randomUUID();
  yield* fs.writeFileString(
    path.join(config.state, `selection-${id}.json`),
    yield* Schema.encodeEffect(Schema.fromJsonString(Selection))(selection),
    { mode: 0o600 },
  );
  yield* (yield* Process).detach("dispatch", { WORKFLOW_WATCH_SELECTION: id });

  // The worker closes this popup before changing layout or sending input.
  return yield* Effect.never;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
      yield* Console.error(
        yield* reportError(cause, "Workflow Watch unavailable"),
      );
      yield* Prompt.Select({
        message: "Workflow Watch unavailable",
        choices: [{ title: "Close", value: "close" }],
      });
    }),
  ),
);
