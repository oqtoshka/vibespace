/**
 * The server process BEFORE the restart, for session-restart-resume.test.js.
 *
 * Run as its own node process against the test's throwaway data dir: it creates
 * the session rows a live server would have, records the sessions through the
 * real restore registry, persists a card plan the way the Mission Control
 * reporter keeps one (a file per provider-native session id), waits for the
 * registry's debounced write to reach disk, prints READY and then idles until
 * the test kills it — so nothing it held in memory survives into the restart.
 *
 * Env: DATABASE_PATH (the data dir is its parent), RESTART_FIXTURE (JSON with
 * `cwd` and `planDir`). Not a test file: the runner's glob is `*.test.js`.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { initializeDatabase, sessionsDb } from '../../../modules/database/index.js';
import { recordSessionActivity } from '../../session-restore.service.js';

const { cwd, planDir } = JSON.parse(process.env.RESTART_FIXTURE);
const registryFile = path.join(path.dirname(process.env.DATABASE_PATH), 'active-agent-sessions.json');

await initializeDatabase();

// The briefing session: its turn had ended (it was waiting on a detached
// cutover it had started), and its only task list is the card plan.
sessionsDb.createAppSession('app-briefing', 'claude', cwd, false, false, null, { 'mission-control.briefing': true });
sessionsDb.assignProviderSessionId('app-briefing', 'native-briefing');
await mkdir(planDir, { recursive: true });
await writeFile(path.join(planDir, 'native-briefing.json'), JSON.stringify({
  activity: 7,
  steps: [
    { id: 's1', content: 'Cut VibeSpace over to the new release', status: 'done' },
    { id: 's2', content: 'Confirm the new release on vs.dudin.net', status: 'in_progress' },
    { id: 's3', content: 'Report the cutover on the card', status: 'pending' },
  ],
}));
await recordSessionActivity({
  provider: 'claude', sessionId: 'native-briefing', cwd, permissionMode: 'bypassPermissions', userId: 7, turnActive: false,
});

// An ordinary idle session with nothing declared anywhere: a restart must not
// wake it.
sessionsDb.createAppSession('app-idle', 'claude', cwd);
sessionsDb.assignProviderSessionId('app-idle', 'native-idle');
await recordSessionActivity({ provider: 'claude', sessionId: 'native-idle', cwd, userId: 7, turnActive: false });

while (!existsSync(registryFile)) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
