import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { issueSessionCapability, issueSideCapability } from '@/modules/session-capabilities/index.js';
import { sessionsService } from '@/modules/providers/index.js';

import { handleNativeChat } from '../services/native-chat.service.js';
import { buildSideExcerpt, SIDE_EXCERPT_MAX_CHARS } from '../services/native-side-excerpt.service.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: Record<string, unknown>[] = [];
  code = 0;
  send(raw: string, callback?: (error?: Error) => void) { this.frames.push(JSON.parse(raw)); callback?.(); }
  close(code: number) { this.code = code; this.readyState = 3; this.emit('close'); }
  async input(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

test('side question excerpt keeps the newest visible messages within the bound', () => {
  const messages = [
    { kind: 'tool_use', role: 'assistant', content: 'hidden tool call' },
    ...Array.from({ length: 30 }, (_, index) => ({ kind: 'text', role: index % 2 ? 'assistant' : 'user', content: `message ${index}` })),
  ];
  const excerpt = buildSideExcerpt(messages, '/tmp/parent.jsonl');
  assert.ok(!excerpt.includes('message 9\n') && excerpt.includes('message 10') && excerpt.includes('message 29'));
  assert.ok(!excerpt.includes('hidden tool call'));
  assert.match(excerpt, /untrusted/);
  assert.match(excerpt, /\/tmp\/parent\.jsonl/);
  const long = buildSideExcerpt([
    { kind: 'text', role: 'user', content: 'OLDEST'.padEnd(9000, 'x') },
    { kind: 'text', role: 'assistant', content: 'NEWEST'.padEnd(9000, 'y') },
  ], null);
  assert.ok(long.includes('NEWEST') && !long.includes('OLDEST'), 'the oldest is cut first');
  assert.ok(long.length < SIDE_EXCERPT_MAX_CHARS + 1000);
  assert.equal(buildSideExcerpt([], null), '');
});

test('native side question gateway: own credential, send and stop only, read-only runs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-side-chat-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const sockets: Socket[] = [];
  const history = mock.method(sessionsService, 'fetchHistory', async (id: string) => ({
    messages: id === 'codex-parent'
      ? [{ kind: 'text', role: 'user', content: 'PARENT_QUESTION' }, { kind: 'text', role: 'assistant', content: 'PARENT_ANSWER' }]
      : [],
    total: 0, hasMore: false, offset: 0, limit: 100,
  }));
  try {
    userDb.createUser('native-owner', 'fixture');
    sessionsDb.createAppSession('claude-parent', 'claude', '/tmp/native-side-fixture');
    sessionsDb.assignProviderSessionId('claude-parent', 'claude-parent-provider');
    sessionsDb.createAppSession('claude-side', 'claude', '/tmp/native-side-fixture', true);
    sessionsDb.setSideParent('claude-side', 'claude-parent');
    sessionsDb.createAppSession('codex-parent', 'codex', '/tmp/native-side-fixture');
    sessionsDb.assignProviderSessionId('codex-parent', 'codex-thread');
    sessionsDb.createAppSession('codex-side', 'codex', '/tmp/native-side-fixture', true);
    sessionsDb.setSideParent('codex-side', 'codex-parent');
    sessionsDb.createAppSession('browser-btw', 'claude', '/tmp/native-side-fixture', true);

    const runs: { content: string; options: Record<string, unknown> }[] = [];
    const aborts: unknown[] = [];
    const dependencies = { runtime: {
      hasRuntime: () => true,
      run: async (_provider: string, content: string, options: Record<string, unknown>) => { runs.push({ content, options }); },
      abort: async (...args: unknown[]) => { aborts.push(args); return true; },
      resolveToolApproval: () => { throw new Error('a side question never answers permissions'); },
      getPendingApprovalsForSession: () => [],
    } } as unknown as Parameters<typeof handleNativeChat>[2];
    const open = (target: string, capability: string) => {
      const socket = new Socket(); sockets.push(socket);
      handleNativeChat(socket as never, { url: '/native-chat/' + target, headers: { 'x-vibespace-session-capability': capability } } as never, dependencies);
      return socket;
    };

    // Credentials do not cross: owner capability never opens a side, side never opens the parent.
    assert.equal(open('claude-side', issueSessionCapability('claude-side')).code, 4403);
    assert.equal(open('claude-parent', issueSideCapability('claude-parent')).code, 4403);
    assert.equal(open('codex-side', issueSideCapability('claude-side')).code, 4403);
    assert.equal(open('browser-btw', issueSideCapability('browser-btw')).code, 4403, 'a browser /btw row has no parent and no native access');

    const side = open('claude-side', issueSideCapability('claude-side'));
    assert.equal(side.code, 0);
    assert.equal(side.frames[0]?.kind, 'native.hello');
    assert.equal(side.frames[0]?.side, true);
    assert.equal(side.frames[0]?.rewind, false);

    // Reads of its own session are allowed; the Swift panel loads history first.
    await side.input({ type: 'native.history', requestId: 'h', chunked: false, limit: 100 });
    assert.ok(side.frames.some(frame => frame.kind === 'native.history'));
    await side.input({ type: 'native.background', requestId: 'b' });
    await side.input({ type: 'chat.subscribe' });

    // Everything else is refused with a code the client can act on.
    for (const frame of [
      { type: 'chat.queue-add', id: 'q1', clientMsgId: 'q1', content: 'queued' },
      { type: 'chat.queue-remove', id: 'q1' },
      { type: 'chat.permission-response', requestId: 'p', allow: true },
      { type: 'native.select', model: 'x', effort: '' },
      { type: 'native.transcribe', audio: 'AAAA' },
      { type: 'chat.send', clientMsgId: 'rw', content: 'edit', rewind: 'anchor' },
      { type: 'chat.send', clientMsgId: 'att', content: 'file', attachments: ['11111111-1111-4111-8111-111111111111'] },
    ]) {
      const before = side.frames.filter(f => f.code === 'SIDE_SEND_ONLY').length;
      await side.input(frame);
      assert.equal(side.frames.filter(f => f.code === 'SIDE_SEND_ONLY').length, before + 1, `${frame.type} must be refused`);
    }
    await side.input({ type: 'chat.send', sessionId: 'claude-parent', clientMsgId: 'foreign', content: 'to the parent' });
    assert.ok(side.frames.some(f => f.kind === 'native.error' && f.error === 'Wrong session'));
    assert.equal(runs.length, 0);

    // A send runs read-only, off the board, forked from the parent, whatever the client asked.
    await side.input({ type: 'chat.send', clientMsgId: 'ask-1', content: 'What did we decide?',
      options: { permissionMode: 'bypassPermissions', toolsSettings: { skipPermissions: true } } });
    assert.equal(runs.length, 1);
    const claudeRun = runs[0];
    assert.equal(claudeRun.content, 'What did we decide?', 'Claude forks instead of quoting');
    assert.equal(claudeRun.options.permissionMode, 'plan');
    assert.equal(claudeRun.options.private, true);
    assert.equal(claudeRun.options.sideSession, true);
    assert.equal(claudeRun.options.forkFrom, 'claude-parent-provider');
    assert.equal(claudeRun.options.sessionId, 'claude-side');
    const tools = claudeRun.options.toolsSettings as { disallowedTools: string[]; skipPermissions: boolean };
    assert.equal(tools.skipPermissions, false);
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Task']) assert.ok(tools.disallowedTools.includes(tool));
    assert.ok(side.frames.some(f => f.kind === 'send_ack' && f.clientMsgId === 'ask-1'));
    const refusals = side.frames.filter(f => f.code === 'SIDE_SEND_ONLY').length;
    await side.input({ type: 'chat.abort' });
    assert.equal(side.frames.filter(f => f.code === 'SIDE_SEND_ONLY').length, refusals, 'stop is allowed');

    // Once it has its own provider session it no longer forks.
    sessionsDb.assignProviderSessionId('claude-side', 'claude-side-provider');
    await side.input({ type: 'chat.send', clientMsgId: 'ask-2', content: 'And then?' });
    assert.equal(runs.at(-1)!.options.forkFrom, undefined);

    // Codex quotes the parent on the first turn only.
    const codex = open('codex-side', issueSideCapability('codex-side'));
    await codex.input({ type: 'chat.send', clientMsgId: 'codex-1', content: 'Summarise' });
    const codexRun = runs.at(-1)!;
    assert.match(codexRun.content, /PARENT_QUESTION[\s\S]*PARENT_ANSWER[\s\S]*Summarise$/);
    assert.match(codexRun.content, /untrusted/);
    assert.equal(codexRun.options.permissionMode, 'plan');
    assert.equal(codexRun.options.private, true);
    assert.equal(codexRun.options.forkFrom, undefined);

    // A parent that turns private revokes the side socket on the next frame.
    getConnection().prepare('UPDATE sessions SET is_private = 1 WHERE session_id = ?').run('codex-parent');
    const count = runs.length;
    await codex.input({ type: 'chat.send', clientMsgId: 'codex-2', content: 'Again' });
    assert.equal(runs.length, count);
    assert.equal(open('codex-side', issueSideCapability('codex-side')).code, 4403);

    // Promotion ends the side credential; the promoted session uses the owner capability.
    sessionsDb.promoteSideSession('claude-side', 'Side question');
    const after = runs.length;
    await side.input({ type: 'chat.send', clientMsgId: 'ask-3', content: 'After promotion' });
    assert.equal(runs.length, after);
    assert.equal(open('claude-side', issueSideCapability('claude-side')).code, 4403);
    const promoted = open('claude-side', issueSessionCapability('claude-side'));
    assert.equal(promoted.code, 0);
    await promoted.input({ type: 'chat.send', clientMsgId: 'ask-4', content: 'Ordinary now' });
    assert.equal(runs.at(-1)!.options.sideSession, undefined);
    assert.equal(runs.at(-1)!.options.private, false);
  } finally {
    history.mock.restore();
    for (const socket of sockets) socket.close(1000);
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
