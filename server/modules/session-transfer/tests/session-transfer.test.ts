import assert from 'node:assert/strict';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import { sessionTransferService } from '../index.js';

// Entire suite uses isolated in-memory SQLite, never the application's database.
test('exact addresses, active refusal, durable CAS and scheduled continuation guards', async () => {
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = process.env.TRANSFER_TEST_ROOT
    ? process.env.TRANSFER_TEST_ROOT + '/session-transfer-test-' + process.pid + '.sqlite' : ':memory:';
  try {
    await initializeDatabase();
    const db = getConnection();
    db.prepare(`INSERT INTO sessions(session_id,provider,provider_session_id,is_private,is_side,isArchived)
      VALUES(?,?,?,0,0,0)`).run('source-app','claude','source-native');
    db.prepare(`INSERT INTO sessions(session_id,provider,provider_session_id,is_private,is_side,isArchived)
      VALUES(?,?,?,0,0,0)`).run('target-app','codex','target-native');
    const input = { requestId: 'request-one', sourceNativeId: 'source-native', successorSessionId: 'target-app', successorNativeId: 'target-native' };
    assert.throws(() => sessionTransferService.transfer('source-app', { ...input, sourceNativeId: 'wrong-native' }, false), /addresses/);
    assert.throws(() => sessionTransferService.transfer('source-app', input, true), /processing/);
    assert.equal(sessionTransferService.successor('source-app'), undefined);
    const receipt = sessionTransferService.transfer('source-app', input, false);
    assert.equal(receipt.successor_native_id, 'target-native');
    assert.deepEqual(sessionTransferService.transfer('source-app', input, true), receipt, 'accepted retry does not inspect stale process state');
    assert.equal(sessionTransferService.successor('source-native')?.request_id, 'request-one');
    assert.equal(sessionTransferService.successor('target-native'), undefined);
    assert.throws(() => sessionTransferService.transfer('source-app', { ...input, requestId: 'request-two' }, false), /another request/);
    const { planTaskContinuation } = await import('@/modules/task-continuation/index.js');
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'source-native' }), null);
    // SQL backing is the restart contract; deleting process-side service references cannot remove it.
    assert.equal((db.prepare('SELECT count(*) AS n FROM session_transfer').get() as { n: number }).n, 1);
    if (process.env.TRANSFER_TEST_ROOT) {
      closeConnection();
      await initializeDatabase();
      assert.equal(sessionTransferService.successor('source-native')?.successor_native_id, 'target-native', 'guard survives connection restart');
    }
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
  }
});
