import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

test('an existing sessions table gains name_source and backfills derived', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
  const dbPath = path.join(dir, 'auth.db');
  // A pre-migration schema: sessions with no name_source column.
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, custom_project_name TEXT, isStarred BOOLEAN DEFAULT 0, isArchived BOOLEAN DEFAULT 0);
    CREATE TABLE sessions (session_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'claude', provider_session_id TEXT, custom_name TEXT, project_path TEXT, jsonl_path TEXT, worktree_path TEXT, isArchived BOOLEAN DEFAULT 0, created_at DATETIME, updated_at DATETIME, PRIMARY KEY (session_id));
    INSERT INTO projects (project_id, project_path) VALUES ('p1', '/tmp/p');
    INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path) VALUES ('s1', 'claude', 's1', 'an old name', '/tmp/p');
    INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path) VALUES ('s2', 'claude', 's2', NULL, '/tmp/p');
  `);
  legacy.close();

  const prev = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();
  try {
    assert.equal(sessionsDb.getSessionById('s1')?.name_source, 'derived');
    assert.equal(sessionsDb.getSessionById('s2')?.name_source, null);
    assert.equal(sessionsDb.getSessionById('s1')?.custom_name, 'an old name');
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
