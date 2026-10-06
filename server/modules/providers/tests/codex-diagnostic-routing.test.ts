import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, closeConnection, sessionsDb, getConnection } from '../../database/index.js';
import { chatRunRegistry } from '../../websocket/index.js';
import { codexApprovals } from '../../codex-approvals/index.js';
// eslint-disable-next-line boundaries/no-unknown -- Actual cached ordinary peer identity and native JSON-RPC round trips are part of this integration fixture.
import { getCodexAppServer, getExistingCodexAppServerTransports, stopCodexAppServer } from '../../../services/codex-app-server.service.js';
import { createCodexDiagnosticBindings } from '../services/codex-diagnostic-binding.service.js';
import { createCodexDiagnosticHost } from '../services/codex-diagnostic-host.service.js';
import { createCodexDiagnosticRouting } from '../services/codex-diagnostic-routing.service.js';

const root = process.env.TEST_ARTIFACT_ROOT ?? os.tmpdir();
process.env.DATABASE_PATH = path.join(root, `routing-${process.pid}.db`);
const native = '22222222-2222-2222-2222-222222222222';
const descendant = '33333333-3333-3333-3333-333333333333';
const unrelated = '44444444-4444-4444-4444-444444444444';
await initializeDatabase();
test.after(() => closeConnection());

async function fixture() {
  const dir = await mkdtemp(path.join(root, 'diagnostic-transfer-'));
  const oldScript = path.join(dir, 'old-peer'); const script = path.join(dir, 'reviewed-peer');
  const receipts = path.join(dir, 'requests.jsonl'); const counter = path.join(dir, 'counter');
  const states = [path.join(dir, 'shared.json'), path.join(dir, 'private.json'), path.join(dir, 'dedicated.json')];
  await writeFile(counter, '0');
  await writeFile(states[0], JSON.stringify({ ids: [native, descendant] }));
  await writeFile(states[1], JSON.stringify({ ids: [unrelated] }));
  await writeFile(states[2], JSON.stringify({ ids: [] }));
  const code = (old: boolean) => `#!/usr/bin/env node
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
const old=${old};const count=old?Number(fs.readFileSync(${JSON.stringify(counter)},'utf8')):2;
if(old)fs.writeFileSync(${JSON.stringify(counter)},String(count+1));
const statePath=${JSON.stringify(states)}[count];const capture=${JSON.stringify(receipts)};
const read=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));const save=s=>fs.writeFileSync(statePath,JSON.stringify(s));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
fs.appendFileSync(capture,JSON.stringify({kind:'spawn',count,pid:process.pid})+'\\n');
let pendingTurn;
rl.on('line',line=>{
const m=JSON.parse(line);fs.appendFileSync(capture,JSON.stringify({count,...m})+'\\n');
if(m.id!==undefined&&m.method===undefined){if(pendingTurn){send({id:pendingTurn.id,result:{turn:{id:'synthetic-turn'}}});pendingTurn=null;}return;}
if(m.id===undefined)return;const p=m.params||{};let s=read();let result={};
if(m.method==='initialize')result={};
else if(m.method==='thread/loaded/list')result={data:s.ids,nextCursor:null};
else if(m.method==='thread/read'){
 if(s.notify){s.notify=false;save(s);send({method:'turn/started',params:{threadId:p.threadId}});}
 result={thread:{id:p.threadId,status:{type:s.active===p.threadId?'active':s.unknown?'unknown':'idle'},parentThreadId:p.threadId===${JSON.stringify(descendant)}?${JSON.stringify(native)}:null}};
}else if(m.method==='thread/unsubscribe'){
 s.ids=s.ids.filter(id=>id!==p.threadId);save(s);send({method:'thread/closed',params:{threadId:p.threadId}});result={status:'unsubscribed'};
}else if(m.method==='thread/resume'){
 if(!s.ids.includes(p.threadId))s.ids.push(p.threadId);save(s);
 if(s.failResume){send({id:m.id,error:{message:'PRIVATE_PROVIDER_ERROR'}});return;}
 result={thread:{id:s.wrongIdentity?${JSON.stringify(unrelated)}:p.threadId}};
}else if(m.method==='thread/turns/list')result={data:[{id:'synthetic-history'}],nextCursor:null};
else if(m.method==='turn/start'){
 pendingTurn=m;send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,command:'synthetic'}});return;
}else throw new Error('unexpected-request');send({id:m.id,result});
});
`;
  await writeFile(oldScript, code(true)); await chmod(oldScript, 0o500);
  const bytes = code(false); await writeFile(script, bytes); await chmod(script, 0o500);
  const previous = process.env.VIBESPACE_CODEX_PATH; process.env.VIBESPACE_CODEX_PATH = oldScript;
  const shared = await getCodexAppServer(); const privatePeer = await getCodexAppServer({ private: true });
  const appSessionId = randomUUID(); const generation = 'trusted-resource-epoch';
  const scope = { appSessionId, nativeThreadId: native, generation, private: false, side: false };
  sessionsDb.createAppSession(appSessionId, 'codex', dir); sessionsDb.assignProviderSessionId(appSessionId, native);
  let epoch: string | null = generation; let checkpoint = true; let wall = Date.now(); let monotonic = 1000;
  const host = createCodexDiagnosticHost({ generationFor: () => epoch,
    checkpointed: async (_scope, ids) => checkpoint && ids.includes(native) && ids.every(id => [native, descendant].includes(id)) });
  const bindings = createCodexDiagnosticBindings({ capture: getExistingCodexAppServerTransports, now: () => wall,
    monotonicNow: () => monotonic, reserve: host.reserve, ownersCheckpointed: host.ownersCheckpointed });
  const review = await bindings.reviewExecutable({ executable: script, captureDirectory: dir,
    sha256: createHash('sha256').update(bytes).digest('hex'), observerContract: 'exec-fingerprint-utc-v1', environment: { PATH: process.env.PATH } });
  const deadline = new Date(Math.floor((wall + 60000) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const handle = await bindings.prepare(scope, review, deadline);
  const routing = createCodexDiagnosticRouting({ bindings, host, capture: () => [...getExistingCodexAppServerTransports(), ...bindings.capture()],
    now: () => wall, monotonicNow: () => monotonic });
  const state = async (index: number, patch: Record<string, unknown>) => { const value = JSON.parse(await readFile(states[index], 'utf8')); await writeFile(states[index], JSON.stringify({ ...value, ...patch })); };
  return { scope, handle, host, bindings, routing, shared, privatePeer, state,
    setCheckpoint: (value: boolean) => { checkpoint = value; }, rebound: () => { epoch = 'new-epoch'; },
    expire: () => { monotonic += 61000; wall -= 3600000; },
    ids: async (index: number) => JSON.parse(await readFile(states[index], 'utf8')).ids as string[],
    requests: async () => (await readFile(receipts, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    async close() {
      for (const entry of bindings.capture()) {
        if (entry.client.child.exitCode !== null || entry.client.child.signalCode !== null) continue;
        const exited = new Promise<void>(resolve => entry.client.child.once('exit', () => resolve())); entry.client.stop(); await exited;
      }
      const exits = [shared, privatePeer].filter(peer => !peer.exited).map(peer => new Promise<void>(resolve => peer.child.once('exit', () => resolve())));
      stopCodexAppServer(); await Promise.all(exits);
      if (previous === undefined) delete process.env.VIBESPACE_CODEX_PATH; else process.env.VIBESPACE_CODEX_PATH = previous;
      getConnection().prepare('DELETE FROM sessions WHERE session_id=?').run(appSessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('actual host reservation rejects active lease, rebound/private/side/archive and never infers owner checkpoint', async () => {
  const f = await fixture();
  try {
    const lease = chatRunRegistry.reserveAdmission({ appSessionId: f.scope.appSessionId, providerSessionId: native, resourceId: 'foreign-owned-test', generation: f.scope.generation, ttlMs: 15000 });
    assert.ok(lease); assert.equal(f.host.reserve(f.scope, 'candidate'), null); lease.release();
    f.setCheckpoint(false); assert.equal(await f.host.ownersCheckpointed(f.scope, [native]), false);
    const db = getConnection();
    for (const field of ['is_private', 'is_side', 'isArchived']) {
      db.prepare(`UPDATE sessions SET ${field}=1 WHERE session_id=?`).run(f.scope.appSessionId);
      assert.equal(f.host.reserve(f.scope, 'candidate'), null);
      db.prepare(`UPDATE sessions SET ${field}=0 WHERE session_id=?`).run(f.scope.appSessionId);
    }
    f.rebound(); assert.equal(f.host.reserve(f.scope, 'candidate'), null);
  } finally { await f.close(); }
});

test('real old-owner transfer selects the same dedicated peer for turn/history, preserves unrelated private peer and native approvals', async () => {
  const f = await fixture(); let unbind: (() => void) | undefined;
  try {
    const initialPrivate = await f.ids(1);
    await f.routing.transfer(f.scope, f.handle);
    assert.deepEqual(await f.ids(0), []); assert.deepEqual(await f.ids(2), [native]);
    assert.deepEqual(await f.ids(1), initialPrivate);
    const turn = f.routing.acquire(f.scope, 'turn', () => f.shared);
    const history = f.routing.acquire(f.scope, 'history', () => f.shared);
    assert.equal(turn.peer, history.peer); assert.notEqual(turn.peer, f.shared);
    assert.deepEqual(await history.request('thread/turns/list', { threadId: native }), { data: [{ id: 'synthetic-history' }], nextCursor: null });
    let approvals = 0;
    unbind = codexApprovals.bind(native, f.scope.appSessionId, event => { if (event.kind === 'permission_request') { approvals++; codexApprovals.resolve(String(event.requestId), { allow: true }); } });
    assert.deepEqual(await turn.request('turn/start', { threadId: native, input: [] }), { turn: { id: 'synthetic-turn' } });
    assert.equal(approvals, 1);
    await assert.rejects(history.request('turn/start', { threadId: native }), /readonly-purpose/);
    await assert.rejects(turn.request('turn/start', { threadId: unrelated }), /execution-scope/);
    assert.equal(f.shared.closed, false); assert.equal(f.privatePeer.closed, false);
    assert.equal(await f.bindings.cleanup(f.handle), false, 'uncoordinated expiry cleanup cannot stop a claimed transport');
    assert.equal(f.routing.state(f.scope)?.holds, 2); turn.release(); turn.release(); history.release();
    assert.equal(f.routing.state(f.scope)?.holds, 0);
    await assert.rejects(turn.request('turn/start', { threadId: native }), /route-unavailable/);
    assert.equal((await f.requests()).filter(row => row.kind === 'spawn').length, 3);
    assert.equal(f.shared.listeners.size, 0);
  } finally { unbind?.(); await f.close(); }
});

test('a throwing host admission leaves ordinary ownership intact and releases the pending selector gate', async () => {
  const f = await fixture();
  const reserve = f.host.reserve;
  try {
    f.host.reserve = () => { throw new Error('PRIVATE_HOST_ERROR'); };
    await assert.rejects(f.routing.transfer(f.scope, f.handle), /^Error: diagnostic-transfer-refused$/);
    assert.deepEqual(await f.ids(0), [native, descendant]); assert.deepEqual(await f.ids(2), []);
    f.host.reserve = reserve;
    await f.routing.transfer(f.scope, f.handle);
    assert.deepEqual(await f.ids(0), []); assert.deepEqual(await f.ids(2), [native]);
  } finally { f.host.reserve = reserve; await f.close(); }
});

test('the real host adapter times out an unavailable explicit checkpoint instead of deriving it from idle peers', async () => {
  const f = await fixture();
  try {
    const stalled = createCodexDiagnosticHost({ generationFor: () => f.scope.generation,
      checkpointed: () => new Promise<boolean>(() => undefined) });
    const started = Date.now();
    assert.equal(await stalled.ownersCheckpointed(f.scope, [native]), false);
    assert.ok(Date.now() - started >= 1400); assert.ok(Date.now() - started < 5000);
    assert.deepEqual(await f.ids(0), [native, descendant]);
  } finally { await f.close(); }
});

for (const reason of ['activeChild', 'lifecycle', 'otherHost', 'unknownCheckpoint'] as const) {
  test(`${reason} refuses actual transfer before old-owner unload`, async () => {
    const f = await fixture();
    try {
      if (reason === 'activeChild') await f.state(0, { active: descendant });
      if (reason === 'lifecycle') await f.state(0, { notify: true });
      if (reason === 'otherHost') await f.state(1, { ids: [unrelated, native] });
      if (reason === 'unknownCheckpoint') f.setCheckpoint(false);
      await assert.rejects(f.routing.transfer(f.scope, f.handle), /transfer-refused/);
      assert.deepEqual(await f.ids(0), [native, descendant]); assert.deepEqual(await f.ids(2), []);
      assert.equal(f.shared.closed, false); assert.equal(f.privatePeer.closed, false);
      assert.equal(f.shared.listeners.size, 0);
    } finally { await f.close(); }
  });
}

for (const reason of ['failResume', 'wrongIdentity']) {
  test(`${reason} actual diagnostic resume rolls back to old owner without duplicate hosting`, async () => {
    const f = await fixture();
    try {
      await f.state(2, { [reason]: true });
      await assert.rejects(f.routing.transfer(f.scope, f.handle), /transfer-refused/);
      assert.deepEqual(await f.ids(0), [native, descendant]);
      assert.deepEqual(await f.ids(1), [unrelated]); assert.deepEqual(await f.ids(2), []);
      assert.equal(f.bindings.capture().length, 0);
      assert.equal(f.routing.acquire(f.scope, 'history', () => f.shared).peer, f.shared);
      const req = await f.requests();
      const firstResume = req.findIndex(row => row.count === 2 && row.method === 'thread/resume');
      const oldUnload = req.findIndex(row => row.count === 0 && row.method === 'thread/unsubscribe' && row.params.threadId === native);
      assert.ok(firstResume > oldUnload);
    } finally { await f.close(); }
  });
}

test('expiry denies new turns, retains exact history peer/holds, and rejects copied identity/private rebound', async () => {
  const f = await fixture();
  try {
    await f.routing.transfer(f.scope, f.handle);
    const history = f.routing.acquire(f.scope, 'history', () => f.shared);
    const acquiredTurn = f.routing.acquire(f.scope, 'turn', () => f.shared);
    f.expire();
    assert.throws(() => f.routing.acquire(f.scope, 'turn', () => f.shared), /expired/);
    await assert.rejects(acquiredTurn.request('turn/start', { threadId: native }), /expired/);
    await assert.rejects(acquiredTurn.request('thread/resume', { threadId: native }), /route-method/);
    await assert.rejects(history.request('turn/start', { threadId: native }), /readonly-purpose/);
    assert.equal(f.routing.acquire(f.scope, 'history', () => f.shared).peer, history.peer);
    assert.throws(() => f.routing.acquire({ ...f.scope, generation: 'wrong' }, 'history', () => f.shared), /rebound/);
    assert.throws(() => f.routing.acquire({ ...f.scope, private: true }, 'turn', () => f.privatePeer), /rebound/);
    let calls = 0;
    const privateScope = { ...f.scope, appSessionId: randomUUID(), nativeThreadId: unrelated, private: true };
    assert.equal(f.routing.acquire(privateScope, 'turn', () => { calls++; return f.privatePeer; }).peer, f.privatePeer);
    assert.equal(calls, 1); history.release(); acquiredTurn.release();
    assert.equal(history.peer.closed, false);
  } finally { await f.close(); }
});


for (const reason of ['active', 'unknown', 'notify']) {
  test(`dedicated ${reason} after ambiguous resume quarantines without restoring another native host`, async () => {
    const f = await fixture();
    try {
      await f.state(2, { failResume: reason !== 'notify', [reason]: reason === 'active' ? native : true });
      await assert.rejects(f.routing.transfer(f.scope, f.handle), /transfer-quarantined/);
      assert.deepEqual(await f.ids(0), []); assert.deepEqual(await f.ids(2), [native]);
      assert.equal(f.routing.state(f.scope)?.phase, 'quarantined');
      assert.throws(() => f.routing.acquire(f.scope, 'history', () => f.shared), /unavailable/);
      assert.equal(f.shared.closed, false); assert.equal(f.privatePeer.closed, false);
    } finally { await f.close(); }
  });
}
