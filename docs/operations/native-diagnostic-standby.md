# Native diagnostic standby: unexposed source preparation

This slice is **not an installed observer or usable per-session routing feature**.
The factory in `server/modules/providers/services/codex-diagnostic-binding.service.ts`
is used by an unregistered routing factory and tests. Neither factory is exported through the Providers barrel,
registered in HTTP/plugin APIs, or selected by `openai-codex.js`. Existing shared,
private, and ephemeral clients retain their existing behavior.

The internal factory accepts an opaque host-reviewed executable recipe, pins its
SHA-256, canonical absolute path and read-only executable mode, and rechecks the
bytes before an explicitly configured stdio spawn. Its diagnostic capture directory
must be canonical and private. The recipe requires the reviewed native
`exec-fingerprint-utc-v1` contract: exact native UUID, new create-only capture file,
and `YYYY-MM-DDTHH:MM:SSZ` deadline no more than 900 seconds in the future, with a
native monotonic cutoff. A contract string is a trusted bootstrap attestation,
not independent proof that a binary implements the overlay. No bootstrap currently
supplies a production artifact. The historical reviewed full CLI lacks the final
hard-expiry overlay and **must not be declared capture-ready**. The filtered native
test executable is not a production CLI replacement.

The standby is bound to one canonical application session UUID, native thread UUID,
and generation. Scope/environment copies and returned handles are immutable. Both
wall and monotonic deadlines gate selection. Private sessions, side sessions,
rebound handles, duplicate native bindings, stale host leases, missing ownership,
changed source bytes, active/UNKNOWN observations, and lifecycle changes fail
closed. The injected host reservation is at most 60 seconds, and owned-descendant
checkpoint checks have a 1.5-second bound. The cached shared peer and its exact native
inventory are checked without spawning a replacement for that ordinary peer.

Preparation is deliberately conservative: every loaded thread in the old shared
peer must be idle. It does not move, unsubscribe, or resume the target. The dedicated
ordinary standby interface only allows inspection. Initialization
failure stops only the newly owned candidate and releases its listeners/reservation.
Expiry refuses selection and attempts targeted cleanup. If an actual native
observation is active or UNKNOWN, cleanup defers and retains the entry; an explicit
later idle cleanup can remove it without stopping unrelated cached peers. The
standby drains stderr without collecting it and emits finite local error reasons.

## Dormant host and residency integration

The unregistered host adapter uses the real session database and chat-run admission
registry. It reserves a 15-second host lease and rechecks provider/native identity,
public/non-side/non-archived state and an explicitly supplied resource generation.
A separate trusted owner-checkpoint callback is mandatory and bounded to 1.5 seconds.
An idle host or empty inventory never substitutes for that callback.

The internal routing factory snapshots every existing shared/private/ephemeral and
dedicated cached peer without spawning an ordinary replacement. It verifies target
and owned-descendant idle states, rejects another peer hosting any of those IDs,
and retains lifecycle invalidation across inventory reads, unsubscribe, resume and
verification. A later idle read never clears a prior activity notification. Under
the host lease it unsubscribes descendants before their root, proves old ownership
absent, then resumes the exact native root on the pinned dedicated peer. The final
conservative check requires every cached native peer to be idle. Ordinary runtime
paths do not yet observe or participate in this transfer.

Only a claimed transfer capability permits exact-thread resume/unsubscribe/turn
operations. Native approval and user-input server requests use the existing approval
broker; unbound or unsupported requests are declined/cancelled. The scoped selector
returns the same dedicated client for turn, history and idle reads. History is read
only; normal turn handles cannot change residency. Deadline expiry denies new turn
admissions, including a previously acquired handle starting a new turn after expiry.
It neither kills existing work nor disables an already held turn's steer/interrupt.
History stays on that same client after capture expires. Handle release is
idempotent and prevents further requests through that handle.

Resume failures are ambiguous until actual peer inventory/status checks succeed.
Rollback requires still-valid host admission, explicit owner checkpoints, all-peer
idle checks and no lifecycle change; it unloads the dedicated root before restoring
the original root/descendants. Active, UNKNOWN, rebound or changed-lifecycle cases
retain a quarantined route. They never restore a second host or stop active work.
Once claimed, ordinary binding expiry cleanup cannot stop the peer independently.
An explicit dormant `returnToOrdinary(scope)` now coordinates idle return. No runtime
bootstrap, timer or automatic idle retry invokes it; retained peers still require
an explicit trusted caller.

## Explicit coordinated return and idle cleanup

The dormant return operation serializes selection and requires zero holds, current
host/session identity and a fresh bounded admission lease. Releasing a handle while
an async request is pending does not remove its hold: both success and rejection
must settle before return can proceed. Capture expiry keeps held steer/interrupt
controls on the same client and never forces a turn interruption.

Return inventories every cached peer and requires the same original shared client,
all-native idle observations, target/owned-descendant identity and explicit owner
checkpoints. It unsubscribes observed dedicated descendants before the root, proves
them absent from other peers, restores the root/descendants on the retained original
client and independently verifies ownership and idle status before targeted cleanup.
The cleanup capability rechecks host lease, identity and lifecycle synchronously
AFTER its async idle observation, immediately before stopping only the owned empty
peer. Admission's monotonic duration never extends beyond 15 seconds on clock rollback.

Held/pending handles or unavailable admission defer return without unloading work.
Active, UNKNOWN, unrelated dedicated residency, duplicate native ownership, rebound
or replaced cached-client identity refuse cleanup. Ambiguous unsubscribe/resume or
late activity after mutation quarantines the route, retaining transports. Explicit
retry reconciles actual original/dedicated inventories; it never resumes a second
host because a provider response failed. There is no new timer or installed runtime
caller. Actual full-native notification/ownership behavior remains a release gate.

## Required before exposing or activating routing

1. Build and independently verify a complete native CLI with the hard UTC/monotonic
   expiry overlay. Pin its actual SHA in a trusted immutable release artifact.
   Read-only mode and hash rechecks do not stop the same owner replacing files or
   ancestor directories between verification and path-based execution. Bootstrap
   must enforce trusted artifact ownership and release identity.
2. Bootstrap the adapter with the actual trusted resource generation and external
   session-owner checkpoint source. Real SQLite/registry fixtures do not establish
   deployment admission, external native ownership or operator authorization.
3. Integrate the dormant selector with every legacy runtime turn/resume/history/idle
   path and serialize those paths against residency transfer. Host admission covers
   VibeSpace starts, not an external terminal owner starting native work.
4. Verify transfer, notifications and native server-request semantics against the
   complete reviewed native CLI. Synthetic peers use the real transport but are not
   proof of every native notification sequence; uncertain sequences deliberately
   quarantine rather than claim successful migration.
5. Preserve the same immutable handle/client across actual runtime paths. Do not add
   a global executable override or caller-provided executable/environment.
6. Integrate the explicit coordinated return with runtime idle retry/release lifecycle.
   Never interrupt active turns because capture expires. Closed/UNKNOWN claimed
   entries remain conservatively retained until actual reconciliation is possible.
7. Independently repeat transport/rollback/residency fixtures and full native
   HTTP/WS capture correlation before deployment.

Fixtures prove preparation/refusal/cache identity, filtered environment, bounded
ownership, unchanged ordinary transports, monotonic expiry, real session/host
admission, residency transfer, approval round trips, rollback/quarantine, read-only
history and same-client selection. Standby-only cleanup is verified separately;
claimed-peer return and cleanup now have explicit source-only tests, but automatic
runtime cleanup remains unimplemented. This slice neither diagnoses the
primary whitespace cause nor makes runtime capture-ready.
