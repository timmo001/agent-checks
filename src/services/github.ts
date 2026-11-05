import {
  Api,
  Gh,
  GhCommandError,
  GhDecodeError,
  Graphql,
  isRateLimited,
  RateLimit,
  Workflow,
} from "@timmo001/effect-gh";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { Process } from "./process";

export class GitHubError extends Schema.TaggedError<GitHubError>()(
  "GitHubError",
  {
    message: Schema.String,
    rateLimited: Schema.optionalKey(Schema.Boolean),
  },
) {}

const rateLimitedEntry = (entry: Graphql.ErrorEntry) =>
  entry.type === "RATE_LIMITED" || /rate limit/i.test(entry.message);

// The gh errors carry their detail in fields, so String() alone gives only
// the tag.
function gitHubError(cause: unknown) {
  if (cause instanceof GitHubError) return cause;

  if (cause instanceof Graphql.ResponseError)
    return new GitHubError({
      message: cause.errors.map((entry) => entry.message).join("; "),
      ...(cause.errors.some(rateLimitedEntry) && { rateLimited: true }),
    });

  return new GitHubError({
    message:
      cause instanceof GhCommandError
        ? `gh exited ${cause.exitCode}: ${cause.stderr.trim()}`
        : cause instanceof GhDecodeError
          ? `gh output was not the expected JSON: ${String(cause.cause)}`
          : String(cause),
    ...(cause instanceof GhCommandError &&
      isRateLimited(cause) && { rateLimited: true }),
  });
}

export const Target = Schema.Struct({
  root: Schema.String,
  remote: Schema.String,
  repository: Schema.String,
  branch: Schema.String,
  localBranch: Schema.String,
});

export type Target = typeof Target.Type;

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

export const Run = Schema.Struct({
  id: Schema.Int,
  run_attempt: Schema.Int,
  name: Schema.NullOr(Schema.String),
  display_title: Schema.String,
  head_branch: Schema.NullOr(Schema.String),
  head_sha: Sha,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});

export type Run = typeof Run.Type;

export const Status = Schema.Struct({
  sha: Sha,
  runs: Schema.Array(Run),
  previous: Schema.NullOr(
    Schema.Struct({
      sha: Sha,
      commitsBehind: Schema.Int,
      runs: Schema.Array(Run),
    }),
  ),
});

export type Status = typeof Status.Type;

// GitHub Actions runs as check suites, which GraphQL can read for many
// branches in one request.
const checkSuitesFields = (first: number) => `checkSuites(first: ${first}) {
  nodes {
    status conclusion branch { name }
    workflowRun { databaseId runAttempt displayTitle url workflow { name } }
  }
}`;

const CheckSuites = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      branch: Schema.NullOr(Schema.Struct({ name: Schema.String })),
      workflowRun: Schema.NullOr(
        Schema.Struct({
          databaseId: Schema.Int,
          runAttempt: Schema.Int,
          displayTitle: Schema.String,
          url: Schema.String,
          workflow: Schema.Struct({ name: Schema.String }),
        }),
      ),
    }),
  ),
});

const Commit = Schema.Struct({ oid: Sha, checkSuites: CheckSuites });

const HeadNode = Schema.NullOr(
  Schema.Struct({
    ref: Schema.NullOr(Schema.Struct({ target: Schema.NullOr(Commit) })),
  }),
);

const HistoryResponse = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      ref: Schema.NullOr(
        Schema.Struct({
          target: Schema.NullOr(
            Schema.Struct({
              history: Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    ...Commit.fields,
                    parents: Schema.Struct({
                      nodes: Schema.Array(Schema.Struct({ oid: Sha })),
                    }),
                  }),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
});

// Shaped like the REST workflow run, which the panel and prompts read.
function workflowRuns(target: Target, commit: typeof Commit.Type): Run[] {
  return commit.checkSuites.nodes.flatMap((suite) =>
    suite.workflowRun && suite.branch?.name === target.branch
      ? [
          {
            id: suite.workflowRun.databaseId,
            run_attempt: suite.workflowRun.runAttempt,
            name: suite.workflowRun.workflow.name,
            display_title: suite.workflowRun.displayTitle,
            head_branch: suite.branch.name,
            head_sha: commit.oid,
            status: suite.status.toLowerCase(),
            conclusion: suite.conclusion?.toLowerCase() ?? null,
            html_url: suite.workflowRun.url,
          },
        ]
      : [],
  );
}

const Job = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        name: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});

export function attention(conclusion: string | null) {
  return (
    conclusion !== null &&
    ["failure", "timed_out", "startup_failure", "action_required"].includes(
      conclusion,
    )
  );
}

export function targetKey(target: Target) {
  return `${target.repository.toLowerCase()}#${target.branch}`;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly discover: (
      root: string,
    ) => Effect.Effect<Target | null, GitHubError>;
    /**
     * Every target's status in one query, keyed by {@link targetKey}. Fails
     * as a whole only when the query itself can't run, such as when the
     * rate limit is spent.
     */
    readonly statuses: (
      targets: ReadonlyArray<Target>,
      includePrevious?: boolean,
    ) => Effect.Effect<
      ReadonlyMap<string, Result.Result<Status | null, GitHubError>>,
      GitHubError
    >;
    readonly status: (
      target: Target,
      includePrevious?: boolean,
    ) => Effect.Effect<Status | null, GitHubError>;
    readonly details: (
      target: Target,
      run: Run,
    ) => Effect.Effect<
      { readonly jobs: ReadonlyArray<typeof Job.Type>; readonly logs: string },
      GitHubError
    >;
    /** When a spent quota resets, in epoch milliseconds, or null when unknown. */
    readonly rateLimitReset: (
      resource: RateLimit.ResourceName,
    ) => Effect.Effect<number | null>;
  }
>()("agent-checks/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const process = yield* Process;
      const gh = yield* Gh;

      // A branch made with `git switch -c name origin/dev`, or pushed without
      // -u, still tracks the branch it started from. It is the checkout's own
      // branch once pushed under its name, or when it tracks the default branch.
      const branchedFrom = Effect.fn("GitHub.branchedFrom")(function* (
        root: string,
        remote: string,
        tracked: string,
        local: string,
      ) {
        const pushed = yield* process.run(
          "git",
          [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/remotes/${remote}/${local}`,
          ],
          root,
        );

        if (pushed.code === 0) return true;

        const head = yield* process.run(
          "git",
          ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
          root,
        );

        return head.code === 0 && head.stdout === `${remote}/${tracked}`;
      });

      // Takes a checkout root from gitRoot.
      const discover = Effect.fn("GitHub.discover")(
        function* (root: string) {
          const branch = yield* process.run(
            "git",
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            root,
          );

          if (branch.code === 1) return null;

          if (branch.code !== 0)
            return yield* new GitHubError({ message: branch.stderr });

          const upstream = yield* process.run(
            "git",
            ["config", "--get", `branch.${branch.stdout}.remote`],
            root,
          );

          const merge = yield* process.run(
            "git",
            ["config", "--get", `branch.${branch.stdout}.merge`],
            root,
          );

          if (upstream.code > 1 || merge.code > 1)
            return yield* new GitHubError({
              message: upstream.stderr || merge.stderr,
            });

          const remotes = (yield* process.text("git", ["remote"], root)).split(
            "\n",
          );

          const candidates = [...new Set([upstream.stdout, "origin"])];

          for (const remote of candidates) {
            if (!remote || !remotes.includes(remote)) continue;

            const url = yield* process.text(
              "git",
              ["remote", "get-url", remote],
              root,
            );

            const match =
              /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/.exec(
                url.replace(/\.git\/?$/, ""),
              );

            if (!match?.[1]) continue;

            const tracked =
              remote === upstream.stdout &&
              merge.stdout.startsWith("refs/heads/")
                ? merge.stdout.slice(11)
                : branch.stdout;

            return {
              root,
              remote,
              repository: match[1],
              localBranch: branch.stdout,
              branch:
                tracked !== branch.stdout &&
                (yield* branchedFrom(root, remote, tracked, branch.stdout))
                  ? branch.stdout
                  : tracked,
            };
          }

          return null;
        },
        (effect) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause) }),
            ),
          ),
      );

      const query = <S extends Schema.Constraint>(
        document: string,
        variables: Graphql.Variables,
        schema: S,
      ) =>
        Graphql.query(document, variables, schema, {
          hostname: "github.com",
        }).pipe(Effect.provideService(Gh, gh));

      // One query for every target's branch head and the workflow runs on it.
      const heads = (targets: ReadonlyArray<Target>) => {
        const variables: Record<string, string> = {};

        const fields = targets.map((target, index) => {
          const [owner = "", name = ""] = target.repository.split("/");
          variables[`o${index}`] = owner;
          variables[`n${index}`] = name;
          variables[`r${index}`] = `refs/heads/${target.branch}`;

          return `t${index}: repository(owner: $o${index}, name: $n${index}) {
            ref(qualifiedName: $r${index}) {
              target { ... on Commit { oid ${checkSuitesFields(100)} } }
            }
          }`;
        });

        return query(
          `query(${targets
            .map(
              (_, index) =>
                `$o${index}: String!, $n${index}: String!, $r${index}: String!`,
            )
            .join(", ")}) { ${fields.join("\n")} }`,
          variables,
          Schema.Record(Schema.String, HeadNode),
        ).pipe(
          Effect.map((data) =>
            targets.map((target, index) => {
              const commit = data[`t${index}`]?.ref?.target;

              return commit
                ? {
                    sha: commit.oid,
                    runs: workflowRuns(target, commit),
                    previous: null,
                  }
                : null;
            }),
          ),
        );
      };

      // The newest ancestor on the branch's first-parent line with runs.
      const previous = Effect.fn("GitHub.previous")(function* (
        target: Target,
        current: Status,
      ) {
        const [owner = "", name = ""] = target.repository.split("/");

        const data = yield* query(
          `query($owner: String!, $name: String!, $ref: String!) {
            repository(owner: $owner, name: $name) {
              ref(qualifiedName: $ref) {
                target {
                  ... on Commit {
                    history(first: 101) {
                      nodes { oid parents(first: 1) { nodes { oid } } ${checkSuitesFields(50)} }
                    }
                  }
                }
              }
            }
          }`,
          { owner, name, ref: `refs/heads/${target.branch}` },
          HistoryResponse,
        );

        const commits = data.repository?.ref?.target?.history?.nodes ?? [];

        const parents = new Map(
          commits.map((commit) => [commit.oid, commit.parents.nodes[0]?.oid]),
        );

        const byOid = new Map(commits.map((commit) => [commit.oid, commit]));
        let sha = parents.get(current.sha);

        for (
          let commitsBehind = 1;
          sha && byOid.has(sha) && commitsBehind <= 100;
          commitsBehind++
        ) {
          const commit = byOid.get(sha);
          const runs = commit ? workflowRuns(target, commit) : [];

          if (runs.length > 0)
            return { ...current, previous: { sha, commitsBehind, runs } };

          sha = parents.get(sha);
        }

        return current;
      });

      const withPrevious = (
        target: Target,
        status: Status | null,
        includePrevious: boolean,
      ) =>
        status && includePrevious && status.runs.length === 0
          ? previous(target, status)
          : Effect.succeed(status);

      const statuses = Effect.fn("GitHub.statuses")(
        function* (targets: ReadonlyArray<Target>, includePrevious = false) {
          if (targets.length === 0)
            return new Map<string, Result.Result<Status | null, GitHubError>>();

          // A repository that fails, such as one gone or out of reach, fails
          // the whole batch, so each target is asked again on its own.
          const batch = yield* heads(targets).pipe(
            Effect.map((found) =>
              found.map((status) => Result.succeed(status)),
            ),
            Effect.catchTag("GraphqlResponseError", (error) =>
              targets.length === 1 || error.errors.some(rateLimitedEntry)
                ? Effect.fail(error)
                : Effect.forEach(
                    targets,
                    (target) =>
                      heads([target]).pipe(
                        Effect.map(([status]) => status ?? null),
                        Effect.mapError(gitHubError),
                        Effect.result,
                      ),
                    { concurrency: 4 },
                  ),
            ),
          );

          return new Map(
            yield* Effect.forEach(
              targets,
              (target, index) => {
                const result = batch[index] ?? Result.succeed(null);

                return (
                  Result.isSuccess(result)
                    ? withPrevious(
                        target,
                        result.success,
                        includePrevious,
                      ).pipe(Effect.mapError(gitHubError), Effect.result)
                    : Effect.succeed(result)
                ).pipe(
                  Effect.map((value) => [targetKey(target), value] as const),
                );
              },
              { concurrency: 4 },
            ),
          );
        },
        (effect) => effect.pipe(Effect.mapError(gitHubError)),
      );

      const status = Effect.fn("GitHub.status")(function* (
        target: Target,
        includePrevious = false,
      ) {
        const result = (yield* statuses([target], includePrevious)).get(
          targetKey(target),
        );

        if (!result) return null;

        if (Result.isFailure(result)) return yield* result.failure;

        return result.success;
      });

      const rateLimitReset = Effect.fn("GitHub.rateLimitReset")(
        function* (resource: RateLimit.ResourceName) {
          return (yield* RateLimit.get(resource)).reset * 1000;
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(Gh, gh),
            Effect.orElseSucceed(() => null),
          ),
      );

      const details = Effect.fn("GitHub.details")(
        function* (target: Target, run: Run) {
          const pages = yield* Api.pages(
            {
              endpoint: `repos/${target.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
              method: "GET",
              hostname: "github.com",
              query: { per_page: 100 },
            },
            Schema.Struct({ jobs: Schema.Array(Job) }),
          );

          const jobs = pages
            .flatMap((page) => page.jobs)
            .filter((job) => attention(job.conclusion));

          const logs = yield* Workflow.logs({
            repo: `github.com/${target.repository}`,
            runId: run.id,
            attempt: run.run_attempt,
            failedOnly: true,
          }).pipe(
            Effect.map((stdout) => stdout.trim()),
            Effect.catchTag("GhCommandError", (error) =>
              Effect.succeed(
                `Failed-step output unavailable: ${error.stderr.trim()}`,
              ),
            ),
          );

          return {
            jobs,
            logs,
          };
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(Gh, gh),
            Effect.mapError(gitHubError),
          ),
      );

      return GitHub.of({
        discover,
        statuses,
        status,
        details,
        rateLimitReset,
      });
    }),
  );
}
