import { HerdrSdk, type WorkspaceId } from "@timmo001/effect-herdr";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  FileSystem,
  Option,
  Path,
  Queue,
  Result,
  Schedule,
  Stream,
} from "effect";
import { check, lock } from "proper-lockfile";
import { RuntimeConfig, stateToken, token } from "../config";
import { reportError } from "../errors";
import { indicator, state } from "../indicator";
import {
  GitHub,
  targetKey,
  type Status,
  type Target,
} from "../services/github";
import { checkout, cleared, enabled, metadata } from "../services/herdr";
import { ProcessError, detach } from "../services/process";
import { waitForUpdate } from "../services/reload";

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

  if (!held) yield* detach("watch");
});

type CachedTarget = {
  readonly next: number;
  readonly status: Status | null;
  readonly error: string | null;
};

const activePollMs = 3_000;

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

  if (!lease) return false;
  yield* Effect.logInfo("Workflow watcher started");
  const workspaces = new Map<WorkspaceId, string>();
  const discoveryErrors = new Map<WorkspaceId, string>();
  const cached = new Map<string, CachedTarget>();

  // Shown until a target's first result, so new workspaces never look unwatched.
  const pending = {
    [token]: config.indicatorTemplates.loading,
    [stateToken]: "v1 loading",
  };

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...workspaces.keys()],
      (id) =>
        metadata(id, cleared).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Could not clear workspace indicator", cause),
          ),
        ),
      { concurrency: config.concurrency, discard: true },
    ),
  );

  const discover = Effect.gen(function* () {
    const snapshot = yield* herdr.session.snapshot();

    const discovered = yield* Effect.forEach(
      snapshot.workspaces,
      Effect.fn("Watch.discover")(function* (workspace) {
        const cwd = checkout(workspace, snapshot.panes);

        const result = cwd
          ? yield* github.discover(cwd).pipe(Effect.result)
          : null;

        const target = result?._tag === "Success" ? result.success : null;

        const error =
          result?._tag === "Failure" ? String(result.failure) : null;

        if (error && result?._tag === "Failure") {
          if (discoveryErrors.get(workspace.id) !== error)
            yield* reportError(
              Cause.fail(result.failure),
              "Could not inspect workspace",
            ).pipe(Effect.annotateLogs({ workspace: workspace.id }));
          discoveryErrors.set(workspace.id, error);
        } else {
          discoveryErrors.delete(workspace.id);
        }

        const key = target ? targetKey(target) : "";

        if (workspaces.get(workspace.id) !== key)
          yield* metadata(
            workspace.id,
            target && !cached.has(key) ? pending : cleared,
          );
        workspaces.set(workspace.id, key);

        return { id: workspace.id, target, error };
      }),
      { concurrency: config.concurrency },
    );

    const targets = new Map<string, Target>();

    for (const item of discovered)
      if (item.target) targets.set(targetKey(item.target), item.target);

    for (const key of cached.keys()) if (!targets.has(key)) cached.delete(key);

    for (const id of workspaces.keys())
      if (!snapshot.workspaces.some((workspace) => workspace.id === id)) {
        workspaces.delete(id);
        discoveryErrors.delete(id);
      }

    return { discovered, targets };
  });

  let discovery: Effect.Success<typeof discover> | undefined;
  let nextDiscovery = 0;
  let nextPoll = 0;
  const wake = yield* Queue.sliding<void>(1);
  const paneCwds = new Map<string, string | undefined>();

  // New workspaces and directory changes would otherwise wait for the next
  // periodic discovery.
  yield* herdr.events
    .subscribe([
      { type: "workspace.created" },
      { type: "workspace.closed" },
      { type: "worktree.opened" },
      { type: "pane.created" },
      { type: "pane.updated" },
      { type: "pane.closed" },
    ])
    .pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "pane.updated") {
            // Title changes also emit this event, so only a new cwd counts.
            const cwd = Option.getOrUndefined(event.pane.cwd);

            if (paneCwds.get(event.pane.id) === cwd) return;
            paneCwds.set(event.pane.id, cwd);
          } else if (event.type === "pane.created") {
            paneCwds.set(event.pane.id, Option.getOrUndefined(event.pane.cwd));
          } else if (event.type === "pane.closed") {
            paneCwds.delete(event.paneId);

            return;
          }

          nextDiscovery = 0;
          yield* Queue.offer(wake, undefined);
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Workspace event stream unavailable", cause),
      ),
      Effect.andThen(Effect.sleep(10_000)),
      Effect.forever,
      Effect.forkScoped,
    );

  const refresh = Effect.gen(function* () {
    if (!discovery || (yield* Clock.currentTimeMillis) >= nextDiscovery) {
      discovery = yield* discover;
      nextDiscovery = (yield* Clock.currentTimeMillis) + config.pollMs;
    }

    const { discovered, targets } = discovery;
    yield* Effect.forEach(
      [...targets]
        .sort(
          ([left], [right]) =>
            (cached.get(left)?.next ?? 0) - (cached.get(right)?.next ?? 0),
        )
        .slice(0, 1),
      Effect.fn("Watch.poll")(function* ([key, target]) {
        const now = yield* Clock.currentTimeMillis;
        const previous = cached.get(key);

        // Targets without a first result skip the stagger so new workspaces show promptly.
        if (previous && (now < nextPoll || now < previous.next)) return;
        yield* Effect.forEach(
          discovered.filter(
            (item) => item.target && targetKey(item.target) === key,
          ),
          (item) =>
            metadata(
              item.id,
              previous
                ? { [token]: config.indicatorTemplates.loading }
                : pending,
            ),
          { concurrency: config.concurrency, discard: true },
        );
        const started = yield* Clock.currentTimeMillis;

        const result = yield* github
          .status(target, config.showPrevious)
          .pipe(Effect.result);

        const finished = yield* Clock.currentTimeMillis;

        if (Result.isFailure(result)) {
          if (previous?.error !== String(result.failure))
            yield* reportError(
              Cause.fail(result.failure),
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
              result.failure,
            );
          cached.set(key, {
            next: finished + config.retryMs,
            status: null,
            error: String(result.failure),
          });
        } else {
          cached.set(key, {
            next:
              finished +
              (unfinished(result.success) ? activePollMs : config.pollMs),
            status: result.success,
            error: null,
          });
        }

        nextPoll =
          started +
          ([...cached.values()].some((value) => unfinished(value.status))
            ? activePollMs
            : config.pollMs) /
            targets.size;
      }),
      { concurrency: config.concurrency, discard: true },
    );

    const entries = yield* Effect.forEach(
      discovered,
      Effect.fn("Watch.publish")(function* (item) {
        const value = item.target
          ? cached.get(targetKey(item.target))
          : undefined;

        const error = item.error ?? value?.error ?? null;

        yield* metadata(
          item.id,
          !error && item.target && !value
            ? pending
            : {
                [token]: error
                  ? config.indicatorTemplates.unavailable
                  : indicator(value?.status ?? null, config),
                [stateToken]: state(value?.status ?? null, error),
              },
        );

        return {
          workspace: item.id,
          target: item.target,
          status: value?.status ?? null,
          error,
        };
      }),
      { concurrency: config.concurrency },
    );

    const file = path.join(config.state, "status.json");
    yield* fs.writeFileString(
      `${file}.tmp`,
      JSON.stringify(
        { updated: yield* Clock.currentTimeMillis, workspaces: entries },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    yield* fs.rename(`${file}.tmp`, file);

    const nextRefresh = Math.min(
      nextDiscovery,
      ...[...targets.keys()].map((key) => {
        const next = cached.get(key)?.next;

        return next === undefined ? 0 : Math.max(nextPoll, next);
      }),
    );

    return Math.max(0, nextRefresh - (yield* Clock.currentTimeMillis));
  });

  return yield* Effect.gen(function* () {
    while (
      yield* enabled.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      )
    ) {
      const delay = yield* refresh.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      );

      yield* Queue.take(wake).pipe(
        Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
      );
    }

    yield* Effect.logInfo("Workflow watcher disabled");

    return false;
  }).pipe(
    Effect.raceFirst(waitForUpdate.pipe(Effect.as(true))),
    Effect.raceFirst(Deferred.await(compromised)),
  );
}).pipe(Effect.scoped);

export const watch = Effect.gen(function* () {
  const restart = yield* runWatcher;

  if (restart && (yield* enabled)) {
    yield* Effect.logInfo("Workflow Watch changed; starting a new watcher");
    yield* detach("watch");
  }
});
