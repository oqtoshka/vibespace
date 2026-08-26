import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexSessionsProvider,
  extractCodexCompactionSummary,
} from '@/modules/providers/list/codex/codex-sessions.provider.js';

const SESSION_ID = 'session-1';
const COMPACT_SUMMARY_TEXT = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: we renamed a thing.';

// ----------------------------------------------------------------- Codex

/**
 * Codex >=0.144 replaces the compacted transcript with an encrypted
 * `compaction` item, so most compactions arrive with nothing readable attached.
 * A marker with no expandable body is still the right outcome — the alternative
 * is the silent gap the transcript showed before, where turns simply stop being
 * remembered with nothing to explain it.
 */
test('codex: an encrypted compaction still yields a boundary, with no summary', () => {
  const summary = extractCodexCompactionSummary({
    message: '',
    replacement_history: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hey' }] },
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'gAAAAA…' },
    ],
  });

  assert.equal(summary, undefined);
});

test('codex: a summary left in payload.message is recovered', () => {
  assert.equal(extractCodexCompactionSummary({ message: COMPACT_SUMMARY_TEXT }), COMPACT_SUMMARY_TEXT);
});

test('codex: a replayed bridge turn at the tail of the replacement history is recovered', () => {
  const summary = extractCodexCompactionSummary({
    message: '',
    replacement_history: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the original prompt' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: COMPACT_SUMMARY_TEXT }] },
    ],
  });

  assert.equal(summary, COMPACT_SUMMARY_TEXT);
});

test('codex: extractCodexCompactionSummary tolerates a missing payload', () => {
  assert.equal(extractCodexCompactionSummary(null), undefined);
  assert.equal(extractCodexCompactionSummary({}), undefined);
});

test('codex: a parsed compaction entry normalizes to a boundary carrying its summary', () => {
  const provider = new CodexSessionsProvider();
  const [message] = provider.normalizeMessage({
    type: 'compact_boundary',
    timestamp: '2026-08-16T20:39:53.755Z',
    summary: COMPACT_SUMMARY_TEXT,
  }, SESSION_ID);

  assert.equal(message.kind, 'compact_boundary');
  assert.equal(message.compaction?.summary, COMPACT_SUMMARY_TEXT);
});
