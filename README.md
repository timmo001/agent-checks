# Herdr Workflow Watch

GitHub workflow failure indicators for Herdr workspaces.

Watches the current branch of every open GitHub-backed workspace. `CI: !2` means
two workflow runs need attention; `CI: ?` means GitHub or repository state could
not be read. `CI: …` means status is loading; `CI: ↻` means workflows are queued
or running. Healthy workspaces have no indicator by default; enable `showSuccess`
to display `CI: ✓` when CI has passed. Ineligible workspaces have no indicator.
Enable `showIdle` for `CI: ○` when the latest pushed commit has no runs, and
`showPrevious` to show an older result with its commit distance in that case.
Both options default to `false`.

The watcher resolves the latest pushed commit from GitHub on each poll, including
all actors and events. Local unpushed commits do not hide its failures. Failed,
timed-out, startup-failed and action-required runs need attention; cancelled,
neutral and skipped runs do not. Reruns replace the previous attempt's result.

## Install

Requires Herdr 0.9.0 with socket protocol 22, Git, authenticated [GitHub CLI](https://cli.github.com/)
and [mise](https://mise.jdx.dev/) with the toolchain from `mise.toml` installed.
The plugin uses your existing `gh` authentication.

```sh
herdr plugin install timmo001/herdr-workflow-watch
herdr plugin action invoke timmo.workflow-watch.start
herdr plugin config-dir timmo.workflow-watch
```

For a local checkout, run `mise run install` and `mise run build`, then
`herdr plugin link .` and invoke the start action. Linking and reloading do not
run startup hooks. Rebuild before starting a new watcher after source changes.

Add the token to your existing Space rows and bind the picker in Herdr's config:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status", { token = "$timmo_workflow_watch", fg = "#f38ba8", dim = false, rules = [{ equals = "CI: ?", fg = "#f9e2af" }, { equals = "CI: …", fg = "#89b4fa" }, { equals = "CI: ↻", fg = "#f9e2af" }, { equals = "CI: ✓", fg = "#a6e3a1" }] }],
]

[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "timmo.workflow-watch.open"
description = "open workflow failures"
```

Reload with `herdr server reload-config`.
The indicator uses red for failures, blue for loading, amber for unavailable or
in-progress status and green for success. Herdr's sidebar colours must use hex values.

## Actions

Choose **Open all Actions in browser** in the first menu to open the repository's
`/actions` page, including when there are no failures.

Open `timmo.workflow-watch.open` to pick a failure and then:

- **Open failure in browser:** opens the selected run through `gh`.
- **Copy failure to clipboard:** copies the investigation draft through Herdr's
  terminal clipboard handling, including run details, failed jobs and logs.
  Large logs are saved to a local file referenced by the copied draft.
- **Paste draft into original agent:** inserts the failure at the cursor without
  clearing existing input or submitting it. Available only while that same agent
  is ready, with no approval or question prompt.
- **New agent in this checkout:** asks which agent to launch, creates a pane in
  the originating workspace and submits an investigation/fix prompt.
- **New agent in a new worktree:** asks which agent to launch, creates a unique
  fix branch from the selected pushed commit, opens its Herdr worktree and
  submits the prompt there.

Prompts include repository, branch, SHA, run and job IDs, attempt, URL and failed
steps. Large logs are saved to a local file referenced by the prompt. Terminal
control sequences are removed. A changed branch, run or agent requires reopening
the picker. New-agent prompts ask for uncommitted, unpushed fixes.

## Configuration and state

Create `config.json` in the directory printed by `herdr plugin config-dir`:

```json
{
  "pollSeconds": 30,
  "retrySeconds": 120,
  "timeoutSeconds": 30,
  "concurrency": 3,
  "showSuccess": true,
  "showIdle": true,
  "showPrevious": true,
  "indicatorTemplates": {
    "failure": "CI: !{count}",
    "unavailable": "CI: ?",
    "loading": "CI: …",
    "inProgress": "CI: ↻",
    "success": "CI: ✓",
    "idle": "CI: ○",
    "previous": "{status} ({distance})"
  },
  "launchers": [
    {
      "id": "custom-opencode",
      "label": "Custom OpenCode",
      "argv": ["/path/to/agent-launcher"],
      "agent": "opencode",
      "verifyCommand": ["/path/to/resolve-agent-executable"]
    },
    {
      "id": "pi",
      "label": "Pi",
      "argv": ["pi"],
      "agent": "pi"
    }
  ]
}
```

Idle GitHub targets are polled every `pollSeconds` (30 by default). Once a poll
finds unfinished workflows, that target switches to a 3-second interval, matching
`gh run watch`, until all runs complete. This includes queued and waiting runs.
Each interval starts after the previous poll finishes.

Poll starts are staggered, including on startup. The spacing is `pollSeconds`
divided by the number of unique repository/branch targets, or 3 seconds divided
by that count while any target has unfinished workflows. Idle targets still
wait their full interval. Workspaces sharing a target share its result. Polls
run one at a time; slow requests can extend the interval. Failed targets wait
at least `retrySeconds` before retrying. Workspace discovery still runs every
`pollSeconds`, with `concurrency` controlling discovery and indicator updates.
Staggering spreads request bursts; increase `pollSeconds` to reduce idle API use.

`showSuccess` defaults to `false`. Set it to `true` to show `CI: ✓` when at least
one run succeeds and all runs have completed with success, neutral or skipped
conclusions. Pending, cancelled and empty run lists do not show a checkmark.

`showIdle` and `showPrevious` also default to `false` and are independent:

- `showIdle` displays the idle template when the latest pushed commit has no runs.
- `showPrevious` falls back to the nearest earlier first-parent commit with runs
  found in the recent history window, only when the latest commit has none. Its
  result is labelled with the number of first-parent commits back, for example
  `CI: ✓ (2 commits ago)` or `CI: !1 (1 commit ago)`. Historical success is shown
  regardless of `showSuccess`; that option controls the current commit only.
- With both enabled, an older result replaces the idle indicator:
  `CI: ✓ (2 commits ago)` with the default templates. Idle appears only when
  there is no result to display.

History lookup checks the latest 100 branch runs against the latest 100 commits
reachable from the pushed tip, following first parents to count distance. Runs
outside that window or on commits removed from the branch are not used. Once a
commit is selected, all its runs are fetched, including rerun attempts. Previous
results are refreshed on each poll; unfinished previous runs use the 3-second
interval too. There are no history requests when `showPrevious` is disabled or
the latest commit already has runs.

Cancelled, neutral or skipped previous runs alone have no pass/fail indicator.
An eligible branch with no usable previous result shows only idle, if enabled.
Missing branches and ineligible workspaces still have no indicator; lookup
errors show unavailable. The picker labels the previous result separately from
current failures; **Open all Actions in browser** gives access to older runs.

Loading appears as soon as a workspace's branch is discovered and stays until its
first result is published. It also appears when a GitHub status request starts,
including refreshes, and is replaced when the poll results are published. New
workspaces and pane directory changes are picked up as soon as Herdr reports
them, and a new target's first poll skips the usual spacing between polls. Cached targets waiting for their
next poll or retry keep their existing status. Once loaded, unavailable status
takes priority over failures, then in-progress runs, then success. In-progress
includes all runs that have not completed, including queued and waiting runs,
and does not require `showSuccess`.

`indicatorTemplates` controls each indicator's text, including icons, spacing
and punctuation. Omitted entries use the defaults shown above. Templates must
be non-empty strings; every `{count}` in `failure` is replaced with the number
of runs needing attention. The `previous` template wraps an older result:
`{status}` is its failure, in-progress or success indicator and `{distance}` is
text such as `1 commit ago` or `2 commits ago`. Use `{count}` for just the commit
distance, for example `"{status} ↶{count}"` renders `✓ ↶2`. The other templates
are literal text.

For compact icons, use:

```json
{
  "showSuccess": true,
  "showIdle": true,
  "showPrevious": true,
  "indicatorTemplates": {
    "failure": "✗ {count}",
    "unavailable": "⚠",
    "loading": "…",
    "inProgress": "↻",
    "success": "✓",
    "idle": "○",
    "previous": "{status} ({distance})"
  }
}
```

Each template is published as one `$timmo_workflow_watch` token. Update the
sidebar colour rules' `equals` values to match your templates:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  [
    "branch",
    "git_status",
    { token = "$timmo_workflow_watch", fg = "#f38ba8", dim = false, rules = [
       { equals = "⚠", fg = "#f9e2af" },
       { equals = "…", fg = "#89b4fa" },
       { equals = "↻", fg = "#f9e2af" },
       { equals = "✓", fg = "#a6e3a1" },
       { equals = "○", fg = "#9399b2" },
    ] },
  ],
]
```

The whole indicator uses one colour: red for failures, blue for loading, amber
for unavailable or in-progress status and green for success. Templates can
contain text, symbols or both.
For current results, the success template requires `showSuccess: true`; older
successes require `showPrevious: true`. Combined historical indicators contain
additional text, so the exact-match colour rules above do not match them.

Omit `launchers` to use the built-in choices: OpenCode, Pi, Cursor Agent, Claude
Code, Codex, GitHub Copilot, OMP, Devin, Droid, Kimi, Kilo, Hermes, Qoder CLI,
Qwen, Mastra Code, Antigravity CLI and Grok. A configured array replaces the
defaults; `"launchers": []` disables new-agent actions.

Only launchers with an installed Herdr integration (`current` or `outdated`) and
an executable command appear. The agent does not need to be running already.
If none are available, both new-agent actions are disabled.

Each launcher has a unique `id`, a display `label`, an `argv` command and Herdr's
detected `agent` name. `argv[0]` can be an executable path or a command resolved
through Bash's login environment. Arguments are shell-quoted. `integration`
optionally overrides the integration name checked for availability; it defaults
to `agent` (Antigravity CLI uses integration `antigravity-cli` and agent `agy`).

For wrappers or multiple versions of the same agent, set `verifyCommand` to print
the single absolute executable path expected in the new pane's foreground argv.
The plugin checks that process before submitting work. All launches wait for
Herdr to detect the selected agent as ready. Changing or removing the selected
launcher requires reopening the picker.

Keep personal launcher settings in your own config, outside the plugin checkout.

Polls are bounded to 10-3600 seconds, retries to 30-3600 seconds, command timeouts
to 5-120 seconds and concurrency to 1-8. Retries are never faster than polling.
The watcher checks its installed bundle and configuration every two seconds.
After a change is stable across two checks, it stops polling, clears its
indicators and releases its lease before starting a replacement. Invalid config
edits are reported once per error; the existing watcher keeps running until the
file is corrected. Missing bundle files during an update defer the restart.

Watchers started before automatic reload was added need one manual restart:
disable the plugin, wait for the watcher lease to disappear, enable it and invoke
the start action. Later updates and configuration changes restart automatically.

Errors produce a short Herdr notification with the cause, a recovery command and
the log location. Fatal watcher errors include the start action to resume polling.
Workspace removal during a refresh is ignored until the next discovery pass.
Invalid configuration is reported before startup, including the setting that failed
validation. Full error details and stack traces stay in the Effect JSON logs;
fatal command errors exit with a non-zero status. If Herdr cannot receive the
notification, the delivery failure is logged too.

Workspace discovery and GitHub polling errors notify when first encountered or
when the error changes. A successful check resets this, so a later failure can
notify again. Repeated identical polling failures stay in the logs.

The plugin uses `HERDR_PLUGIN_CONFIG_DIR` for configuration and a socket-specific
directory under `HERDR_PLUGIN_STATE_DIR` for its lease, `watch.log`, `dispatch.log`,
`status.json` and saved failure output. There is one watcher per server socket;
workspaces sharing a repository and remote branch share GitHub requests. Startup
and workspace hooks start it idempotently. It exits after the plugin is disabled
or the session becomes unavailable, and indicators have a TTL.

Discovery prefers an attached worktree, then a pane directory in the workspace.
It watches the configured GitHub upstream, falling back to GitHub origin.
Detached checkouts, missing remote branches, non-Git directories and non-GitHub
remotes are skipped. Incomplete or failed GitHub requests show unavailable state.

Use `herdr plugin list --plugin timmo.workflow-watch --json` and
`herdr plugin log list --plugin timmo.workflow-watch` for registration and hook
diagnostics. The socket-specific logs contain watcher and action details.

## Integrations

Other tools can follow CI without polling GitHub themselves. Alongside the
display token, the watcher publishes `$timmo_workflow_watch_state`, a
machine-readable token for the current pushed commit only. It ignores the
display options and templates, and keeps its last value while a refresh loads:

```text
v1 failure <sha> <fingerprint>
v1 running <sha>
v1 success <sha>
v1 idle <sha>
v1 loading
v1 unavailable
```

`loading` means the branch was found but its first result has not arrived yet.
`idle` covers commits with no runs, or runs that finished without passing or
failing. The fingerprint is the first 8 hex characters of a SHA-256 over the
sorted `run-id:attempt` pairs needing attention, so it changes when a different
set of runs fails, including reruns. The token is cleared with the display token.

Subscribe to `workspace.metadata_updated` on the Herdr socket to receive it.
Herdr emits that event on every poll because the token TTL is refreshed, so
consumers should compare values and act only on changes.

To read the failures, run the `failures` command from the plugin root, which
`herdr plugin list --plugin timmo.workflow-watch --json` reports as `plugin_root`:

```sh
mise exec -- bun dist/index.js failures --cwd /path/to/checkout --json
```

It needs no Herdr environment and sends no Herdr notifications. It resolves the
checkout's pushed branch the same way as the watcher and prints the repository,
branch, pushed commit, runs needing attention with their failed jobs, steps and
logs, and the same investigation prompt as the picker. Compare `sha` with the
token before acting on it. Large logs are saved under `--log-dir`, by default
`$XDG_STATE_HOME/herdr-workflow-watch/logs`. Without `--json` it prints the prompt.

## Development

[mise](https://mise.jdx.dev/) pins Bun and Node and runs the project tasks.

Herdr requests use the Effect-native [`@timmo001/effect-herdr`](https://github.com/timmo001/effect-herdr).
Until it is published, the dependency is pinned to a GitHub commit. The Bun patch
in `patches/` exposes its TypeScript entrypoint for Bun to bundle. Dependency
overrides reference our direct Effect and platform dependencies, so updating
those versions also updates the SDK's dependencies without separate override
edits. The SDK's own manifest still pins an older beta. Keep the commit, patch
and lockfile together when updating it, and recheck protocol compatibility.

```sh
mise install
mise run install
mise run check
mise run build
bun dist/index.js --help
```

Use `mise run format` to format source and configuration.
CI installs dependencies with `bun install --frozen-lockfile`. Build, lint and
the CLI smoke check run independently. Build output is a Bun module in `dist/`.
Validation is lint, strict types, formatting, build, CLI help and local plugin
registration/startup. Interactive behaviour is tested manually.
