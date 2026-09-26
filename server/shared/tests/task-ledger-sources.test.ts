import assert from 'node:assert/strict';
import test from 'node:test';

process.env.VIBESPACE_TASK_NUDGE_MAX = '3';
const { readExternalTaskLedger, registerTaskLedgerSource } = await import('@/shared/task-ledger-sources.js');
const { planTaskContinuation, __clearTaskContinuationState, __setTaskLedgerReader } = await import('@/modules/task-continuation/index.js');

const card = (open: Array<{ id: string; subject: string; status: 'pending' | 'in_progress'; waitingOnUser?: boolean }>, activity = 1) => ({
  listName: 'card plan',
  guidance: 'Close steps with card.plan; park them with a [waiting on user] title.',
  open: open.map((item) => ({ waitingOnUser: false, updatedAt: null, ...item })),
  activity,
});

test('the first source with an answer wins; null defers; a throwing or malformed source is skipped', () => {
  const unregisterThrows = registerTaskLedgerSource(() => { throw new Error('boom'); });
  const unregisterMalformed = registerTaskLedgerSource(({ sessionId }) => (sessionId === 'bad' ? ({ open: 'nope' } as never) : null));
  const unregisterCard = registerTaskLedgerSource(({ provider, sessionId }) => (
    provider === 'claude' && sessionId.startsWith('card-') ? card([{ id: '2', subject: 'Ship', status: 'in_progress' }, { id: '3', subject: 'x', status: 'done' as never }]) : null
  ));
  try {
    assert.equal(readExternalTaskLedger({ provider: 'claude', sessionId: 'plain' }), null);
    assert.equal(readExternalTaskLedger({ provider: 'claude', sessionId: 'bad' }), null);
    assert.equal(readExternalTaskLedger({ provider: 'codex', sessionId: 'card-1' }), null);
    assert.equal(readExternalTaskLedger({ provider: 'claude', sessionId: '' }), null);
    const ledger = readExternalTaskLedger({ provider: 'claude', sessionId: 'card-1' })!;
    assert.equal(ledger.listName, 'card plan');
    assert.deepEqual(ledger.open.map((item) => item.subject), ['Ship'], 'only pending/in_progress items are open');
  } finally {
    unregisterThrows();
    unregisterMalformed();
    unregisterCard();
  }
});

test('per-turn continuation: an external ledger replaces the native one, including when it is empty', () => {
  __clearTaskContinuationState();
  let external: ReturnType<typeof card> | null = card([{ id: '1', subject: 'Write the card', status: 'in_progress' }]);
  let nativeReads = 0;
  __setTaskLedgerReader('codex', () => { nativeReads += 1; return { open: [{ id: '9', subject: 'Native item', status: 'pending' }], activity: 1 }; });
  const unregister = registerTaskLedgerSource(() => external);
  try {
    const nudge = planTaskContinuation({ provider: 'codex', sessionId: 'ext-1' })!;
    assert.match(nudge, /your card plan still has open items/);
    assert.match(nudge, /Write the card/);
    assert.match(nudge, /Close steps with card\.plan/);
    assert.doesNotMatch(nudge, /Native item|update_plan/);

    external = card([]);
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'ext-1' }), null, 'an empty card plan is done, whatever the native list says');

    external = card([{ id: '1', subject: '[waiting on user] Check the phone', status: 'pending', waitingOnUser: true }]);
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'ext-1' }), null, 'parked steps stand the loop down');
    assert.equal(nativeReads, 0, 'the native ledger is never read while a source answers');

    external = null;
    assert.match(planTaskContinuation({ provider: 'codex', sessionId: 'ext-1' })!, /Native item/);
  } finally {
    unregister();
    __setTaskLedgerReader('codex', null);
    __clearTaskContinuationState();
  }
});
