import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { removeOptimisticUserEchoes } from './sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('drops a codex mid-turn steer echo once the rollout copy is fetched', () => {
  // The live bubble is keyed by the client's queue id; Codex history rows get a
  // fresh `codex_<uuid>` on every read, so nothing matches by id and the two
  // stacked as a duplicate bubble.
  const steerEcho = createUserMessage('queued_1787767948502_vrtwos', '2026-08-26T18:12:28.502Z', {
    provider: 'codex',
    content: 'Pmef надо погасить, он не нужен',
  });
  const persisted = createUserMessage('codex_0c5c638f-d9f8-48b3-9199-b2668fadae61', '2026-08-26T18:12:38.526Z', {
    provider: 'codex',
    content: 'Pmef надо погасить, он не нужен',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [steerEcho]), []);
});

test('drops a server-drained queue echo once the provider persists the turn', () => {
  const drainedEcho = createUserMessage('text_5a1c0f7e-2c1a-4a2f-9f3a-0b1d2e3f4a5b', '2026-08-26T18:12:28.000Z', {
    provider: 'opencode',
    content: 'next task please',
  });
  const persisted = createUserMessage('opencode_bd0a1f2c', '2026-08-26T18:12:31.000Z', {
    provider: 'opencode',
    content: 'next task please',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [drainedEcho]), []);
});

test('keeps a live user row the persisted page does not have yet', () => {
  const live = createUserMessage('queued_1787767948502_vrtwos', '2026-08-26T18:12:28.502Z', {
    provider: 'codex',
    content: 'still indexing',
  });
  const unrelated = createUserMessage('codex_other', '2026-08-26T18:12:30.000Z', {
    provider: 'codex',
    content: 'a different turn',
  });

  assert.deepEqual(removeOptimisticUserEchoes([unrelated], [live]), [live]);
});

test('leaves non-user realtime rows alone', () => {
  const toolUse = {
    ...createUserMessage('codex_tool', '2026-08-26T18:12:28.000Z'),
    kind: 'tool_use',
    role: undefined,
  } as unknown as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes([], [toolUse]), [toolUse]);
});
