# Janitor inbox

Janitor is an optional worker-scoped cleanup reviewer. It appears in the sidebar
with an unread count, proposals, bounded text previews, explicit selection,
Keep, Move to trash, and Restore. Opening the inbox never moves files. It has its
own read-only system prompt; the model has no tools or filesystem mutation API.
No Telegram/email notification is sent. The durable badge is visible next time
the user opens VibeSpace.

## Deployment settings

- `VS_JANITOR_ENABLED=true` enables routes and the scheduled runner.
- `VS_JANITOR_ROOT=/workspace` restricts inventory and file actions to this root.
- `VS_JANITOR_API_BASE` is an operator-owned OpenAI-compatible `/v1` base URL.
- `VS_JANITOR_MODEL` selects the model alias; it has no product-specific default.
- `VS_JANITOR_API_KEY`, when needed, is server-side only. A credential-stamping
  tenant sidecar can avoid exposing a provider key to the worker.
- `VS_JANITOR_TIMEZONE` defaults to UTC. Nightly scans run between 03:00 and 07:00
  in that timezone, once after success, retrying failure at most hourly.
- `VS_JANITOR_STATE_FILE` optionally overrides `~/.vibespace/janitor.json`.

The user can disable nightly scans without disabling manual review. Active
VibeSpace turns defer scanning and block approval. The registry does not detect
independent external agents (for example a separate gateway sharing the files);
content identity is rechecked at approval and all moves remain recoverable.

## Bounds and conservative defaults

Each scan walks at most 5,000 entries, depth six, and reviews up to 100 regular
files, at most 5 MiB each and about 40 MiB total. Files must be older than 48 hours.
Dotfiles, symlinks, credentials by filename, databases, agent instructions,
managed paths, skills and memory directories are excluded. Filesystem/policy
observation errors fail the scan rather than pretending the workspace is empty.

Text samples are limited to 1,200 bytes per eligible file. Session context is a
sample of up to five non-private inactive sessions from the latest 100 indexed
sessions, up to ten normalized messages / 6,000 characters each. This is not an
exhaustive historical search. Session reads and the model request have deadlines.
Model output is restricted to up to 50 paths from the supplied inventory; invented
paths and unrelated session IDs are discarded. File/transcript content is treated
as untrusted data. The model's opinion never authorizes a file operation.

Failed scans preserve pending proposals and show an error. Kept proposals are
suppressed while their content hash remains unchanged. The inbox explicitly says
that zero proposals does not mean an exhaustive inspection was completed.

## Approval and recovery

Approval rechecks the path, current deployment policy, regular-file identity,
size, modification time and SHA-256. Files changed since analysis become stale.
Nothing executes model-supplied commands. A write-ahead manifest records moves
into `.vibespace-trash/<random-id>` on the workspace filesystem. In-flight move
records are reconciled after restart. Protect/hide that directory in managed
file policy so the inbox remains the intended recovery interface.

Restoration uses an atomic no-overwrite link then removes the trash entry. An
existing destination, changed parent, symlink or revoked policy blocks restore
and preserves the trash file. Results are per-item; partial failure is visible.
Trash has no automatic purge in this version and does not reclaim storage until
an operator/user explicitly removes retained contents outside this workflow.

This is an application-level accident-prevention workflow, not protection against
a malicious process concurrently changing the same filesystem. Storage backups
and OS isolation remain necessary. It does not create a second general-purpose
agent with shell access.

## Validation

Tests cover explicit approval, unknown model paths, protected and changed files,
active sessions, failed observations, keep decisions, symlinked trash, crash
recovery, no-overwrite restore, concurrent scans and route validation. Browser
checks cover badge, preview, unchecked defaults, selection, trash/restore and
nightly preferences. No production user files are removed during validation.
