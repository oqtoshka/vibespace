import assert from 'node:assert/strict';
import test from 'node:test';

import { NativeCapabilityLease } from '../services/native-capability-lease.service.js';

test('idle lease expires independently and cannot be revived or close twice', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let closed = 0;
  const lease = new NativeCapabilityLease('first', 2_000, () => 9_000, () => { closed++; });
  t.after(() => lease.stop());
  assert.equal(lease.active(), true);
  t.mock.timers.tick(1_000);
  assert.equal(closed, 1); assert.equal(lease.active(), false); assert.equal(lease.renew('fresh'), false);
  t.mock.timers.tick(9_000); assert.equal(closed, 1);
});

test('fresh same-session renewal extends the lease and cancels the old deadline', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let closed = 0;
  const lease = new NativeCapabilityLease('first', 2_000, value => value === 'first' ? 2_000 : value === 'fresh' ? 3_000 : null, () => { closed++; });
  t.after(() => lease.stop());
  t.mock.timers.tick(500); assert.equal(lease.renew('fresh'), true);
  t.mock.timers.tick(500); assert.equal(lease.active(), true); assert.equal(closed, 0);
  t.mock.timers.tick(1_000); assert.equal(closed, 1);
});

test('invalid renewal and failed verification close before another command or payload', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  for (const failure of ['revoked', 'database', 'wrong-session', 'replay']) {
    let closed = 0; let broken = false;
    const lease = new NativeCapabilityLease('first', 2_000, value => {
      if (broken && failure === 'database') throw new Error('observation unavailable');
      return !broken && value === 'first' ? 2_000 : null;
    }, () => { closed++; });
    if (failure === 'revoked' || failure === 'database') { broken = true; assert.equal(lease.active(), false); }
    else assert.equal(lease.renew(failure === 'replay' ? 'first' : 'other'), false);
    assert.equal(closed, 1); assert.equal(lease.active(), false); lease.stop();
  }
});

test('normal viewer close cancels its deadline', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let closed = 0;
  const lease = new NativeCapabilityLease('first', 2_000, () => 2_000, () => { closed++; });
  lease.stop(); t.mock.timers.tick(5_000); assert.equal(closed, 0);
});
