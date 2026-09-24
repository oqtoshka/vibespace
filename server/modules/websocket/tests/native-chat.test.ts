import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { appConfigDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { issueSessionCapability } from '@/modules/session-capabilities/index.js';
import { providerModelsService } from '@/modules/providers/index.js';

import { connectedClients } from '../services/websocket-state.service.js';
import { chatRunRegistry } from '../services/chat-run-registry.service.js';
import { handleNativeChat } from '../services/native-chat.service.js';
import { nativeHistoryWithReceipts } from '../services/native-send-journal.service.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: Record<string, unknown>[] = [];
  code = 0;
  send(raw: string, callback?: (error?: Error) => void) { this.frames.push(JSON.parse(raw)); callback?.(); }
  close(code: number) { this.code = code; this.readyState = 3; this.emit('close'); }
  inputNow(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  async input(value: unknown) {
    this.inputNow(value);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('native session isolation, history, stream, permissions and duplicate receipt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-chat-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const sockets: Socket[] = [];
  try {
    userDb.createUser('native-owner', 'fixture');
    sessionsDb.createAppSession('native-one', 'claude', '/tmp/native-chat-fixture');
    sessionsDb.createAppSession('native-other', 'claude', '/tmp/native-chat-fixture');
    sessionsDb.createAppSession('native-codex', 'codex', '/tmp/native-chat-fixture');
    const imageId = '11111111-1111-4111-8111-111111111111';
    const fileId = '22222222-2222-4222-8222-222222222222';
    const assets = path.join(homedir(), '.vibespace', 'assets');
    const imagePath = path.join(assets, `native-${imageId}-preview.png`);
    const filePath = path.join(assets, `native-${fileId}-notes.txt`);
    appConfigDb.set(`native_asset:${imageId}`, JSON.stringify({
      id: imageId, sessionId: 'native-one', path: imagePath,
      name: 'preview.png', mimeType: 'image/png', size: 123,
    }));
    appConfigDb.set(`native_asset:${fileId}`, JSON.stringify({
      id: fileId, sessionId: 'native-one', path: filePath,
      name: 'notes.txt', mimeType: 'text/plain', size: 42,
    }));
    let calls = 0; let answers = 0;
    let lastOptions: unknown;
    const dependencies = { runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, _content: string, _options: unknown, writer: { send: (data: unknown) => void }) => {
        calls++; lastOptions = _options;
        writer.send({ id: 'delta', kind: 'stream_delta', content: 'Native stream works', sessionId: 'native-one', provider: 'claude', timestamp: new Date().toISOString() });
      },
      abort: async () => true,
      resolveToolApproval: () => { answers++; },
      getPendingApprovalsForSession: () => [{ requestId: 'permission-one', toolName: 'Bash' }],
    } } as unknown as Parameters<typeof handleNativeChat>[2];
    const open = (tokenSession: string, target = 'native-one') => {
      const socket = new Socket(); sockets.push(socket);
      handleNativeChat(socket as never, { url: '/native-chat/' + target, headers: {
        'x-vibespace-session-capability': issueSessionCapability(tokenSession),
      } } as never, dependencies);
      return socket;
    };
    const malformed = new Socket(); sockets.push(malformed);
    assert.doesNotThrow(() => handleNativeChat(malformed as never, {
      url: '/native-chat/native-one', headers: { 'x-vibespace-session-capability': 'é'.repeat(43) },
    } as never, dependencies));
    assert.equal(malformed.code, 4403);
    assert.deepEqual(malformed.frames, []);
    assert.equal(open('native-other').code, 4403);
    assert.equal(open('native-codex', 'native-codex').frames[0]?.rewind, true);
    const client = open('native-one');
    assert.equal(client.frames[0]?.kind, 'native.hello');
    assert.equal(client.frames[0]?.rewind, true);
    await client.input({ type: 'native.history', requestId: 'history' });
    assert.deepEqual(client.frames.find(f => f.kind === 'native.history')?.messages, []);
    for (const socket of connectedClients) {
      socket.send(JSON.stringify({ kind: 'text', sessionId: 'native-other', content: 'PRIVATE_OTHER' }));
      socket.send(JSON.stringify({ kind: 'loading_progress', content: 'GLOBAL_PRIVATE' }));
    }
    assert.ok(!JSON.stringify(client.frames).includes('PRIVATE'));
    await client.input({ type: 'chat.send', sessionId: 'native-other', clientMsgId: 'foreign', content: 'bad' });
    assert.equal(calls, 0);
    await client.input({ type: 'chat.permission-response', requestId: 'permission-other', allow: true });
    assert.equal(answers, 0);
    assert.ok(client.frames.some(f => f.kind === 'native.error' && f.code === 'PERMISSION_NOT_PENDING'),
      'a stale prompt is identified by code so the phone drops it instead of restoring it');
    await client.input({ type: 'chat.permission-response', requestId: 'permission-one', allow: true });
    assert.equal(answers, 1);
    const catalog = mock.method(providerModelsService, 'getProviderModels', async () => ({ models: {
      DEFAULT: 'fixture-model',
      OPTIONS: [{ value: 'fixture-model', label: 'Fixture', effort: { default: 'low', values: [{ value: 'low' }] } }],
    } }));
    const activeRun = chatRunRegistry.startRun({
      appSessionId: 'native-one', provider: 'claude', providerSessionId: null,
      connection: client as never, userId: 1,
    });
    assert.ok(activeRun);
    await client.input({ type: 'chat.send', clientMsgId: 'busy-edit', content: 'edit', rewind: 'user-2' });
    assert.equal(calls, 0);
    assert.ok(client.frames.some(f => f.kind === 'native.error' && String(f.error).includes('Stop')));
    const errorsBeforeSelection = client.frames.filter(frame => frame.kind === 'native.error').length;
    client.inputNow({ type: 'native.select', model: 'fixture-model', effort: 'low', permissionMode: 'bypassPermissions' });
    assert.equal(sessionsDb.getSessionPermissionMode('native-one'), 'bypassPermissions',
      'a permission selection is saved before a following Stop/send can overtake async model lookup');
    const selectionDeadline = Date.now() + 3000;
    while (!client.frames.some(frame => frame.kind === 'native.options') && Date.now() < selectionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(client.frames.filter(frame => frame.kind === 'native.error').length, errorsBeforeSelection);
    assert.equal(client.frames.filter(frame => frame.kind === 'native.options').at(-1)?.permissionMode, 'bypassPermissions');
    chatRunRegistry.completeRun('native-one', { exitCode: 0 });
    catalog.mock.restore();
    sessionsDb.setSessionPermissionMode('native-one', 'bypassPermissions');
    await client.input({
      type: 'chat.send', clientMsgId: 'native-send', content: 'hello', rewind: 'user-2',
      attachments: [imageId, fileId], options: { permissionMode: 'default' },
    });
    const runtimeOptions = lastOptions as {
      rewind: string;
      permissionMode: string;
      attachments: Array<{ path: string }>;
      images: Array<{ path: string }>;
      files: Array<{ path: string }>;
    };
    assert.equal(runtimeOptions.rewind, 'user-2');
    assert.equal(runtimeOptions.permissionMode, 'bypassPermissions');
    assert.deepEqual(runtimeOptions.attachments.map(item => item.path), [imagePath, filePath]);
    assert.deepEqual(runtimeOptions.images.map(item => item.path), [imagePath]);
    assert.deepEqual(runtimeOptions.files.map(item => item.path), [filePath]);
    assert.equal(calls, 1);
    assert.ok(client.frames.some(f => f.kind === 'send_ack'));
    await client.input({ type: 'native.history', requestId: 'accepted-before-provider-transcript' });
    const acceptedPage = client.frames.find(f => f.requestId === 'accepted-before-provider-transcript');
    assert.equal((acceptedPage?.messages as { role: string; content: string }[]).filter(m => m.role === 'user' && m.content === 'hello').length, 1,
      'a first message accepted before the provider creates its transcript survives Stop/reconnect');
    assert.ok(client.frames.some(f => f.kind === 'stream_delta'));
    client.close(1000);
    const reconnected = open('native-one');
    await reconnected.input({ type: 'chat.send', clientMsgId: 'native-send', content: 'hello' });
    assert.equal(calls, 1);
    assert.ok(reconnected.frames.some(f => f.kind === 'send_ack'));
    await reconnected.input({ type: 'native.history', requestId: 'accepted-after-reconnect' });
    const reconnectedPage = reconnected.frames.find(f => f.requestId === 'accepted-after-reconnect');
    assert.equal((reconnectedPage?.messages as { role: string; content: string }[]).filter(m => m.role === 'user' && m.content === 'hello').length, 1,
      'retrying the same send must not duplicate the durable first message');
    const canonicalPage = { messages: [{ id: 'provider-user', sessionId: 'native-one', provider: 'claude' as const,
      kind: 'text' as const, role: 'user' as const, content: 'hello', timestamp: new Date().toISOString() }],
      total: 150, limit: 100, offset: 0, hasMore: true };
    assert.deepEqual(nativeHistoryWithReceipts('native-one', canonicalPage), canonicalPage,
      'the canonical transcript replaces the receipt without changing pagination or duplicating the first message');
    assert.equal(JSON.parse(appConfigDb.get('native_messages:native-one') || '[]').length, 0);
    sessionsDb.updateSessionIsArchived('native-one', true);
    await reconnected.input({ type: 'chat.send', clientMsgId: 'new-send', content: 'archived' });
    assert.equal(calls, 1);
    assert.ok(reconnected.frames.some(f => f.kind === 'native.error' && String(f.error).includes('archived')));
    userDb.createUser('second-owner', 'fixture');
    assert.equal(open('native-one').code, 4403);
  } finally {
    for (const socket of sockets) socket.close(1000);
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
