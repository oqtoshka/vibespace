import assert from 'node:assert/strict';
import test from 'node:test';

process.env.VIBESPACE_TASK_NUDGE_MAX = '3';
const { planTaskContinuation, __clearTaskContinuationState, __setTaskLedgerReader } = await import('../index.js');

for (const provider of ['codex', 'opencode', 'cursor']) {
  test(`${provider}: productive turns renew budget; empty turns still stop`, () => {
    __clearTaskContinuationState();
    const open = [{ id: '1', subject: 'Finish verified release', status: 'in_progress', waitingOnUser: false }];
    let activity = 0;
    __setTaskLedgerReader(provider, () => ({ open, activity }));
    try {
      for (let turn = 0; turn < 12; turn += 1) {
        activity += 1;
        assert.ok(planTaskContinuation({ provider, sessionId: 'productive-regression' }));
      }
      assert.ok(planTaskContinuation({ provider, sessionId: 'productive-regression' }));
      assert.equal(planTaskContinuation({ provider, sessionId: 'productive-regression' }), null);
      open[0].waitingOnUser = true;
      assert.equal(planTaskContinuation({ provider, sessionId: 'productive-regression' }), null);
    } finally { __setTaskLedgerReader(provider, null); __clearTaskContinuationState(); }
  });
}

test('ledger progress without additional tools also renews the budget', () => {
  __clearTaskContinuationState();
  let subject = 'step 0';
  __setTaskLedgerReader('codex', () => ({ open: [{ id: '1', subject, status: 'in_progress' }], activity: 1 }));
  try {
    for (let turn = 0; turn < 12; turn += 1) {
      subject = `step ${turn}`;
      assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'ledger-regression' }));
    }
  } finally { __setTaskLedgerReader('codex', null); __clearTaskContinuationState(); }
});
