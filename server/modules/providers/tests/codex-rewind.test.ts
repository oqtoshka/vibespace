import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnyRecord } from '@/shared/index.js';

import { rewindCodexTurn } from '../services/codex-rewind.service.js';

for (const [anchor, count] of [['codex-turn-one', 3], ['codex-turn-two', 2], ['codex-turn-three', 1]] as const) {
  test(`Codex edit ${anchor} rolls back exactly ${count} turns`, async () => {
    const calls: AnyRecord[] = [];
    await rewindCodexTurn(async (method, params) => {
      calls.push({ method, ...params });
      return { thread: { id: 'thread', turns: ['one', 'two', 'three'].map(id => ({ id, status: 'completed' })) } };
    }, 'thread', anchor);
    assert.deepEqual(calls, [
      { method: 'thread/read', threadId: 'thread', includeTurns: false },
      { method: 'thread/read', threadId: 'thread', includeTurns: true },
      { method: 'thread/rollback', threadId: 'thread', numTurns: count },
    ]);
  });
}
for (const [name, thread, anchor] of [
  ['missing anchor', { id: 'thread', turns: [] }, 'codex-turn-missing'],
  ['wrong thread', { id: 'other', turns: [{ id: 'one' }] }, 'codex-turn-one'],
  ['active turn', { id: 'thread', turns: [{ id: 'one', status: 'inProgress' }] }, 'codex-turn-one'],
  ['active thread', { id: 'thread', status: { type: 'active' }, turns: [{ id: 'one' }] }, 'codex-turn-one'],
  ['malformed anchor', {}, 'arbitrary-id'],
] as const) {
  test(`Codex edit rejects ${name} without mutation`, async () => {
    const methods: string[] = [];
    await assert.rejects(rewindCodexTurn(async method => { methods.push(method); return { thread }; }, 'thread', anchor));
    assert.ok(!methods.includes('thread/rollback'));
  });
}
test('Codex rollback failure is propagated to the runtime', async () => {
  await assert.rejects(rewindCodexTurn(async method => {
    if (method === 'thread/rollback') throw new Error('Rollback refused');
    return { thread: { id: 'thread', turns: [{ id: 'one', status: 'failed' }] } };
  }, 'thread', 'codex-turn-one'), /Rollback refused/);
});

for (const id of ['first', 'middle', 'last']) {
  test(`paginated edit of ${id} uses the exact turn without legacy hydration or rollback`, async () => {
    const calls: AnyRecord[] = [];
    let marked = false;
    assert.equal(await rewindCodexTurn(async (method, params) => {
      calls.push({method,...params});
      if (method === 'thread/read') return {thread:{id:'thread',historyMode:'paginated',status:{type:'idle'},turns:[]}};
      assert.ok(marked, 'Canonical history routing must be durable before provider mutation');
      assert.equal(method,'thread/revert'); return {thread:{id:'thread',turns:[]}};
    }, 'thread', `codex-turn-${id}`, () => { marked = true; }), 'paginated');
    assert.deepEqual(calls,[{method:'thread/read',threadId:'thread',includeTurns:false},{method:'thread/revert',threadId:'thread',beforeTurnId:id}]);
  });
}
test('paginated stale anchor rejection never falls back to legacy rollback', async () => {
  const methods: string[] = [];
  await assert.rejects(rewindCodexTurn(async method => {
    methods.push(method);
    if(method === 'thread/read') return {thread:{id:'thread',historyMode:'paginated',status:{type:'idle'}}};
    throw new Error('Turn does not exist');
  },'thread','codex-turn-missing'),/Turn does not exist/);
  assert.deepEqual(methods,['thread/read','thread/revert']);
});
