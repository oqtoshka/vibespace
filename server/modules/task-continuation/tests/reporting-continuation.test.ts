import assert from 'node:assert/strict';
import test from 'node:test';

import { registerTaskLedgerSource } from '../../../shared/index.js';
import { beginTaskContinuationTurn, planTaskContinuation, __clearTaskContinuationState, __setTaskLedgerReader } from '../index.js';

test('host continuation consumes a missing card checkpoint even with an empty ledger, only once per human turn', () => {
  __clearTaskContinuationState();
  let completion: { turnId: string; prompt: string } | undefined = { turnId: 'turn-1', prompt: 'Reply to exact thread' };
  const unregister = registerTaskLedgerSource(({ sessionId }) => sessionId === 'briefing' ? { listName: 'card plan', guidance: '', open: [], activity: 0, completion } : null);
  const context = { provider: 'codex', sessionId: 'briefing' };
  try {
    assert.match(planTaskContinuation(context)!, /Reply to exact thread/);
    assert.equal(planTaskContinuation(context), null, 'same failed checkpoint cannot loop');
    completion = undefined;
    assert.equal(planTaskContinuation(context), null, 'success adds no repair');
    completion = { turnId: 'turn-1', prompt: 'Reply still missing' };
    assert.equal(planTaskContinuation(context), null, 'clearing/reappearing checkpoint cannot reset budget');
    completion = { turnId: 'turn-2', prompt: 'Reply to next thread' };
    assert.match(planTaskContinuation(context)!, /next thread/);
  } finally { unregister(); __clearTaskContinuationState(); }
});

test('ordinary sessions and unavailable/malformed reporting source keep native completion behavior', () => {
  __clearTaskContinuationState();
  __setTaskLedgerReader('codex', () => ({ open: [], activity: 0 }));
  const throwing = registerTaskLedgerSource(() => { throw new Error('Unreadable source'); });
  const malformed = registerTaskLedgerSource(() => ({ listName: 'external', guidance: '', open: [], activity: 0, completion: { turnId: '', prompt: 'Bad' } }));
  try {
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'ordinary' }), null);
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: '' }), null);
  } finally { throwing(); malformed(); __setTaskLedgerReader('codex', null); __clearTaskContinuationState(); }
});

test('report repair does not close, fabricate or mask ordinary open tasks after its finite allowance', () => {
  __clearTaskContinuationState();
  const unregister = registerTaskLedgerSource(() => ({ listName: 'card plan', guidance: 'Update card plan', open: [{ id: 's1', subject: 'Finish work', status: 'pending', waitingOnUser: false, updatedAt: null }], activity: 0, completion: { turnId: 'turn', prompt: 'Record answer' } }));
  try {
    const context = { provider: 'codex', sessionId: 'with-open-work' };
    assert.match(planTaskContinuation(context)!, /Record answer/);
    assert.match(planTaskContinuation(context)!, /#s1.*Finish work/);
  } finally { unregister(); __clearTaskContinuationState(); }
});

test('begin callback gets exact prompt and distinct identities; failed provider terminal has no report repair', () => {
  const seen: Array<{ prompt?: string; turnId?: string }> = [];
  const unregister = registerTaskLedgerSource((context) => {
    if (context.phase === 'begin') seen.push({ prompt: context.prompt, turnId: context.turnId });
    return { listName: 'card', guidance: '', open: [], activity: 0, completion: { turnId: 'human', prompt: 'Missing report' } };
  });
  try {
    beginTaskContinuationTurn({ provider: 'codex', sessionId: 'begin', prompt: 'Full human prompt\nnot a headline' });
    beginTaskContinuationTurn({ provider: 'codex', sessionId: 'begin', prompt: 'Next request' });
    assert.equal(seen[0].prompt, 'Full human prompt\nnot a headline');
    assert.notEqual(seen[0].turnId, seen[1].turnId);
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'begin', allowReportingRepair: false }), null);
  } finally { unregister(); __clearTaskContinuationState(); }
});
