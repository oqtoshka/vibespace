import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadUntilSettled,
  nextReconnectEpoch,
  sessionModelForSend,
  sessionModelRetryDelay,
} from './sessionModelLoad';

// The drift these guard against: after a server restart the composer's
// active-model request failed once, the composer fell back to the per-provider
// default, and the next send recorded that default on the session — so the
// session silently changed model while the card showed another.

test('a failed read is retried until it answers, with growing waits', async () => {
  const waits: number[] = [];
  let calls = 0;
  const value = await loadUntilSettled(async () => {
    calls += 1;
    if (calls < 4) throw new Error('server restarting');
    return { model: 'gpt-6.1-sol' };
  }, { isCancelled: () => false, sleep: async (ms) => { waits.push(ms); } });

  assert.deepEqual(value, { model: 'gpt-6.1-sol' });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1_000, 2_000, 5_000]);
});

test('the wait stops growing at its cap', () => {
  assert.equal(sessionModelRetryDelay(0), 1_000);
  assert.equal(sessionModelRetryDelay(4), 30_000);
  assert.equal(sessionModelRetryDelay(40), 30_000);
});

test('switching away stops the retries and drops a late answer', async () => {
  let cancelled = false;
  let calls = 0;
  const value = await loadUntilSettled(async () => {
    calls += 1;
    throw new Error('still down');
  }, { isCancelled: () => cancelled, sleep: async () => { cancelled = true; } });
  assert.equal(value, undefined);
  assert.equal(calls, 1);

  let cancelledLate = false;
  const late = await loadUntilSettled(async () => {
    cancelledLate = true;
    return 'answer for the previous session';
  }, { isCancelled: () => cancelledLate });
  assert.equal(late, undefined);
});

test('an open session sends no model until its own has been read', () => {
  assert.equal(sessionModelForSend(true, false, 'gpt-5.4'), null, 'the default must not reach the server as a choice');
  assert.equal(sessionModelForSend(true, true, 'gpt-6-sol'), 'gpt-6-sol');
  assert.equal(sessionModelForSend(false, true, 'gpt-5.4'), undefined, 'a new chat uses the per-provider default');
});

test('only a connection that comes back counts as a reconnect', () => {
  assert.equal(nextReconnectEpoch(0, null, false), 0, 'mounting disconnected');
  assert.equal(nextReconnectEpoch(0, null, true), 0, 'mounting connected');
  assert.equal(nextReconnectEpoch(0, true, false), 0, 'dropping');
  assert.equal(nextReconnectEpoch(0, false, true), 1, 'coming back');
  assert.equal(nextReconnectEpoch(1, true, true), 1, 'staying up');
});
