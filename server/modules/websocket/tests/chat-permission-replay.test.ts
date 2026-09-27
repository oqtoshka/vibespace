import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appConfigDb, closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '../services/chat-run-registry.service.js';
import { handleNativeChat } from '../services/native-chat.service.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: Record<string, unknown>[] = [];
  code = 0;
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
  close(code: number) { this.code = code; this.readyState = 3; this.emit('close'); }
  async input(value: unknown) {
    for (const handler of this.listeners('message')) await handler(Buffer.from(JSON.stringify(value)));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/**
 * A run's replay buffer holds every event of the turn, including the
 * `permission_request` the reader has already answered. Replaying that one on
 * reconnect put an answered prompt back on screen, and the runtime refuses a
 * second response for it — so the card could no longer be dismissed either.
 */
test('subscribe replays a permission request only while it is still pending', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'permission-replay-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const sockets: Socket[] = [];
  try {
    userDb.createUser('replay-owner', 'fixture');
    sessionsDb.createAppSession('replay-one', 'claude', '/tmp/permission-replay-fixture');
    const secret = appConfigDb.getOrCreateJwtSecret();
    let pending: unknown[] = [{ requestId: 'ask-1', toolName: 'AskUserQuestion', input: { questions: [] } }];
    const dependencies = { runtime: {
      hasRuntime: () => true,
      run: async () => undefined,
      abort: async () => true,
      resolveToolApproval: () => { pending = []; },
      getPendingApprovalsForSession: () => pending,
    } } as unknown as Parameters<typeof handleNativeChat>[2];
    const open = () => {
      const socket = new Socket(); sockets.push(socket);
      handleNativeChat(socket as never, { url: '/native-chat/replay-one', headers: {
        'x-vibespace-session-capability': createHmac('sha256', secret)
          .update('mission-control:vibespace-session:v1:replay-one').digest('base64url'),
      } } as never, dependencies);
      return socket;
    };

    const writer = chatRunRegistry.startResumeRun('replay-one');
    assert.ok(writer);
    writer.send({ id: 'ask', kind: 'permission_request', requestId: 'ask-1', toolName: 'AskUserQuestion',
      input: { questions: [] }, sessionId: 'replay-one', provider: 'claude', timestamp: new Date().toISOString() });

    const before = open();
    await before.input({ type: 'chat.subscribe' });
    const snapshot = before.frames.find(frame => frame.kind === 'chat_subscribed');
    assert.equal((snapshot?.pendingPermissions as unknown[])?.length, 1);
    assert.ok(before.frames.some(frame => frame.kind === 'permission_request'),
      'an unanswered prompt must survive a reconnect');

    await before.input({ type: 'chat.permission-response', requestId: 'ask-1', allow: true });
    assert.deepEqual(pending, []);

    const after = open();
    await after.input({ type: 'chat.subscribe' });
    assert.equal((after.frames.find(frame => frame.kind === 'chat_subscribed')?.pendingPermissions as unknown[])?.length, 0);
    assert.ok(!after.frames.some(frame => frame.kind === 'permission_request'),
      'an answered prompt must not come back from the replay buffer');
  } finally {
    for (const socket of sockets) socket.close(1000);
    closeConnection();
    if (previous) process.env.DATABASE_PATH = previous; else delete process.env.DATABASE_PATH;
    await rm(directory, { recursive: true, force: true });
  }
});
