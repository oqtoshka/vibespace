import assert from 'node:assert/strict';
import test from 'node:test';

import { registerTaskLedgerSource } from '../../../shared/index.js';
import { planTaskContinuation, __clearTaskContinuationState } from '../index.js';

for (const provider of ['codex', 'cursor', 'opencode']) {
  test(`${provider}: unchanged parked card stays quiet; answered cards and due work still continue`, () => {
    __clearTaskContinuationState();
    const open = [
      { id: 's1', subject: 'Open card', status: 'pending' as const, waitingOnUser: true, updatedAt: null },
      { id: 's2', subject: 'Future schedule', status: 'pending' as const, waitingOnUser: true, updatedAt: null },
    ];
    const stop = registerTaskLedgerSource(() => ({ listName: 'card', guidance: 'Continue through card tools', open, activity: 7, agentTextPolicy: 'reject' }));
    const options = { provider, sessionId: 'silent-completed' };
    try {
      for (let i = 0; i < 5; i++) assert.equal(planTaskContinuation(options), null);
      open[0].waitingOnUser = false;
      assert.match(planTaskContinuation(options)!, /Open card/);
      open[0].waitingOnUser = true;
      open[1].waitingOnUser = false;
      assert.match(planTaskContinuation(options)!, /Future schedule/);
      assert.ok(planTaskContinuation(options));
      assert.equal(planTaskContinuation(options), null, 'unchanged report-only turns yield after two nudges');
      // Restart/resume resets only the continuation budget, not the card.
      __clearTaskContinuationState();
      assert.match(planTaskContinuation(options)!, /Future schedule/);
    } finally { stop(); __clearTaskContinuationState(); }
  });
}

test('exhausted external requests retain dedup state; progress and runnable changes bypass cooldown', () => {
  __clearTaskContinuationState();
  let activity = 1;
  let now = 1_000_000;
  const originalNow = Date.now;
  Date.now = () => now;
  const open = [{ id: 'r1', subject: 'Deliver outcome', status: 'in_progress' as const, waitingOnUser: false, updatedAt: null }];
  const stop = registerTaskLedgerSource(() => ({ listName: 'card', guidance: 'Use card tools', open, activity }));
  const options = { provider: 'codex', sessionId: 'dedup-reporting' };
  try {
    assert.ok(planTaskContinuation(options));
    assert.ok(planTaskContinuation(options));
    assert.equal(planTaskContinuation(options), null, 'unchanged work reaches its existing stall bound');
    for (let i = 0; i < 20; i++) assert.equal(planTaskContinuation(options), null);
    now += 60_000;
    assert.ok(planTaskContinuation(options), 'still-runnable unchanged work can be retried after cooldown');
    assert.ok(planTaskContinuation(options));
    assert.equal(planTaskContinuation(options), null);
    now += 60_000;
    assert.equal(planTaskContinuation(options), null, 'repeated duplicate bursts increase backoff');
    activity += 1;
    assert.ok(planTaskContinuation(options), 'actual ledger progress immediately bypasses cooldown');
    assert.ok(planTaskContinuation(options));
    assert.equal(planTaskContinuation(options), null);
    open.push({ id: 's2', subject: 'New runnable step', status: 'in_progress', waitingOnUser: false, updatedAt: null });
    assert.match(planTaskContinuation(options)!, /New runnable step/, 'new runnable work never waits for the old cooldown');
    open[0].waitingOnUser = true;
    open[1].waitingOnUser = true;
    assert.equal(planTaskContinuation(options), null);
    open[0].waitingOnUser = false;
    assert.ok(planTaskContinuation(options), 'answered wait starts immediately');
  } finally { Date.now = originalNow; stop(); __clearTaskContinuationState(); }
});
