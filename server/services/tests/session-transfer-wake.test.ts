import assert from 'node:assert/strict';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '../../modules/database/index.js';
import { sessionTransferService } from '../../modules/session-transfer/index.js';
import { __resetRateLimitWakeState, runRateLimitWakeTick, scheduleRateLimitWake, startRateLimitWakeLoop } from '../rate-limit-wake.service.js';

// Legacy scheduler integration stays beside that scheduler's other tests.
test('due wake selected before transfer cannot start and later registration is refused', { skip: !process.env.TRANSFER_TEST_ROOT }, async () => {
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = process.env.TRANSFER_TEST_ROOT + '/wake-transfer-' + process.pid + '.sqlite';
  try {
    await initializeDatabase();
    const db = getConnection();
    for (const [app, native] of [['wake-source','wake-source-native'], ['wake-target','wake-target-native']]) {
      db.prepare(`INSERT INTO sessions(session_id,provider,provider_session_id,is_private,is_side,isArchived)
        VALUES (?,'claude',?,0,0,0)`).run(app, native);
    }
    __resetRateLimitWakeState();
    await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'wake-source-native', now: Date.now() - 7200000 });
    let started = 0;
    await startRateLimitWakeLoop({ startTurn: () => { started++; return true; } });
    sessionTransferService.transfer('wake-source', { requestId: 'wake-transfer-one', sourceNativeId: 'wake-source-native',
      successorSessionId: 'wake-target', successorNativeId: 'wake-target-native' }, false);
    assert.deepEqual(await runRateLimitWakeTick(Date.now() + 1000000), []);
    assert.equal(started, 0);
    assert.equal(await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'wake-source-native' }), null);
  } finally {
    __resetRateLimitWakeState(); closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
  }
});
