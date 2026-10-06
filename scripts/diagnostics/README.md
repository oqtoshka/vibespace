# One-thread reporting whitespace observation

Source-only opt-in app-server wrapper. This does not install itself or change a running
VibeSpace process. Requires existing Node, packaged TypeScript runtime dependency and an
existing native Codex CLI with `experimentalRawEvents` support. Verify compatibility
with a synthetic fixture before considering an observation on an existing thread.

## Boundaries and evidence

The wrapper forwards native stdout buffers unchanged. It observes selected native
`rawResponseItem/completed` exec literals immediately before/after that forwarding
operation. `forwarded-code-mode` means the wrapper's stdout writer boundary, **not an
independent observation inside the final VibeSpace consumer**. Native executable SHA256,
PID and argv hash identify the source; a CLI version must be recorded separately with
`codex --version`. This does not capture the upstream provider HTTP/SSE response.

Raw-to-forwarded comparison requires matching native call IDs. Outgoing reporting tool
notifications sometimes expose a different dynamic call ID with no parent link. Their
comparison is explicitly a unique thread/turn/tool/field inference; duplicate or missing
stages are `unobserved-or-ambiguous`. A missing outgoing notification proves nothing about
report delivery. Dynamic expressions and nested functions are not evaluated or traced.
Encrypted compaction cannot be decoded by this instrumentation. It cannot establish
whether a supplied context caused an earlier model output.

Only the selected thread's allowlisted MC reporting string fields are fingerprinted.
No prose, source, prompts, credentials, other tool arguments or other thread values are
written. Records contain SHA256, lengths, Unicode whitespace offsets and correlation
IDs. Hashes are not encryption: protect the local diagnostic artifact as sensitive
metadata. The exclusive output file has mode 0600. Diagnostics disable themselves after
1 MiB of output, an 8 MiB parser buffer, parser/observer or file-write failure. Transport
continues. Sources/values over 1 MiB and more than 256 tracked field groups/rows are not
fully observed; these limits provide no coverage claim.

## Deliberate enable / disable

After a separate reviewed, quiescent supported VibeSpace lifecycle change, configure its
existing executable override and three private environment variables:

```
VIBESPACE_CODEX_PATH=/absolute/worktree/scripts/diagnostics/codex-report-whitespace-proxy.mjs
VIBESPACE_CODEX_DIAGNOSTIC_NATIVE=/absolute/existing/codex
VIBESPACE_CODEX_DIAGNOSTIC_THREAD=<one-existing-native-thread-UUID>
VIBESPACE_CODEX_DIAGNOSTIC_OUTPUT=<allocated-artifact-directory>/report-fingerprints.jsonl
```

The native executable must differ from the wrapper. The output file must not already
exist. Only matching `thread/resume` adds `experimentalRawEvents: true`; initialization
adds `experimentalApi: true`. Thread creation and other threads are unchanged. There is
no login, new provider, default tracing, or runtime installation in this change.

To disable observation, remove the THREAD and OUTPUT variables: the wrapper then passes
stdin/stdout bytes unchanged. To roll back entirely, restore the original CODEX_PATH and
remove all DIAGNOSTIC variables through the same supported lifecycle. Already retained
artifacts remain under their tracked resource policy. No global process kill is needed.

## Independent repeat

```
node --test scripts/diagnostics/codex-report-whitespace.test.mjs
node scripts/diagnostics/codex-report-whitespace-proxy.check.mjs <allocated-artifact-directory>
```

The second check launches only a local synthetic fake native executable, not a provider.
It verifies target-only enablement, unchanged forwarded UTF8 bytes, deliberate deletion
detection, disabled identity and exclusion of synthetic secret sentinels. It retains
its bounded fixture files inside the passed tracked artifact directory.
