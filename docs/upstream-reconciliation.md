# Reconciling with upstream cloudcli (v1.37.x)

Written 2026-08-26 against `origin/main` = `677b7ba4` (v1.37.2) and our `main`
= `828b702a` (1.38.43). Merge-base `75ff8a5d` (v1.36.3).

## What upstream did

19 commits, but two of them (#1037, #1153) are squashed mega-PRs: **394 files,
+29k/−12k**. The substance:

1. **Whole backend into TypeScript feature modules.** `server/index.js`
   (2.6k lines of inline routes) became a thin `server/index.ts`; every feature
   is `server/modules/<feature>/{index.ts barrel, *.module.ts factory,
   *.routes.ts, *.service.ts, tests/}` — `agent`, `auth`, `cli` (+ a sandbox
   service), `commands`, `file-tree`, `git`, `plugins`, `settings`, `system`,
   `user`, `voice`, `worktrees`. The provider runtimes moved but stayed JS:
   `claude-sdk.js → modules/providers/list/claude/claude-runtime.provider.js`
   (only **59 %** similar — upstream rewrote a lot of it, not just moved it),
   codex 83 %, opencode 82 %, cursor 79 %. Routes get their collaborators
   injected (`createAgentModule({ queryClaude, … })`, fs/crypto/spawn passed
   into routers).
2. **The rules are codified** in `AGENTS.md` +
   `.agents/skills/backend-module-standards/SKILL.md`: barrels only, no
   deep imports, shared types in `server/shared/{types,interfaces,utils}.ts`,
   thin routes, tests inside the module, export-at-declaration with a
   consumer comment.
3. **Build/deploy plumbing:** `scripts/promote-dist-server.mjs` builds into
   `dist-server.next` and promotes atomically (`preserver` recovers a
   half-promoted tree); `bin` moved to `dist-server/server/modules/cli/cli.js`;
   `npm test` / `npm run test:client` scripts; `load-env.ts`.
4. **Features we want:** gitignore-aware file tree; "keep background work
   alive after turn completion" (30-min background-agent ceiling); history
   refresh gated by chat visibility (their bandwidth fix); session deep-link
   resolution endpoint (we solved the same bug ourselves in `828b702a` —
   duplicate work to reconcile); Codex SDK 0.146; mermaid; `remark-breaks`;
   es/ko/zh-CN i18n; recent-conversation feed; copy provider session id;
   clock-skew-tolerant auth; `@/` alias resolution for the server test suite.

## Where we diverge

240 commits, **410 files, +55k/−4.7k**, concentrated exactly where upstream
moved things:

| our hot file | our commits since base | upstream did |
|---|---|---|
| `server/claude-sdk.js` (2.7k lines) | 39 | rename + 41 % rewrite |
| `server/index.js` (2.6k lines) | 29 | deleted; routes scattered into modules |
| `server/opencode-cli.js` | 12 | rename + 18 % rewrite |
| `server/modules/websocket/…/chat-websocket.service.ts` | 11 | rewritten (app session ids into runtimes) |
| `server/routes/agent.js` | 3 | deleted → `modules/agent` |

Plus whole areas upstream has no counterpart for: `server/manager/` (the
multi-worker vsa proxy), OIDC, the supervisor stack in `server/services/`
(session restore, rate-limit wake, task continuation, recap, telegram,
activity status), previews (html/custom/plantuml/dbml/csv/api-spec) with their
routes inline in `index.js`, worktrees, shares, compaction, private
sessions/shred. The good news: everything we added *recently* already follows
the module shape (`modules/websocket`, `modules/providers/list/*`,
`modules/database`, `modules/projects`, and now `modules/plugins`).

## Trial merge (throwaway worktree, `git merge origin/main`)

**108 conflicted paths**, of three kinds:

- **26 `AU` — bogus directory-rename detection.** Because upstream moved
  `services/vapid-keys.js → modules/notifications/` and `utils/* →
  modules/plugins/`, git "helpfully" relocated *our* `server/services/*`
  (rate-limit wake, session restore, telegram…) into
  `modules/notifications/` and our `server/utils/*` (htmlPreview, dbml,
  plantuml, allowedPaths, worktrees) into `modules/plugins/`. Every one of
  those is wrong and would need undoing by hand.
- **15 `UD`/`DU` — deleted on one side, edited on the other:** `index.js`,
  `cli.js`, `routes/{agent,auth,settings,user}.js`, `voice-proxy.js`,
  `notification-orchestrator.js`.
- **67 `UU` — real content conflicts**, including `claude-runtime.provider.js`
  (our 39 commits of nudge/reaper/idle/rate-limit/compaction logic against
  their background-keepalive rewrite), the websocket service, the database
  layer, `sessions.service.ts`, and ~20 chat components.

A single `git merge` is therefore not the tool. It is not that the conflicts
are many; it is that git's guesses about *where* our code belongs are wrong,
and the one file where the semantics genuinely collide (the Claude runtime) is
also our most-touched file.

## Verdict: adopt the new architecture — but port into it, don't merge

**Adopt**, because:

1. We were converging on it anyway. Every module we added lives in
   `server/modules/*` with a barrel; the things that don't (`index.js`,
   `services/`, `utils/`, `claude-sdk.js`) are our biggest merge liabilities
   and would be split up in any refactor we did ourselves.
2. `index.js` at 2.6k lines is the single largest reason every upstream sync
   hurts. Upstream's thin entry + per-feature modules is the fix we'd want.
3. Barrels and module factories give exactly the seams our supervisor stack and
   the new plugin host need (today `modules/plugins` is injected from
   `index.js` by hand; in the upstream shape it's a module like any other).
4. The standards are a *skill*, so agent-written code keeps the shape without
   review nagging. We can extend it with our own rules (privacy gating,
   contributor hooks, the "failed observation ≠ empty" rule).

Costs and risks, stated plainly:

- **Injection ceremony.** Passing `fs`, `crypto`, `os.homedir` into routers is
  verbose. Adopt the *layout* (modules, barrels, thin routes, tests-in-module);
  don't cargo-cult the injection where a direct import is clearer.
- **Deploy path changes.** `promote-dist-server` (dist-server.next → promote)
  and the new `bin` location touch the launchd deploy on this Mac, the
  verdaccio package, and `oqtopus/openclaw`'s Dockerfile. Small, but a
  release-day item, not a merge-day one.
- **The Claude runtime is the one semantic collision.** Upstream's
  background-agent keepalive holds CLI input open after a turn; our idle
  reaper, task-ledger nudge, rate-limit wake and compaction hooks all reason
  about "the turn is over". Port this file last, with its tests
  (`claude-sdk-*.test.js`) as the spec.
- **"TS everywhere" is aspirational even upstream** — the runtimes are still
  `.js`. Don't block on converting ours.

Rejected alternative — stay on our layout and cherry-pick upstream features:
every future upstream commit lands in `modules/*` files we don't have, so each
cherry-pick is a manual relocation, forever, and the gap only widens.

## Method

**Phase 0 — fence the personal integrations (done in this change).** Mission
Control and Anthill now live in a host-module plugin
(`~/projects/ai/vibespace-dudin-plugin`, symlinked into
`~/.claude-code-ui/plugins/`), reached through a narrow `PluginHost` API in
`server/modules/plugins`. Core keeps only a generic `collectAgentEnv`
contributor hook for private/ephemeral spawns. Less to carry through the port,
and the oqto package no longer ships them.

**Phase 1 — port, area by area, in a worktree.** Commit the WIP first (there
are ~50 modified files in the tree today). Then `git merge --no-commit
origin/main` and resolve by *class*, not by file order:

1. `AU` bogus renames: `git rm --cached` upstream's guessed path, keep ours
   where it was (`git checkout HEAD -- server/services server/utils`).
2. `UD` deletions: keep `index.js` and the old routes *temporarily*
   (`git checkout HEAD -- server/index.js server/routes`), so the tree runs.
3. `UU`: hand-merge in dependency order — `database` → `shared` →
   `providers/services` → `websocket` → `providers/list/*` → chat components.
   Run `npm test` and `npm run typecheck` after each area; the test suite is
   large enough (ours + theirs) to be the spec.
4. Then move our inline routes from `index.js` into modules
   (`file-preview`, `shares`, `worktrees` are already separable), retire
   `routes/*.js`, and switch to `server/index.ts` — at which point `index.js`
   and `routes/` can finally be deleted and the `UD` class disappears.

Estimate: 2–4 focused days. The Claude runtime alone is half of it.

**Phase 2 — after the port.** Move `server/services/*` (supervision) and
`server/utils/*` (previews, allowed paths) into modules per the skill; add our
own rules to `.agents/skills/backend-module-standards`; adopt
`promote-dist-server` and update the deploy notes and the oqto Dockerfile
`bin`.

**Phase 3** — subsequent `origin/main` merges are small again.

## While porting: the seams we must not lose

- `collectAgentEnv` / `registerAgentEnvContributor` (`server/shared/agent-env.ts`)
  — the only place private/ephemeral spawns are tagged. Upstream has
  `buildAgentEnv`'s ancestor but no contributor hook.
- `modules/plugins` host API — `createRouter/mountRouter`, `sessions.*`,
  `enqueueMessage`, `hmacSha256`, `onShutdown`. Upstream's `modules/plugins`
  is subprocess-only; ours must be merged *into* it, not replaced by it.
- `serverEnqueueMessage` + `registerChatDependenciesAtBoot` — server-initiated
  runs (restore, rate-limit wake, plugin queues). Upstream's rewrite of the
  chat service ("dispatch queued messages server-side", `react-doctor-changes`
  branch) is the closest thing they have; reconcile rather than keep both.
- Per-file `files.watch` (this change) next to the project watcher — upstream
  has neither.
