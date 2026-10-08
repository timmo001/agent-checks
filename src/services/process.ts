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

type RunOptions = {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export class Process extends Context.Service<
  Process,
  {
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      cwd?: string,
      options?: RunOptions,
    ) => Effect.Effect<Output, ProcessError>;
    readonly text: (
      command: string,
      args: ReadonlyArray<string>,
      cwd?: string,
      options?: RunOptions,
    ) => Effect.Effect<string, ProcessError>;
  }
>()("agent-checks/Process") {
  static readonly layer = Layer.effect(
    Process,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("Process.run")(
        function* (
          command: string,
          args: ReadonlyArray<string>,
          cwd?: string,
          options?: RunOptions,
        ) {
          return yield* Effect.gen(function* () {
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
                  ...options?.env,
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
          }).pipe(
            Effect.scoped,
            Effect.timeout(options?.timeoutMs ?? config.timeoutMs),
          );
        },
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
        options?: RunOptions,
      ) {
        const output = yield* run(command, args, cwd, options);

        if (output.code !== 0)
          return yield* new ProcessError({
            command,
            message: output.stderr || `${command} exited ${output.code}`,
          });

        return output.stdout;
      });

      return Process.of({ run, text });
    }),
  );
}

// The detached watcher outlives this scope and owns its own lease.
export const detachWatcher = Effect.fn("Process.detachWatcher")(
  function* () {
    const config = yield* RuntimeConfig;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(
        "sh",
        [
          "-c",
          'umask 077; log=$1; shift; exec "$@" >>"$log" 2>&1',
          "sh",
          path.join(config.state, "watch.log"),
          process.execPath,
          path.join(config.root, "dist/index.js"),
          "watch",
        ],
        {
          cwd: config.root,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          extendEnv: true,
        },
      ),
    );

    yield* child.unref.pipe(Effect.asVoid);
  },
  Effect.scoped,
  Effect.mapError(
    (cause) => new ProcessError({ command: "watch", message: String(cause) }),
  ),
);
