import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line boundaries/no-unknown -- The fixture exercises the actual old cached native transports without replacing them.
import { getCodexAppServer, getExistingCodexAppServerTransports, stopCodexAppServer } from '../../../services/codex-app-server.service.js';
import { createCodexDiagnosticBindings } from '../services/codex-diagnostic-binding.service.js';

const app = '11111111-1111-1111-1111-111111111111';
const native = '22222222-2222-2222-2222-222222222222';
const descendant = '33333333-3333-3333-3333-333333333333';
const scope = { appSessionId: app, nativeThreadId: native, generation: 'generation_1', private: false, side: false };

async function fixture(options: { active?: boolean; notify?: boolean; refuse?: boolean; owners?: boolean; failInitialize?: boolean; stallOwner?: boolean; expireLease?: boolean } = {}) {
  const dir = await mkdtemp(path.join(process.env.TEST_ARTIFACT_ROOT ?? os.tmpdir(), 'diagnostic-routing-'));
  const capture = path.join(dir, 'receipts.jsonl');
  const oldExecutable = path.join(dir, 'old-peer');
  const executable = path.join(dir, 'reviewed-peer');
  const statePath = path.join(dir, 'dedicated-state');
  await writeFile(statePath, 'idle');
  const previous = process.env.VIBESPACE_CODEX_PATH;
  const script = (old: boolean) => `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({kind:'spawn',old:${old},pid:process.pid,
  thread:process.env.CODEX_EXEC_FINGERPRINT_THREAD,deadline:process.env.CODEX_EXEC_FINGERPRINT_DEADLINE_UTC,
  serverSecretPresent:!!process.env.JWT_SECRET})+'\\n');
rl.on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 let result;
 if(m.method==='initialize') {
   if(${!old && Boolean(options.failInitialize)}) {process.stdout.write(JSON.stringify({id:m.id,error:{message:'PRIVATE_ERROR_MUST_NOT_ESCAPE'}})+'\\n');return;}
   result={userAgent:'fake'};
 } else if(m.method==='thread/loaded/list') result={data:${old ? JSON.stringify([native, descendant]) : `fs.readFileSync(${JSON.stringify(statePath)},'utf8')==='idle'?[]:[${JSON.stringify(native)}]`},nextCursor:null};
 else if(m.method==='thread/read') {
   if(${old && Boolean(options.notify)})process.stdout.write(JSON.stringify({method:'turn/started',params:{threadId:m.params.threadId}})+'\\n');
   result={thread:{id:m.params.threadId,status:{type:${old ? options.active ? "'active'" : "'idle'" : `fs.readFileSync(${JSON.stringify(statePath)},'utf8')`}},parentThreadId:m.params.threadId===${JSON.stringify(descendant)}?${JSON.stringify(native)}:null}};
 } else throw new Error('unexpected-request');
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`;
  try {
    const bytes = script(false);
    await writeFile(oldExecutable, script(true)); await chmod(oldExecutable, 0o500);
    await writeFile(executable, bytes); await chmod(executable, 0o500);
    process.env.VIBESPACE_CODEX_PATH = oldExecutable;
    const shared = await getCodexAppServer(); const privatePeer = await getCodexAppServer({ private: true });
    let wall = Date.now(); let monotonic = 1000; let released = 0;
    const engine = createCodexDiagnosticBindings({ capture: getExistingCodexAppServerTransports,
      now: () => wall, monotonicNow: () => monotonic,
      reserve: () => options.refuse ? null : { expiresAt: wall + 15000, release: () => { released++; } },
      ownersCheckpointed: async (_scope, ids) => {
        assert.deepEqual(ids, [native, descendant].sort());
        if (options.stallOwner) return new Promise<boolean>(() => undefined);
        if (options.expireLease) { monotonic += 16000; wall -= 3600000; }
        return options.owners !== false;
      },
    });
    const reviewId = await engine.reviewExecutable({ executable, sha256: createHash('sha256').update(bytes).digest('hex'), captureDirectory: dir,
      observerContract: 'exec-fingerprint-utc-v1', environment: { PATH: process.env.PATH, JWT_SECRET: 'SYNTHETIC_SERVER_SECRET' } });
    const until = Math.floor((wall + 60000) / 1000) * 1000;
    const deadline = new Date(until).toISOString().replace('.000Z', 'Z');
    return { engine, reviewId, deadline, shared, privatePeer, dir, executable,
      receipts: async () => (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
      released: () => released,
      setDedicatedState: (state: string) => writeFile(statePath, state),
      expireMonotonically: () => { monotonic += 61000; wall -= 3600000; },
      async close() {
        // Test fixture owns these exact synthetic processes, including cleanup
        // after an assertion fails; never enumerate a production process tree.
        for (const entry of engine.capture()) {
          const exit = new Promise<void>(resolve => entry.client.child.once('exit', () => resolve()));
          entry.client.stop(); await exit;
        }
        const exits = [shared, privatePeer].filter(peer => !peer.exited).map(peer => new Promise<void>(resolve => peer.child.once('exit', () => resolve())));
        stopCodexAppServer(); await Promise.all(exits);
        if (previous === undefined) delete process.env.VIBESPACE_CODEX_PATH; else process.env.VIBESPACE_CODEX_PATH = previous;
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    stopCodexAppServer();
    if (previous === undefined) delete process.env.VIBESPACE_CODEX_PATH; else process.env.VIBESPACE_CODEX_PATH = previous;
    await rm(dir, { recursive: true, force: true }); throw error;
  }
}

test('reviewed standby has a dedicated executable/env/cache; old shared/private peers remain identical', async () => {
  const f = await fixture();
  try {
    const globalOverride = process.env.VIBESPACE_CODEX_PATH;
    const handle = await f.engine.prepare(scope, f.reviewId, f.deadline);
    assert.equal(await f.engine.prepare(scope, f.reviewId, f.deadline), handle);
    const peer = f.engine.standby(handle, scope);
    assert.notEqual(peer, f.shared); assert.notEqual(peer, f.privatePeer);
    assert.equal(getExistingCodexAppServerTransports()[0].client, f.shared);
    assert.equal(getExistingCodexAppServerTransports()[1].client, f.privatePeer);
    assert.equal(f.shared.listeners.size, 0); assert.equal(f.privatePeer.listeners.size, 0);
    assert.equal(process.env.VIBESPACE_CODEX_PATH, globalOverride);
    const receipts = await f.receipts();
    assert.equal(receipts.length, 3);
    assert.deepEqual(receipts.filter(row => !row.old).map(row => [row.thread, row.deadline, row.serverSecretPresent]), [[native, f.deadline, false]]);
    for (const method of ['thread/resume', 'turn/start', 'thread/unsubscribe']) {
      await assert.rejects(peer.request(method, { threadId: native }), /transfer-unavailable/);
    }
    await assert.rejects(f.engine.cleanup({ ...handle }), /handle-mismatch/);
    assert.equal(await f.engine.cleanup(handle), true);
    assert.equal(f.engine.capture().length, 0);
    assert.equal(f.shared.closed, false); assert.equal(f.privatePeer.closed, false);
    assert.equal(f.released(), 1);
  } finally { await f.close(); }
});

const refusals: Array<[string, NonNullable<Parameters<typeof fixture>[0]>]> = [
  ['active', { active: true }], ['lifecycle', { notify: true }], ['hostRefusal', { refuse: true }],
  ['unknownOwner', { owners: false }], ['initializationFailure', { failInitialize: true }],
  ['stalledOwner', { stallOwner: true }], ['expiredMonotonicHostLease', { expireLease: true }],
];
for (const [name, options] of refusals) {
  test(`${name} refuses preparation without changing ordinary cached peers`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(f.engine.prepare(scope, f.reviewId, f.deadline), error => error instanceof Error && !error.message.includes('PRIVATE_ERROR'));
      assert.equal(f.engine.capture().length, 0);
      assert.equal(f.shared.closed, false); assert.equal(f.privatePeer.closed, false);
      assert.equal(f.shared.listeners.size, 0);
      assert.equal((await f.receipts()).length, options.failInitialize ? 3 : 2);
    } finally { await f.close(); }
  });
}

test('private/side/mismatched/rebound/expired bindings cannot select a standby', async () => {
  const f = await fixture();
  try {
    for (const bad of [{ ...scope, private: true }, { ...scope, side: true }, { ...scope, nativeThreadId: 'invalid' }]) {
      await assert.rejects(f.engine.prepare(bad, f.reviewId, f.deadline), /scope-refused/);
    }
    await assert.rejects(f.engine.prepare(scope, 'missing-review', f.deadline), /review-missing/);
    await assert.rejects(f.engine.prepare(scope, f.reviewId, f.deadline.replace('Z', '.000Z')), /deadline/);
    const handle = await f.engine.prepare(scope, f.reviewId, f.deadline);
    assert.throws(() => f.engine.standby(handle, { ...scope, generation: 'new' }), /rebound/);
    f.expireMonotonically();
    assert.throws(() => f.engine.standby(handle, scope), /expired/);
    // A backwards wall clock never extends admission; cleanup is targeted.
    assert.equal(await f.engine.cleanup(handle), true);
  } finally { await f.close(); }
});

test('changed reviewed bytes refuse spawning a dedicated peer', async () => {
  const f = await fixture();
  try {
    await chmod(f.executable, 0o700); await writeFile(f.executable, '#!/bin/false\n'); await chmod(f.executable, 0o500);
    await assert.rejects(f.engine.prepare(scope, f.reviewId, f.deadline), /review-changed/);
    assert.equal((await f.receipts()).length, 2);
    assert.equal(f.shared.closed, false);
  } finally { await f.close(); }
});


test('expired active or UNKNOWN dedicated peer defers only its own cleanup until actual idle', async () => {
  const f = await fixture();
  try {
    const handle = await f.engine.prepare(scope, f.reviewId, f.deadline);
    const peer = f.engine.standby(handle, scope);
    f.expireMonotonically();
    for (const state of ['active', 'unknown']) {
      await f.setDedicatedState(state);
      assert.throws(() => f.engine.standby(handle, scope), /expired/);
      assert.equal(await f.engine.cleanup(handle), false);
      assert.equal(peer.closed, false);
      assert.equal(f.engine.capture()[0].client, peer);
      assert.equal(f.shared.closed, false); assert.equal(f.privatePeer.closed, false);
    }
    await f.setDedicatedState('idle');
    assert.equal(await f.engine.cleanup(handle), true);
    assert.equal(peer.closed, true);
    assert.equal(f.engine.capture().length, 0);
  } finally { await f.close(); }
});

test('concurrent same-native preparation is refused without another dedicated spawn', async () => {
  const f = await fixture();
  try {
    const first = f.engine.prepare(scope, f.reviewId, f.deadline);
    await assert.rejects(f.engine.prepare({ ...scope, appSessionId: descendant }, f.reviewId, f.deadline), /binding-busy/);
    const handle = await first;
    await assert.rejects(f.engine.prepare({ ...scope, appSessionId: descendant }, f.reviewId, f.deadline), /binding-busy/);
    assert.equal((await f.receipts()).length, 3);
    assert.equal(await f.engine.cleanup(handle), true);
  } finally { await f.close(); }
});


test('mutating caller scope during awaited checks cannot rebind the native target', async () => {
  const f = await fixture();
  try {
    const supplied = { ...scope };
    const preparing = f.engine.prepare(supplied, f.reviewId, f.deadline);
    supplied.nativeThreadId = descendant; supplied.generation = 'changed';
    const handle = await preparing;
    assert.equal(handle.nativeThreadId, native);
    assert.equal(handle.generation, scope.generation);
    assert.equal(f.engine.standby(handle, scope).closed, false);
    assert.equal(await f.engine.cleanup(handle), true);
  } finally { await f.close(); }
});
