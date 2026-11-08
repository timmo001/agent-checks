import {
  HerdrSdk,
  type PaneId,
  type WorkspaceId,
} from "@timmo001/effect-herdr";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  FiberHandle,
  FiberSet,
  FileSystem,
  Path,
  Queue,
  Result,
  Schedule,
  Semaphore,
  Stream,
} from "effect";
import { check, lock } from "proper-lockfile";
import { RuntimeConfig, ciToken, lintToken, reviewsToken } from "../config";
import { reportError } from "../errors";
import { ciIndicator, lintIndicator, reviewsIndicator } from "../indicator";
import { lintCheck, lintDirectory, readLint } from "../lint";
import {
  GitHub,
  targetKey,
  type Status,
  type Target,
} from "../services/github";
import { gitRoot } from "../services/git";
import {
  checkout,
  cleared,
  enabled,
  metadata,
  paneDirectory,
  registration,
} from "../services/herdr";
import { ProcessError, detachWatcher } from "../services/process";
import { waitForUpdate } from "../services/reload";
import { PullRequestReviews, type Reviews } from "../services/reviews";
import { writeStatus } from "../status";

export const start = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;

  if (!(yield* enabled)) return;

  const held = yield* Effect.tryPromise(() =>
    check(path.join(config.state, "watcher"), {
      realpath: false,
      stale: 15_000,
    }),
  );

  if (!held) yield* detachWatcher(config.root);
});

type CachedTarget = {
  readonly polled: number;
  readonly status: Status | null;
  readonly error: string | null;
};

type CachedReviews = {
  readonly polled: number;
  readonly reviews: Reviews | null;
  readonly error: string | null;
};

const activePollMs = 15_000;

const rateLimitedMessage = (message: string) => /rate limit/i.test(message);

function unfinished(status: Status | null) {
  return (status?.previous?.runs ?? status?.runs)?.some(
    (run) => run.status !== "completed",
  );
}

const runWatcher = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const herdr = yield* HerdrSdk;
  const github = yield* GitHub;
  const pullRequestReviews = yield* PullRequestReviews;
  const compromised = yield* Deferred.make<never, ProcessError>();

  const lease = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      lock(path.join(config.state, "watcher"), {
        realpath: false,
        stale: 15_000,
        update: 5_000,
        onCompromised: (cause) => {
          Deferred.doneUnsafe(
            compromised,
            Effect.fail(
              new ProcessError({ command: "watch", message: String(cause) }),
            ),
          );
        },
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logInfo("Watcher lease not acquired", cause).pipe(
          Effect.as(null),
        ),
      ),
    ),
    (release) =>
      release
        ? Effect.tryPromise(() => release()).pipe(
            Effect.catch((cause) =>
              Effect.die(
                new ProcessError({
                  command: "watch",
                  message: `Could not release watcher lease: ${String(cause)}`,
                }),
              ),
            ),
          )
        : Effect.void,
  );

  if (!lease) return null;
  yield* Effect.logInfo("Agent Checks watcher started");
  const workspaces = new Map<WorkspaceId, string>();
  const discoveryErrors = new Map<WorkspaceId, string>();
  const cached = new Map<string, CachedTarget>();
  const reviewsCached = new Map<string, CachedReviews>();
  const wake = yield* Queue.sliding<void>(1);

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...workspaces.keys()],
      (id) =>
        metadata(id, cleared).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Could not clear workspace indicators", cause),
          ),
        ),
      { concurrency: config.concurrency, discard: true },
    ),
  );

  // Lint runs one checkout at a time. A request while that checkout is
  // queued or running runs it once more afterwards, so later edits count.
  const lints = yield* FiberSet.make();
  const lintPermit = yield* Semaphore.make(1);
  const lintQueued = new Set<string>();
  const lintAgain = new Set<string>();

  const lint = (root: string) => {
    if (!config.lint.enabled) return Effect.void;

    if (lintQueued.has(root)) {
      lintAgain.add(root);

      return Effect.void;
    }

    lintQueued.add(root);

    return FiberSet.run(
      lints,
      Effect.gen(function* () {
        do {
          lintAgain.delete(root);
          yield* lintCheck(root).pipe(
            lintPermit.withPermits(1),
            Effect.catch((cause) =>
              Effect.logWarning(`${root}: lint unavailable`, cause),
            ),
          );
        } while (lintAgain.has(root));
      }).pipe(Effect.ensuring(Effect.sync(() => lintQueued.delete(root)))),
    ).pipe(Effect.asVoid);
  };

  const lintDir = yield* lintDirectory;
  yield* fs.makeDirectory(lintDir, { recursive: true, mode: 0o700 });

  // Lint results land here from the watcher, the panel and the CLI alike.
  yield* fs.watch(lintDir).pipe(
    Stream.runForEach(() => Queue.offer(wake, undefined)),
    Effect.catch((cause) =>
      Effect.logWarning("Lint state watch unavailable", cause),
    ),
    Effect.andThen(Effect.sleep(10_000)),
    Effect.forever,
    Effect.forkScoped,
  );

  // Agents finishing a turn get their checkout linted.
  const roots = new Map<WorkspaceId, string>();
  const paneStatus = new Map<PaneId, string>();
  const agentEvents = yield* FiberHandle.make();
  let subscribedPanes = "";

  const followAgents = (panes: ReadonlyArray<PaneId>) =>
    herdr.events
      .subscribe(
        panes.map((paneId) => ({
          type: "pane.agent_status_changed" as const,
          paneId,
        })),
      )
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type !== "pane.agent_status_changed") return;
            const previous = paneStatus.get(event.paneId);
            paneStatus.set(event.paneId, event.agentStatus);

            const root = roots.get(event.workspaceId);

            if (
              root &&
              previous === "working" &&
              (event.agentStatus === "idle" || event.agentStatus === "done")
            )
              yield* lint(root);
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Agent status stream unavailable", cause),
        ),
        Effect.andThen(Effect.sleep(10_000)),
        Effect.forever,
      );

  const discover = Effect.gen(function* () {
    const snapshot = yield* herdr.session.snapshot();

    const discovered = yield* Effect.forEach(
      snapshot.workspaces,
      Effect.fn("Watch.discover")(function* (workspace) {
        const cwd = checkout(workspace, snapshot.panes);

        const result = cwd
          ? yield* Effect.gen(function* () {
              const root = yield* gitRoot(cwd);

              return {
                root,
                target: root ? yield* github.discover(root) : null,
              };
            }).pipe(Effect.result)
          : null;

        const found =
          result && Result.isSuccess(result)
            ? result.success
            : { root: null, target: null };

        const error =
          result && Result.isFailure(result) ? String(result.failure) : null;

        if (result && Result.isFailure(result)) {
          if (discoveryErrors.get(workspace.id) !== error)
            yield* reportError(
              Cause.fail(result.failure),
              "Could not inspect workspace",
            ).pipe(Effect.annotateLogs({ workspace: workspace.id }));
          discoveryErrors.set(workspace.id, String(result.failure));
        } else {
          discoveryErrors.delete(workspace.id);
        }

        const key = found.target ? targetKey(found.target) : "";

        if (workspaces.get(workspace.id) !== key)
          yield* metadata(
            workspace.id,
            found.target && !cached.has(key)
              ? { [ciToken]: config.indicatorTemplates.loading }
              : cleared,
          );
        workspaces.set(workspace.id, key);

        return {
          id: workspace.id,
          focused: workspace.focused,
          ...found,
          error,
        };
      }),
      { concurrency: config.concurrency },
    );

    const targets = new Map<string, Target>();

    for (const item of discovered)
      if (item.target) targets.set(targetKey(item.target), item.target);

    for (const key of cached.keys()) if (!targets.has(key)) cached.delete(key);

    for (const key of reviewsCached.keys())
      if (!targets.has(key)) reviewsCached.delete(key);

    for (const id of workspaces.keys())
      if (!snapshot.workspaces.some((workspace) => workspace.id === id)) {
        workspaces.delete(id);
        discoveryErrors.delete(id);
      }

    // Checkouts appearing for the first time, including at startup, get linted.
    const previousRoots = new Set(roots.values());
    roots.clear();

    for (const item of discovered)
      if (item.root) {
        roots.set(item.id, item.root);

        if (!previousRoots.has(item.root)) yield* lint(item.root);
      }

    for (const id of paneStatus.keys())
      if (!snapshot.panes.some((pane) => pane.id === id)) paneStatus.delete(id);

    for (const pane of snapshot.panes)
      if (!paneStatus.has(pane.id)) paneStatus.set(pane.id, pane.agentStatus);

    const panes = snapshot.panes.map((pane) => pane.id).toSorted();

    if (panes.join("\n") !== subscribedPanes) {
      subscribedPanes = panes.join("\n");

      if (panes.length)
        yield* FiberHandle.run(agentEvents, followAgents(panes));
      else yield* FiberHandle.clear(agentEvents);
    }

    return { discovered, targets };
  });

  let discovery: Effect.Success<typeof discover> | undefined;
  let nextDiscovery = 0;
  // GitHub polls wait here once a rate limit is spent.
  let pausedUntil = 0;
  const paneCwds = new Map<string, string | undefined>();

  // New workspaces, focus, directory changes and moved panes would otherwise
  // wait for the next periodic discovery.
  yield* herdr.events
    .subscribe([
      { type: "workspace.created" },
      { type: "workspace.closed" },
      { type: "workspace.focused" },
      { type: "worktree.opened" },
      { type: "tab.focused" },
      { type: "pane.created" },
      { type: "pane.updated" },
      { type: "pane.focused" },
      { type: "pane.moved" },
      { type: "pane.closed" },
    ])
    .pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "pane.updated") {
            // Title changes also emit this event, so only a new directory counts.
            const cwd = paneDirectory(event.pane);

            if (paneCwds.get(event.pane.id) === cwd) return;
            paneCwds.set(event.pane.id, cwd);
          } else if (event.type === "pane.created") {
            paneCwds.set(event.pane.id, paneDirectory(event.pane));
          } else if (event.type === "pane.moved") {
            // A move to another workspace gives the pane a new ID, without
            // close or create events, so its agent status follows it.
            const status = paneStatus.get(event.previousPaneId);
            paneCwds.delete(event.previousPaneId);
            paneStatus.delete(event.previousPaneId);
            paneCwds.set(event.pane.id, paneDirectory(event.pane));

            if (status !== undefined) paneStatus.set(event.pane.id, status);
          } else if (event.type === "pane.closed") {
            paneCwds.delete(event.paneId);
          }

          nextDiscovery = 0;
          yield* Queue.offer(wake, undefined);
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Workspace event stream unavailable", cause),
      ),
      Effect.andThen(Effect.sleep(10_000)),
      // The stream ends after Herdr drops events, such as with events_lost.
      Effect.andThen(
        Effect.suspend(() => {
          nextDiscovery = 0;

          return Queue.offer(wake, undefined);
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

  const refresh = Effect.gen(function* () {
    if (!discovery || (yield* Clock.currentTimeMillis) >= nextDiscovery) {
      discovery = yield* discover;
      nextDiscovery = (yield* Clock.currentTimeMillis) + config.pollMs;
    }

    const { discovered, targets } = discovery;

    const focused = new Set(
      discovered.flatMap((item) =>
        item.focused && item.target ? [targetKey(item.target)] : [],
      ),
    );

    // Workspaces out of focus poll no more often than unfocusedPollMs.
    const interval = (key: string, ms: number) =>
      focused.has(key) ? ms : Math.max(ms, config.unfocusedPollMs);

    const ciInterval = (key: string, value: CachedTarget) =>
      value.error
        ? config.retryMs
        : interval(
            key,
            unfinished(value.status) ? activePollMs : config.pollMs,
          );

    const ciNext = (key: string) => {
      const value = cached.get(key);

      return value ? value.polled + ciInterval(key, value) : 0;
    };

    const reviewsNext = (key: string) => {
      const value = reviewsCached.get(key);

      return value
        ? value.polled +
            (value.error
              ? config.retryMs
              : interval(key, config.reviews.pollMs))
        : 0;
    };

    const pause = Effect.fn("Watch.pause")(function* () {
      const reset = yield* github.rateLimitReset("graphql");
      const now = yield* Clock.currentTimeMillis;

      pausedUntil = Math.max(now, reset ?? now + config.retryMs) + 1_000;
      yield* Effect.logWarning(
        `GitHub rate limit spent; polling resumes at ${new Date(pausedUntil).toISOString()}`,
      );
    });

    const started = yield* Clock.currentTimeMillis;

    const ciDue =
      started >= pausedUntil &&
      [...targets.keys()].some((key) => ciNext(key) <= started);

    // Every target due, or due within half its interval, shares one query, so
    // targets drift into the same poll rather than each costing a request.
    const batch = ciDue
      ? [...targets].filter(([key]) => {
          const value = cached.get(key);

          return !value || ciNext(key) - started <= ciInterval(key, value) / 2;
        })
      : [];

    if (batch.length > 0) {
      const keys = new Set(batch.map(([key]) => key));

      yield* Effect.forEach(
        discovered.filter(
          (item) => item.target && keys.has(targetKey(item.target)),
        ),
        (item) =>
          metadata(item.id, {
            [ciToken]: config.indicatorTemplates.loading,
          }),
        { concurrency: config.concurrency, discard: true },
      );

      const result = yield* github
        .statuses(
          batch.map(([, target]) => target),
          config.showPrevious,
        )
        .pipe(Effect.result);

      const polled = yield* Clock.currentTimeMillis;

      if (Result.isFailure(result) && result.failure.rateLimited)
        yield* pause();

      yield* Effect.forEach(
        batch,
        Effect.fn("Watch.recordCi")(function* ([key, target]) {
          const previous = cached.get(key);

          const outcome = Result.isFailure(result)
            ? Result.fail(result.failure)
            : (result.success.get(key) ?? Result.succeed(null));

          if (Result.isFailure(outcome)) {
            if (previous?.error !== String(outcome.failure))
              yield* reportError(
                Cause.fail(outcome.failure),
                "GitHub Actions unavailable",
              ).pipe(
                Effect.annotateLogs({
                  repository: target.repository,
                  branch: target.branch,
                }),
              );
            else
              yield* Effect.logWarning(
                `${target.repository} ${target.branch}: GitHub polling still unavailable`,
                outcome.failure,
              );
            cached.set(key, {
              polled,
              status: null,
              error: String(outcome.failure),
            });
          } else {
            cached.set(key, { polled, status: outcome.success, error: null });
          }
        }),
        { discard: true },
      );
    }

    // Reviews poll on their own, slower interval, one target per pass.
    const now = yield* Clock.currentTimeMillis;

    const dueReviews =
      config.reviews.enabled && now >= pausedUntil
        ? [...targets]
            .filter(([key]) => reviewsNext(key) <= now)
            .sort(([left], [right]) => reviewsNext(left) - reviewsNext(right))
            .slice(0, 1)
        : [];

    yield* Effect.forEach(
      dueReviews,
      Effect.fn("Watch.pollReviews")(function* ([key, target]) {
        const previous = reviewsCached.get(key);

        const result = yield* pullRequestReviews
          .forTarget(target)
          .pipe(Effect.result);

        const polled = yield* Clock.currentTimeMillis;

        if (Result.isFailure(result)) {
          if (rateLimitedMessage(result.failure.message)) yield* pause();

          if (previous?.error !== String(result.failure))
            yield* reportError(
              Cause.fail(result.failure),
              "Pull request reviews unavailable",
            ).pipe(
              Effect.annotateLogs({
                repository: target.repository,
                branch: target.branch,
              }),
            );
          reviewsCached.set(key, {
            polled,
            reviews: null,
            error: String(result.failure),
          });
        } else {
          reviewsCached.set(key, {
            polled,
            reviews: result.success,
            error: null,
          });
        }
      }),
      { discard: true },
    );

    const entries = yield* Effect.forEach(
      discovered,
      Effect.fn("Watch.publish")(function* (item) {
        const value = item.target
          ? cached.get(targetKey(item.target))
          : undefined;

        const error = item.error ?? value?.error ?? null;

        // Shown until a target's first result, so new workspaces never look unwatched.
        const ci = error
          ? config.indicatorTemplates.unavailable
          : item.target && !value
            ? config.indicatorTemplates.loading
            : ciIndicator(value?.status ?? null, config);

        const lintState = item.root
          ? yield* readLint(item.root).pipe(Effect.orElseSucceed(() => null))
          : null;

        const lintValue = config.lint.enabled
          ? lintIndicator(lintState, config.lint.templates)
          : null;

        const reviews = item.target
          ? reviewsCached.get(targetKey(item.target))
          : undefined;

        const reviewsValue = !config.reviews.enabled
          ? null
          : reviews?.error
            ? config.reviews.templates.unavailable
            : reviewsIndicator(
                reviews?.reviews ?? null,
                config.reviews.templates,
              );

        yield* metadata(item.id, {
          [ciToken]: ci,
          [lintToken]: lintValue,
          [reviewsToken]: reviewsValue,
        });

        return {
          workspace: item.id,
          root: item.root,
          target: item.target,
          ci: value?.status ?? null,
          ciPending: item.target !== null && !value && !error,
          ciError: error,
          ciIndicator: ci,
          lint: lintState,
          lintIndicator: lintValue,
          reviews: reviews?.reviews ?? null,
          reviewsPending:
            config.reviews.enabled && item.target !== null && !reviews,
          reviewsError: reviews?.error ?? null,
          reviewsIndicator: reviewsValue,
        };
      }),
      { concurrency: config.concurrency },
    );

    yield* writeStatus({
      updated: yield* Clock.currentTimeMillis,
      workspaces: entries,
    });

    const nextRefresh = Math.min(
      nextDiscovery,
      ...[...targets.keys()].map((key) => Math.max(pausedUntil, ciNext(key))),
      ...(config.reviews.enabled
        ? [...targets.keys()].map((key) =>
            Math.max(pausedUntil, reviewsNext(key)),
          )
        : []),
    );

    return Math.max(0, nextRefresh - (yield* Clock.currentTimeMillis));
  });

  return yield* Effect.gen(function* () {
    while (true) {
      const plugin = yield* registration.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      );

      if (!plugin.enabled) break;

      // `herdr plugin update` installs into a new directory and leaves this
      // watcher running the old one.
      if (plugin.managedRoot && plugin.managedRoot !== config.root)
        return plugin.managedRoot;

      const delay = yield* refresh.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      );

      yield* Queue.take(wake).pipe(
        Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
      );
    }

    yield* Effect.logInfo("Agent Checks watcher disabled");

    return null;
  }).pipe(
    Effect.raceFirst(waitForUpdate.pipe(Effect.as(config.root))),
    Effect.raceFirst(Deferred.await(compromised)),
  );
}).pipe(Effect.scoped);

export const watch = Effect.gen(function* () {
  const root = yield* runWatcher;

  if (root !== null && (yield* enabled)) {
    yield* Effect.logInfo("Agent Checks changed; starting a new watcher");
    yield* detachWatcher(root);
  }
});
