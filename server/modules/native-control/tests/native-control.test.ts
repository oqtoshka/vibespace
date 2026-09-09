import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { providerModelsService } from '@/modules/providers/index.js';
import { appConfigDb, closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { authenticateNativeControl, nativeControlService, resolveNativeAttachments, setNativeSelection } from '../native-control.service.js';

test('federation credentials, idempotent creation, registered projects and session-bound files', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'native-control-test-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  const cleanup: string[] = [];
  try {
    await initializeDatabase();
    assert.equal(authenticateNativeControl('x'), false);
    userDb.createUser('operator', 'unused');
    appConfigDb.set('mc_federation_token', 'x'.repeat(40));
    assert.equal(authenticateNativeControl('x'.repeat(40)), true);
    assert.equal(authenticateNativeControl(['x'.repeat(40)]), false);
    assert.equal(authenticateNativeControl('y'.repeat(40)), false);
    projectsDb.createProjectPath(directory, 'Native fixture');
    const projectId = projectsDb.getProjectPaths()[0].project_id;
    const input = { requestId: randomUUID(), projectId, provider: 'codex' as const, title: 'Native fixture' };
    const first = await nativeControlService.create(input);
    assert.equal((await nativeControlService.create(input)).sessionId, first.sessionId);
    await assert.rejects(nativeControlService.create({ ...input, title: 'Changed' }), /different content/);
    await assert.rejects(nativeControlService.create({ ...input, requestId: randomUUID(), projectId: '/etc' }), /Project/);
    const catalog = mock.method(providerModelsService, 'getProviderModels', async () => ({ models: {
      DEFAULT: 'fixture-model', OPTIONS: [{ value: 'fixture-model', label: 'Fixture', effort: { default: 'low', values: [{ value: 'low' }, { value: 'ultra' }] } }],
    } }));
    try {
      assert.equal((await setNativeSelection(first.sessionId, 'fixture-model', 'ultra')).effort, 'ultra');
      assert.equal((await setNativeSelection(first.sessionId, 'fixture-model', '')).effort, 'low');
      await assert.rejects(setNativeSelection(first.sessionId, 'fixture-model', 'made-up'), /does not support/);
    } finally { catalog.mock.restore(); }
    const second = await nativeControlService.create({ ...input, requestId: randomUUID() });
    const file = await nativeControlService.upload(first.sessionId, '../../note.txt', 'text/plain', Buffer.from('attachment fixture'));
    const [stored] = resolveNativeAttachments(first.sessionId, [file.id]); cleanup.push(stored.path);
    assert.equal(file.name, 'note.txt');
    assert.equal((await nativeControlService.asset(first.sessionId, file.id)).bytes.toString(), 'attachment fixture');
    assert.throws(() => resolveNativeAttachments(second.sessionId, [file.id]), /another session/);
    assert.throws(() => resolveNativeAttachments(first.sessionId, ['/etc/passwd']));
    assert.throws(() => resolveNativeAttachments(first.sessionId, Array(11).fill(file.id)));
    sessionsDb.updateSessionIsArchived(first.sessionId, true);
    await assert.rejects(nativeControlService.upload(first.sessionId, 'note', 'text/plain', Buffer.from('x')), /archived/);
    getConnection().prepare('UPDATE sessions SET is_private = 1 WHERE session_id = ?').run(second.sessionId);
    assert.throws(() => nativeControlService.describe(second.sessionId), /unavailable/);
    userDb.createUser('another-user', 'unused');
    assert.equal(authenticateNativeControl('x'.repeat(40)), false);
  } finally {
    for (const file of cleanup) await unlink(file).catch(() => {});
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
