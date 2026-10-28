import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, scanStateDb, sessionsDb } from '../index.js';

test('background migration resets the scan cursor once while preserving old sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'background-migration-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, '');
  try {
    await initializeDatabase();
    sessionsDb.createSession('legacy', 'codex', '/workspace/example', 'Legacy chat');
    scanStateDb.updateLastScannedAt(new Date('2026-07-01T00:00:00Z'));
    getConnection().exec('ALTER TABLE sessions DROP COLUMN is_background');
    getConnection().exec('ALTER TABLE sessions DROP COLUMN interactive_resumed');
    closeConnection();
    await initializeDatabase();
    assert.equal(scanStateDb.getLastScannedAt(), null);
    assert.equal(sessionsDb.getSessionById('legacy')?.is_background, 0);
    assert.equal(sessionsDb.getSessionById('legacy')?.custom_name, 'Legacy chat');
    scanStateDb.updateLastScannedAt(new Date('2026-07-02T00:00:00Z'));
    closeConnection();
    await initializeDatabase();
    assert.equal(scanStateDb.getLastScannedAt()?.toISOString(), '2026-07-02T00:00:00.000Z');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
