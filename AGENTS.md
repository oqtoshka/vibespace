# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Restarting the server

Restarting VibeSpace to put a fix live is safe — do it without asking and without waiting for sessions to go idle, including the session you are running in. Live sessions are recorded in `<dataDir>/active-agent-sessions.json`; on boot `server/services/session-restore.service.js` resumes every one that had a turn in flight or open items in its task ledger with a `[session supervisor]` continuation turn, and sessions parked on a usage limit stay with the wake scheduler. The only thing lost is the interrupted turn itself, which the resumed agent picks back up. (`VIBESPACE_SESSION_RESTORE=0` disables the boot pass — check it is unset before relying on this.)

### Restarting without resuming sessions

Sometimes a restart must not wake anything — for example right after switching the machine's Claude account, when every resumed session would start spending the new account's limits. Create the one-shot marker right before restarting:

```sh
touch ~/.vibespace/restart-without-resume   # <dataDir>, the directory of DATABASE_PATH
# ...then restart the server the usual way, within 15 minutes
```

The next boot deletes the marker, resumes nothing, logs `[session restore] restart without resume: not resuming N recorded session(s): <ids>`, and forgets those sessions, so a later ordinary restart does not wake them either. They stay intact on disk; the user's next message resumes each one the usual way. A marker older than 15 minutes is treated as a restart that never happened and is removed without effect. `VIBESPACE_RESTART_WITHOUT_RESUME=1` does the same for every boot of a process started with it — for a manual run, not for the LaunchAgent.

Sessions parked on a usage limit are a separate mechanism (`<dataDir>/rate-limited-sessions.json`, `server/services/rate-limit-wake.service.js`): their wakes survive a quiet restart and still fire at the provider's reset time. To stop one, send the session a message (that cancels its wake) or shred it.
