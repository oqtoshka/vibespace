import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { OpenCodeSessionsProvider } from '../modules/providers/list/opencode/opencode-sessions.provider.js';
import { sessionsService } from '../modules/providers/services/sessions.service.js';
import { buildOpenCodePromptAttachments } from '../shared/image-attachments.js';

import { persistOpenCodeTurn } from './opencode-history-writer.js';
import { toModelRef, toTokenBudget, translateEvent } from './opencode-http-runner.js';

const SESSION_ID = 'ses_test';

/** Runs an event through the translator and the normalizer, as the runner does. */
const render = (type: string, properties: Record<string, unknown>, toolNames = new Map<string, string>()) => {
  const translated = translateEvent(type, properties, toolNames);
  return translated ? sessionsService.normalizeMessage('opencode', translated, SESSION_ID) : [];
};

// The field is `delta` on a delta event and `text` on the `ended` event that
// repeats the whole block. Reading the wrong one yields an empty string, which
// the normalizer drops — a turn that streams nothing at all.
test('streamed text is read from the delta field', () => {
  const [message] = render('session.next.text.delta', {
    sessionID: SESSION_ID,
    assistantMessageID: 'msg_1',
    textID: 'text-0',
    delta: 'Orange',
    text: 'Orange',
  });

  assert.equal(message?.kind, 'stream_delta');
  assert.equal(message?.content, 'Orange');
});

test('the completed text event is not forwarded a second time', () => {
  // Every delta is appended by the client, so replaying the finished block
  // would print the whole reply twice.
  assert.deepEqual(render('session.next.text.ended', {
    sessionID: SESSION_ID,
    assistantMessageID: 'msg_1',
    textID: 'text-0',
    text: 'Orange',
  }), []);
});

test('reasoning is streamed as thinking', () => {
  const [message] = render('session.next.reasoning.delta', {
    sessionID: SESSION_ID,
    assistantMessageID: 'msg_1',
    reasoningID: 'reasoning-0',
    delta: 'weighing it up',
  });

  assert.equal(message?.kind, 'thinking');
  assert.equal(message?.content, 'weighing it up');
});

// Only the call event names the tool; the result events carry the id alone, so
// the name has to be remembered or every finished tool renders as "Tool".
test('a tool result is named from the call that started it', () => {
  const toolNames = new Map<string, string>();

  const [called] = render('session.next.tool.called', {
    sessionID: SESSION_ID,
    callID: 'call_1',
    tool: 'bash',
    input: { command: 'echo hi' },
  }, toolNames);
  assert.equal(called?.toolName, 'bash');
  assert.deepEqual(called?.toolInput, { command: 'echo hi' });
  assert.equal(called?.toolResult, undefined, 'a running tool has no result yet');

  const [succeeded] = render('session.next.tool.success', {
    sessionID: SESSION_ID,
    callID: 'call_1',
    content: [{ type: 'text', text: 'hi' }],
    structured: { exit: 0 },
  }, toolNames);
  assert.equal(succeeded?.toolName, 'bash');
  assert.equal(succeeded?.toolResult?.content, 'hi');
  assert.equal(succeeded?.toolResult?.isError, false);
});

test('a failed tool is reported as an error result', () => {
  const toolNames = new Map<string, string>([['call_1', 'bash']]);
  const [message] = render('session.next.tool.failed', {
    sessionID: SESSION_ID,
    callID: 'call_1',
    error: 'command not found',
  }, toolNames);

  assert.equal(message?.toolName, 'bash');
  assert.equal(message?.toolResult?.isError, true);
});

test('the end of a step closes the stream', () => {
  const [message] = render('session.next.step.ended', { sessionID: SESSION_ID, finish: 'stop' });
  assert.equal(message?.kind, 'stream_end');
});

test('events with no counterpart in the CLI output are dropped', () => {
  const toolNames = new Map<string, string>();
  for (const type of ['session.next.tool.input.delta', 'session.next.model.switched', 'session.updated']) {
    assert.equal(translateEvent(type, { sessionID: SESSION_ID }, toolNames), null, type);
  }
});

// The provider id is the first segment only: custom providers routinely serve
// models whose own id contains slashes.
test('a model id keeps every slash after the provider', () => {
  assert.deepEqual(toModelRef('dudin/zhiqing/Qwen3-VL'), { providerID: 'dudin', id: 'zhiqing/Qwen3-VL' });
  assert.deepEqual(toModelRef('anthropic/claude', 'high'), { providerID: 'anthropic', id: 'claude', variant: 'high' });
  assert.equal(toModelRef('bare-model-id'), null);
});

test('token totals come out of the step payload', () => {
  assert.deepEqual(
    toTokenBudget({ input: 3000, output: 2, reasoning: 0, cache: { read: 100, write: 0 } }),
    { used: 3102, inputTokens: 3100, outputTokens: 2, breakdown: { input: 3100, output: 2 } },
  );
  assert.equal(toTokenBudget({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }), null);
  assert.equal(toTokenBudget(undefined), null);
});

// An image has to travel as bytes: OpenCode's server rejects a file:// URI for
// media, and a path the model is told to read comes back inside a tool result,
// which OpenAI-compatible transports flatten to text.
test('images are inlined as data URIs and other files are left for the agent to read', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'opencode-attachments-'));
  try {
    const imagePath = path.join(workspace, 'dot.png');
    // Smallest valid PNG: a single transparent pixel.
    await writeFile(imagePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ));
    const notesPath = path.join(workspace, 'notes.txt');
    await writeFile(notesPath, 'plain text');

    const { files, passthrough } = await buildOpenCodePromptAttachments(
      [{ path: imagePath, name: 'dot.png' }, { path: notesPath, name: 'notes.txt' }],
      workspace,
    );

    assert.equal(files.length, 1);
    assert.match(files[0].uri, /^data:image\/png;base64,iVBOR/);
    assert.equal(files[0].name, 'dot.png');
    assert.deepEqual(passthrough.map((entry) => entry.name), ['notes.txt']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// The trust boundary every provider builder shares: only the upload store and
// the run's own directory, so a crafted descriptor cannot exfiltrate a file.
test('an attachment outside the allowed roots is refused', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'opencode-attachments-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'opencode-outside-'));
  try {
    const secretPath = path.join(outside, 'secret.png');
    await writeFile(secretPath, 'not really an image');

    const { files, passthrough } = await buildOpenCodePromptAttachments([{ path: secretPath }], workspace);

    assert.deepEqual(files, []);
    assert.deepEqual(passthrough, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// A turn that ran over the HTTP server exists only inside that server: it
// creates the session row and writes no messages. Everything that reads a
// conversation back — the transcript view, the sidebar, `opencode run
// --session` — reads opencode.db, so without this write the exchange answers
// once and is gone by the next page load.
test('a turn run over the server is written back as readable history', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-history-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });

    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );

        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }

    persistOpenCodeTurn({
      sessionId: SESSION_ID,
      cwd: '/workspace/notes',
      providerId: 'dudin',
      modelId: 'vision-model',
      promptText: 'What colour is this image?',
      images: [{ path: '/assets/dot.png', name: 'dot.png' }],
      assistantMessageId: 'msg_assistant',
      text: 'Blue',
      tools: [{ callId: 'call_1', name: 'bash', input: { command: 'ls' }, output: 'dot.png' }],
      tokens: { input: 3000, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    });

    const history = await new OpenCodeSessionsProvider().fetchHistory(SESSION_ID, {});
    const kinds = history.messages.map((message) => message.kind);
    assert.ok(kinds.includes('tool_use'), 'the tool call belongs in the transcript');

    const [prompt] = history.messages;
    assert.equal(prompt.content, 'What colour is this image?', 'the attachment block is stripped back out');
    assert.equal((prompt.images as unknown[] | undefined)?.length, 1, 'the attachment is recorded so it renders again on reload');

    const reply = history.messages.find((message) => message.kind === 'text' && message.content === 'Blue');
    assert.ok(reply, 'the answer must survive the reload');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
