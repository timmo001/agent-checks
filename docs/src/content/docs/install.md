---
title: Install
description: Build the CLI, link the Herdr plugin and deploy the Omarchy plugin.
---

Requires Herdr 0.9.0 with socket protocol 22, Git, an authenticated [GitHub CLI](https://cli.github.com/) and [mise](https://mise.jdx.dev/). Lint and reviews use the [dotfiles](https://github.com/timmo001/dotfiles) `dot` command by default.

```sh
mise run install
mise run build
herdr plugin link .
herdr plugin action invoke timmo.agent-checks.start
```

Linking and reloading do not run startup hooks. Rebuild before starting a new watcher after source changes; a running watcher restarts itself when its bundle or configuration changes. For a GitHub install, a running watcher moves to the new installation after `herdr plugin update`.

## Omarchy plugin

Deploy the repository as the `timmo.agent-checks` plugin in `~/.config/omarchy/plugins/`. `FilterablePanel`, `OutputView`, `PanelFlickable`, `PanelHeader` and `SectionHeading` are copies of [Groundwork's](https://github.com/timmo001/groundwork) shared panel components, kept in step by its sync (`sync.json` and `sync.lock.json` in the repository).

## State and errors

State lives in a socket-specific directory under `HERDR_PLUGIN_STATE_DIR`, or `~/.local/state/herdr/plugins/timmo.agent-checks` outside Herdr. It holds the watcher lease, `watch.log`, `status.json`, lint results and saved CI logs. There is one watcher per server socket. It exits when the plugin is disabled or the session goes away, and the tokens expire on their own.

Errors raise a short Herdr notification with the cause and the log location. With `--json`, commands print a one-line error on stderr instead. Full details stay in the JSON logs.
