import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { Context, Effect, Layer, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { RuntimeConfig } from "../config";

export class ProcessError extends Schema.TaggedError<ProcessError>()(
  "ProcessError",
  {
    command: Schema.String,
    message: Schema.String,
  },
) {}

type Output = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

export class Process extends Context.Service<
  Process,
  {
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      cwd?: string,
    ) => Effect.Effect<Output, ProcessError>;
    readonly text: (
      command: string,
      args: ReadonlyArray<string>,
      cwd?: string,
    ) => Effect.Effect<string, ProcessError>;
    readonly detach: (
      mode: string,
      env?: Record<string, string>,
    ) => Effect.Effect<void, ProcessError>;
  }
>()("herdr-workflow-watch/Process") {
  static readonly layer = Layer.effect(
    Process,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("Process.run")(
        function* (command: string, args: ReadonlyArray<string>, cwd?: string) {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env: {
                GH_PROMPT_DISABLED: "1",
                GIT_TERMINAL_PROMPT: "0",
                NO_COLOR: "1",
              },
              extendEnv: true,
            }),
          );

          const [stdout, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );

          return {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: Number(code),
          };
        },
        Effect.scoped,
        Effect.timeout(config.timeoutMs),
        (effect, command) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new ProcessError({ command, message: String(cause) }),
            ),
          ),
      );

      const text = Effect.fn("Process.text")(function* (
        command: string,
        args: ReadonlyArray<string>,
        cwd?: string,
      ) {
        const output = yield* run(command, args, cwd);

        if (output.code !== 0)
          return yield* new ProcessError({
            command,
            message: output.stderr || `${command} exited ${output.code}`,
          });

        return output.stdout;
      });

      // Only the detached entrypoints outlive this scope; the watcher owns its lease.
      const detach = Effect.fn("Process.detach")(
        function* (mode: string, env: Record<string, string> = {}) {
          const fd = yield* Effect.acquireRelease(
            Effect.try(() =>
              openSync(path.join(config.state, `${mode}.log`), "a", 0o600),
            ),
            (file) => Effect.sync(() => closeSync(file)),
          );

          yield* Effect.callback<void, ProcessError>((resume) => {
            const child = spawn(
              process.execPath,
              [path.join(config.root, "dist/index.js"), mode],
              {
                cwd: config.root,
                detached: true,
                stdio: ["ignore", fd, fd],
                env: { ...process.env, ...env },
              },
            );

            child.once("error", (cause) =>
              resume(
                Effect.fail(
                  new ProcessError({ command: mode, message: String(cause) }),
                ),
              ),
            );
            child.once("spawn", () => {
              child.unref();
              resume(Effect.void);
            });
          });
        },
        Effect.scoped,
        (effect, mode) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ProcessError({ command: mode, message: String(cause) }),
            ),
          ),
      );

      return Process.of({ run, text, detach });
    }),
  );
}
