# Native diagnostic standby: unexposed source preparation

This slice is **not an installed observer or usable per-session routing feature**.
The factory in `server/modules/providers/services/codex-diagnostic-binding.service.ts`
currently has only a test caller. It is not exported through the Providers barrel,
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
standby only allows inspection; start/resume requests are refused. Initialization
failure stops only the newly owned candidate and releases its listeners/reservation.
Expiry refuses selection and attempts targeted cleanup. If an actual native
observation is active or UNKNOWN, cleanup defers and retains the entry; an explicit
later idle cleanup can remove it without stopping unrelated cached peers. The
standby drains stderr without collecting it and emits finite local error reasons.

## Required before exposing or activating routing

1. Build and independently verify a complete native CLI with the hard UTC/monotonic
   expiry overlay. Obtain its actual SHA and place it in a trusted, immutable release
   artifact. Read-only mode plus hash rechecks do not stop the same owner replacing
   files or ancestor directories between verification and path-based execution.
   The future bootstrap must enforce trusted artifact ownership and release identity.
2. Wire the real bounded host admission and actual session-owner checkpoint source.
   The current factory only accepts injected dependencies; its tests do not establish
   real deployment admission or operator authorization.
3. Verify target residency across every relevant cached peer. Standby preparation
   checks the old shared peer only and does not prove no private/ephemeral transport
   hosts the same target. Actual transfer must refuse concurrent native hosting.
4. Implement a serialized residency transfer with lifecycle invalidation and idle
   checks for the target and its owned descendants. Unsubscribe the old owner only
   inside that verified transfer; handle rollback and initialization failures safely.
5. Bind turn, resume, history and idle inspection to the same immutable handle/client.
   Do not add a global executable override or caller-provided executable/environment.
6. Add the runtime idle retry/eviction lifecycle after expiry and define release
   removal/revocation. Never interrupt active turns merely because capture expires.
   Closed/UNKNOWN entries intentionally remain conservatively retained in this slice.
7. Independently repeat real transport fixtures, transfer/rollback/residency tests,
   and full native HTTP/WS capture correlation before deployment.

The current synthetic fixture suite proves preparation/refusal/cache identity,
secret-filtered environment, bounded ownership, unchanged ordinary transports,
monotonic expiry, active/UNKNOWN cleanup deferral, and targeted idle cleanup. It
neither diagnoses the primary whitespace cause nor makes the runtime capture-ready.
