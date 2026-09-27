import { Gh } from "@timmo001/effect-gh";
import { Effect, FileSystem, Match, Path, Schema } from "effect";
import { launchAgent, pasteDraft } from "../actions/agent";
import { handoff } from "../actions/prompt";
import { ActionError, Selection } from "../actions/selection";
import { RuntimeConfig } from "../config";
import { GitHub, attention, targetKey } from "../services/github";
import { checkout, enabled } from "../services/herdr";
import { ProcessError } from "../services/process";

export const dispatch = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const id = yield* Schema.decodeUnknownEffect(
    Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
  )(process.env.WORKFLOW_WATCH_SELECTION);

  const file = path.join(config.state, `selection-${id}.json`);

  const selection = yield* Schema.decodeEffect(
    Schema.fromJsonString(Selection),
  )(yield* fs.readFileString(file));

  yield* fs.remove(file);
  const herdr = yield* HerdrSdk;
  yield* herdr.popups.close();
  const github = yield* GitHub;
  const gh = yield* Gh;

  const browse = Effect.fn("Dispatch.browse")(
    (args: ReadonlyArray<string>) => gh.execute(args),
    (effect) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProcessError({
              command: "gh",
              message: Match.value(cause).pipe(
                Match.tag(
                  "GhCommandError",
                  (error) =>
                    error.stderr.trim() || `gh exited ${error.exitCode}`,
                ),
                Match.orElse(String),
              ),
            }),
        ),
      ),
  );

  if (!(yield* enabled))
    return yield* new ActionError({ message: "Workflow Watch is disabled" });
  const snapshot = yield* herdr.session.snapshot();

  const workspace = snapshot.workspaces.find(
    (value) => value.id === selection.origin.workspace,
  );

  const cwd = workspace && checkout(workspace, snapshot.panes);
  const target = cwd ? yield* github.discover(cwd) : null;

  if (
    !target ||
    target.root !== selection.target.root ||
    targetKey(target) !== targetKey(selection.target) ||
    target.localBranch !== selection.target.localBranch
  ) {
    return yield* new ActionError({
      message:
        "The originating checkout or branch changed; reopen Workflow Watch",
    });
  }

  if (selection.action === "actions") {
    yield* browse([
      "browse",
      "--actions",
      "--repo",
      `github.com/${target.repository}`,
    ]);

    return;
  }

  const status = yield* github.status(target);
  const current = status?.runs.find((run) => run.id === selection.run.id);

  if (
    !current ||
    current.head_sha !== selection.run.head_sha ||
    current.run_attempt !== selection.run.run_attempt ||
    !attention(current.conclusion)
  ) {
    return yield* new ActionError({
      message: "The selected run changed or recovered; reopen Workflow Watch",
    });
  }

  if (!("launcher" in selection)) {
    if (selection.action === "browser") {
      yield* browse([
        "run",
        "view",
        String(current.id),
        "--repo",
        `github.com/${target.repository}`,
        "--web",
      ]);
    } else {
      yield* pasteDraft(selection.origin, yield* handoff(target, current));
    }

    return;
  }

  const prompt = yield* handoff(target, current);
  const pane = yield* herdr.panes.get(selection.origin.pane.id);

  if (
    pane.workspaceId !== selection.origin.workspace ||
    pane.terminalId !== selection.origin.pane.terminalId
  ) {
    return yield* new ActionError({
      message: "The originating pane changed; reopen Workflow Watch",
    });
  }

  yield* launchAgent(
    selection.origin,
    target,
    current,
    selection.action,
    selection.launcher,
    prompt,
  );
});

import { HerdrSdk } from "@timmo001/effect-herdr";
