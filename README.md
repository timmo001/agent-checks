# Agent Checks

CI, lint and pull request review status for Herdr workspaces, with an Omarchy
panel to read and act on it.

One repository holds three parts:

- An Effect CLI in `src/`, built to `dist/`.
- A Herdr plugin (`herdr-plugin.toml`) that runs the watcher, publishes sidebar
  tokens and binds the actions.
- An Omarchy shell plugin (`manifest.json`, `Service.qml`, `BarWidget.qml`,
  `Panel.qml`) with a bar widget and a panel for CI, lint and reviews.

Nothing is published. mise and Bun build and run everything from the checkout.

## Status

The watcher follows the current branch of every open GitHub-backed workspace and
lints each workspace's checkout. A workspace's checkout is the one its active
tab's focused pane is working in, using the foreground process's directory, so
an agent working in another worktree is followed there. A branch that still
tracks the branch it was created from, such as `origin/dev`, is followed under
its own name once pushed, or when it tracks the default branch.

It publishes three tokens for Herdr's sidebar:

- `$timmo_agent_checks_lint` starts with the Nerd Font code scanning icon
  (`U+F4B1`). `!2` after it means two checks failed, `↻` that lint is running,
  `⏱` that it timed out, `⚠` that it could not run and `✓` that the working tree
  is clean.
- `$timmo_agent_checks_ci` starts with the Nerd Font GitHub workflow icon
  (`U+F52E`). `!2` after it means two runs need attention, `↻` that runs are in
  progress, `…` that the first result is loading and `⚠` that GitHub or the
  repository could not be read. `✓` and `○` (no runs) need `showSuccess` and
  `showIdle`.
- `$timmo_agent_checks_reviews` shows the review state of the branch's open pull
  request: `PR !2` for two open review threads, `PR ↻` when a bot review is
  requested, `PR ✓` when neither, and `PR ⚠` when the reviews could not be read.
  It is empty without an open pull request.

Failed, timed-out, startup-failed and action-required runs need attention;
cancelled, neutral and skipped runs do not. Reruns replace the previous attempt.
Local unpushed commits do not hide the pushed commit's failures.

Lint runs `dot agent lint --json` by default, when a workspace is first found
and whenever an agent in it goes from working to idle or done. Results are
cached by working-tree fingerprint, so an unchanged tree is not linted again.
Only one lint runs at a time.

Reviews come from `dot pr reviews --json` for the open pull request from the
followed branch, polled every minute. A thread is open when it is neither
resolved nor minimised.

The watcher also writes `status.json` in its state directory. The Omarchy bar
widget and panel follow it.

## Install

Requires Herdr 0.9.0 with socket protocol 22, Git, an authenticated
[GitHub CLI](https://cli.github.com/) and [mise](https://mise.jdx.dev/). Lint
and reviews use the [dotfiles](https://github.com/timmo001/dotfiles) `dot`
command by default.

```sh
mise run install
mise run build
herdr plugin link .
herdr plugin action invoke timmo.agent-checks.start
```

Linking and reloading do not run startup hooks. Rebuild before starting a new
watcher after source changes; a running watcher restarts itself when its bundle
or configuration changes.

For the Omarchy side, deploy the repository as the `timmo.agent-checks` plugin
in `~/.config/omarchy/plugins/`. `FilterablePanel`, `OutputView`,
`PanelFlickable`, `PanelHeader` and `SectionHeading` are copies of the shared
dotfiles panel components. Change them in dotfiles and run
`dot omarchy plugin sync components`, rather than editing them here.

Add the tokens to Herdr's sidebar and bind the actions:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status",
    { token = "$timmo_agent_checks_lint", fg = "#f38ba8", dim = false, rules = [{ equals = "\uF4B1 ⚠", fg = "#f9e2af" }, { equals = "\uF4B1 ↻", fg = "#f9e2af" }, { equals = "\uF4B1 ✓", fg = "#a6e3a1" }] },
    { token = "$timmo_agent_checks_ci", fg = "#f38ba8", dim = false, rules = [{ equals = "\uF52E ⚠", fg = "#f9e2af" }, { equals = "\uF52E …", fg = "#89b4fa" }, { equals = "\uF52E ↻", fg = "#f9e2af" }, { equals = "\uF52E ✓", fg = "#a6e3a1" }] },
    { token = "$timmo_agent_checks_reviews", fg = "#f38ba8", dim = false, rules = [{ equals = "PR ⚠", fg = "#f9e2af" }, { equals = "PR ↻", fg = "#f9e2af" }, { equals = "PR ✓", fg = "#a6e3a1" }] }],
]

[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "timmo.agent-checks.open"

[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "timmo.agent-checks.lint"

[[keys.command]]
key = "prefix+alt+f"
type = "plugin_action"
command = "timmo.agent-checks.paste-ci"

[[keys.command]]
key = "prefix+alt+l"
type = "plugin_action"
command = "timmo.agent-checks.paste-lint"

[[keys.command]]
key = "prefix+g"
type = "plugin_action"
command = "timmo.agent-checks.reviews"

[[keys.command]]
key = "prefix+alt+g"
type = "plugin_action"
command = "timmo.agent-checks.paste-reviews"
```

## Actions

| Action          | What it does                                                           |
| --------------- | ---------------------------------------------------------------------- |
| `start`         | Starts the watcher for this socket if none is running                  |
| `open`          | Opens the Omarchy panel on CI for the invoking pane's checkout         |
| `lint`          | Opens the panel on lint, running lint first if the tree has changed    |
| `reviews`       | Opens the panel on the pull request's reviews                          |
| `paste-ci`      | Pastes the CI failure prompt into the invoking agent without sending   |
| `paste-lint`    | Pastes the lint failure prompt into the invoking agent without sending |
| `paste-reviews` | Pastes the open review threads into the invoking agent without sending |

## Panel

The panel shows CI, lint and reviews together, one section each. Each section
heading shows whether it is loading, running, empty, stale or failed, with a
retry where one helps. Opening the panel on CI, lint or reviews scrolls to that
section.

- **CI** lists the workflow runs. Failed runs expand to their failed jobs, steps
  and logs. From there you can paste or copy the prompt, open the Actions page,
  or launch a new agent to fix it in this checkout or in a new worktree.
- **Lint** lists every configured check with its output, and can paste, copy, run
  lint again or launch a new agent in this checkout. The play buttons run every
  check, or one check, on every file, even when nothing has changed.
- **Reviews** lists the open review threads on the branch's pull request. Each
  expands to its comments and opens in the browser. With open threads you can
  paste or copy the prompt, which asks the agent to triage them with the
  `dot-pr-watch` skill, or launch a new agent in this checkout.

Worktree launches are CI only, since lint needs the checkout's uncommitted
changes and review fixes belong on the pull request's branch. The bar widget
shows lint, CI and reviews for the focused workspace and opens the panel.

The panel opens through Omarchy shell IPC:

```sh
omarchy-shell timmo.agent-checks ci <cwd> <pane>
omarchy-shell timmo.agent-checks lint <cwd> <pane>
omarchy-shell timmo.agent-checks reviews <cwd> <pane>
omarchy-shell timmo.agent-checks open
```

## CLI

Run commands from the plugin root with `HERDR_SOCKET_PATH` set; `herdr plugin
list --plugin timmo.agent-checks --json` reports the root as `plugin_root`.

```sh
mise exec -- bun dist/index.js status --cwd /path/to/checkout --json
mise exec -- bun dist/index.js ci logs --cwd /path/to/checkout --json
mise exec -- bun dist/index.js lint check --cwd /path/to/checkout --json
```

`paths` prints the state directory and `status.json` location. `ci logs` and
`lint check` print the agent prompt without `--json`. `launchers`, `launch`,
`paste` and `browser` back the panel's actions; see `--help` for each.

## Configuration

Create `config.json` in the directory printed by
`herdr plugin config-dir timmo.agent-checks`:

```json
{
  "pollSeconds": 30,
  "retrySeconds": 120,
  "timeoutSeconds": 30,
  "concurrency": 3,
  "showSuccess": true,
  "showIdle": false,
  "showPrevious": true,
  "indicatorTemplates": {
    "failure": "\uF52E !{count}",
    "previous": "{status} ↶{count}"
  },
  "lint": {
    "enabled": true,
    "command": ["dot", "agent", "lint", "--json"],
    "timeoutSeconds": 600,
    "templates": { "failure": "\uF4B1 !{count}" }
  },
  "reviews": {
    "enabled": true,
    "pollSeconds": 60,
    "templates": { "open": "PR !{count}" }
  },
  "launchers": [{ "id": "pi", "label": "Pi", "argv": ["pi"], "agent": "pi" }]
}
```

- `pollSeconds` (10-3600) sets how often idle branches are polled. Branches with
  unfinished runs are polled every 3 seconds until they finish. Polls are
  staggered across branches, and workspaces on the same branch share a poll.
- `retrySeconds` (30-3600) is the wait after a failed poll, never shorter than
  `pollSeconds`. `timeoutSeconds` (5-120) bounds each command and `concurrency`
  (1-8) bounds discovery and token updates.
- `showPrevious` falls back to the nearest earlier first-parent commit with runs
  when the pushed commit has none, within the latest 100 runs and commits.
- `indicatorTemplates` keys are `failure`, `unavailable`, `loading`,
  `inProgress`, `success`, `idle` and `previous`. `{count}` is the number of
  failed runs, or the commit distance in `previous`, where `{status}` is the
  wrapped indicator and `{distance}` reads like `2 commits ago`.
- `lint.templates` keys are `failure`, `timedOut`, `running`, `clean` and
  `unavailable`. `{count}` is the number of failed checks. The lint command must
  print `dot agent lint --json` output, and accept its `--all` and `--only`
  flags for the panel's run buttons.
- `reviews.pollSeconds` (30-3600) sets how often each branch's reviews are
  polled. `reviews.templates` keys are `open`, `requested`, `clear` and
  `unavailable`. `{count}` is the number of open threads.
- `launchers` replaces the built-in agents: OpenCode, Pi, Cursor Agent, Claude
  Code, Codex, GitHub Copilot, OMP, Devin, Droid, Kimi, Kilo, Hermes, Qoder CLI,
  Qwen, Mastra Code, Antigravity CLI and Grok. Only launchers with an installed
  Herdr integration and an executable command are offered. `integration`
  overrides the integration name, and `verifyCommand` prints the executable
  path expected in the new pane, for wrappers.

Update the sidebar `equals` rules if you change the templates.

## State and errors

State lives in a socket-specific directory under `HERDR_PLUGIN_STATE_DIR`, or
`~/.local/state/herdr/plugins/timmo.agent-checks` outside Herdr. It holds the
watcher lease, `watch.log`, `status.json`, lint results and saved CI logs.
There is one watcher per server socket. It exits when the plugin is disabled or
the session goes away, and the tokens expire on their own.

Errors raise a short Herdr notification with the cause and the log location.
With `--json`, commands print a one-line error on stderr instead. Full details
stay in the JSON logs.

## Development

[mise](https://mise.jdx.dev/) pins Bun and Node and runs the project tasks.

Herdr requests use [`@timmo001/effect-herdr`](https://github.com/timmo001/effect-herdr)
and GitHub requests use [`@timmo001/effect-gh`](https://github.com/timmo001/effect-gh).
effect-herdr is pinned to a GitHub commit, with a Bun patch in `patches/` that
exposes its TypeScript entrypoint. Keep the commit, patch and lockfile together.

```sh
mise install
mise run format
mise run check ::: build ::: check:plugin
bun dist/index.js --help
```

`check:plugin` validates the Omarchy manifest and syntax-checks the QML.
Interactive behaviour is tested by hand.
