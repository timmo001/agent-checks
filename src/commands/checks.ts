import { Gh } from "@timmo001/effect-gh";
import { HerdrSdk, PaneId } from "@timmo001/effect-herdr";
import { Console, Effect, Match, Option, Path, Schema } from "effect";
import { availableLaunchers, launchAgent, pasteDraft } from "../actions/agent";
import { CiFailures, ciFailures, reviewsPrompt } from "../actions/prompt";
import { pluginId } from "../config";
import { ActionError } from "../errors";
import { LintState, lintCheck, lintPrompt } from "../lint";
import { GitHub } from "../services/github";
import { gitRoot } from "../services/git";
import { focusedPane, paneDirectory } from "../services/herdr";
import { Process, ProcessError } from "../services/process";
import { PullRequestReviews } from "../services/reviews";
import { CheckoutStatus, checkoutStatus, statusFile } from "../status";
import { start } from "./watch";

type Kind = "ci" | "lint" | "reviews";

const printJson = <S extends Schema.Constraint>(schema: S) =>
  Effect.fn("Checks.printJson")(function* (value: S["Type"]) {
    yield* Console.log(
      yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value),
    );
  });

/**
 * The pane and checkout an action applies to: the flags when given, otherwise
 * the pane a Herdr plugin action was invoked from and its checkout.
 */
const origin = Effect.fn("Checks.origin")(function* (options: {
  readonly cwd: Option.Option<string>;
  readonly pane: Option.Option<string>;
}) {
  const herdr = yield* HerdrSdk;

  const pane = Option.isSome(options.pane)
    ? yield* herdr.panes.get(
        yield* Schema.decodeEffect(PaneId)(options.pane.value),
      )
    : yield* focusedPane;

  const cwd = Option.isSome(options.cwd)
    ? options.cwd.value
    : (paneDirectory(pane) ??
      Option.getOrUndefined(
        Option.flatMap(
          Option.fromNullishOr(
            (yield* herdr.session.snapshot()).workspaces.find(
              (workspace) => workspace.id === pane.workspaceId,
            ),
          ),
          (workspace) => workspace.worktree,
        ),
      )?.checkoutPath);

  if (!cwd)
    return yield* new ActionError({
      message: `${pane.id} has no working directory`,
    });

  return { pane, root: yield* checkoutRoot(cwd) };
});

const checkoutRoot = Effect.fn("Checks.checkoutRoot")(function* (cwd: string) {
  const directory = (yield* Path.Path).resolve(cwd);
  const root = yield* gitRoot(directory);

  if (!root)
    return yield* new ActionError({
      message: `${directory} is not a Git checkout`,
    });

  return root;
});

const ciFor = Effect.fn("Checks.ciFor")(function* (
  root: string,
  run: Option.Option<number>,
) {
  const github = yield* GitHub;
  const target = yield* github.discover(root);

  if (!target)
    return yield* new ActionError({
      message: `${root} is not on a branch with a GitHub remote`,
    });

  const status = yield* github.status(target);

  if (!status)
    return yield* new ActionError({
      message: `${target.branch} has not been pushed to ${target.repository}`,
    });

  return {
    target,
    failures: yield* ciFailures(target, status, Option.getOrUndefined(run)),
  };
});

/** The current lint result, re-running it when the working tree changed. */
const lintFor = Effect.fn("Checks.lintFor")(function* (root: string) {
  const state = yield* lintCheck(root);

  if (state.running)
    return yield* new ActionError({ message: "Lint is still running" });

  const result = state.result;

  if (!result || result.status === "clean" || result.status === "unconfigured")
    return yield* new ActionError({
      message:
        result?.status === "unconfigured"
          ? "No lint checks are configured for this checkout"
          : "Lint is clean",
    });

  if (result.status === "error")
    return yield* new ActionError({
      message: `Lint could not run: ${result.error ?? "unknown error"}`,
    });

  return lintPrompt(root, result);
});

/** The open review threads on the checkout's pull request, fetched fresh. */
const reviewsFor = Effect.fn("Checks.reviewsFor")(function* (root: string) {
  const target = yield* (yield* GitHub).discover(root);

  if (!target)
    return yield* new ActionError({
      message: `${root} is not on a branch with a GitHub remote`,
    });

  const reviews = yield* (yield* PullRequestReviews).forTarget(target);

  if (!reviews)
    return yield* new ActionError({
      message: `${target.branch} has no open pull request`,
    });

  if (!reviews.threads.length)
    return yield* new ActionError({
      message: `#${reviews.number} has no open review threads`,
    });

  return reviewsPrompt(reviews);
});

const draftFor = (kind: Exclude<Kind, "ci">, root: string) =>
  kind === "lint" ? lintFor(root) : reviewsFor(root);

export const paths = Effect.gen(function* () {
  yield* printJson(Schema.Struct({ status: Schema.String }))({
    status: yield* statusFile,
  });
});

export const status = Effect.fn("Checks.status")(function* (cwd: string) {
  yield* printJson(CheckoutStatus)(
    yield* checkoutStatus(yield* checkoutRoot(cwd)),
  );
});

export const ciLogs = Effect.fn("Checks.ciLogs")(function* (options: {
  readonly cwd: string;
  readonly run: Option.Option<number>;
  readonly json: boolean;
}) {
  const { failures } = yield* ciFor(
    yield* checkoutRoot(options.cwd),
    options.run,
  );

  if (options.json) yield* printJson(CiFailures)(failures);
  else yield* Console.log(failures.prompt);
});

export const lintRun = Effect.fn("Checks.lintRun")(function* (options: {
  readonly cwd: string;
  readonly force: boolean;
  readonly all: boolean;
  readonly only: readonly string[];
  readonly json: boolean;
}) {
  const state = yield* lintCheck(yield* checkoutRoot(options.cwd), {
    force: options.force,
    all: options.all,
    only: options.only,
  });

  if (options.json) yield* printJson(LintState)(state);
  else
    yield* Console.log(
      state.running
        ? "Lint is already running"
        : state.result
          ? lintPrompt(state.root, state.result) || state.result.status
          : "No lint result",
    );
});

export const paste = Effect.fn("Checks.paste")(function* (options: {
  readonly kind: Kind;
  readonly cwd: Option.Option<string>;
  readonly pane: Option.Option<string>;
}) {
  const { pane, root } = yield* origin(options);

  yield* pasteDraft(
    pane.id,
    options.kind === "ci"
      ? (yield* ciFor(root, Option.none())).failures.prompt
      : yield* draftFor(options.kind, root),
  );
});

export const launchers = Effect.fn("Checks.launchers")(function* (cwd: string) {
  yield* printJson(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  )(
    (yield* availableLaunchers(yield* checkoutRoot(cwd))).map(
      ({ id, label }) => ({ id, label }),
    ),
  );
});

export const launch = Effect.fn("Checks.launch")(function* (options: {
  readonly kind: Kind;
  readonly cwd: Option.Option<string>;
  readonly pane: Option.Option<string>;
  readonly launcher: string;
  readonly worktree: boolean;
  readonly run: Option.Option<number>;
}) {
  const { pane, root } = yield* origin(options);

  if (options.kind !== "ci") {
    if (options.worktree)
      return yield* new ActionError({
        message:
          options.kind === "lint"
            ? "Lint fixes need this checkout's uncommitted changes"
            : "Review fixes belong on the pull request's branch",
      });

    yield* launchAgent({
      origin: pane,
      root,
      launcherId: options.launcher,
      prompt: yield* draftFor(options.kind, root),
      worktree: null,
    });

    return;
  }

  const { target, failures } = yield* ciFor(root, options.run);
  const run = Option.getOrUndefined(options.run);

  yield* launchAgent({
    origin: pane,
    root,
    launcherId: options.launcher,
    prompt: failures.prompt,
    worktree: options.worktree
      ? {
          remote: target.remote,
          sha: failures.sha,
          branch: run === undefined ? "fix/ci" : `fix/workflow-${run}`,
          label: `Fix ${failures.runs.length === 1 ? failures.runs[0]?.workflow : "CI"}`,
        }
      : null,
  });
});

export const browser = Effect.fn("Checks.browser")(function* (options: {
  readonly cwd: string;
  readonly run: Option.Option<number>;
}) {
  const github = yield* GitHub;
  const gh = yield* Gh;
  const target = yield* github.discover(yield* checkoutRoot(options.cwd));

  if (!target)
    return yield* new ActionError({
      message: `${options.cwd} is not on a branch with a GitHub remote`,
    });

  const repo = `github.com/${target.repository}`;

  yield* gh
    .execute(
      Option.isSome(options.run)
        ? ["run", "view", String(options.run.value), "--repo", repo, "--web"]
        : ["browse", "--actions", "--repo", repo],
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProcessError({
            command: "gh",
            message: Match.value(cause).pipe(
              Match.tag(
                "GhCommandError",
                (error) => error.stderr.trim() || `gh exited ${error.exitCode}`,
              ),
              Match.orElse(String),
            ),
          }),
      ),
    );
});

/** Open the Omarchy panel for the pane a Herdr action came from. */
export const open = Effect.fn("Checks.open")(function* (kind: Kind) {
  const { pane, root } = yield* origin({
    cwd: Option.none(),
    pane: Option.none(),
  });

  yield* start;
  yield* (yield* Process).text("omarchy-shell", [
    pluginId,
    kind,
    root,
    pane.id,
  ]);
});
