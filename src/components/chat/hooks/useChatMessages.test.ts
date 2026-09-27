import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

// Shapes below mirror real Claude Code transcripts (anonymised): when a
// background agent finishes, the runtime wakes the parent itself with its own
// `<task-notification>` user row, and VibeSpace used to push a second copy
// wrapped in its `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble. Both rows
// land in the transcript and both reach the chat on reload.

const SYSTEM_PREAMBLE = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'This is an automated background-task event, NOT a message from the user.',
  'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.',
  '',
].join('\n');

function notificationBlock(fields: {
  taskId: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
  result?: string;
}): string {
  const lines = ['<task-notification>', `<task-id>${fields.taskId}</task-id>`];
  if (fields.toolUseId) lines.push(`<tool-use-id>${fields.toolUseId}</tool-use-id>`);
  lines.push(`<status>${fields.status ?? 'completed'}</status>`);
  if (fields.summary) lines.push(`<summary>${fields.summary}</summary>`);
  if (fields.result) lines.push(`<result>${fields.result}</result>`);
  lines.push('</task-notification>');
  return lines.join('\n');
}

let seq = 0;
function userRow(content: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  seq += 1;
  return {
    id: `row-${seq}`,
    sessionId: 'session-1',
    timestamp: new Date(Date.UTC(2026, 8, 25, 12, 0, seq)).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content,
    ...overrides,
  };
}

function assistantRow(content: string): NormalizedMessage {
  return { ...userRow(content), role: 'assistant' };
}

function toolUseRow(toolId: string, toolName: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { ...userRow(''), kind: 'tool_use', toolId, toolName, toolInput: {}, role: undefined, ...extra };
}

const cards = (messages: ReturnType<typeof normalizedToChatMessages>) =>
  messages.filter((m) => m.isTaskNotification);

test('the runtime copy and the VibeSpace copy of one completion render as ONE card', () => {
  const messages = normalizedToChatMessages([
    toolUseRow('toolu_agent', 'Agent'),
    userRow(notificationBlock({
      taskId: 'a76d5a95',
      toolUseId: 'toolu_agent',
      summary: 'Agent "Map the app" finished',
      result: '# Survey\n\nThe app has three tabs.',
    }), { id: 'native' }),
    userRow(SYSTEM_PREAMBLE + notificationBlock({
      taskId: 'a76d5a95',
      toolUseId: 'toolu_agent',
      summary: 'Map the app',
    }), { id: 'injected' }),
    assistantRow('Survey is in.'),
  ]);

  const shown = cards(messages);
  assert.equal(shown.length, 1, 'one card per (task id, tool-use id)');
  assert.equal(shown[0].taskId, 'a76d5a95');
  assert.equal(shown[0].taskNotificationCount, 2, 'the card records what it folded');

  // The agent's result is rendered exactly once, even though only the first
  // copy carried it and the surviving card is the later one.
  const results = messages.filter((m) => typeof m.content === 'string' && m.content.includes('The app has three tabs'));
  assert.equal(results.length, 1);
});

test('a re-notified agent keeps only its final result, at the final position', () => {
  const messages = normalizedToChatMessages([
    toolUseRow('toolu_agent', 'Agent'),
    userRow(notificationBlock({ taskId: 'a1', toolUseId: 'toolu_agent', status: 'completed', result: 'first draft' })),
    assistantRow('Asking it to try again.'),
    userRow(notificationBlock({ taskId: 'a1', toolUseId: 'toolu_agent', status: 'failed', result: 'final answer' })),
  ]);

  const shown = cards(messages);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].taskStatus, 'failed', 'the terminal status of the last notification wins');
  const contents = messages.map((m) => m.content);
  assert.ok(!contents.includes('first draft'), 'intermediate result collapsed away');
  assert.ok(contents.includes('final answer'));
  assert.ok(
    contents.indexOf('Asking it to try again.') < contents.indexOf('final answer'),
    'the surviving card sits where the last notification arrived',
  );
});

test('different tasks, or the same task id under another tool use, stay separate', () => {
  const messages = normalizedToChatMessages([
    userRow(notificationBlock({ taskId: 'b1', toolUseId: 'toolu_1', summary: 'one' })),
    userRow(notificationBlock({ taskId: 'b2', toolUseId: 'toolu_2', summary: 'two' })),
    userRow(notificationBlock({ taskId: 'b1', toolUseId: 'toolu_3', summary: 'three' })),
  ]);
  assert.equal(cards(messages).length, 3);
});

test('a batched notification drops only its superseded block', () => {
  const messages = normalizedToChatMessages([
    userRow(notificationBlock({ taskId: 'b1', toolUseId: 'toolu_1', summary: 'one (early copy)' })
      + '\n' + notificationBlock({ taskId: 'b2', toolUseId: 'toolu_2', summary: 'two' })),
    userRow(SYSTEM_PREAMBLE + notificationBlock({ taskId: 'b1', toolUseId: 'toolu_1', summary: 'one' })),
  ]);
  const shown = cards(messages);
  assert.equal(shown.length, 2);
  assert.deepEqual(
    shown.map((m) => (m.taskNotifications as Array<{ taskId: string }>).map((n) => n.taskId)),
    [['b2'], ['b1']],
  );
});

test("a subagent's own background tasks never render in the parent chat", () => {
  const messages = normalizedToChatMessages([
    toolUseRow('toolu_agent', 'Agent', {
      subagentTools: [{ toolId: 'toolu_child_bash', toolName: 'Bash', toolInput: {} }],
    }),
    // VibeSpace used to forward the child's own shell completions to the parent.
    userRow(SYSTEM_PREAMBLE + notificationBlock({ taskId: 'bchild', toolUseId: 'toolu_child_bash', summary: 'Run the tests' })),
    userRow(notificationBlock({ taskId: 'aparent', toolUseId: 'toolu_agent', summary: 'Agent finished' })),
  ]);
  const shown = cards(messages);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].taskId, 'aparent');
});

test('a notification without ids is left alone', () => {
  const messages = normalizedToChatMessages([
    userRow('<task-notification>\n<status>completed</status>\n<summary>legacy</summary>\n</task-notification>'),
    userRow('<task-notification>\n<status>completed</status>\n<summary>legacy</summary>\n</task-notification>'),
  ]);
  assert.equal(cards(messages).length, 2);
});
