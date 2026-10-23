import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = 'session-1';

const SKILL_BODY = [
  'Base directory for this skill: /tmp/claude/bundled-skills/2.1.220/abc123/claude-api',
  '',
  '# Building LLM-Powered Applications with Claude',
  '',
  'This skill helps you build LLM-powered applications with Claude.',
].join('\n');

test('claude: injected skill bodies are hidden even without the isMeta flag', () => {
  const provider = new ClaudeSessionsProvider();

  // The live SDK stream omits `isMeta`, so the payload has to be recognised by
  // its content or it renders as a giant user bubble mid-run.
  const live = provider.normalizeMessage(
    {
      uuid: 'u1',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  const persisted = provider.normalizeMessage(
    {
      uuid: 'u2',
      timestamp: '2026-07-28T10:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(persisted, []);
});

test('claude: the Skill tool result itself still reaches the UI', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      uuid: 'u3',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: claude-api' }],
      },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, 'toolu_1');
});

// A message sent while the agent works is folded into the running turn; the
// runtime files it as a `queued_command` attachment, its only durable copy.
const queuedCommand = (prompt: unknown) => ({
  type: 'attachment',
  uuid: 'attachment-row',
  timestamp: '2026-10-23T20:00:00.000Z',
  attachment: { type: 'queued_command', prompt, source_uuid: 'injected-1', commandMode: 'prompt' },
});
const PNG = 'iVBORw0KGgo=';

test('claude: a text message folded into the running turn is a user row keyed by its injection uuid', () => {
  const messages = new ClaudeSessionsProvider().normalizeMessage(queuedCommand('also check the logs'), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'injected-1');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'also check the logs');
  assert.equal(messages[0].images, undefined);
});

test('claude: a picture message folded into the running turn keeps its text and pictures on reload', () => {
  const messages = new ClaudeSessionsProvider().normalizeMessage(queuedCommand([
    { type: 'text', text: 'Links do nothing here, inside the card.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } },
    { type: 'image', source: { type: 'base64', data: PNG } },
  ]), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'injected-1', 'the id the live row carried, so the two merge');
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].timestamp, '2026-10-23T20:00:00.000Z');
  assert.equal(messages[0].content, 'Links do nothing here, inside the card.');
  assert.deepEqual(messages[0].images, [
    { data: `data:image/jpeg;base64,${PNG}` },
    { data: `data:image/png;base64,${PNG}` },
  ]);
});

test('claude: a picture-only message folded into the running turn is still a user row', () => {
  const messages = new ClaudeSessionsProvider().normalizeMessage(queuedCommand([
    { type: 'text', text: '' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
  ]), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'injected-1');
  assert.equal(messages[0].content, '');
  assert.deepEqual(messages[0].images, [{ data: `data:image/png;base64,${PNG}` }]);
});

test('claude: a queued command with neither text nor pictures adds nothing', () => {
  const provider = new ClaudeSessionsProvider();
  assert.deepEqual(provider.normalizeMessage(queuedCommand([]), SESSION_ID), []);
  assert.deepEqual(provider.normalizeMessage(queuedCommand([{ type: 'text', text: '  ' }]), SESSION_ID), []);
  assert.deepEqual(provider.normalizeMessage(queuedCommand('   '), SESSION_ID), []);
  assert.deepEqual(provider.normalizeMessage(queuedCommand(undefined), SESSION_ID), []);
});
