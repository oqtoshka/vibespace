import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';

import { authorizeSessionCapability, issueSessionCapability, sessionCapabilityExpiry } from '../index.js';

test('dedicated signing state persists, is independent of browser JWT, and corruption is never replaced', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-signing-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  try {
    await initializeDatabase();
    appConfigDb.set('jwt_secret', 'browser-only');
    const key = appConfigDb.getOrCreateSessionCapabilitySecret();
    assert.match(key, /^[a-f0-9]{128}$/);
    const token = issueSessionCapability('one');
    assert.ok(sessionCapabilityExpiry('one', token));
    assert.equal(authorizeSessionCapability('one', token), false);
    userDb.createUser('operator', 'fixture');
    sessionsDb.createAppSession('one', 'codex', directory);
    assert.equal(authorizeSessionCapability('one', token), true);
    for (const flags of [[1, 0], [0, 1]]) {
      getConnection().prepare('UPDATE sessions SET is_private=?,is_side=? WHERE session_id=?').run(...flags, 'one');
      assert.equal(authorizeSessionCapability('one', token), false);
    }
    getConnection().prepare('UPDATE sessions SET is_private=0,is_side=0 WHERE session_id=?').run('one');
    assert.equal(appConfigDb.getOrCreateSessionCapabilitySecret(), key);
    appConfigDb.set('jwt_secret', 'browser-rotated');
    assert.ok(sessionCapabilityExpiry('one', token));
    appConfigDb.set('mc_session_capability_secret_v2', 'a'.repeat(128));
    assert.equal(sessionCapabilityExpiry('one', token), null);
    appConfigDb.set('mc_session_capability_secret_v2', 'invalid');
    assert.throws(() => issueSessionCapability('one'), /signing state/);
    assert.equal(sessionCapabilityExpiry('one', token), null);
    assert.equal(appConfigDb.get('mc_session_capability_secret_v2'), 'invalid');
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
