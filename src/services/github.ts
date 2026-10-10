import { Api, Gh, Workflow } from "@timmo001/effect-gh";
import { Context, Effect, Layer, Schema } from "effect";
import { Process } from "./process";

export class GitHubError extends Schema.TaggedError<GitHubError>()(
  "GitHubError",
  {
    message: Schema.String,
  },
) {}

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

const RunPage = Schema.Struct({
  total_count: Schema.Int,
  workflow_runs: Schema.Array(Run),
});

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
    /** The open pull request from the target's branch, if any. */
    readonly pullRequest: (
      target: Target,
    ) => Effect.Effect<number | null, GitHubError>;
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

      const runsAt = Effect.fn("GitHub.runsAt")(function* (
        target: Target,
        sha: string,
      ) {
        const pages = yield* Api.pages(
          {
            endpoint: `repos/${target.repository}/actions/runs`,
            method: "GET",
            hostname: "github.com",
            query: { branch: target.branch, head_sha: sha, per_page: 100 },
          },
          RunPage,
        );

        const attempts = new Map<number, Run>();

        for (const page of pages) {
          for (const run of page.workflow_runs) {
            if ((attempts.get(run.id)?.run_attempt ?? 0) <= run.run_attempt)
              attempts.set(run.id, run);
          }
        }

        if (pages.some((page) => page.total_count > attempts.size))
          return yield* new GitHubError({
            message: "GitHub returned an incomplete workflow run list",
          });

        return [...attempts.values()].filter(
          (run) => run.head_sha === sha && run.head_branch === target.branch,
        );
      });

      const status = Effect.fn("GitHub.status")(
        function* (target: Target, includePrevious = false) {
          const refs = yield* Api.json(
            {
              endpoint: `repos/${target.repository}/git/matching-refs/heads/${encodeURIComponent(target.branch)}`,
              method: "GET",
              hostname: "github.com",
            },
            Schema.Array(
              Schema.Struct({
                ref: Schema.String,
                object: Schema.Struct({ sha: Sha }),
              }),
            ),
          );

          const ref = refs.find(
            (value) => value.ref === `refs/heads/${target.branch}`,
          );

          if (!ref) return null;
          const runs = yield* runsAt(target, ref.object.sha);
          const current: Status = { sha: ref.object.sha, runs, previous: null };

          if (runs.length > 0 || !includePrevious) return current;

          const recent = yield* Api.json(
            {
              endpoint: `repos/${target.repository}/actions/runs`,
              method: "GET",
              hostname: "github.com",
              query: { branch: target.branch, per_page: 100 },
            },
            RunPage,
          );

          if (recent.workflow_runs.length === 0) return current;

          const commits = yield* Api.json(
            {
              endpoint: `repos/${target.repository}/commits`,
              method: "GET",
              hostname: "github.com",
              query: { sha: ref.object.sha, per_page: 100 },
            },
            Schema.Array(
              Schema.Struct({
                sha: Sha,
                parents: Schema.Array(Schema.Struct({ sha: Sha })),
              }),
            ),
          );

          const parents = new Map(
            commits.map((commit) => [commit.sha, commit.parents[0]?.sha]),
          );

          const candidates = new Set(
            recent.workflow_runs
              .filter((run) => run.head_branch === target.branch)
              .map((run) => run.head_sha),
          );

          let sha = parents.get(current.sha);

          for (
            let commitsBehind = 1;
            sha && parents.has(sha) && commitsBehind <= 100;
            commitsBehind++
          ) {
            if (candidates.has(sha)) {
              const previousRuns = yield* runsAt(target, sha);

              if (previousRuns.length > 0)
                return {
                  ...current,
                  previous: { sha, commitsBehind, runs: previousRuns },
                };
            }

            sha = parents.get(sha);
          }

          return current;
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(Gh, gh),
            Effect.mapError((cause) =>
              cause instanceof GitHubError
                ? cause
                : new GitHubError({ message: String(cause) }),
            ),
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
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause) }),
            ),
          ),
      );

      const pullRequest = Effect.fn("GitHub.pullRequest")(
        function* (target: Target) {
          const pulls = yield* Api.json(
            {
              endpoint: `repos/${target.repository}/pulls`,
              method: "GET",
              hostname: "github.com",
              query: {
                head: `${target.repository.split("/")[0]}:${target.branch}`,
                state: "open",
                per_page: 1,
              },
            },
            Schema.Array(Schema.Struct({ number: Schema.Int })),
          );

          return pulls[0]?.number ?? null;
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(Gh, gh),
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause) }),
            ),
          ),
      );

      return GitHub.of({ discover, status, details, pullRequest });
    }),
  );
}
