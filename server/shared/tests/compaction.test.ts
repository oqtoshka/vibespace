import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompactBoundaryMessage, looksLikeCompactSummary } from '@/shared/compaction.js';

/**
 * The preamble check is the only handle we have on runtimes that do not flag
 * their compaction summaries, so it has to be narrow: a false positive folds a
 * prompt the user actually typed away behind a disclosure.
 */
test('looksLikeCompactSummary matches the runtime preamble regardless of case and leading space', () => {
  assert.equal(
    looksLikeCompactSummary('This session is being continued from a previous conversation that ran out of context.'),
    true,
  );
  assert.equal(
    looksLikeCompactSummary('\n  this SESSION is being continued from a previous conversation…'),
    true,
  );
});

test('looksLikeCompactSummary ignores prose that merely mentions compaction', () => {
  assert.equal(looksLikeCompactSummary('Can you explain how this session is being continued?'), false);
  assert.equal(looksLikeCompactSummary('summarize the conversation so far'), false);
  assert.equal(looksLikeCompactSummary(''), false);
  assert.equal(looksLikeCompactSummary(undefined), false);
  assert.equal(looksLikeCompactSummary({ text: 'This session is being continued from a previous conversation' }), false);
});

test('createCompactBoundaryMessage omits metrics it was not given', () => {
  const message = createCompactBoundaryMessage({ sessionId: 's1', provider: 'codex' });

  assert.equal(message.kind, 'compact_boundary');
  // A marker must not claim the context shrank to nothing just because the
  // runtime declined to report the numbers.
  assert.deepEqual(message.compaction, { trigger: 'manual' });
  assert.equal(message.isCompactSummary, false);
});

test('createCompactBoundaryMessage carries trigger, metrics and trimmed summary', () => {
  const message = createCompactBoundaryMessage({
    id: 'cb1',
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'claude',
    trigger: 'auto',
    preTokens: 180_000,
    postTokens: 12_000,
    durationMs: 91_000,
    summary: '  kept this  ',
  });

  assert.equal(message.id, 'cb1');
  assert.equal(message.isCompactSummary, true);
  assert.deepEqual(message.compaction, {
    trigger: 'auto',
    preTokens: 180_000,
    postTokens: 12_000,
    durationMs: 91_000,
    summary: 'kept this',
  });
});

test('createCompactBoundaryMessage drops a blank summary rather than flagging an empty disclosure', () => {
  const message = createCompactBoundaryMessage({ sessionId: 's1', provider: 'opencode', summary: '   ' });

  assert.equal(message.compaction?.summary, undefined);
  assert.equal(message.isCompactSummary, false);
});
