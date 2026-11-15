---
title: Status
description: What the watcher follows, the sidebar tokens it publishes and the actions you can bind.
---

The watcher follows the current branch of every open GitHub-backed workspace and lints each workspace's checkout. A workspace's checkout is the one its active tab's focused pane is working in, using the foreground process's directory, so an agent working in another worktree is followed there. A branch that still tracks the branch it was created from, such as `origin/dev`, is followed under its own name once pushed, or when it tracks the default branch.

It publishes three tokens for Herdr's sidebar:

- `$timmo_agent_checks_lint` starts with the Nerd Font code scanning icon (`U+F4B1`). `!2` after it means two checks failed, `↻` that lint is running, `⏱` that it timed out, `⚠` that it could not run and `✓` that the working tree is clean.
- `$timmo_agent_checks_ci` starts with the Nerd Font GitHub workflow icon (`U+F52E`). `!2` after it means two runs need attention, `↻` that runs are in progress, `…` that the first result is loading and `⚠` that GitHub or the repository could not be read. `✓` and `○` (no runs) need `showSuccess` and `showIdle`.
- `$timmo_agent_checks_reviews` starts with the Nerd Font git pull request icon (`U+F407`) and shows the review state of the branch's open pull request. `!2` after it means two open review threads, `↻` that a bot review is requested, `✓` neither, and `⚠` that the reviews could not be read. It is empty without an open pull request.

Failed, timed-out, startup-failed and action-required runs need attention; cancelled, neutral and skipped runs do not. Reruns replace the previous attempt. Local unpushed commits do not hide the pushed commit's failures.

Lint runs `dot agent lint --json` by default, when a workspace is first found and whenever an agent in it goes from working to idle or done. Results are cached by working-tree fingerprint, so an unchanged tree is not linted again. Only one lint runs at a time.

Reviews come from `dot pr reviews --json` for the open pull request from the followed branch, polled every minute. A thread is open when it is neither resolved nor minimised. A reviewer's change request also counts as an open thread until they approve or the review is dismissed.

The watcher also writes `status.json` in its state directory. The Omarchy bar widget and panel follow it.

## Sidebar

Add the tokens to Herdr's sidebar:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status",
    { token = "$timmo_agent_checks_lint", fg = "#f38ba8", dim = false, rules = [{ equals = "\uF4B1 ⚠", fg = "#f9e2af" }, { equals = "\uF4B1 ↻", fg = "#f9e2af" }, { equals = "\uF4B1 ✓", fg = "#a6e3a1" }] },
    { token = "$timmo_agent_checks_ci", fg = "#f38ba8", dim = false, rules = [{ equals = "\uF52E ⚠", fg = "#f9e2af" }, { equals = "\uF52E …", fg = "#89b4fa" }, { equals = "\uF52E ↻", fg = "#f9e2af" }, { equals = "\uF52E ✓", fg = "#a6e3a1" }] },
    { token = "$timmo_agent_checks_reviews", fg = "#f38ba8", dim = false, rules = [{ equals = "\uF407 ⚠", fg = "#f9e2af" }, { equals = "\uF407 ↻", fg = "#f9e2af" }, { equals = "\uF407 ✓", fg = "#a6e3a1" }] }],
]
```

Update the `equals` rules if you change the [templates](/configuration).

## Actions

Bind them in Herdr's config:

```toml
[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "timmo.agent-checks.open"
```

| Action          | What it does                                                           |
| --------------- | ---------------------------------------------------------------------- |
| `start`         | Starts the watcher for this socket if none is running                  |
| `open`          | Opens the Omarchy panel on CI for the invoking pane's checkout         |
| `lint`          | Opens the panel on lint, running lint first if the tree has changed    |
| `reviews`       | Opens the panel on the pull request's reviews                          |
| `paste-ci`      | Pastes the CI failure prompt into the invoking agent without sending   |
| `paste-lint`    | Pastes the lint failure prompt into the invoking agent without sending |
| `paste-reviews` | Pastes the open review threads into the invoking agent without sending |
