import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import express from 'express';
import { providerModelsService } from '@/modules/providers/index.js';
import { voiceService } from '@/modules/voice/index.js';
import { appConfigDb, closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { authenticateNativeControl, nativeControlService, nativePermissionOptions, resolveNativeAttachments, setNativePermissionSelection, setNativeSelection } from '../native-control.service.js';
import { nativeControlRoutes } from '../index.js';

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
    const transcribe = mock.method(voiceService, 'transcribe', async (request: Parameters<typeof voiceService.transcribe>[0]) => ({
      ok: true as const,
      value: { text: request.audio.bytes.toString() },
    }));
    try {
      assert.deepEqual(await nativeControlService.transcribe(Buffer.from('spoken fixture')), { text: 'spoken fixture' });
      assert.equal(transcribe.mock.calls[0].arguments[0].userId, Number(userDb.getSingleActiveUser()!.id));
      assert.equal(transcribe.mock.calls[0].arguments[0].audio.mimeType, 'audio/mp4');
      await assert.rejects(nativeControlService.transcribe(Buffer.alloc(0)), /between 1 byte and 4 MiB/);
    } finally { transcribe.mock.restore(); }
    const routeTranscribe = mock.method(nativeControlService, 'transcribe', async (bytes: Buffer) => ({ text: bytes.toString() }));
    const app = express(); app.use('/native', nativeControlRoutes); const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/native/transcribe`, { method: 'POST',
        headers: { 'content-type': 'audio/mp4', 'x-mc-federation-token': 'x'.repeat(40) }, body: Buffer.from('route fixture') });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: 'route fixture' });
      assert.deepEqual(routeTranscribe.mock.calls[0].arguments[0], Buffer.from('route fixture'));
    } finally {
      routeTranscribe.mock.restore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    projectsDb.createProjectPath(directory, 'Native fixture');
    const projectId = projectsDb.getProjectPaths()[0].project_id;
    const input = { requestId: randomUUID(), projectId, provider: 'codex' as const, title: 'Native fixture' };
    const first = await nativeControlService.create(input);
    appConfigDb.set(`permission-default:${userDb.getSingleActiveUser()!.id}:codex`, 'bypassPermissions');
    assert.equal(nativePermissionOptions('codex', first.sessionId).permissionMode, 'bypassPermissions');
    assert.equal(setNativePermissionSelection(first.sessionId, 'default').permissionMode, 'default');
    assert.equal(setNativePermissionSelection(first.sessionId, null).permissionMode, 'bypassPermissions');
    assert.throws(() => setNativePermissionSelection(first.sessionId, 'invented'), /Invalid permission mode/);
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
    const restricted = await nativeControlService.create({ ...input, requestId: randomUUID(), permissionMode: 'default' });
    assert.equal(nativePermissionOptions('codex', restricted.sessionId).sessionMode, 'default');
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
