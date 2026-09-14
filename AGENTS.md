# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Restarting the server

Restarting VibeSpace to put a fix live is safe — do it without asking and without waiting for sessions to go idle, including the session you are running in. Live sessions are recorded in `<dataDir>/active-agent-sessions.json`; on boot `server/services/session-restore.service.js` resumes every one that had a turn in flight or open items in its task ledger with a `[session supervisor]` continuation turn, and sessions parked on a usage limit stay with the wake scheduler. The only thing lost is the interrupted turn itself, which the resumed agent picks back up. (`VIBESPACE_SESSION_RESTORE=0` disables the boot pass — check it is unset before relying on this.)
