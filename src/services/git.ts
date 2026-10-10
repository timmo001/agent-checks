import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Process } from "./process";

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
}) {}

// Hash of the empty tree, used as the base before a repository's first commit.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Adapted from dotfiles' dot/src/lib/git.ts gitOutput.
const git = Effect.fn("Git.output")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const output = yield* (yield* Process)
    .run("git", ["-c", "core.quotePath=false", ...args], cwd)
    .pipe(
      Effect.mapError(
        (cause) =>
          new GitError({ message: `git ${args.join(" ")}: ${cause.message}` }),
      ),
    );

  if (output.code !== 0)
    return yield* new GitError({
      message: `git ${args.join(" ")} failed with exit ${output.code}${output.stderr ? `: ${output.stderr}` : ""}`,
    });

  return output.stdout;
});

export const gitRoot = Effect.fn("Git.root")(function* (cwd: string) {
  const output = yield* (yield* Process)
    .run("git", ["rev-parse", "--show-toplevel"], cwd)
    .pipe(Effect.mapError((cause) => new GitError({ message: cause.message })));

  if (output.code === 0) return output.stdout;

  if (output.stderr.includes("not a git repository")) return null;

  return yield* new GitError({ message: output.stderr });
});

/**
 * Identify the working tree `dot agent lint` would lint, without touching the
 * index or the object database: HEAD plus the content hash of every changed
 * and untracked path, read the same way as dot's changedFiles.
 */
export const workingTreeFingerprint = Effect.fn("Git.workingTreeFingerprint")(
  function* (root: string, salt: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const head = yield* git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD",
    ]).pipe(Effect.orElseSucceed(() => emptyTree));

    const [tracked, untracked] = yield* Effect.all([
      git(root, ["diff", "--name-only", "-z", head]),
      git(root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--full-name",
        "-z",
      ]),
    ]);

    const paths = [
      ...new Set([...tracked.split("\0"), ...untracked.split("\0")]),
    ]
      .filter(Boolean)
      .toSorted();

    // Deleted paths and submodule pointers have no file content to hash.
    const files = yield* Effect.filter(paths, (file) =>
      fs.stat(path.join(root, file)).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      ),
    );

    // hash-object without -w only reads the files; nothing is written to .git.
    const hashes = yield* Effect.forEach(
      Array.from({ length: Math.ceil(files.length / 500) }, (_, index) =>
        files.slice(index * 500, index * 500 + 500),
      ),
      (batch) =>
        git(root, ["hash-object", "--no-filters", "--", ...batch]).pipe(
          Effect.map((output) => output.split("\n")),
        ),
    );

    const flat = hashes.flat();
    const contents = new Map(files.map((file, index) => [file, flat[index]]));

    return createHash("sha256")
      .update(
        [
          salt,
          head,
          ...paths.map((file) => `${file}\0${contents.get(file) ?? "-"}`),
        ].join("\n"),
      )
      .digest("hex");
  },
);
