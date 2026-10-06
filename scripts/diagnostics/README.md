# One-thread reporting whitespace observation

Opt-in app-server wrapper. This does not install itself or change a running VibeSpace
process. Uses existing Node, packaged TypeScript runtime and an existing native Codex
CLI. Verify compatibility with a synthetic fixture before enabling a capture.

## Boundaries and evidence

The wrapper forwards native stdout buffers unchanged, then parses a copy of selected
`rawResponseItem/completed` exec literals. `native-raw` and `forwarded-code-mode` are two
labels for that same parsed notification. Their agreement is expected by construction;
the synthetic transport check independently verifies actual forwarded bytes.
`forwarded-code-mode` means the wrapper's stdout writer boundary, **not an independent
observation inside the final VibeSpace consumer**. Native executable SHA256, PID and argv
hash identify the source; record CLI version separately with `codex --version`. This does
not capture the upstream provider HTTP/SSE response.

Raw-to-forwarded comparison requires matching native call IDs. Outgoing reporting tool
notifications sometimes expose a different dynamic call ID with no parent link. Their
comparison is explicitly a unique thread/turn/tool/field inference; duplicate or missing
stages are `unobserved-or-ambiguous`. A missing outgoing notification proves nothing about
report delivery. Dynamic expressions and nested functions are not evaluated or traced.
Encrypted compaction cannot be decoded by this instrumentation. It cannot establish
whether supplied context caused an earlier model output.

Only the selected thread's allowlisted MC reporting string fields are fingerprinted.
No prose, source, prompts, credentials, other tool arguments or other thread values are
written. Records contain SHA256, lengths, Unicode whitespace offsets and correlation
IDs. Hashes are not encryption: protect the local artifact as sensitive metadata.
The exclusive output file has mode 0600. Existing output, unwritable paths, invalid
diagnostic configuration and a missing parser runtime fall back to unchanged native
transport. Diagnostics disable after 1 MiB of output, an 8 MiB stdin/stdout parser buffer,
parser/observer or file-write failure. Fixed stderr labels identify lost coverage without
exception text or paths. Sources/values over 1 MiB and more than 256 tracked field
groups/rows are not fully observed; these limits provide no coverage claim.

## Dedicated process enable / disable

Set these variables only for the dedicated process:

```
VIBESPACE_CODEX_PATH=/absolute/release/scripts/diagnostics/codex-report-whitespace-proxy.mjs
VIBESPACE_CODEX_DIAGNOSTIC_NATIVE=/absolute/existing/codex
VIBESPACE_CODEX_DIAGNOSTIC_THREAD=<one-existing-native-thread-UUID>
VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT=<allocated-artifact-directory>/report-fingerprints.jsonl
```

The native executable must differ from the wrapper. Use a strict native thread UUID.
Only matching `thread/resume` adds `experimentalRawEvents: true`; initialization adds
`experimentalApi: true`. All other stdin messages and all stdout bytes are forwarded
unchanged, including spacing, CRLF and unterminated input. There is no login, new provider,
default tracing or runtime installation in this change.

Remove THREAD and OUTPUT to disable capture: the wrapper then passes stdin/stdout bytes
unchanged. Restore the original CODEX_PATH and remove DIAGNOSTIC variables to roll back
entirely. Retained artifacts stay under their tracked resource policy.

## One existing VibeSpace session: supported capture lifecycle

This is a release-operator procedure. The proxy must host the selected thread's actual
app-server. A separate `thread/read` process or a provenance-only file provides no live
pre-tool evidence. Do not replay old tools or start an extra paid provider turn merely to
populate the artifact.

1. Record the selected native thread UUID, session ID, ordinary/private variant, exact
   native executable and version, release/plugin receipts, and existing executable
   override (presence and value only for this non-secret key). Allocate a tracked private
   artifact directory. Run the synthetic check below on the exact proxy release first.
   Check that parser runtime and executable assets are present.
2. In a machine-local private directory, create an executable shim with mode 0700 using
   the template below. Substitute absolute paths and one selected UUID. Point at an
   immutable packaged proxy; production must not point at a worktree to be removed.
   A separate filename per shim PID avoids ordinary/private/retry capture collisions.
   Each file remains filtered to the same single target UUID.
3. Set only the existing `VIBESPACE_CODEX_PATH` override to that shim through the approved
   local launch/release wrapper, retaining an exact rollback. Keep diagnostic values
   inside the shim. Putting them in shared `.env` is insufficient: loaded server
   configuration keys are stripped from child environments by `buildAgentEnv`.
4. Checkpoint owned agents and record resume notes before the supported, health-checked
   restart with rollback. Verify the hosting app-server's receipt, proxy provenance and
   selected thread resume. Other app-servers may create provenance-only files; these
   supply no observation of the selected thread. A setup/cap/error stderr label means
   coverage stopped, even if the session continues normally.
5. Observe the next already-authorized selected-session turn. Do not replay reporting
   mutations. Compare the fingerprint of the MC field in the native exec code literal
   against outgoing tool notification and independently recorded reporting argument.
   Require matching UUID/turn/tool/field, unique occurrence, and available call IDs; if a
   link is absent, retain its explicit inference label. Missing stages remain unobserved.
6. At the agreed capture deadline, restore the original executable override through the
   same launch/release wrapper and supported restart. Verify fresh Codex processes use
   the original executable. Closing this window belongs to the operator's tracked
   lifecycle: removing a shim alone does not stop an already-running proxy's capture.

Private shim template (no credentials or session prose):

```sh
#!/bin/sh
capture_directory='/absolute/allocated/private/artifact-directory'
export VIBESPACE_CODEX_DIAGNOSTIC_NATIVE='/absolute/existing/native/codex'
export VIBESPACE_CODEX_DIAGNOSTIC_THREAD='11111111-1111-1111-1111-111111111111'
export VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT="$capture_directory/report-fingerprints.$$.jsonl"
exec '/absolute/existing/node' '/absolute/immutable/release/scripts/diagnostics/codex-report-whitespace-proxy.mjs' "$@"
```

The shim changes only its subprocess environment. Selecting it as the executable affects
each shared app-server variant on restart; UUID filtering limits retained report metadata,
not process lifecycle. Record that boundary explicitly when enabling capture.

## Independent repeat

```
node --test scripts/diagnostics/codex-report-whitespace.test.mjs
node scripts/diagnostics/codex-report-whitespace-proxy.check.mjs <allocated-artifact-directory>
node --test scripts/diagnostics/codex-report-whitespace-packaging.test.mjs
```

The integration check launches only local synthetic fake native executables, not a
provider. It verifies exact child argv, unrelated stdin and stdout bytes (including split
Unicode, invalid UTF8 and CRLF), target-only injection, deliberate deletion detection,
mode 0600, sentinel exclusion, collisions/concurrent opens, missing parser,
invalid/unwritable output, short/zero/failed writes, actual parser stack exhaustion,
input/output buffer caps, output cap and native exit propagation. Bounded fixture files
remain inside the allocated tracked directory.
