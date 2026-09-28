# Herdr Workflow Watch

## Project

- TypeScript with Effect v4, Bun and mise.
- `src/index.ts` owns the Effect CLI entrypoint and platform layers.
- Use lowercase filenames, with kebab-case for multiword names.
- `src/commands/` owns CLI workflows, `src/services/` owns external clients and
  subprocesses, and `src/actions/` owns selection data, agent handling and prompts.
- `dist/` is generated Bun-targeted module output and stays untracked.
- The package is private; distribution is through the GitHub repository.

## Commands

Use the versions pinned in `mise.toml` and Bun for dependency changes.
Keep `bun.lock` in sync with `package.json`.

```sh
mise run install
mise run format
mise run check
mise run build
bun dist/index.js --help
```

`check` runs local Oxlint, strict TypeScript checking and formatting checks.
CI runs `bun install --frozen-lockfile` first. Check and build tasks must not
install dependencies.

## Effect conventions

- Use Effect v4 APIs and keep `effect` and `@effect/platform-node` aligned.
- Use `effect/cli` for commands and provide platform services once at
  the CLI boundary.
- Use `Context.Service` and layers for dependencies, schemas at external JSON
  boundaries and `Schema.TaggedErrorClass` for domain failures.
- Use `Effect.fn` for effectful functions and scoped resources for subprocesses.
- Run effects only at the application boundary.
- Keep TypeScript strict and avoid unsafe assertions and `any`.
- Use the published `@timmo001/oxlint-rules/configs/recommended-effect` preset
  with its exact supported Oxlint peers.

## Validation

Validate with lint, type-checking, formatting, build and CLI help.
Do not add tests for the scaffold or automate UX testing; the owner tests
interactive behaviour. Keep the project small and add modules when behaviour
needs them.
