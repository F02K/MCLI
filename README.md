# MCLI

![code quality: A](badges/quality.svg)

A full-screen text UI for running and managing a Minecraft server from the console.
One JavaScript file, no dependencies, no installer: drop it next to your server and start it.

- **Servers:** Vanilla, Paper, Fabric, Forge and the Velocity proxy (detected automatically, also in an existing folder)
- **Platforms:** Windows and Linux (macOS should work, but is untested)
- **Needs:** [Node.js](https://nodejs.org) 22 or newer. Java is found or installed by MCLI itself.

## Quick start

1. Download `mcli-vX.Y.Z.zip` from the **Releases** page and unpack it into your server folder
   (or any empty folder if you want MCLI to install a server for you).
2. Start it:
   - Windows: double-click `start.bat`
   - Linux: `./start.sh`
3. In an empty folder: press `5` (Versions), then `I` to install Paper, Vanilla, Fabric or Forge.
4. Go to the Dashboard (`1`) and press `S` to start the server.

Only `mcli.js` is required. `start.bat` / `start.sh` just run `node mcli.js` in the right folder.

## Features

**Dashboard** - server state, uptime, players, CPU and RAM graphs (system and server), reachability check, update status, recent log, and a *Problems* box that explains what is wrong and how to fix it.

**Console** - live server log with colors, command history, scrollback (PgUp/PgDn, mouse wheel), log filter (`Ctrl+F`). Anything you type goes to the server; MCLI's own commands start with `:` (see below).

**Players** - online players, whitelist, operators, bans and IP bans. Kick, ban, op, deop, whitelist and message from a menu.

**Settings** - edit `server.properties` with descriptions, toggles and choice menus (comments and unknown keys are preserved), plus MCLI's own settings.

**Versions** - download and update server software straight from the official sources:

| Software | Source |
| --- | --- |
| Vanilla | Mojang version manifest |
| Paper | PaperMC download API |
| Fabric | Fabric meta API |
| Forge (1.12.2+) | Forge promotions and maven (runs the official installer) |
| Velocity (proxy) | PaperMC download API |

Downloads are checksum-verified where the provider publishes one, the jar structure is checked afterwards, and the previous jar is moved to `old-jars/`. MCLI warns about downgrades and can back up the world first. It also tells you when a newer build or Minecraft version is available.

**Java** - MCLI scans for installed Java versions (`JAVA_HOME`, `PATH`, common install folders, SDKMAN, Gradle JDKs, the Minecraft launcher runtime) and picks the lowest one that fits the server. If the needed version is missing, it offers to download Eclipse Temurin into its own `java/` folder; your other Java installations are never touched.

**Backups** - zip backups of the world folders (Overworld, Nether, End). On a running server saving is paused while zipping. Optional schedule, retention, restore (current worlds are renamed, not deleted) and delete.

**Health checks** - before every start MCLI verifies the jar, Java, the EULA and that the port is free. While running it pings the server like the Minecraft server list does, so "running" means "actually answers". It recognizes common failures (EULA, port in use, Java too old, broken jar, out of memory, corrupt world, mod errors) and does not blindly restart on problems a restart cannot fix. Crashes are restarted automatically with a limit.

## Keys

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab`, `F1`-`F7`, `Alt+1`-`7` | switch view |
| Mouse | click tabs and buttons, wheel scrolls |
| `Ctrl+C` or `Q` | quit (asks first while the server runs; pressing again forces) |
| Dashboard: `S` `X` `R` `B` `C` | start, stop, restart, backup, console |
| Dashboard: `E` `V` `G` `J` `K` | fix a listed problem: accept EULA, Versions, Settings, install Java, Backups |
| Versions: `I` `U` `V` `R` `J` `E` `F` | install/switch, update, verify jar, repair, Java, EULA, refresh |
| Backups: `N` `R` `D` `O` | new, restore, delete, open folder |
| Console: `Ctrl+F` / `Ctrl+L` | filter / jump to latest |

The Help tab (`7`) lists everything in the app.

## Headless API

`mcli --api` runs without a text UI and speaks JSON lines on stdin/stdout, so other programs can control a server (status, start/stop, players, metrics, memory, installs). See [docs/API.md](docs/API.md).

## Console commands

Typed into the Console (or piped in when there is no terminal):

```
:start  :stop  :restart  :backup  :status  :quit
:versions <paper|vanilla|fabric|forge>
:install <provider> <minecraft version>
:update [latest]      newest build, or newest Minecraft version
:verify  :repair      deep-check the server jar / download it again
:eula                 accept the Minecraft EULA
:java                 list Java installs     :java install 21     :java use <path|auto>
:help
```

Without an interactive terminal (pipes, services) MCLI runs in plain mode: log lines on stdout, commands from stdin.

## Configuration

Optional. MCLI reads `mcli.json` from the folder it is started in; most values can also be changed in *Settings > MCLI*.

```json
{
  "serverDir": ".",
  "java": "",
  "javaAutoInstall": false,
  "minMemory": "1G",
  "maxMemory": "2G",
  "autoRestart": true,
  "maxRestarts": 3,
  "backupDir": "",
  "backupIntervalMinutes": 0,
  "backupKeep": 10
}
```

| Key | Meaning |
| --- | --- |
| `serverDir` | folder that contains (or will contain) the server |
| `java` | fixed path to a java executable; empty lets MCLI choose per server |
| `javaAutoInstall` | install a missing Java without asking |
| `minMemory` / `maxMemory` | JVM heap, e.g. `1G`; ignored for modern Forge (use `user_jvm_args.txt`) |
| `autoRestart` / `maxRestarts` | restart after a crash, give up after N crashes in a row |
| `backupDir` | where backups go; empty means `<serverDir>/backups` |
| `backupIntervalMinutes` | automatic backup interval while running; `0` = off |
| `backupKeep` | keep the newest N backups; `0` = keep all |

MCLI also writes `mcli-install.json` into the server folder to remember what it installed.

## Good to know

- **EULA:** MCLI never accepts the Minecraft EULA on its own. It asks, shows the link, and only then writes `eula=true`.
- **Stopping MCLI stops the server.** The server runs as a child process; quitting MCLI shuts it down gracefully first.
- **Windows CPU/RAM of the server** is sampled every 10 seconds (via `tasklist`); on Linux and macOS every 2 seconds (via `ps`).
- **Backups use plain zip** without ZIP64, so a single backup is limited to 4 GB and 65,535 files.
- **Velocity** is detected by its jar; its port comes from `bind` in `velocity.toml` (default 25565). Other proxies (BungeeCord, Waterfall) are not supported.
- **Spigot** cannot be installed (it has no download, only a build tool), but an existing Spigot server is recognised and run. Use Paper to install, which is a drop-in replacement for Spigot plugins.

## Building from source

```
npm ci
npm run build        # bundles src/ into dist/mcli.js with esbuild
node dist/mcli.js
```

The bundle has no runtime dependencies and no native modules, which is what makes the single-file delivery possible. The source is TypeScript under `src/`; the interface lives in `src/tui/` and is plain ANSI, so it can be tested headlessly with a fake terminal.

## Code quality

The badge above is not decorative: `npm run quality` measures it and CI refuses anything below **A** (and a badge that no longer matches the result).

| Check | Points | What is measured |
| --- | --- | --- |
| Types | 15 | `tsc --noEmit` in strict mode |
| Lint | 15 | ESLint (type-aware, `no-floating-promises`, no empty `catch`) with zero warnings |
| Tests | 20 | all tests pass |
| Coverage | 20 | line coverage, full marks at 90 % |
| Branches | 5 | branch coverage, full marks at 85 % |
| Dependencies | 10 | no runtime dependencies, no known vulnerabilities (`npm audit`) |
| Size | 10 | no source file over 500 lines |
| Docs | 5 | README, CI and release workflows exist |

100 points in total. **A** needs 90 or more, and failing types, lint or tests caps the grade at **C**. Run the pieces on their own with:

```
npm run typecheck
npm run lint
npm test                # node:test, no network; downloads are tested against local mock servers
npm run test:coverage
npm run quality         # everything above, prints the score and refreshes badges/quality.svg
```

The tests never download real server jars or Java; the provider APIs, the download pipeline, the Java installer and the whole interface are exercised against local mock servers and a fake terminal.

## Releases

Releases are fully automatic. Every push to `main` is checked; if it contains releasable commits (Conventional Commits) since the last tag, a new version is tagged, built and published with a zip.

| Commit type | Version bump |
| --- | --- |
| `feat:` | minor |
| `fix:` `perf:` `refactor:` | patch |
| `feat!:` or a `BREAKING CHANGE:` footer | major (minor while below 1.0) |
| `docs:` `chore:` `ci:` `test:` `build:` `style:` | no release |

The first release is `v0.1.0`. A release can also be forced from the *Actions* tab with a chosen bump.
