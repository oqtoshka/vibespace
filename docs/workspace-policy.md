# Workspace presentation and protection

Local file-tree preferences allow hiding individual entries through their context
menu. Settings → Appearance → Workspace files → Show hidden files and folders
reveals them again. Preferences are browser-local and scoped to the signed-in
username. Hiding is presentation only; hidden files remain readable by path.

Managed deployments set `VS_WORKSPACE_POLICY_FILE` on each worker to a
read-only policy file:

```json
{
  "version": 1,
  "root": "/workspace",
  "rules": [
    { "path": ".config", "hidden": true, "readOnly": true },
    { "path": "system/skills", "readOnly": true, "description": "Managed tools" },
    { "path": "local-memory", "displayName": "Local memory", "description": "Personal agent notes" }
  ]
}
```

Paths are exact, relative to the configured workspace root, with `/` separators;
no globs, absolute paths or traversal. Hidden/read-only rules inherit to children.
Display names and descriptions apply to the exact entry, without renaming disk
paths or changing copied paths and agent references. Ancestors containing protected
entries cannot be renamed, deleted or moved. File saves, creation, uploads,
rename/delete and drag/drop enforce protection server-side across both current
and legacy file APIs. Canonical path checks cover symlink aliases and nested
projects. User-created skill directories need not be protected.

This is accidental-edit protection in VibeSpace APIs, not a shell sandbox. Agents
and terminal commands need read-only mounts or OS permissions if they must also
be prevented from changing managed files. Concurrent malicious filesystem changes
can race application-level path checks; filesystem isolation remains the boundary.

## Manager administration

Set `VS_WORKSPACE_POLICY_FILE` on the manager to the same policy (at its manager
mount path), and explicitly list administrators in `VS_WORKSPACE_POLICY_ADMINS`
(comma-separated verified usernames). Configure `VS_OIDC_REDIRECT_URI` for the
public origin check. The worker never exposes the write API. Ordinary users
cannot enable administration with their own preferences.

The admin form appears in Appearance settings only for authorized identities.
It edits paths, labels, descriptions, hidden and read-only flags. Writes require
a matching revision, are serialized within the manager, and atomically replace
the file. A stale form must reload; the administrator's unsaved edits are retained
until they choose to reload. Same-origin JSON is required.

Mount the **containing directory** read-only into workers, not just the JSON file:
a single-file bind mount would pin the old inode after an atomic replacement.
The manager needs write access to the directory. Its adjacent
`<policy-file>.audit.jsonl` records prepared changes with actor/before/after and a
commit marker after replacement. Prepared alone is not proof of success.
Workers read current policy on each mutation; presentation refreshes on window
focus and after a local admin save. A configured missing/malformed policy fails
closed for writes. Unconfigured local installations keep ordinary behavior.

The first implementation expects one manager writer per shared policy file;
it does not provide a distributed lock across multiple manager processes.

## Validation

Module tests cover paths, aliases, ancestors, invalid/unavailable policy, reload,
authorization, concurrent/stale saves, audit and cross-origin rejection. File-tree
service tests prove all write methods consult the policy before mutating protected
content. Browser checks cover hide/unhide, reveal, labels, disabled protected menu
actions and admin saves. No AI Marketing paths or identities are built into the
public product.
