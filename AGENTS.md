# vibespace

Web & mobile IDE for `claude` / `codex` / `gemini` sessions. This repo is a
fork of [`siteboon/claudecodeui`](https://github.com/siteboon/claudecodeui),
rebranded from `cloudcli` to **VibeSpace** and published as the **private**
package `@vibespace-ai/vibespace`. The user's own instance is served at
**cloud.dudin.net**.

## Remotes & upstream

- **`origin`** → `https://github.com/siteboon/claudecodeui.git` — the upstream
  this fork tracks. **Upstream is itself `cloudcli`-branded**, so every fetch
  re-introduces `cloudcli` strings in new upstream code. We periodically rebase
  our branch on top of it for updates:
  `git fetch origin && git rebase origin/main`. Our `vibespace` rebrand lives in
  our commits **on top of** upstream, so expect to carry/re-apply it across each
  rebase (and resolve conflicts where upstream touched the same code).
- **`oqto`** → `git@github.com:oqtoshka/vibespace.git` — **our** publish remote
  (SSH). Push our work here: `git push oqto main`.
- **Do NOT push to `origin`.** It's read-only upstream; pushing releases there
  would also trip `npm run release` (see pitfalls).

Workflow each cycle: rebase on `origin` (GitHub) for upstream updates → resolve
conflicts → keep the `vibespace` rename on top → push to `oqto`.

- Frontend: Vite + React (TS) under `src/` → builds to `dist/`.
- Backend: Node server under `server/` → builds to `dist-server/` (tsc + tsc-alias).
- `npm run build` = `build:client` (vite → `dist/`) + `build:server` (→ `dist-server/`).

## Deploying to cloud.dudin.net

**The production daemon runs THIS checkout's build directly — not the npm/pnpm
package.** The running LaunchAgent executes:

```
node /Users/dudin/projects/ai/vibespace/dist-server/server/index.js
```

So a deploy is just **build + kickstart the daemon**. Do NOT publish to a
registry and do NOT run `npm run release` for a normal deploy (see pitfalls).

```bash
# from this repo, on the Mac that hosts cloud.dudin.net
npm run build                                   # regenerates dist/ + dist-server/
launchctl kickstart -k "gui/$(id -u)/net.dudin.vibespace"
```

> **Note on the service id:** the launchd rename landed (2026-06-11) — the
> LaunchAgent is now `net.dudin.vibespace` (+ watchdog
> `net.dudin.vibespace-watchdog`). The legacy `net.dudin.cloudcli*` labels are
> gone; kickstarting them fails with "Could not find service".

That's the whole deploy. The daemon picks up the freshly-built `dist/` and
`dist-server/` on restart.

### Moving parts (for context, not steps)

- **LaunchAgent** `net.dudin.vibespace` (+ watchdog `net.dudin.vibespace-watchdog`)
  — managed by the ansible role in the `infrastructure` repo (renamed from
  `roles/desktop/cloudcli` along with the service labels).
  A wrapper waits for the SOYUZ WireGuard IP to be assigned, then starts the
  server bound to that IP:port. KeepAlive restarts on crash; the watchdog
  probes HTTP every 60s and kickstarts if the process is wedged.
- nginx (on spider/soyuz) reverse-proxies cloud.dudin.net → the WireGuard IP:port.
- **Title** is configurable via the build-time env var `VITE_APP_TITLE` (drives
  the sidebar header + browser tab; defaults to `VibeSpace`). This deployment's
  gitignored `.env` sets it to `VibeSpace Home`, so it must be present when you
  `npm run build` for the title to take effect.
- The repo `.npmrc` points scoped packages at the **private Verdaccio**
  (`@*:registry=https://verdaccio.dudin.net/`); auth token lives in `~/.npmrc`.
  This matters for `npm install`, not for deploying.
- **PlantUML preview** (`.puml`/`.plantuml`/`.iuml`/`.wsd` files render as
  diagrams) goes through `POST /api/projects/:id/plantuml`, which resolves the
  file's local `!include`s server-side then returns a render URL for a PlantUML
  server. Configurable via the **runtime** env var `PLANTUML_SERVER_URL`
  (default `https://www.plantuml.com/plantuml`). Note the encoded diagram source
  is fetched from that server by the browser — point it at a self-hosted server
  to keep diagrams private. No env is set on this host, so it uses the default.

### Pitfalls (learned the hard way)

- A globally pnpm-installed package on `PATH` (the legacy
  `~/Library/pnpm/...@cloudcli-ai+cloudcli@...` copy, possibly under the
  `vibespace` bin name after a reinstall) is **NOT what the daemon runs** —
  it's a stale red herring. The daemon runs `node` against this repo's
  `dist-server/` (verify with `ps -o command -p <pid>`).
- `origin` is the upstream `siteboon/claudecodeui`. Do **not** push releases
  there. `npm run release` (release-it) requires `main` + clean tree and would
  bump the version, push commits/tags to `origin`, cut a GitHub release, and
  publish — none of which is part of deploying this instance.
- Version stays in lockstep with upstream (currently `1.34.0`); the deploy
  does not bump it.
- Releases/tags/CHANGELOG entries in git history are upstream's, not ours.
- **`npm config get ignore-scripts` is `true` on this machine**, so a fresh
  `npm install` never compiles native addons. bcrypt and node-pty ship NAPI
  prebuilds and keep working, but **better-sqlite3 has no prebuilt binary for
  brew's Node** and the server crash-loops on startup with "Could not locate
  the bindings file". After any `node_modules` wipe, build it manually with
  **brew's node** (the daemon's runtime — `nvm` node is a different ABI):
  `cd node_modules/better-sqlite3 && PATH=/opt/homebrew/bin:$PATH npx node-gyp rebuild --release`
- `sharp` is a devDependency (icon scripts only); the server never imports
  it, so its missing platform binaries are harmless.
- **The wrapper must stay executable.** The LaunchAgent runs
  `exec /Users/dudin/.local/bin/vibespace-wrapper.sh` *directly* (not
  `bash wrapper.sh`), so if the file loses its `+x` bit, zsh refuses with
  `permission denied`, the service exits **126**, and KeepAlive crash-loops it
  forever — nginx then returns **502** on cloud.dudin.net. This bit gets dropped
  whenever the script's hand-edited "LOCAL OVERRIDE" block is re-saved by an
  editor that doesn't preserve mode. Symptom in `~/Library/Logs/vibespace.stderr.log`:
  repeated `zsh:1: permission denied: .../vibespace-wrapper.sh`. Fix:
  `chmod +x /Users/dudin/.local/bin/vibespace-wrapper.sh && launchctl kickstart -k "gui/$(id -u)/net.dudin.vibespace"`
- **`@vscode/ripgrep` has no binary** for the same ignore-scripts reason (its
  postinstall downloads `rg`), which silently breaks conversation-content
  search (`Error searching conversations: spawn .../@vscode/ripgrep/bin/rg
  ENOENT`; the UI just shows "Search failed"/no results). Fix after any
  `node_modules` wipe by symlinking brew's ripgrep:
  `ln -sf "$(which rg)" node_modules/@vscode/ripgrep/bin/rg`
- **Data dir moved with the rebrand:** the default app data directory is now
  `~/.vibespace/` (was `~/.cloudcli/`) — it holds `auth.db` (users, API keys,
  tokens), `provider-models-cache.json`, and provider model-override state.
  There is **no `DATABASE_PATH` override** on this host, so the default is what's
  used. The cloudcli→vibespace migration copied `~/.cloudcli/.` → `~/.vibespace/`
  (old dir kept as a backup). If you ever wipe `~/.vibespace`, restore from there
  or you lose all logins.

## Conventions

- This project follows the umbrella `ai/` convention: `AGENTS.md` is the real
  file, `CLAUDE.md` is a symlink to it.
- Don't add `Co-Authored-By: Claude` trailers to commits.
