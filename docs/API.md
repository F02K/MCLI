# MCLI API mode

`mcli --api` runs MCLI without a text UI so that another program (for example MCNetwork) can control one server.
Start it with the server folder as working directory.

- **Transport:** newline-delimited JSON on stdin (requests) and stdout (replies and events). Nothing else is printed to stdout.
- **Lifetime:** closing stdin (or SIGINT/SIGTERM) stops the server gracefully and exits MCLI.
- **Protocol version:** `1` (announced in the `ready` event).

## Messages

Request: `{"id": 1, "method": "status", "params": {}}`

Reply: `{"id": 1, "ok": true, "result": ...}` or `{"id": 1, "ok": false, "error": "..."}`

Event (no `id`): `{"event": "log", "data": {...}}`

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `ping` | | `"pong"` |
| `status` | | state, pid, uptime, software, java, memory (config + live), players, health, problems, installer, backups, updates |
| `start` / `stop` / `restart` | | new state (and problems); replies when the action has finished |
| `command` | `text` | `true` if the line was sent to the server console, `false` if not running |
| `exec` | `text` | like typing into MCLI: `:commands` for MCLI, anything else to the server |
| `logs` | `limit` (200), `since` (epoch ms) | log entries |
| `players` | | `{count, max, online: [{name, since}]}` |
| `list` | `kind`: whitelist, ops, banned-players, banned-ips | entries |
| `metrics` | | current point and history arrays (system CPU/RAM %, server RSS bytes, server CPU %) |
| `settings` / `setSetting` | `key`, `value` | editable MCLI settings (types are checked) |
| `setMemory` | `min`, `max` (e.g. `512M`, `2G`) | saved to `mcli.json`; **applies on the next start** (a running JVM cannot change its heap) |
| `versions` | `provider`, `snapshots` | versions, newest first |
| `plan` | `provider`, `version` | what an install would fetch: `{display, build, channel, javaMajor, filename, size}` |
| `install` | `provider`, `version`, `backupFirst` | `true` on success |
| `update` / `checkUpdates` | `latest` | |
| `backup` / `backups` | | create / list backups |
| `acceptEula` / `installJava` / `shutdown` | `major` | |

Providers: `paper`, `vanilla`, `fabric`, `forge`, `velocity`. For `velocity` the "version" is the Velocity version (e.g. `3.5.1`).

## Events

`ready`, `log`, `state`, `players`, `problems`, `health`, `installer`, `backups`, `sample` (every 2 s on Linux/macOS, every 10 s on Windows), `quitting`.
