import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionsService } from '@/modules/providers/index.js';

/**
 * A briefing-mode session (Mission Control ADR-0021) is decided at creation
 * exactly like a private one: the two flags are written with the row, read
 * back by the launch, and never updated. `needsPlan` without `briefing` is
 * nothing — the plan gate is a property of the mode.
 */

const PROJECT_PATH = '/workspace/briefing-project';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'briefing-sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('both briefing flags are stored with the row and default to off', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('plain', 'claude', PROJECT_PATH);
    sessionsDb.createAppSession('briefing', 'claude', PROJECT_PATH, false, false, null, { needsPlan: false });
    sessionsDb.createAppSession('briefing-plan', 'codex', PROJECT_PATH, false, false, null, { needsPlan: true });

    const plain = sessionsDb.getSessionById('plain');
    assert.equal(plain?.briefing_mode, 0);
    assert.equal(plain?.briefing_needs_plan, 0);
    const briefing = sessionsDb.getSessionById('briefing');
    assert.equal(briefing?.briefing_mode, 1);
    assert.equal(briefing?.briefing_needs_plan, 0);
    const withPlan = sessionsDb.getSessionById('briefing-plan');
    assert.equal(withPlan?.briefing_mode, 1);
    assert.equal(withPlan?.briefing_needs_plan, 1);
  });
});

test('the service passes the choice through, reports it back, and lists it', async () => {
  await withIsolatedDatabase(() => {
    const created = sessionsService.createAppSession('opencode', PROJECT_PATH, false, false, 'Ship it', { needsPlan: true });
    assert.deepEqual(created.briefing, { needsPlan: true });
    assert.equal(created.isPrivate, false);
    assert.equal(sessionsDb.getSessionById(created.sessionId)?.briefing_needs_plan, 1);

    const ordinary = sessionsService.createAppSession('opencode', PROJECT_PATH);
    assert.equal(ordinary.briefing, null);
    assert.equal(sessionsDb.getSessionById(ordinary.sessionId)?.briefing_mode, 0);

    // A private briefing session is both: the flags are independent.
    const both = sessionsService.createAppSession('claude', PROJECT_PATH, false, true, undefined, { needsPlan: false });
    const row = sessionsDb.getSessionById(both.sessionId);
    assert.equal(row?.is_private, 1);
    assert.equal(row?.briefing_mode, 1);
  });
});

test('the flags survive the provider id being assigned and the row being read back by it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('mapped', 'claude', PROJECT_PATH, false, false, null, { needsPlan: true });
    sessionsDb.assignProviderSessionId('mapped', 'claude-native-briefing');

    const row = sessionsDb.getSessionByProviderSessionId('claude-native-briefing');
    assert.equal(row?.briefing_mode, 1);
    assert.equal(row?.briefing_needs_plan, 1);
  });
});
