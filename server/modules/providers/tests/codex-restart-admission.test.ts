import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexRestartAdmissionObserver } from '../services/codex-restart-admission.service.js';

function fixture(options: { statuses?: string[]; parent?: boolean; failure?: string; drift?: boolean;
  notify?: boolean; cursorCycle?: boolean; invalid?: boolean; replacement?: boolean; closed?: boolean } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let listener: ((message: { method: string }) => void) | undefined;
  let cleanup = 0;
  let lists = 0;
  let captures = 0;
  const client = {
    child: { pid: 123 }, closed: Boolean(options.closed),
    subscribe(fn: typeof listener) { listener = fn; return () => { cleanup++; }; },
    async request(method: string, params: Record<string, unknown>, timeout: number) {
      assert.ok(timeout > 0 && timeout <= 1500); calls.push({ method, params });
      if (options.failure) throw new Error(options.failure);
      if (method === 'thread/loaded/list') {
        lists++;
        if (options.invalid) return { data: 'not-an-inventory' };
        if (options.cursorCycle) return { data: [], nextCursor: 'same' };
        return { data: options.drift && lists > 1 ? ['new-id'] : (options.statuses ?? ['idle']).map((_, i) => `t${i}`), nextCursor: null };
      }
      assert.equal(method, 'thread/read');assert.equal(params.includeTurns, false);
      if (options.notify) listener?.({ method: 'turn/started' });
      const i = Number(String(params.threadId).slice(1));
      return { thread: { id: params.threadId, status: { type: (options.statuses ?? ['idle'])[i] },
        parentThreadId: options.parent ? 'parent' : null,
        preview: 'SECRET_PROMPT', turns: [{ text: 'SECRET_PROMPT' }], cwd: '/private/secret' } };
    },
  };
  const entries = [{ variant: 'shared', client }];
  const observer = createCodexRestartAdmissionObserver({ now: Date.now, capture() {
    captures++; return options.replacement && captures > 1 ? [] : entries;
  } });
  return { observer, calls, cleanup: () => cleanup };
}

test('idle existing transport is observable without authorizing restart or exposing content', async () => {
 const f=fixture();const r=await f.observer.observe();
 assert.equal(r.nativeThreadsIdle,true);assert.equal(r.restartAuthorized,false);
 assert.equal(f.calls.filter(c=>c.method==='thread/loaded/list').length,2);
 assert.equal(f.calls.filter(c=>c.method==='thread/read').length,1);
 assert.ok(!JSON.stringify(r).includes('SECRET'));assert.ok(!JSON.stringify(r).includes('private/secret'));
 assert.equal(f.cleanup(),1);
});
test('active native child blocks even when host registry would be idle',async()=>{
 const f=fixture({statuses:['idle','active'],parent:true});const r=await f.observer.observe();
 assert.equal(r.nativeThreadsIdle,false);assert.equal(r.variants[0].activeChildThreads,1);
 assert.equal(r.variants[0].activeThreads,1);
});
for(const status of ['notLoaded','systemError','future-status'])test(`${status} is UNKNOWN, never idle`,async()=>{
 const r=await fixture({statuses:[status]}).observer.observe();assert.equal(r.observation,'unknown');assert.equal(r.nativeThreadsIdle,false);
});
test('unsupported method or timeout remains UNKNOWN with no provider error payload',async()=>{
 const f=fixture({failure:'unsupported method SECRET_TOKEN'});const r=await f.observer.observe();
 assert.equal(r.observation,'unknown');assert.equal(r.nativeThreadsIdle,false);
 assert.equal(r.variants[0].reason,'native-observation-failed');assert.ok(!JSON.stringify(r).includes('SECRET'));assert.equal(f.cleanup(),1);
});
test('changed loaded set blocks snapshot',async()=>{
 const r=await fixture({drift:true}).observer.observe();assert.equal(r.observation,'unknown');assert.equal(r.nativeThreadsIdle,false);
});
test('turn lifecycle event during read blocks snapshot',async()=>{
 const r=await fixture({notify:true}).observer.observe();assert.equal(r.activityChanged,true);assert.equal(r.nativeThreadsIdle,false);
});
test('replaced cached client blocks snapshot',async()=>{
 const r=await fixture({replacement:true}).observer.observe();assert.equal(r.activityChanged,true);assert.equal(r.nativeThreadsIdle,false);
});
test('closed cached client is UNKNOWN',async()=>{
 const r=await fixture({closed:true}).observer.observe();assert.equal(r.observation,'unknown');assert.equal(r.nativeThreadsIdle,false);
});
test('invalid inventory is UNKNOWN',async()=>{
 const r=await fixture({invalid:true}).observer.observe();assert.equal(r.observation,'unknown');assert.equal(r.nativeThreadsIdle,false);
});
test('pagination cycle is bounded and UNKNOWN',async()=>{
 const f=fixture({cursorCycle:true});const r=await f.observer.observe();assert.equal(r.observation,'unknown');assert.equal(f.calls.length,2);
});
test('production empty cache observation never spawns an app-server',async()=>{
 const r=await createCodexRestartAdmissionObserver().observe();
 assert.equal(r.variants.length,0);assert.equal(r.restartAuthorized,false);
});


test('a cached readiness handshake that never settles is bounded without spawning', async () => {
 let unsubscribed = false;
 const observer = createCodexRestartAdmissionObserver({ now: Date.now, capture: () => [{
   variant: 'shared', client: { child: { pid: 123 }, closed: false,
     subscribe: () => () => { unsubscribed = true; },
     request: () => new Promise(() => undefined),
   },
 }] });
 const started = performance.now();
 const result = await observer.observe();
 assert.ok(performance.now() - started < 2500);
 assert.equal(result.observation, 'unknown');
 assert.equal(result.variants[0].reason, 'observation-deadline');
 assert.equal(result.restartAuthorized, false);
 assert.equal(unsubscribed, true);
});
