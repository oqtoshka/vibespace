# Child-process pipes and descriptors

## Why this exists

On 2026-09-29 an `xcodebuild` on the Mac stalled. `clang` was blocked in
`write()` to SWBBuildService, because every new pipe on the host was being
created with a 512-byte buffer instead of 65536. macOS does that when the
system-wide pipe memory runs short. Restarting only the VibeSpace server
brought 65536 back, so the pipes were being held by this server or by its
children.

Nobody took a snapshot before that restart, so which spawn site held the pipes
is **not proven**. A read-only look at the live server afterwards found:

| Holder | Descriptors |
| --- | --- |
| The server | 35 REG, 25 unix, 6 IPv4, 4 PIPE |
| One native `codex` | 9 PIPE, 9 unix, plus its Playwright MCP children |
| Host-wide | 453 PIPE, 182 of them held by node processes |

The descriptor sampler below exists so the next occurrence leaves evidence.

Two platform facts shape everything that follows:

- **libuv makes child stdio from socketpairs on macOS.** `lsof` therefore
  lists a child's stdio as `unix`, not `PIPE`. Real kernel `PIPE`s come from
  the children themselves: shells, `codex` and its MCP servers.
- **Node waits for every holder of a child's pipe.** The `close` event, and so
  `execFile`'s callback, fires only once every process holding the pipe has
  exited. A grandchild that keeps stdout open can outlive the timeout kill.
  Separately, a pipe nobody reads blocks its writer once 64 KiB are buffered.

## Audit

Line numbers refer to this branch.

### Verdicts

- **LEAK:** the spawn site holds a process and its pipes indefinitely on a
  normal path.
- **RISK:** it holds them only on a fault, such as a hang, a network stall or
  a SIGTERM being ignored.
- **OK:** neither.

"Default pipes" means stdin, stdout and stderr are all pipes, so stdin stays an
open pipe unless the code ends it.

### Fixed on this branch

| file:line | stdio config | close/drain/kill paths | verdict | fix |
| --- | --- | --- | --- | --- |
| `server/services/codex-app-server.service.js:64` (app-server, one per variant) | pipes ×3, JSON-RPC over stdin/stdout, stderr tail 4 KB | `getCodexAppServer` forgot a candidate whose initialize failed without stopping it. `stop()` sent SIGTERM only and never released the parent's pipe ends. | LEAK: one orphaned app-server per failed-init retry. RISK: a wedged native codex kept its stdio. | Failed init calls `candidate.stop()`. `stop()` is idempotent: SIGTERM, then SIGKILL after `VIBESPACE_CODEX_STOP_GRACE_MS` (5 s). stdio is destroyed on close. stdin gets an `error` listener (EPIPE). Commit `dc14215c`. |
| `server/openai-codex.js:136` (threads on the shared app-server) | inside the app-server | A loaded thread keeps its MCP servers (for example Playwright, each with pipes) until `thread/unsubscribe`. Nothing ever unsubscribed. | LEAK: MCP children accumulate for every thread ever resumed, for the server's lifetime. This is the most likely incident holder. | `holdCodexThread` counts residency. A thread idle for `VIBESPACE_CODEX_THREAD_IDLE_MS` (10 min; 0 disables) is unsubscribed. Commit `dc14215c`. |
| `server/modules/websocket/services/shell-websocket.service.ts:534` (PTY) | pty master fd | Re-initializing a socket onto a different session key dropped the previous PTY without killing it, and its timeout never ran. `kill()` sent SIGHUP only. | LEAK: one PTY and its shell tree per re-init. RISK: a shell ignoring SIGHUP. | The previous session is detached with its disconnect timeout armed. `killPtySession` sends SIGKILL after 5 s unless the PTY has exited. The handlers capture their own PTY, so a stale exit cannot delete a newer entry. Commit `7a07090e`. |
| `server/modules/plugins/plugin-registry.service.ts` (was `:157`, `:355`, `:400`, `:437`, `:467`; now `:222`, `:233`, `:406`, `:473`) | stdin ignored. `npm install` read neither stream; build, clone and pull left stdout unread. | Only the build had a 60 s timeout, and that was SIGTERM only. Clone and pull had no prompt suppression. | LEAK: more than 64 KiB of npm output blocks forever and nothing kills it. RISK: git stalls on the network or on a credential prompt. | Everything goes through `runRegistryChild` (`:163`). It drains stdout, keeps a stderr tail, and applies a timeout of 120 s (git), 300 s (install) or 60 s (build). A timeout sends SIGTERM, then SIGKILL after 5 s, and destroys the streams. `GIT_TERMINAL_PROMPT=0` is set. Commit `a966057c`. |
| `server/opencode-cli.js:492` (per turn), abort at `:694` | pipes, stdin ended, both streams read | Abort sent SIGTERM and dropped the handle immediately. | RISK: a wrapper that ignores SIGTERM becomes an untracked orphan with live pipes. | `terminateChild` (`server/shared/utils.ts`) escalates to SIGKILL after 5 s. Commit `dd541043`. |
| `server/cursor-cli.js:206` (per turn), abort at `:460` | pipes, stdin ended, both streams read | Same as OpenCode. | RISK | Same fix. Commit `dd541043`. |

### Remaining risks, not changed here

| file:line | stdio config | close/drain/kill paths | verdict | fix |
| --- | --- | --- | --- | --- |
| `server/modules/git/git.routes.ts:35` (`spawnAsync`, ~50 callers; fetch, pull and push at ~1401/1446/1514/1599) | default pipes, stdin never ended, both streams read | No timeout, no kill on request close, no `GIT_TERMINAL_PROMPT=0`. | RISK: a stalled network or credential prompt holds 3 pipes forever, and every UI retry adds another stuck process. | Timeout plus prompt suppression plus `req.on('close')` kill, using the `runRegistryChild` pattern. |
| `server/routes/agent.js:382` clone, `:1100` push; `server/modules/agent/agent.routes.ts:398` clone, `:1122` push | pipes, both streams read | No timeout. The JS version never sets prompt suppression; the TS version sets it only when a token is supplied. | RISK | Same. |
| `server/routes/agent.js:1063`, `:1079`; `agent.routes.ts:1085`, `:1101`; `taskmaster.routes.ts:105` | pipes, output tiny | No `error` listener. | Not an FD leak, but a failed spawn is an unhandled `error` that crashes the server. | Add `child.once('error', …)`. |
| `server/modules/worktrees/services/worktree-git.service.ts:16` | default pipes, stdin open | No timeout. | RISK (low): checkout hooks | Timeout. |
| `server/index.js:559`, `server/modules/system/system.module.ts:23` (`sh -c` update) | default pipes, stdin never ended | No timeout. Lifecycle scripts inherit an open stdin. | RISK | `stdio: ['ignore', …]` plus a timeout. |
| `server/services/opencode-server.service.js:181` (long-lived) | stdin ignored, both streams read | Stop and boot timeout send SIGTERM only, and not to the process group. | RISK: the native binary or tool shells under an npm wrapper can survive. | `terminateChild`, and a process-group kill where supported. |
| `server/modules/taskmaster/taskmaster.routes.ts:75` | pipes, stdin ended | No timeout; LLM calls can hang. | RISK (low) | Timeout. |
| `server/shared/opencode-context.ts:401`, `server/index.js:1274`, `server/modules/native-workspace/native-workspace.service.ts:171`, `server/utils/commandParser.js:281` | `execFile` with a timeout | The timeout kills only the direct child, and the callback waits for `close`. | RISK: a grandchild holding stdout hangs the call past its timeout. | Settle on a Node-side deadline, as `withDeadline` does in the observer, and destroy the streams. |
| `server/modules/browser-use/browser-use.service.ts:247` | stdin ignored, both streams read | 10 min, then SIGKILL to npm only. | OK: bounded, though a grandchild can delay `close`. | — |
| `server/cli.js:214`, `server/modules/cli/cli.module.ts:76` | `execSync` | No timeout, at startup. | Not an FD leak; a startup stall. | `timeout` option. |
| `server/modules/providers/services/session-conversations-search.service.ts:659` (rg) | stdin ignored | Request close aborts the signal. | OK | — |
| `server/modules/projects/services/project-clone.service.ts:131` | stdin ignored, `GIT_TERMINAL_PROMPT=0` | Request close cancels. | OK | — |
| Auth providers (`cursor-auth:77`, `claude-auth:203`, `codex-auth:24`, `opencode-auth:32`), `opencode-models.provider.ts:601`, `native-workspace.service.ts:93` | short, with a timeout | Timeout (SIGTERM). | OK | — |
| `server/modules/plugins/plugin-process.service.ts` (plugin servers) | read for their whole life | The ready timeout sends SIGTERM. | OK (SIGTERM-only on that one path) | — |
| `server/claude-sdk.js` (Claude Agent SDK sessions) | owned by the SDK | Idle reaper after 5 min. | OK | — |
| `routes/agent.js:72`, `:230`; `agent.routes.ts:103`, `:261`; `managed-profile.service.ts:7`; `routes/user.js:13`; `utils/gitConfig.js:6`; `user.module.ts:12`; `taskmaster.routes.ts:124`; CLI-only sites in `cli.js` / `cli.module.ts` | short, output read | Exit | OK | — |

## Observation: `GET /api/diagnostics/fd`

`server/modules/fd-observation/` samples this process's own descriptors on a
timer and keeps the results in a ring. The server starts it next to the
event-loop health monitor. The route is authenticated (`authenticateToken`),
because a sample lists child PIDs.

### Probe

| Platform | Descriptor source | Deadline |
| --- | --- | --- |
| Linux | `readdir` + `readlink` of `/proc/<pid>/fd`, classified as pipe, socket, file, dev, anon_inode or other | Node-side |
| Other | `lsof -n -P -w -p <pid> -F ft` | Node-side, as well as execFile's own SIGKILL timeout |

- Only numeric descriptors are counted.
- `-F ft` asks lsof for the descriptor and type fields only, so no path or
  socket peer is ever read.
- Children come from `pgrep -P <pid>`, run after lsof has finished so the probe
  does not count itself. Exit status 1 means no children.

### What a sample holds

A successful sample holds:

- `total`
- `byType` (counts per type)
- `children: { count, pids (at most 64), truncated }`

It records no request data.

### Bounds

| Setting | Default | Range | Environment variable |
| --- | --- | --- | --- |
| Interval | 60 s | 5 s – 1 h | `VIBESPACE_FD_SAMPLE_INTERVAL_MS` |
| Ring size | 60 | 1 – 1000 | `VIBESPACE_FD_RING_SIZE` |
| Probe timeout | 5 s | ≤ 30 s | `VIBESPACE_FD_PROBE_TIMEOUT_MS` |

- The timer is `unref`'d, so it never keeps the process alive.
- Concurrent `sample()` calls share a single probe.

### Failures

A failure is recorded as `{ ok: false, error }` and never as a zero. That
covers a missing lsof, a failed lsof, a timeout, empty output, and an
unreadable `/proc`. A missing pgrep leaves the descriptor counts in the sample
and records `children: { ok: false, error }`.

### Reading it

`?fresh=1` takes one sample before answering.

```sh
curl -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:3001/api/diagnostics/fd?fresh=1'
```

`PIPE` or `unix` climbing between samples while `children.count` stays flat
means descriptors are leaking in the server itself. Both climbing together
means children are being left behind.

## Tests

| File | What it covers |
| --- | --- |
| `server/modules/fd-observation/tests/fd-observation.service.test.ts` | Parsing; macOS and Linux probes; missing, failing, hung and empty lsof; pgrep semantics; PID cap; ring and clamps; shared in-flight probe; the real probe on this host |
| `server/modules/fd-observation/tests/fd-observation.routes.test.ts` | The route |
| `server/modules/fd-observation/tests/fd-churn.test.ts` | The churn test below |

### The churn test

`fd-churn.test.ts` runs 20 rounds (`FD_CHURN_ROUNDS`) in four parallel lanes,
all through the real code paths. That is about 100 children in total:

- Codex app-server clients that exit on their own.
- Codex app-server clients stopped with a request in flight.
- A SIGTERM-ignoring Codex app-server every third round.
- Registry children writing 200 KB bursts, plus hung registry children that
  must hit their timeout.
- A SIGTERM-ignoring CLI aborted through `terminateChild`.

Alongside the churn, a "compiler probe" runs
`sh -c 'head -c 262144 /dev/zero | cat'`. The 256 KiB go through a real kernel
pipe, and the probe must deliver all of them within 15 s.

Afterwards, three conditions must hold:

- Every recorded Codex PID is dead.
- The only live children are those that existed before the churn, such as
  tsx's esbuild service.
- PIPE+unix is within 2 of the baseline, and the descriptor total within 4.

Against the pre-fix `codex-app-server.service.js` the test fails with `codex
children alive: …`.
