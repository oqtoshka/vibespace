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
