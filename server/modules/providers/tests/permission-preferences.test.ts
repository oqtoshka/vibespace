import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initializeDatabase, closeConnection, sessionsDb, userDb } from '@/modules/database/index.js';

import { permissionPreferencesService as preferences } from '../services/permission-preferences.service.js';

test('native permissions inherit defaults, preserve session restrictions and migrate without overwriting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'permission-preferences-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const user = userDb.createUser('permission-fixture', 'fixture');
    const id = Number(user.id);
    sessionsDb.createAppSession('permission-test', 'codex', '/tmp/permissions');
    assert.equal(preferences.get(id, 'codex', 'permission-test').permissionMode, 'bypassPermissions');
    preferences.update(id, 'codex', undefined, { defaultMode: 'bypassPermissions' });
    assert.equal(preferences.get(id, 'codex', 'permission-test').permissionMode, 'bypassPermissions');
    preferences.update(id, 'codex', 'permission-test', { sessionMode: 'default' });
    assert.equal(preferences.get(id, 'codex', 'permission-test').permissionMode, 'default');
    preferences.update(id, 'codex', 'permission-test', { sessionMode: 'bypassPermissions', defaultMode: 'default', onlyIfMissing: true });
    assert.deepEqual(preferences.get(id, 'codex', 'permission-test'), { permissionModes: ['default', 'acceptEdits', 'bypassPermissions'], defaultMode: 'bypassPermissions', sessionMode: 'default', permissionMode: 'default' });
    preferences.update(id, 'codex', 'permission-test', { sessionMode: null });
    assert.equal(preferences.get(id, 'codex', 'permission-test').permissionMode, 'bypassPermissions');
    assert.throws(() => preferences.update(id, 'codex', 'permission-test', { sessionMode: 'invented' }));
    assert.throws(() => preferences.update(id, 'claude', 'permission-test', { sessionMode: 'bypassPermissions' }));
    assert.equal(preferences.get(id + 1, 'codex').defaultMode, 'bypassPermissions');
    const previousMode = process.env.VS_OPENCODE_DEFAULT_PERMISSION_MODE;
    try {
      process.env.VS_OPENCODE_DEFAULT_PERMISSION_MODE = 'bypassPermissions';
      assert.equal(preferences.get(id, 'opencode').defaultMode, 'bypassPermissions');
      preferences.update(id, 'opencode', undefined, { defaultMode: 'plan' });
      assert.equal(preferences.get(id, 'opencode').defaultMode, 'plan');
      process.env.VS_OPENCODE_DEFAULT_PERMISSION_MODE = 'invalid';
      assert.equal(preferences.get(id + 1, 'opencode').defaultMode, 'default');
    } finally {
      if (previousMode === undefined) delete process.env.VS_OPENCODE_DEFAULT_PERMISSION_MODE;
      else process.env.VS_OPENCODE_DEFAULT_PERMISSION_MODE = previousMode;
    }
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
