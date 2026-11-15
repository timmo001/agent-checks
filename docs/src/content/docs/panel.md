---
title: Panel
description: The Omarchy panel and bar widget for CI, lint and reviews.
---

The panel shows CI, lint and reviews together, one section each. Each section heading shows whether it is loading, running, empty, stale or failed, with a retry where one helps. Opening the panel on CI, lint or reviews scrolls to that section.

- **CI** lists the workflow runs. Failed runs expand to their failed jobs, steps and logs. From there you can paste or copy the prompt, open the Actions page, or launch a new agent to fix it in this checkout or in a new worktree.
- **Lint** lists every configured check with its output, and can paste, copy, run lint again or launch a new agent in this checkout. The play buttons run every check, or one check, on every file, even when nothing has changed.
- **Reviews** lists the open review threads on the branch's pull request. Each expands to its comments and opens in the browser. With open threads you can paste or copy the prompt, which asks the agent to triage them with the `dot-pr-watch` skill, or launch a new agent in this checkout.

Worktree launches are CI only, since lint needs the checkout's uncommitted changes and review fixes belong on the pull request's branch. The bar widget shows lint, CI and reviews for the focused workspace and opens the panel.

The panel opens through Omarchy shell IPC:

```sh
omarchy-shell timmo.agent-checks ci <cwd> <pane>
omarchy-shell timmo.agent-checks lint <cwd> <pane>
omarchy-shell timmo.agent-checks reviews <cwd> <pane>
omarchy-shell timmo.agent-checks open
```
