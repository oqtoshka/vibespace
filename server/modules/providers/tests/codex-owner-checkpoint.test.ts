import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createCodexOwnerCheckpoints } from '../services/codex-owner-checkpoint.service.js';

const root = '22222222-2222-2222-2222-222222222222';
const child = '33333333-3333-3333-3333-333333333333';
const foreign = '44444444-4444-4444-4444-444444444444';
const scope = { appSessionId: 'app-session', nativeThreadId: root, generation: 'g1', private: false, side: false };
type Dependencies = Parameters<typeof createCodexOwnerCheckpoints>[0];
type Challenge = Parameters<Dependencies['requestAcknowledgement']>[0];
type Reply = Awaited<ReturnType<Dependencies['requestAcknowledgement']>>;

/** The controlled owner channel separates authenticated sender identity from its payload.
 * It deliberately supplies no default ACK when a run is idle or an inventory is read. */
function fixture(ttlMs = 100) {
  const events = new EventEmitter();
  let wall = 1000;
  let monotonic = 50;
  let observations = 0;
  let requests = 0;
  let actualScope = { ...scope };
  let ownerId = 'authenticated-owner';
  let revision = 'residency-1';
  let nativeIds = [root, child];
  let receive: ((value: Reply) => void) | undefined;
  let latest: Challenge | undefined;
  let observed: Dependencies['observeOwner'] | undefined;
  let cleanup: (() => void) | undefined;
  const deps: Dependencies = {
    ttlMs, now: () => wall, monotonicNow: () => monotonic,
    observeOwner: async input => {
      observations++;
      if (observed) return observed(input);
      return { scope: { ...actualScope }, ownerId, residencyRevision: revision, nativeIds: [...nativeIds] };
    },
    requestAcknowledgement: async challenge => {
      requests++; latest = challenge;
      return new Promise<Reply>(resolve => { receive = resolve; events.emit('challenge', challenge); });
    },
    subscribeInvalidation: (_input, invalidate) => {
      events.on('lifecycle', invalidate);
      return () => { events.off('lifecycle', invalidate); cleanup?.(); };
    },
  };
  const checkpoints = createCodexOwnerCheckpoints(deps);
  return {
    checkpoints, deps, events,
    snapshot: () => ({ scope: { ...actualScope }, ownerId, residencyRevision: revision, nativeIds: [...nativeIds] }),
    reply(sender: string, payload: NonNullable<Reply>['payload']) { receive?.({ authenticatedOwnerId: sender, payload }); },
    ack(challenge: Challenge) { receive?.({ authenticatedOwnerId: ownerId, payload: { ...challenge, acknowledged: true } }); },
    absent() { receive?.(null); },
    setScope(value: typeof scope) { actualScope = value; },
    setIds(value: string[]) { nativeIds = value; },
    setOwner(value: string) { ownerId = value; },
    setRevision(value: string) { revision = value; },
    setClocks(w: number, m: number) { wall = w; monotonic = m; },
    setObserve(value: Dependencies['observeOwner']) { observed = value; },
    setCleanup(value: () => void) { cleanup = value; },
    get latest() { return latest; }, get observations() { return observations; }, get requests() { return requests; },
  };
}

test('explicit owner ACK binds complete actual inventory; reads and delivery alone never acknowledge', async () => {
  const f = fixture();
  const requested = new Promise<Challenge>(resolve => f.events.once('challenge', resolve));
  const pending = f.checkpoints.checkpointed(scope, [child, root]);
  const challenge = await requested;
  assert.equal(f.observations, 1); assert.equal(f.requests, 1);
  assert.equal(Object.isFrozen(challenge), true); assert.equal(Object.isFrozen(challenge.scope), true);
  assert.equal(Object.isFrozen(challenge.nativeIds), true);
  assert.deepEqual(challenge.nativeIds, [root, child]);
  let settled = false; void pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  f.ack(challenge);
  assert.equal(await pending, true); assert.equal(f.observations, 2);
  assert.equal(f.events.listenerCount('lifecycle'), 0);
});

for (const [name, transform] of [
  ['missing ACK', (_c: Challenge) => null],
  ['different authenticated sender', (c: Challenge) => ({ authenticatedOwnerId: 'foreign-owner', payload: { ...c, acknowledged: true } })],
  ['cross-session', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, scope: { ...c.scope, appSessionId: 'other-app' }, acknowledged: true } })],
  ['cross-native', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, scope: { ...c.scope, nativeThreadId: foreign }, acknowledged: true } })],
  ['stale generation', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, scope: { ...c.scope, generation: 'old' }, acknowledged: true } })],
  ['partial children', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, nativeIds: [root], acknowledged: true } })],
  ['extra child', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, nativeIds: [...c.nativeIds, foreign], acknowledged: true } })],
  ['duplicate child', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, nativeIds: [root, child, child], acknowledged: true } })],
  ['changed owner in payload', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, ownerId: 'spoofed-owner', acknowledged: true } })],
  ['stale residency', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, residencyRevision: 'old', acknowledged: true } })],
  ['wrong nonce', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, nonce: 'replayed', acknowledged: true } })],
  ['changed expiry', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, expiresAt: c.expiresAt + 1, acknowledged: true } })],
  ['changed issue time', (c: Challenge) => ({ authenticatedOwnerId: c.ownerId, payload: { ...c, issuedAt: c.issuedAt - 1, acknowledged: true } })],
] as const) test(`reject ${name}`, async () => {
  const f = fixture(); f.deps.requestAcknowledgement = async c => transform(c) as Reply;
  assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), false);
  assert.equal(f.events.listenerCount('lifecycle'), 0);
});

test('one-use challenge: replay fails but independently acknowledged later challenge succeeds', async () => {
  const f = fixture(); let saved: Challenge | undefined;
  f.events.on('challenge', c => { saved = c; f.ack(c); });
  assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), true);
  const previous = saved!; f.events.removeAllListeners('challenge');
  f.events.on('challenge', () => f.reply(previous.ownerId, { ...previous, acknowledged: true }));
  assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), false);
  assert.notEqual(f.latest!.nonce, previous.nonce);
  f.events.removeAllListeners('challenge'); f.events.on('challenge', c => f.ack(c));
  assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), true);
});

test('concurrent same app/generation challenges do not replace pending consent', async () => {
  const f = fixture(); const requested = new Promise<Challenge>(resolve => f.events.once('challenge', resolve));
  const pending = f.checkpoints.checkpointed(scope, [root, child]); const c = await requested;
  assert.equal(await f.checkpoints.checkpointed({ ...scope, generation: 'g2' }, [root, child]), false);
  assert.equal(f.requests, 1); f.ack(c); assert.equal(await pending, true);
});

for (const change of ['lifecycle', 'membership', 'revision', 'generation', 'owner'] as const) {
  test(`actual ${change} change after challenge invalidates acknowledgement`, async () => {
    const f = fixture(); f.events.once('challenge', c => {
      if (change === 'lifecycle') f.events.emit('lifecycle');
      if (change === 'membership') f.setIds([root]);
      if (change === 'revision') f.setRevision('residency-2');
      if (change === 'generation') f.setScope({ ...scope, generation: 'g2' });
      if (change === 'owner') f.setOwner('replacement-owner');
      f.ack(c);
    });
    assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), false);
    assert.equal(f.events.listenerCount('lifecycle'), 0);
  });
}

test('lifecycle change during final asynchronous observation defeats unchanged inventory', async () => {
  const f = fixture(); let reads = 0;
  f.setObserve(async () => { reads++; if (reads === 2) { await new Promise(resolve => setImmediate(resolve)); f.events.emit('lifecycle'); } return f.snapshot(); });
  f.events.on('challenge', c => f.ack(c));
  assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), false);
});

for (const [name, wall, monotonic] of [
  ['wall expiry', 1100, 50], ['monotonic expiry', 1000, 150],
  ['wall rollback', 999, 50], ['monotonic rollback', 1000, 49], ['NaN wall', NaN, 50],
] as const) test(`${name} invalidates even an explicit ACK`, async () => {
  const f = fixture(); f.events.on('challenge', c => { f.setClocks(wall, monotonic); f.ack(c); });
  assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), false);
});

for (const failure of ['observation throws', 'ACK throws', 'observation stalls', 'ACK stalls', 'subscription throws', 'cleanup throws'] as const) {
  test(`${failure} returns false and leaves no listener`, async () => {
    const f = fixture(20);
    if (failure === 'observation throws') f.setObserve(async () => { throw new Error('PRIVATE_ERROR'); });
    if (failure === 'ACK throws') f.deps.requestAcknowledgement = async () => { throw new Error('PRIVATE_ERROR'); };
    if (failure === 'observation stalls') f.setObserve(() => new Promise(() => undefined));
    if (failure === 'ACK stalls') f.deps.requestAcknowledgement = () => new Promise(() => undefined);
    if (failure === 'subscription throws') f.deps.subscribeInvalidation = () => { throw new Error('PRIVATE_ERROR'); };
    if (failure === 'cleanup throws') { f.setCleanup(() => { throw new Error('PRIVATE_ERROR'); }); f.events.on('challenge', c => f.ack(c)); }
    assert.equal(await f.checkpoints.checkpointed(scope, [root, child]), false);
    assert.equal(f.events.listenerCount('lifecycle'), 0);
  });
}

test('input mutation cannot change a frozen pending challenge; final cleanup expiry still rejects', async () => {
  const f = fixture(); const mutable = { ...scope }; const ids = [root, child];
  f.events.on('challenge', c => { mutable.generation = 'g2'; ids.pop(); f.ack(c); });
  f.setCleanup(() => f.setClocks(1100, 150));
  assert.equal(await f.checkpoints.checkpointed(mutable, ids), false);
  assert.equal(f.latest!.scope.generation, 'g1'); assert.deepEqual(f.latest!.nativeIds, [root, child]);
});

test('invalid/private/side scope and incomplete actual inventories cannot request an ACK', async () => {
  const f = fixture();
  for (const value of [{ ...scope, private: true }, { ...scope, side: true }, { ...scope, generation: '' }, { ...scope, nativeThreadId: 'not-a-uuid' }]) {
    assert.equal(await f.checkpoints.checkpointed(value, [root, child]), false);
  }
  for (const ids of [[], [child], [root], [root, child, child], [root, foreign]]) assert.equal(await f.checkpoints.checkpointed(scope, ids), false);
  assert.equal(f.requests, 0);
});
