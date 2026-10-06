# Dormant legacy selector boundary

The ordinary Codex runtime retains its existing behavior when no scope is mounted.
`transferCodexDiagnosticRuntime` is source-only and has no server-startup, HTTP,
plugin or environment caller. It accepts a prepared handle and calls the reviewed
routing adapter; it cannot review a binary, create a standby or produce consent.

The mounted selector serves turn/start, steer, interrupt and paginated reverted
history through the routing adapter's immutable scope. Diagnostic execution does
not call the ordinary thread/resume or create ordinary idle-residency timers.
The hold is released in the existing finally block. Diagnostic rewind is explicitly
unavailable because the reviewed routing contract does not permit thread/rollback.
Removing a registration while the route still owns the thread is refused, including
quarantine. Coordinated return must finish before removing the selector.

The bridge installs a fail-closed pending selector synchronously before awaiting
the routing transfer. Legacy execution therefore cannot resume the ordinary peer
in the gap after the routing admission lease is released. Success commits the
selector; failure removes it only after routing state is confirmed null. Unknown
ownership or quarantine retains refusal. Exact-scope reconciliation may release
that gate only after coordinated return proves no remaining diagnostic route.
This dormant transaction still needs independent review before any activation.

## Owner-checkpoint audit

The database provider/native mapping identifies the indexed conversation. The
chat registry's admission lease excludes host-dispatched turns. Neither proves
that an external CLI owner, an agent with pending tool work, or a native descendant
has saved its work and consented to transfer.

The current native-control owner-capability response establishes local ownership
and permissions, not a fresh checkpoint tied to the exact generation, native
descendants and transfer. The session-restore activity snapshot records turnActive
and wake state, not checkpoint acknowledgement. Presence, an empty task ledger,
idle thread/read and a successful old handshake therefore remain insufficient.
No trustworthy external-owner checkpoint producer was found in these paths.
`createCodexDiagnosticHost` must continue to require its explicit callback and
refuse admission if that producer is missing, stalls or returns false.

A future activation needs a reviewed standalone CLI, canonical generation source,
fresh acknowledgements from every relevant owner, complete coordinated return,
and a bounded host-controlled preparation/transfer workflow. This change supplies
none of those authorizations and installs no observer. The whitespace root cause
remains unknown.
