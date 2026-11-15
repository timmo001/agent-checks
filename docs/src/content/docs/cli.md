---
title: CLI
description: The commands behind the plugin and the panel.
---

Run commands from the plugin root with `HERDR_SOCKET_PATH` set; `herdr plugin list --plugin timmo.agent-checks --json` reports the root as `plugin_root`.

```sh
mise exec -- bun dist/index.js status --cwd /path/to/checkout --json
mise exec -- bun dist/index.js ci logs --cwd /path/to/checkout --json
mise exec -- bun dist/index.js lint check --cwd /path/to/checkout --json
```

`paths` prints the state directory and `status.json` location. `ci logs` and `lint check` print the agent prompt without `--json`. `launchers`, `launch`, `paste` and `browser` back the panel's actions; see `--help` for each.
