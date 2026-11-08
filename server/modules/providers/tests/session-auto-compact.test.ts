import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  CLAUDE_AUTO_COMPACT_AT_MAX,
  CLAUDE_AUTO_COMPACT_AT_MIN,
  claudeAutoCompactWindowFor,
  readClaudeAutoCompactAt,
} from '@/shared/utils.js';

/**
 * A Claude session can carry its own auto-compact trigger (tokens). The row
 * stores it; the service validates it; the runtime turns it into the CLI's
 * autoCompactWindow setting (trigger + the CLI's fixed 33k reserve).
 */

const PROJECT_PATH = '/workspace/auto-compact-project';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-auto-compact-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('the trigger maps to the CLI window and bad values read as the default', () => {
  assert.equal(claudeAutoCompactWindowFor(160_000), 193_000);
  assert.equal(claudeAutoCompactWindowFor(200_000), 233_000);
  assert.equal(CLAUDE_AUTO_COMPACT_AT_MIN, 67_000);
  assert.equal(CLAUDE_AUTO_COMPACT_AT_MAX, 967_000);
  assert.equal(readClaudeAutoCompactAt(200_000), 200_000);
  for (const bad of [null, undefined, '200000', 200_000.5, 50_000, 2_000_000, Number.NaN]) {
    assert.equal(readClaudeAutoCompactAt(bad), null, `${String(bad)} is not a trigger`);
  }
});

test('a Claude session stores, changes and clears its own trigger', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('orchestrator', 'claude', PROJECT_PATH);
    assert.equal(sessionsDb.getSessionAutoCompactAt('orchestrator'), null, 'new sessions use the default');

    assert.deepEqual(sessionsService.setAutoCompactAt('orchestrator', 200_000),
      { sessionId: 'orchestrator', autoCompactAt: 200_000, changed: true });
    assert.equal(sessionsDb.getSessionAutoCompactAt('orchestrator'), 200_000);

    assert.deepEqual(sessionsService.setAutoCompactAt('orchestrator', 200_000),
      { sessionId: 'orchestrator', autoCompactAt: 200_000, changed: false }, 'asking for the same value is a no-op');

    assert.equal(sessionsService.setAutoCompactAt('orchestrator', 'default').autoCompactAt, null);
    sessionsService.setAutoCompactAt('orchestrator', 180_000);
    assert.equal(sessionsService.setAutoCompactAt('orchestrator', null).autoCompactAt, null);
    assert.equal(sessionsDb.getSessionAutoCompactAt('orchestrator'), null);
  });
});

test('the service refuses bad values, unknown sessions and other providers', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('claude-one', 'claude', PROJECT_PATH);
    sessionsDb.createAppSession('codex-one', 'codex', PROJECT_PATH);
    const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

    for (const bad of ['200000', 200_000.5, 10_000, 2_000_000, true, {}]) {
      assert.throws(() => sessionsService.setAutoCompactAt('claude-one', bad), code('INVALID_AUTO_COMPACT_AT'));
    }
    assert.throws(() => sessionsService.setAutoCompactAt('no-such', 200_000), code('SESSION_NOT_FOUND'));
    assert.throws(() => sessionsService.setAutoCompactAt('codex-one', 200_000), code('AUTO_COMPACT_UNSUPPORTED'));
    assert.equal(sessionsDb.getSessionAutoCompactAt('claude-one'), null, 'a refused value is never stored');
  });
});
