---
title: Configuration
description: Every setting in the plugin's config.json.
---

Create `config.json` in the directory printed by `herdr plugin config-dir timmo.agent-checks`:

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
    "templates": { "open": "\uF407 !{count}" }
  },
  "launchers": [{ "id": "pi", "label": "Pi", "argv": ["pi"], "agent": "pi" }]
}
```

- `pollSeconds` (10-3600) sets how often idle branches are polled. Branches with unfinished runs are polled every 15 seconds until they finish. Every branch due shares one GraphQL query, and workspaces on the same branch share a poll.
- `unfocusedPollSeconds` (10-3600, default 120) is the shortest CI and review interval for workspaces not in focus, never shorter than `pollSeconds`.
- `retrySeconds` (30-3600) is the wait after a failed poll, never shorter than `pollSeconds`. Once GitHub's rate limit is spent, polling waits until it resets. `timeoutSeconds` (5-120) bounds each command and `concurrency` (1-8) bounds discovery and token updates.
- `showPrevious` falls back to the nearest earlier first-parent commit with runs when the pushed commit has none, within the latest 100 commits.
- `indicatorTemplates` keys are `failure`, `unavailable`, `loading`, `inProgress`, `success`, `idle` and `previous`. `{count}` is the number of failed runs, or the commit distance in `previous`, where `{status}` is the wrapped indicator and `{distance}` reads like `2 commits ago`.
- `lint.templates` keys are `failure`, `timedOut`, `running`, `clean` and `unavailable`. `{count}` is the number of failed checks. The lint command must print `dot agent lint --json` output, and accept its `--all` and `--only` flags for the panel's run buttons.
- `reviews.pollSeconds` (30-3600) sets how often each branch's reviews are polled. `reviews.templates` keys are `open`, `requested`, `clear` and `unavailable`. `{count}` is the number of open threads.
- `launchers` replaces the built-in agents: OpenCode, Pi, Cursor Agent, Claude Code, Codex, GitHub Copilot, OMP, Devin, Droid, Kimi, Kilo, Hermes, Qoder CLI, Qwen, Mastra Code, Antigravity CLI and Grok. Only launchers with an installed Herdr integration and an executable command are offered. `integration` overrides the integration name, and `verifyCommand` prints the executable path expected in the new pane, for wrappers.
