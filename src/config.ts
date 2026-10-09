import { createHash } from "node:crypto";
import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

export const pluginId = "timmo.agent-checks";

export const ciToken = "timmo_agent_checks_ci";

export const lintToken = "timmo_agent_checks_lint";

export function stateDirectory(root: string, socket: string) {
  return join(
    root,
    createHash("sha256").update(socket).digest("hex").slice(0, 20),
  );
}

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const Text = Schema.String.check(Schema.isMinLength(1));

export const Launcher = Schema.Struct({
  id: Text,
  label: Text,
  argv: Schema.NonEmptyArray(Text),
  agent: Text,
  integration: Schema.optionalKey(Text),
  verifyCommand: Schema.optionalKey(Schema.NonEmptyArray(Text)),
});

const defaultLaunchers: ReadonlyArray<typeof Launcher.Type> = [
  { id: "opencode", label: "OpenCode", agent: "opencode", argv: ["opencode"] },
  { id: "pi", label: "Pi", agent: "pi", argv: ["pi"] },
  {
    id: "cursor",
    label: "Cursor Agent",
    agent: "cursor",
    argv: ["cursor-agent"],
  },
  { id: "claude", label: "Claude Code", agent: "claude", argv: ["claude"] },
  { id: "codex", label: "Codex", agent: "codex", argv: ["codex"] },
  {
    id: "copilot",
    label: "GitHub Copilot",
    agent: "copilot",
    argv: ["copilot"],
  },
  { id: "omp", label: "OMP", agent: "omp", argv: ["omp"] },
  { id: "devin", label: "Devin", agent: "devin", argv: ["devin"] },
  { id: "droid", label: "Droid", agent: "droid", argv: ["droid"] },
  { id: "kimi", label: "Kimi", agent: "kimi", argv: ["kimi"] },
  { id: "kilo", label: "Kilo", agent: "kilo", argv: ["kilo"] },
  { id: "hermes", label: "Hermes", agent: "hermes", argv: ["hermes"] },
  { id: "qodercli", label: "Qoder CLI", agent: "qodercli", argv: ["qodercli"] },
  { id: "qwen", label: "Qwen", agent: "qwen", argv: ["qwen"] },
  {
    id: "mastracode",
    label: "Mastra Code",
    agent: "mastracode",
    argv: ["mastracode"],
  },
  {
    id: "antigravity-cli",
    label: "Antigravity CLI",
    agent: "agy",
    integration: "antigravity-cli",
    argv: ["antigravity-cli"],
  },
  { id: "grok", label: "Grok", agent: "grok", argv: ["grok"] },
];

const IndicatorTemplates = Schema.Struct({
  failure: Schema.optionalKey(Text),
  unavailable: Schema.optionalKey(Text),
  loading: Schema.optionalKey(Text),
  inProgress: Schema.optionalKey(Text),
  success: Schema.optionalKey(Text),
  idle: Schema.optionalKey(Text),
  previous: Schema.optionalKey(Text),
});

const LintTemplates = Schema.Struct({
  failure: Schema.optionalKey(Text),
  timedOut: Schema.optionalKey(Text),
  running: Schema.optionalKey(Text),
  clean: Schema.optionalKey(Text),
  unavailable: Schema.optionalKey(Text),
});

const LintSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  command: Schema.optionalKey(Schema.NonEmptyArray(Text)),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
  templates: Schema.optionalKey(LintTemplates),
});

const Settings = Schema.Struct({
  pollSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
  retrySeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 120 })),
  ),
  concurrency: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  ),
  showSuccess: Schema.optionalKey(Schema.Boolean),
  showIdle: Schema.optionalKey(Schema.Boolean),
  showPrevious: Schema.optionalKey(Schema.Boolean),
  indicatorTemplates: Schema.optionalKey(IndicatorTemplates),
  launchers: Schema.optionalKey(Schema.Array(Launcher)),
  lint: Schema.optionalKey(LintSettings),
});

// The Omarchy panel runs commands outside Herdr with only the socket set, so
// the plugin directories fall back to Herdr's own layout.
const Environment = Schema.Struct({
  HERDR_SOCKET_PATH: Text,
  HERDR_PLUGIN_ROOT: Schema.optionalKey(Text),
  HERDR_PLUGIN_CONFIG_DIR: Schema.optionalKey(Text),
  HERDR_PLUGIN_STATE_DIR: Schema.optionalKey(Text),
  HOME: Text,
  XDG_CONFIG_HOME: Schema.optionalKey(Text),
  XDG_STATE_HOME: Schema.optionalKey(Text),
});

export const loadSettings = Effect.fn("Config.loadSettings")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;

  const contents = (yield* fs.exists(file))
    ? yield* fs.readFileString(file)
    : "{}";

  const settings = yield* Schema.decodeEffect(Schema.fromJsonString(Settings))(
    contents,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `Invalid config.json: ${cause.message}. Fix the file and try again.`,
          cause,
        }),
    ),
  );

  const launchers = settings.launchers ?? defaultLaunchers;

  if (
    new Set(launchers.map((launcher) => launcher.id)).size !== launchers.length
  )
    return yield* new ConfigError({
      message:
        "Launcher IDs in config.json must be unique. Rename the duplicates and try again.",
    });

  return {
    settings,
    launchers,
    revision: createHash("sha256").update(contents).digest("hex"),
  };
});

export class RuntimeConfig extends Context.Service<
  RuntimeConfig,
  {
    readonly socket: string;
    readonly root: string;
    readonly state: string;
    readonly settingsFile: string;
    readonly settingsRevision: string;
    readonly pollMs: number;
    readonly retryMs: number;
    readonly timeoutMs: number;
    readonly concurrency: number;
    readonly showSuccess: boolean;
    readonly showIdle: boolean;
    readonly showPrevious: boolean;
    readonly indicatorTemplates: Required<typeof IndicatorTemplates.Type>;
    readonly launchers: ReadonlyArray<typeof Launcher.Type>;
    readonly lint: {
      readonly enabled: boolean;
      readonly command: readonly [string, ...Array<string>];
      readonly timeoutMs: number;
      readonly templates: Required<typeof LintTemplates.Type>;
    };
  }
>()("agent-checks/Config") {
  static readonly layer = Layer.effect(
    RuntimeConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const env = yield* Schema.decodeUnknownEffect(Environment)(
        process.env,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              message:
                "Agent Checks needs HERDR_SOCKET_PATH. Run it through the Herdr plugin or the Omarchy panel.",
              cause,
            }),
        ),
      );

      const configDirectory =
        env.HERDR_PLUGIN_CONFIG_DIR ??
        path.join(
          env.XDG_CONFIG_HOME ?? path.join(env.HOME, ".config"),
          "herdr",
          "plugins",
          "config",
          pluginId,
        );

      const file = path.join(configDirectory, "config.json");
      const { settings, launchers, revision } = yield* loadSettings(file);

      const state = stateDirectory(
        env.HERDR_PLUGIN_STATE_DIR ??
          path.join(
            env.XDG_STATE_HOME ?? path.join(env.HOME, ".local", "state"),
            "herdr",
            "plugins",
            pluginId,
          ),
        env.HERDR_SOCKET_PATH,
      );

      yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });

      const templates = settings.indicatorTemplates;
      const lintTemplates = settings.lint?.templates;

      return RuntimeConfig.of({
        socket: env.HERDR_SOCKET_PATH,
        root: env.HERDR_PLUGIN_ROOT ?? path.resolve(import.meta.dirname, ".."),
        state,
        settingsFile: file,
        settingsRevision: revision,
        pollMs: (settings.pollSeconds ?? 30) * 1000,
        retryMs:
          Math.max(settings.retrySeconds ?? 120, settings.pollSeconds ?? 30) *
          1000,
        timeoutMs: (settings.timeoutSeconds ?? 30) * 1000,
        concurrency: settings.concurrency ?? 3,
        showSuccess: settings.showSuccess ?? false,
        showIdle: settings.showIdle ?? false,
        showPrevious: settings.showPrevious ?? false,
        indicatorTemplates: {
          failure: templates?.failure ?? "\uF52E\u2009!{count}",
          unavailable: templates?.unavailable ?? "\uF52E\u2009⚠",
          loading: templates?.loading ?? "\uF52E\u2009…",
          inProgress: templates?.inProgress ?? "\uF52E\u2009↻",
          success: templates?.success ?? "\uF52E\u2009✓",
          idle: templates?.idle ?? "\uF52E\u2009○",
          previous: templates?.previous ?? "{status} ↶{count}",
        },
        launchers,
        lint: {
          enabled: settings.lint?.enabled ?? true,
          command: settings.lint?.command ?? ["dot", "agent-lint", "--json"],
          timeoutMs: (settings.lint?.timeoutSeconds ?? 600) * 1000,
          templates: {
            failure: lintTemplates?.failure ?? "\uF4B1\u2009!{count}",
            timedOut: lintTemplates?.timedOut ?? "\uF4B1\u2009⏱",
            running: lintTemplates?.running ?? "\uF4B1\u2009↻",
            clean: lintTemplates?.clean ?? "\uF4B1\u2009✓",
            unavailable: lintTemplates?.unavailable ?? "\uF4B1\u2009⚠",
          },
        },
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ConfigError
          ? cause
          : new ConfigError({
              message:
                "Could not load Agent Checks configuration. Check the plugin config and state directories.",
              cause,
            }),
      ),
    ),
  );
}
