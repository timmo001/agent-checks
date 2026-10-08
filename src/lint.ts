import { createHash } from "node:crypto";
import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import { check, lock } from "proper-lockfile";
import { RuntimeConfig } from "./config";
import { workingTreeFingerprint } from "./services/git";
import { Process } from "./services/process";
import { plain } from "./text";

const LintCheck = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["passed", "skipped", "failed", "timedOut"]),
  command: Schema.String,
  output: Schema.String,
  durationMs: Schema.NullOr(Schema.Finite),
});

type LintCheck = typeof LintCheck.Type;

export const failing = (checks: readonly LintCheck[]) =>
  checks.filter(
    (value) => value.status === "failed" || value.status === "timedOut",
  );

const LintResult = Schema.Struct({
  fingerprint: Schema.String,
  finished: Schema.Finite,
  status: Schema.Literals([
    "clean",
    "failed",
    "timedOut",
    "unconfigured",
    "error",
  ]),
  files: Schema.Int,
  checks: Schema.Array(LintCheck),
  message: Schema.String,
  error: Schema.NullOr(Schema.String),
});

type LintResult = typeof LintResult.Type;

export const LintState = Schema.Struct({
  root: Schema.String,
  fingerprint: Schema.String,
  running: Schema.Boolean,
  started: Schema.NullOr(Schema.Finite),
  result: Schema.NullOr(LintResult),
});

export type LintState = typeof LintState.Type;

// Report printed by `dot agent-lint --json`.
const Report = Schema.Struct({
  configured: Schema.Boolean,
  files: Schema.Array(Schema.String),
  results: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["passed", "failed", "timed-out", "skipped"]),
      output: Schema.optionalKey(Schema.String),
      command: Schema.optionalKey(Schema.Array(Schema.String)),
      durationMs: Schema.optionalKey(Schema.Finite),
    }),
  ),
  message: Schema.optionalKey(Schema.String),
});

const defaultMessage =
  "Please fix these, then run all relevant checks and keep going until they pass.";

const checkStatus = {
  passed: "passed",
  failed: "failed",
  "timed-out": "timedOut",
  skipped: "skipped",
} as const;

const shellQuote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

export const lintDirectory = Effect.gen(function* () {
  const config = yield* RuntimeConfig;

  return (yield* Path.Path).join(config.state, "lint");
});

const stateFile = Effect.fn("Lint.stateFile")(function* (root: string) {
  const path = yield* Path.Path;

  return path.join(
    yield* lintDirectory,
    `${createHash("sha256").update(root).digest("hex").slice(0, 20)}.json`,
  );
});

const write = Effect.fn("Lint.write")(function* (state: LintState) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* stateFile(state.root);

  yield* fs.makeDirectory(yield* lintDirectory, {
    recursive: true,
    mode: 0o700,
  });
  yield* fs.writeFileString(
    `${file}.tmp`,
    yield* Schema.encodeEffect(Schema.fromJsonString(LintState))(state),
    { mode: 0o600 },
  );
  yield* fs.rename(`${file}.tmp`, file);
});

/** The stored state for a checkout. A run whose process died reads as finished. */
export const readLint = Effect.fn("Lint.read")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* stateFile(root);

  if (!(yield* fs.exists(file))) return null;

  const state = yield* Schema.decodeEffect(Schema.fromJsonString(LintState))(
    yield* fs.readFileString(file),
  ).pipe(Effect.option);

  if (Option.isNone(state)) return null;

  if (!state.value.running) return state.value;

  const held = yield* Effect.tryPromise(() =>
    check(file, { realpath: false, stale: 30_000 }),
  ).pipe(Effect.orElseSucceed(() => false));

  return held ? state.value : { ...state.value, running: false };
});

export function lintPrompt(result: LintResult) {
  return plain(
    [
      ...failing(result.checks).map((value) =>
        value.status === "timedOut"
          ? `$ ${value.command}\n(timed out)`
          : `$ ${value.command}\n${value.output}`,
      ),
      result.message,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

const resultStatus = (
  configured: boolean,
  checks: readonly LintCheck[],
): LintResult["status"] => {
  const failed = failing(checks);

  return !configured
    ? "unconfigured"
    : failed.some((value) => value.status === "failed")
      ? "failed"
      : failed.length
        ? "timedOut"
        : "clean";
};

/** Which checks to run: every file instead of changed ones, and named checks only. */
export interface LintScope {
  readonly all?: boolean;
  readonly only?: readonly string[];
}

const runCommand = Effect.fn("Lint.runCommand")(function* (
  root: string,
  scope: LintScope,
) {
  const config = yield* RuntimeConfig;
  const [command, ...args] = config.lint.command;

  const output = yield* (yield* Process).run(
    command,
    [
      ...args,
      ...(scope.all ? ["--all"] : []),
      ...(scope.only ?? []).flatMap((name) => ["--only", name]),
    ],
    root,
    { timeoutMs: config.lint.timeoutMs },
  );

  // agent-lint exits 1 when a check fails, with the report still on stdout.
  const report = yield* Schema.decodeEffect(Schema.fromJsonString(Report))(
    output.stdout,
  ).pipe(Effect.option);

  if (Option.isNone(report))
    return {
      status: "error",
      files: 0,
      checks: [],
      message: defaultMessage,
      error: plain(
        output.stderr || output.stdout || `${command} exited ${output.code}`,
      ).slice(-2_000),
    } as const;

  const checks = report.value.results.map((result): LintCheck => ({
    name: result.name,
    status: checkStatus[result.status],
    command: (result.command ?? [result.name]).map(shellQuote).join(" "),
    output: plain(result.output ?? "").trimEnd(),
    durationMs: result.durationMs ?? null,
  }));

  return {
    status: resultStatus(report.value.configured, checks),
    files: report.value.files.length,
    checks,
    message: report.value.message ?? defaultMessage,
    error: null,
  } as const;
});

/**
 * Put the checks from a run of named checks in place of the previous ones,
 * keeping the rest of the previous result.
 */
const mergeChecks = (
  previous: LintResult | null | undefined,
  outcome: Omit<LintResult, "fingerprint" | "finished">,
) => {
  if (!previous || outcome.status === "error") return outcome;

  const checks = previous.checks.map(
    (value) => outcome.checks.find((next) => next.name === value.name) ?? value,
  );

  const added = outcome.checks.filter(
    (next) => !previous.checks.some((value) => value.name === next.name),
  );

  const merged = [...checks, ...added];

  return {
    ...outcome,
    status: resultStatus(outcome.status !== "unconfigured", merged),
    checks: merged,
  };
};

/**
 * Lint a checkout unless its working tree matches the last result. A scope
 * always runs; checks named in `only` replace their previous results. Only
 * one run per checkout happens at a time; a call that finds one running
 * returns without waiting.
 */
export const lintCheck = Effect.fn("Lint.check")(function* (
  root: string,
  options: { readonly force?: boolean } & LintScope = {},
) {
  const config = yield* RuntimeConfig;
  const fs = yield* FileSystem.FileSystem;
  const file = yield* stateFile(root);
  const previous = yield* readLint(root);
  const partial = (options.only?.length ?? 0) > 0;

  if (previous?.running) return previous;

  const fingerprint = yield* workingTreeFingerprint(
    root,
    config.lint.command.join("\0"),
  );

  if (
    !options.force &&
    !options.all &&
    !partial &&
    previous?.result &&
    previous.result.fingerprint === fingerprint
  )
    return previous;

  yield* fs.makeDirectory(yield* lintDirectory, {
    recursive: true,
    mode: 0o700,
  });

  // The lock is on the state file, so it must exist first.
  if (!(yield* fs.exists(file)))
    yield* write({
      root,
      fingerprint,
      running: false,
      started: null,
      result: null,
    });

  const release = yield* Effect.tryPromise(() =>
    lock(file, { realpath: false, stale: 30_000, update: 10_000 }),
  ).pipe(Effect.option);

  // Another process holds the lock, so it is running there.
  if (Option.isNone(release))
    return (
      (yield* readLint(root)) ?? {
        root,
        fingerprint,
        running: true,
        started: null,
        result: previous?.result ?? null,
      }
    );

  return yield* Effect.gen(function* () {
    yield* write({
      root,
      fingerprint,
      running: true,
      started: yield* Clock.currentTimeMillis,
      result: previous?.result ?? null,
    });

    const outcome = yield* runCommand(root, options).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          status: "error",
          files: 0,
          checks: [],
          message: defaultMessage,
          error: cause.message,
        } as const),
      ),
    );

    const state: LintState = {
      root,
      fingerprint,
      running: false,
      started: null,
      // A partial run keeps the previous fingerprint, so the other checks
      // still rerun once the working tree changes.
      result: {
        ...(partial ? mergeChecks(previous?.result, outcome) : outcome),
        fingerprint: (partial && previous?.result?.fingerprint) || fingerprint,
        finished: yield* Clock.currentTimeMillis,
      },
    };

    yield* write(state);

    return state;
  }).pipe(
    Effect.ensuring(Effect.promise(() => release.value()).pipe(Effect.ignore)),
    Effect.onInterrupt(() =>
      write({
        root,
        fingerprint,
        running: false,
        started: null,
        result: previous?.result ?? null,
      }).pipe(Effect.ignore),
    ),
  );
});
