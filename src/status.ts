import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { RuntimeConfig } from "./config";
import { LintState, lintPrompt, readLint } from "./lint";
import { Status, Target } from "./services/github";

/** Written by the watcher; the Omarchy bar and panel follow it. */
const StatusFile = Schema.Struct({
  updated: Schema.Finite,
  workspaces: Schema.Array(
    Schema.Struct({
      workspace: Schema.String,
      root: Schema.NullOr(Schema.String),
      target: Schema.NullOr(Target),
      ci: Schema.NullOr(Status),
      ciPending: Schema.Boolean,
      ciError: Schema.NullOr(Schema.String),
      ciIndicator: Schema.NullOr(Schema.String),
      lint: Schema.NullOr(LintState),
      lintIndicator: Schema.NullOr(Schema.String),
    }),
  ),
});

export const statusFile = Effect.gen(function* () {
  return (yield* Path.Path).join((yield* RuntimeConfig).state, "status.json");
});

export const writeStatus = Effect.fn("Status.write")(function* (
  status: typeof StatusFile.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* statusFile;
  yield* fs.writeFileString(
    `${file}.tmp`,
    yield* Schema.encodeEffect(Schema.fromJsonString(StatusFile))(status),
    { mode: 0o600 },
  );
  yield* fs.rename(`${file}.tmp`, file);
});

/**
 * What the watcher last published for a checkout, with its lint state read
 * fresh. `watched` is false when no workspace has this checkout or the
 * watcher has not run.
 */
export const checkoutStatus = Effect.fn("Status.checkout")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* statusFile;

  const published = (yield* fs.exists(file))
    ? yield* Schema.decodeEffect(Schema.fromJsonString(StatusFile))(
        yield* fs.readFileString(file),
      ).pipe(Effect.option)
    : Option.none();

  const entry = Option.getOrUndefined(published)?.workspaces.find(
    (value) => value.root === root,
  );

  const lint = yield* readLint(root);

  return {
    root,
    watched: entry !== undefined,
    updated: Option.getOrUndefined(published)?.updated ?? null,
    target: entry?.target ?? null,
    ci: entry?.ci ?? null,
    ciPending: entry?.ciPending ?? false,
    ciError: entry?.ciError ?? null,
    lint,
    lintPrompt:
      lint?.result?.status === "failed" || lint?.result?.status === "timedOut"
        ? lintPrompt(root, lint.result)
        : null,
  };
});

export const CheckoutStatus = Schema.Struct({
  root: Schema.String,
  watched: Schema.Boolean,
  updated: Schema.NullOr(Schema.Finite),
  target: Schema.NullOr(Target),
  ci: Schema.NullOr(Status),
  ciPending: Schema.Boolean,
  ciError: Schema.NullOr(Schema.String),
  lint: Schema.NullOr(LintState),
  lintPrompt: Schema.NullOr(Schema.String),
});
