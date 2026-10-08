import {
  Cause,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Result,
} from "effect";
import { RuntimeConfig, loadSettings } from "../config";
import { reportError } from "../errors";

export const waitForUpdate = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entrypoint = path.join(config.root, "dist/index.js");

  const revision = Effect.gen(function* () {
    const info = yield* fs.stat(entrypoint);

    return `${Option.getOrUndefined(info.mtime)?.getTime()}:${info.size}`;
  });

  const initial = `${yield* revision}:${config.settingsRevision}`;
  let pending: string | undefined;
  let lastError: string | undefined;

  while (true) {
    yield* Effect.sleep(2_000);

    const result = yield* Effect.gen(function* () {
      const build = yield* revision;
      const settings = yield* loadSettings(config.settingsFile);

      return `${build}:${settings.revision}`;
    }).pipe(Effect.result);

    if (Result.isFailure(result)) {
      pending = undefined;

      if (
        Predicate.isTagged(result.failure, "PlatformError") &&
        Predicate.isTagged(result.failure.reason, "NotFound")
      )
        continue;
      const message = String(result.failure);

      if (lastError !== message)
        yield* reportError(
          Cause.fail(result.failure),
          "Agent Checks update deferred",
        );
      lastError = message;
      continue;
    }

    lastError = undefined;

    if (result.success === initial) {
      pending = undefined;
      continue;
    }

    if (result.success === pending) return;
    pending = result.success;
  }
});
