import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __resetSessionRestoreState,
  forgetSession,
  recordSessionActivity,
} from '../session-restore.service.js';

// Shred's hook into the restore-on-boot registry: one session's entry goes,
// the neighbour's stays, and the file is rewritten at once rather than on the
// debounce — a restart in the gap must not bring the session back.
test('forgetSession drops one entry and flushes the registry immediately', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restore-forget-'));
  process.env.DATABASE_PATH = path.join(dataDir, 'auth.db');
  __resetSessionRestoreState();

  try {
    const activity = { cwd: '/workspace/demo', permissionMode: undefined, userId: 1, turnActive: true, private: true };
    await recordSessionActivity({ sessionId: 'mine', ...activity });
    await recordSessionActivity({ sessionId: 'theirs', ...activity });

    assert.equal(await forgetSession('mine'), true);
    assert.equal(await forgetSession('mine'), false);

    const registry = JSON.parse(await readFile(path.join(dataDir, 'active-claude-sessions.json'), 'utf8'));
    assert.deepEqual(registry.map((entry) => entry.sessionId), ['theirs']);
    // The private flag rides along in the entry so a restored turn keeps the gate.
    assert.equal(registry[0].private, true);
  } finally {
    __resetSessionRestoreState();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dataDir, { recursive: true, force: true });
  }
});
