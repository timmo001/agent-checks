import { Config, Console, Effect, Option, Path, Schema } from "effect";
import { prompt, report } from "../actions/prompt";
import { GitHub, GitHubError, attention } from "../services/github";

const logDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;

  const base = yield* Config.String("XDG_STATE_HOME").pipe(
    Config.orElse(() =>
      Config.String("HOME").pipe(
        Config.map((home) => path.join(home, ".local", "state")),
      ),
    ),
  );

  return path.join(base, "herdr-workflow-watch", "logs");
});

const Failures = Schema.Struct({
  repository: Schema.String,
  branch: Schema.String,
  sha: Schema.NullOr(Schema.String),
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      attempt: Schema.Int,
      workflow: Schema.String,
      url: Schema.String,
      jobs: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.String,
          conclusion: Schema.NullOr(Schema.String),
          url: Schema.String,
          failedSteps: Schema.Array(
            Schema.Struct({
              number: Schema.Int,
              name: Schema.String,
              conclusion: Schema.NullOr(Schema.String),
            }),
          ),
        }),
      ),
      logs: Schema.NullOr(Schema.String),
      logFile: Schema.NullOr(Schema.String),
    }),
  ),
  prompt: Schema.NullOr(Schema.String),
});

export const failures = Effect.fn("Commands.failures")(function* (options: {
  readonly cwd: string;
  readonly logDir: Option.Option<string>;
  readonly json: boolean;
}) {
  const github = yield* GitHub;
  const path = yield* Path.Path;
  const cwd = path.resolve(options.cwd);
  const target = yield* github.discover(cwd);

  if (!target)
    return yield* new GitHubError({
      message: `${cwd} is not on a branch with a GitHub remote`,
    });

  const status = yield* github.status(target);

  const directory = Option.isSome(options.logDir)
    ? path.resolve(options.logDir.value)
    : yield* logDirectory;

  const runs = (status?.runs ?? []).filter((run) => attention(run.conclusion));

  const reports = yield* Effect.forEach(
    runs,
    (run) =>
      report(target, run, directory).pipe(
        Effect.map((value) => ({ ...value, run })),
      ),
    { concurrency: 3 },
  );

  const text =
    status && reports.length ? prompt(target, status.sha, reports) : null;

  if (!options.json) {
    yield* Console.log(text ?? "No failed workflow runs on the pushed branch.");

    return;
  }

  const output = yield* Schema.encodeEffect(Schema.fromJsonString(Failures))({
    repository: target.repository,
    branch: target.branch,
    sha: status?.sha ?? null,
    runs: reports.map(({ run, jobs, logs, logFile }) => ({
      id: run.id,
      attempt: run.run_attempt,
      workflow: run.name ?? run.display_title,
      url: run.html_url,
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        url: job.html_url,
        failedSteps: (job.steps ?? [])
          .filter((step) => attention(step.conclusion))
          .map((step) => ({
            number: step.number,
            name: step.name,
            conclusion: step.conclusion,
          })),
      })),
      logs,
      logFile,
    })),
    prompt: text,
  });

  yield* Console.log(output);
});
