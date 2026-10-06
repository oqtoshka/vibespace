# Native thread observations before a restart

A persistent Codex app-server PID is a transport, not a session. VibeSpace caches
one transport for each shared/private variant. Several unrelated sessions and
native child agents can use it; it can survive all their turns. Presence cannot
prove an active foreign turn, and absence of a host chat run cannot prove that
an autonomous native child has finished.

The authenticated `GET /api/providers/sessions/restart-admission` endpoint reads
only **existing** cached Codex clients. It never calls the client initializer,
starts/resumes a thread, starts a model turn, interrupts a thread, or kills a
process. For each client it paginates `thread/loaded/list`, requests
`thread/read` with `includeTurns:false`, then repeats the loaded inventory.
The supported native protocol reports `Thread.status` and `parentThreadId`.
Only `idle` is known idle; `active` (including waiting flags) blocks quiescence.
`notLoaded`, `systemError`, unrecognized statuses, errors, timeouts, pagination
cycles, changed inventories, replaced transports, or lifecycle notifications
during observation return UNKNOWN. Requests have a shared eight-second budget,
a maximum 1.5-second request timeout and 500 loaded-thread cap per transport.
The request deadline also bounds a cached client whose readiness handshake never settles; its clock uses monotonic elapsed time. These are conservative diagnostic bounds, not claimed runtime capacity.

Output contains transport variants/PIDs and counts for loaded, active, child,
active-child and unknown threads. It excludes thread IDs, names, previews,
messages, paths, environment, credentials and native error payloads. The same
existing Providers authentication remains mandatory. This observation does not
change anyone's permission or publishing/restart policy.

`nativeThreadsIdle` is a point-in-time snapshot, **not an admission lock**;
`restartAuthorized` is always false. A deployment owner must combine a fresh
successful snapshot with host registry zero, complete provider-process ownership
(the snapshot PIDs must cover every observed native app-server), current child
checkpoint receipts, unchanged candidate/stage hashes and previous links,
restore settings, and the operator's applicable restart authorization. Other
provider kinds and externally owned terminals are outside this Codex observer;
unknown owners remain blockers. A transport created or a turn begun after the
response can invalidate it. Do not advertise an atomic global admission barrier.

## First-install limitation

An older installed server without this endpoint cannot obtain new same-client
observations by running a second app-server, reading saved transcripts or
attaching to the existing process. A local test or new source commit is not
live proof. Installing a release with `--no-flip` leaves the old runtime and
its observation limitation intact. Its first cutover therefore needs an
independent restart-safe checkpoint of every potentially active owner; this
endpoint can strengthen subsequent cutovers only after it is actually running.
Plugin install/update does not bootstrap this observer: the supported plugin
management service restarts only plugin server subprocesses. In-process host
extensions are activated at VibeSpace boot, skip already active modules, and
receive no cached native RPC capability. Session-peer routing and native-control
session operations do not expose `thread/loaded/list` over an existing client.
Replacing files therefore cannot retrofit the observer into the running process.
Do not attach to a process, initialize a second client, or treat a saved
`turnActive:false` record as live native-child proof.

For the first cutover, collect restart-safe receipts from each affected existing
session owner, including that owner's native children: source/artifact checkpoint,
terminal owned jobs, no further scheduled/queued turns, child completion state,
and safe resume instructions. Reconcile that roster with host processing runs,
saved session ownership and the complete provider process tree. A persistent
shared/private transport may cover several owners and does not identify them;
any uncovered owner/native child remains UNKNOWN. The deployment owner must
reach the already-required foreign-session completion checkpoint, rather than
request another generic permission to restart or silently loosen the gate.
Do not repeatedly arm a waiter requiring idle cached transport PIDs to disappear.

## Supported staged publication boundary

1. Independently verify the proposed source commit, package/build/security gates,
   immutable plugin inventory and checkpoint notes. The deployment owner records
   previous server/plugin targets, rollback and resume paths before restart.
2. Use supported `scripts/release/install-local.mjs --source <reviewed source>
   --no-flip` to prepare and smoke/security-test the installed server release.
   Preserve the exact resulting `release-source.json`; do not pick a release by
   mtime alone. Stage preparation is distinct from restart admission.
3. After the complete authorized admission check, use supported
   `scripts/release/cutover.mjs --release <exact installed release> --link
   <server link> --also <plugin link>=<immutable plugin> --service <service>
   --probe-url <health> --expect-version <version> --detach`.
   It runs independently of the restarted session and probes/rolls back both
   links on failure. Record its run-specific receipt, not an older RESULT.
4. On resume, read the current run's status/log and both actual links before
   reporting LIVE or ROLLED_BACK. Resume children from preserved checkpoints.

The observer itself installs nothing, flips no link and schedules no restart.
