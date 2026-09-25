import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { providerModelsService } from '@/modules/providers/index.js';
import { voiceService } from '@/modules/voice/index.js';
import { appConfigDb, closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { ensureImageAssetsDir } from '@/modules/assets/index.js';
import { registerLaunchOption } from '@/shared/agent-env.js';

import { authenticateNativeControl, nativeControlService, nativePermissionOptions, resolveNativeAttachments, setNativePermissionSelection, setNativeSelection } from '../native-control.service.js';
import { nativeControlRoutes } from '../index.js';

test('federation credentials, idempotent creation, registered projects and session-bound files', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(homedir(), '.native-control-test-'));
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
      assert.equal('prompt' in transcribe.mock.calls[0].arguments[0], false);
      await nativeControlService.transcribe(Buffer.from('hinted'), 'VibeSpace, Mission Control.');
      assert.equal(transcribe.mock.calls.at(-1)!.arguments[0].prompt, 'VibeSpace, Mission Control.');
      await assert.rejects(nativeControlService.transcribe(Buffer.alloc(0)), /between 1 byte and 8 MiB/);
      await nativeControlService.transcribe(Buffer.alloc(6 * 1024 * 1024));
      await assert.rejects(nativeControlService.transcribe(Buffer.alloc(8 * 1024 * 1024 + 1)), /between 1 byte and 8 MiB/);
    } finally { transcribe.mock.restore(); }
    const routeTranscribe = mock.method(nativeControlService, 'transcribe', async (bytes: Buffer) => ({ text: bytes.length > 1000 ? 'large recording' : bytes.toString() }));
    const routeSearch = mock.method(nativeControlService, 'search', async (input: unknown) => ({ input, results: [] }));
    const app = express(); app.use('/native', nativeControlRoutes); const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/native/transcribe`, { method: 'POST',
        headers: { 'content-type': 'audio/mp4', 'x-mc-federation-token': 'x'.repeat(40) }, body: Buffer.from('route fixture') });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: 'route fixture' });
      assert.deepEqual(routeTranscribe.mock.calls[0].arguments[0], Buffer.from('route fixture'));
      assert.equal(routeTranscribe.mock.calls[0].arguments[1], undefined);
      const hinted = await fetch(`http://127.0.0.1:${port}/native/transcribe`, { method: 'POST',
        headers: { 'content-type': 'audio/mp4', 'x-mc-federation-token': 'x'.repeat(40), 'x-mc-stt-prompt': encodeURIComponent('VibeSpace, Кванта.') },
        body: Buffer.from('hinted') });
      assert.equal(hinted.status, 200); await hinted.arrayBuffer();
      assert.equal(routeTranscribe.mock.calls.at(-1)!.arguments[1], 'VibeSpace, Кванта.');
      const malformed = await fetch(`http://127.0.0.1:${port}/native/transcribe`, { method: 'POST',
        headers: { 'content-type': 'audio/mp4', 'x-mc-federation-token': 'x'.repeat(40), 'x-mc-stt-prompt': '%E0%A4%A' },
        body: Buffer.from('malformed') });
      assert.equal(malformed.status, 200); await malformed.arrayBuffer();
      assert.equal(routeTranscribe.mock.calls.at(-1)!.arguments[1], undefined);
      const searchResponse = await fetch(`http://127.0.0.1:${port}/native/search/sessions?q=legacy&archived=all&matchType=phrase&limit=7`, {
        headers: { 'x-mc-federation-token': 'x'.repeat(40) },
      });
      assert.equal(searchResponse.status, 200);
      assert.deepEqual(routeSearch.mock.calls[0].arguments[0], {
        query: 'legacy', projectId: undefined, provider: undefined, archived: 'all',
        from: undefined, to: undefined, matchType: 'phrase', limit: 7, cursor: undefined,
      });
      const refused = await fetch(`http://127.0.0.1:${port}/native/search/sessions?q=legacy`, {
        headers: { 'x-mc-federation-token': 'y'.repeat(40) },
      });
      assert.equal(refused.status, 403);
      const large = await fetch(`http://127.0.0.1:${port}/native/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/mp4', 'x-mc-federation-token': 'x'.repeat(40) }, body: Buffer.alloc(6 * 1024 * 1024) });
      assert.equal(large.status, 200); await large.arrayBuffer();
      assert.equal(routeTranscribe.mock.calls.at(-1)!.arguments[0].length, 6 * 1024 * 1024);
    } finally {
      routeTranscribe.mock.restore(); routeSearch.mock.restore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    projectsDb.createProjectPath(directory, 'Native fixture');
    const projectId = projectsDb.getProjectPaths()[0].project_id;
    const registered = await nativeControlService.createProject({ path: directory + '/', name: 'Native fixture' });
    assert.equal(registered.outcome, 'existing');
    assert.equal(registered.project.projectId, projectId);
    assert.equal(projectsDb.getProjectPaths().length, 1, 'retry must reuse the registered folder');
    await assert.rejects(nativeControlService.createProject({ path: 'relative/path', name: 'Invalid' }), /absolute project folder/);
    await assert.rejects(nativeControlService.createProject({ path: directory, name: ' ' }), /absolute project folder/);
    await assert.rejects(nativeControlService.createProject(null), /Invalid project request/);
    const input = { requestId: randomUUID(), projectId, provider: 'codex' as const, title: 'Native fixture' };
    const first = await nativeControlService.create(input);
    assert.equal(first.model, 'gpt-5.6-sol');
    assert.equal(first.effort, 'high');
    assert.equal(first.permissionMode, 'bypassPermissions');
    appConfigDb.set(`permission-default:${userDb.getSingleActiveUser()!.id}:codex`, 'bypassPermissions');
    assert.equal(nativePermissionOptions('codex', first.sessionId).permissionMode, 'bypassPermissions');
    assert.equal(setNativePermissionSelection(first.sessionId, 'default').permissionMode, 'default');
    assert.equal(setNativePermissionSelection(first.sessionId, null).permissionMode, 'bypassPermissions');
    assert.throws(() => setNativePermissionSelection(first.sessionId, 'invented'), /Invalid permission mode/);
    assert.equal((await nativeControlService.create(input)).sessionId, first.sessionId);
    await assert.rejects(nativeControlService.create({ ...input, title: 'Changed' }), /different content/);
    await assert.rejects(nativeControlService.create({ ...input, requestId: randomUUID(), projectId: '/etc' }), /Project/);
    await assert.rejects(nativeControlService.create({ ...input, requestId: randomUUID(), model: 'invented' }), /model/i);
    // The phone sends its "Default" choice as an empty string.
    assert.equal((await nativeControlService.create({ ...input, requestId: randomUUID(), model: '' })).model, 'gpt-5.6-sol');
    await assert.rejects(nativeControlService.create({ ...input, requestId: randomUUID(), permissionMode: 'invented' }), /permission/i);
    const catalog = mock.method(providerModelsService, 'getProviderModels', async () => ({ models: {
      DEFAULT: 'fixture-model', OPTIONS: [{ value: 'fixture-model', label: 'Fixture', effort: { default: 'low', values: [{ value: 'low' }, { value: 'ultra' }] } }],
    } }));
    const change = mock.method(providerModelsService, 'changeActiveModel', async () => ({}) as never);
    try {
      assert.equal((await setNativeSelection(first.sessionId, 'fixture-model', 'ultra')).effort, 'ultra');
      assert.deepEqual(change.mock.calls[0].arguments, ['codex', { sessionId: first.sessionId, model: 'fixture-model' }]);
      assert.equal((await setNativeSelection(first.sessionId, 'fixture-model', '')).effort, 'low');
      await assert.rejects(setNativeSelection(first.sessionId, 'fixture-model', 'made-up'), /does not support/);
    } finally { catalog.mock.restore(); change.mock.restore(); }
    const second = await nativeControlService.create({ ...input, requestId: randomUUID() });
    const restricted = await nativeControlService.create({ ...input, requestId: randomUUID(), permissionMode: 'default' });
    assert.equal(nativePermissionOptions('codex', restricted.sessionId).sessionMode, 'default');
    // Launch options are a creation-time choice like private: stored on the row, reported
    // back, and refused outright when no plugin here declares them.
    const unregisterOption = registerLaunchOption({ id: 'acme.review', label: 'review' });
    try {
      const chosen = await nativeControlService.create({ ...input, requestId: randomUUID(), launchOptions: { 'acme.review': { depth: 'deep' } } });
      assert.deepEqual(nativeControlService.describe(chosen.sessionId).launchOptions, { 'acme.review': { depth: 'deep' } });
      assert.equal(nativeControlService.describe(first.sessionId).launchOptions, null);
      await assert.rejects(nativeControlService.create({ ...input, requestId: randomUUID(), launchOptions: { 'other.thing': true } }), /Unknown launch option: other\.thing/);
      await assert.rejects(nativeControlService.create({ ...input, requestId: randomUUID(), launchOptions: 'yes' as never }), /Invalid launch options/);
    } finally {
      unregisterOption();
    }
    const file = await nativeControlService.upload(first.sessionId, '../../note.txt', 'text/plain', Buffer.from('attachment fixture'));
    const [stored] = resolveNativeAttachments(first.sessionId, [file.id]); cleanup.push(stored.path);
    assert.equal(file.name, 'note.txt');
    assert.equal((await nativeControlService.asset(first.sessionId, file.id)).bytes.toString(), 'attachment fixture');
    assert.throws(() => resolveNativeAttachments(second.sessionId, [file.id]), /another session/);
    assert.throws(() => resolveNativeAttachments(first.sessionId, ['/etc/passwd']));
    assert.throws(() => resolveNativeAttachments(first.sessionId, Array(11).fill(file.id)));
    const browserFilename = `native-${randomUUID()}-Pasted_image.png`;
    const browserPath = path.join(await ensureImageAssetsDir(), browserFilename); cleanup.push(browserPath);
    await writeFile(browserPath, Buffer.from('browser image fixture'));
    const browserAsset = await nativeControlService.storedAsset(first.sessionId, browserFilename);
    assert.equal(browserAsset.status, 'found');
    if (browserAsset.status === 'found') {
      const chunks: Buffer[] = [];
      for await (const chunk of browserAsset.stream) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(), 'browser image fixture');
    }
    assert.equal((await nativeControlService.storedAsset(first.sessionId, '../private')).status, 'invalid');
    const assetApp = express(); assetApp.use('/native', nativeControlRoutes); const assetServer = assetApp.listen(0);
    try {
      const port = (assetServer.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/native/sessions/${first.sessionId}/stored-assets/${browserFilename}`, {
        headers: { 'x-mc-federation-token': 'x'.repeat(40) },
      });
      assert.equal(response.status, 200); assert.equal(await response.text(), 'browser image fixture');
    } finally { await new Promise<void>((resolve, reject) => assetServer.close(error => error ? reject(error) : resolve())); }
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
