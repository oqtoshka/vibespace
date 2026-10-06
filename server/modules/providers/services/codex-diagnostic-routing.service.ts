import { randomUUID } from 'node:crypto';

import type { CodexDiagnosticScope, CodexDiagnosticHandle, CodexDiagnosticLease } from '../../../shared/index.js';

import { createCodexDiagnosticBindings } from './codex-diagnostic-binding.service.js';
import { createCodexRestartAdmissionObserver } from './codex-restart-admission.service.js';
import { createCodexDiagnosticHost } from './codex-diagnostic-host.service.js';

type Bindings = ReturnType<typeof createCodexDiagnosticBindings>;
type Host = ReturnType<typeof createCodexDiagnosticHost>;
type Capture = NonNullable<Parameters<typeof createCodexRestartAdmissionObserver>[0]>['capture'];
type Peer = ReturnType<Capture>[number]['client'];
type Claim = ReturnType<Bindings['claim']>;
type Route = { scope: CodexDiagnosticScope; handle: CodexDiagnosticHandle; original: Peer;
  claim: Claim; phase: 'transferring' | 'diagnostic' | 'returning' | 'quarantined'; holds: number; owned: string[] };
type Dependencies = { bindings: Bindings; host: Host; capture: Capture; now: () => number; monotonicNow: () => number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Source-only host integration/tests use this serialized selector. No HTTP,
 * plugin bootstrap, or legacy turn/history path installs it. */
export function createCodexDiagnosticRouting(deps: Dependencies) {
  const routes = new Map<string, Route>();
  const pending = new Set<string>();
  async function loaded(peer: Peer) {
    const page = await peer.request('thread/loaded/list', { limit: 100 }, 1500) as { data?: unknown; nextCursor?: unknown };
    if (!Array.isArray(page?.data) || page.nextCursor || page.data.length > 100 || page.data.some(id => typeof id !== 'string' || !UUID.test(id))
      || new Set(page.data).size !== page.data.length || peer.closed) throw new Error('diagnostic-residency-unknown');
    return (page.data as string[]).slice().sort();
  }
  async function ownedIdle(peer: Peer, target: string) {
    const before = await loaded(peer);
    if (!before.includes(target)) throw new Error('diagnostic-target-not-hosted');
    const parents = new Map<string, string | null>();
    const statuses = new Map<string, string>();
    for (const id of before) {
      const value = await peer.request('thread/read', { threadId: id, includeTurns: false }, 1500) as {
        thread?: { id?: unknown; status?: { type?: unknown }; parentThreadId?: unknown } };
      const thread = value?.thread;
      if (thread?.id !== id || !['idle', 'active'].includes(String(thread.status?.type))
        || (thread.parentThreadId != null && (typeof thread.parentThreadId !== 'string' || !UUID.test(thread.parentThreadId)))) throw new Error('diagnostic-residency-unknown');
      parents.set(id, thread.parentThreadId as string | null ?? null); statuses.set(id, String(thread.status?.type));
    }
    const owned = new Set([target]);
    for (let pass = 0; pass < parents.size; pass++) for (const [id, parent] of parents) if (parent && owned.has(parent)) owned.add(id);
    if ([...owned].some(id => statuses.get(id) !== 'idle') || JSON.stringify(before) !== JSON.stringify(await loaded(peer))) throw new Error('diagnostic-native-not-idle');
    return [...owned].sort();
  }
  async function noOtherHosts(owner: Peer, owned: string[]) {
    const before = deps.capture();
    for (const entry of before) if (entry.client !== owner) {
      if ((await loaded(entry.client)).some(id => owned.includes(id))) throw new Error('diagnostic-concurrent-host');
    }
    const after = deps.capture();
    if (after.length !== before.length || after.some((entry, i) => entry.client !== before[i]?.client || entry.variant !== before[i]?.variant)) throw new Error('diagnostic-inventory-replaced');
  }
  async function resume(peer: Peer | Claim['execution'], id: string) {
    const result = await peer.request('thread/resume', { threadId: id, excludeTurns: true }, 1500) as { thread?: { id?: unknown } };
    if (result?.thread?.id !== id) throw new Error('diagnostic-resume-identity');
  }
  function find(scope: CodexDiagnosticScope) {
    const route = routes.get(scope.appSessionId);
    if (route && (route.scope.nativeThreadId !== scope.nativeThreadId || route.scope.generation !== scope.generation
      || scope.private || scope.side || !deps.host.current(scope))) throw new Error('diagnostic-route-rebound');
    return route;
  }
  return {
    async transfer(scope: CodexDiagnosticScope, handle: CodexDiagnosticHandle) {
      scope = Object.freeze({ ...scope });
      if (pending.has(scope.appSessionId) || routes.has(scope.appSessionId) || !deps.host.current(scope)) throw new Error('diagnostic-transfer-busy-or-rebound');
      pending.add(scope.appSessionId);
      let route: Route | undefined;
      let claim: Claim | undefined;
      let lease: CodexDiagnosticLease | null = null;
      let releaseListeners: Array<() => void> = [];
      let changed = false;
      let expectedClose: string | null = null;
      let expectedCloseOwner: Peer | null = null;
      let inventory: ReturnType<Capture> | undefined;
      let monotonicUntil = 0;
      function check() {
        if (!lease || changed || !deps.host.current(scope) || deps.now() >= lease.expiresAt || deps.monotonicNow() >= monotonicUntil) throw new Error('diagnostic-transfer-stale');
        if (inventory) {
          const current = deps.capture();
          if (current.length !== inventory.length || current.some((entry, i) => entry.client !== inventory![i]?.client || entry.variant !== inventory![i]?.variant)) throw new Error('diagnostic-inventory-replaced');
        }
      }
      try {
        lease = deps.host.reserve(scope, randomUUID());
        monotonicUntil = deps.monotonicNow() + Math.max(0, Math.min(15000, (lease?.expiresAt ?? 0) - deps.now()));
        check();
        const original = deps.capture().find(entry => entry.variant === 'shared')?.client;
        if (!original) throw new Error('diagnostic-old-transport-missing');
        const peer = deps.bindings.standby(handle, scope);
        const captured = deps.capture();
        if (!captured.some(entry => entry.client === peer)) throw new Error('diagnostic-standby-inventory-missing');
        inventory = captured;
        releaseListeners = captured.map(entry => entry.client.subscribe((method, params) => {
          if (method === 'thread/closed' && entry.client === expectedCloseOwner && params.threadId === expectedClose) return;
          if (/^(turn\/|thread\/|transport\/)/.test(method)) changed = true;
        }));
        const owned = await ownedIdle(original, scope.nativeThreadId);
        await noOtherHosts(original, owned);
        if ((await loaded(peer)).length !== 0 || !await deps.host.ownersCheckpointed(scope, owned)) throw new Error('diagnostic-owner-or-standby-unknown');
        check();
        claim = deps.bindings.claim(handle, scope);
        route = { scope, handle, original, claim, phase: 'transferring', holds: 0, owned };
        routes.set(scope.appSessionId, route);
        // Descendants unload before their root; never start a diagnostic resume
        // until actual all-peer inventories prove the old ownership is absent.
        for (const id of owned.filter(id => id !== scope.nativeThreadId).concat(scope.nativeThreadId)) {
          check(); expectedClose = id; expectedCloseOwner = original;
          await original.request('thread/unsubscribe', { threadId: id }, 1500);
          expectedClose = null; expectedCloseOwner = null;
        }
        check();
        if ((await loaded(original)).some(id => owned.includes(id))) throw new Error('diagnostic-old-owner-retained');
        await noOtherHosts(peer, owned); check();
        // Keep all-peer lifecycle invalidation armed throughout resume and
        // verification; an unchanged idle read cannot erase a turn notification.
        await resume(claim.execution, scope.nativeThreadId);
        const actual = await ownedIdle(peer, scope.nativeThreadId);
        await noOtherHosts(peer, actual);
        const quiescent = await createCodexRestartAdmissionObserver({ capture: deps.capture, now: deps.now }).observe();
        if (!quiescent.nativeThreadsIdle) throw new Error('diagnostic-native-not-idle');
        deps.bindings.standby(handle, scope); check();
        route.phase = 'diagnostic';
        return handle;
      } catch {
        // An error response may be ambiguous: inspect actual dedicated residency
        // before restoring the old owner. UNKNOWN/active keeps a quarantined
        // route instead of creating a second native host or killing active work.
        if (route && claim) {
          route.phase = 'quarantined';
          try {
            if (!lease || !deps.host.current(scope) || deps.now() >= lease.expiresAt || deps.monotonicNow() >= monotonicUntil) throw new Error('diagnostic-rollback-no-admission');
            const observed = await createCodexRestartAdmissionObserver({ capture: deps.capture, now: deps.now }).observe();
            if (!observed.nativeThreadsIdle || !await deps.host.ownersCheckpointed(scope, route.owned)) throw new Error('diagnostic-rollback-not-idle');
            // A lifecycle event never becomes harmless just because a later
            // inventory/read reports idle. Retain ownership for reconciliation.
            check();
            const present = await loaded(claim.peer);
            if (present.length) {
              const ids = await ownedIdle(claim.peer, scope.nativeThreadId);
              if (ids.some(id => id !== scope.nativeThreadId)) throw new Error('diagnostic-rollback-children-unknown');
              check(); expectedClose = scope.nativeThreadId; expectedCloseOwner = claim.peer;
              await claim.execution.request('thread/unsubscribe', { threadId: scope.nativeThreadId }, 1500);
              expectedClose = null; expectedCloseOwner = null; check();
              if ((await loaded(claim.peer)).length) throw new Error('diagnostic-rollback-owner-retained');
            }
            await noOtherHosts(route.original, route.owned);
            const retained = await loaded(route.original);
            for (const id of [scope.nativeThreadId, ...route.owned.filter(id => id !== scope.nativeThreadId)]) if (!retained.includes(id)) { check(); await resume(route.original, id); }
            check();
            if (!await claim.cleanup(() => { try { check(); return true; } catch { return false; } })) throw new Error('diagnostic-rollback-cleanup-unknown');
            routes.delete(scope.appSessionId);
          } catch { /* Retain/quarantine ownership; never expose provider errors. */ }
        }
        throw new Error(route?.phase === 'quarantined' && routes.has(scope.appSessionId)
          ? 'diagnostic-transfer-quarantined' : 'diagnostic-transfer-refused');
      } finally {
        releaseListeners.forEach(release => release()); lease?.release(); pending.delete(scope.appSessionId);
      }
    },
    async returnToOrdinary(scope: CodexDiagnosticScope) {
      scope = Object.freeze({ ...scope });
      const route = find(scope);
      if (!route) return { returned: false, reason: 'not-routed' as const };
      if (pending.has(scope.appSessionId) || route.holds !== 0) return { returned: false, reason: 'held-or-pending' as const };
      pending.add(scope.appSessionId);
      const previousPhase = route.phase;
      route.phase = 'returning';
      let lease: CodexDiagnosticLease | null = null;
      let monotonicUntil = 0;
      let inventory: ReturnType<Capture> | undefined;
      const releaseListeners: Array<() => void> = [];
      let changed = false;
      let mutated = false;
      let expectedClose: string | null = null;
      const check = () => {
        if (!lease || changed || !deps.host.current(scope) || deps.now() >= lease.expiresAt
          || deps.monotonicNow() >= monotonicUntil || route.holds !== 0) throw new Error('diagnostic-return-stale');
        if (inventory) {
          const current = deps.capture();
          if (current.length !== inventory.length || current.some((entry, i) => entry.client !== inventory![i]?.client
            || entry.variant !== inventory![i]?.variant)) throw new Error('diagnostic-inventory-replaced');
        }
      };
      try {
        lease = deps.host.reserve(scope, randomUUID());
        monotonicUntil = deps.monotonicNow() + Math.max(0, Math.min(15000, (lease?.expiresAt ?? 0) - deps.now()));
        check();
        inventory = deps.capture();
        if (inventory.find(entry => entry.variant === 'shared')?.client !== route.original
          || !inventory.some(entry => entry.client === route.claim.peer)) throw new Error('diagnostic-return-owner-replaced');
        for (const entry of inventory) releaseListeners.push(entry.client.subscribe((method, params) => {
          if (method === 'thread/closed' && entry.client === route.claim.peer && params.threadId === expectedClose) return;
          if (/^(turn\/|thread\/|transport\/)/.test(method)) changed = true;
        }));
        const observed = await createCodexRestartAdmissionObserver({ capture: deps.capture, now: deps.now }).observe();
        if (!observed.nativeThreadsIdle) throw new Error('diagnostic-return-not-idle');
        const dedicatedIds = await loaded(route.claim.peer);
        const originalIds = await loaded(route.original);
        if (dedicatedIds.includes(scope.nativeThreadId) && originalIds.includes(scope.nativeThreadId)) throw new Error('diagnostic-concurrent-host');
        let owned = route.owned.slice();
        if (dedicatedIds.length) {
          const actual = await ownedIdle(route.claim.peer, scope.nativeThreadId);
          // A pinned dedicated process belongs only to this native root and its
          // observed descendants. Unrelated residency makes cleanup unknown.
          if (actual.length !== dedicatedIds.length) throw new Error('diagnostic-return-owner-unknown');
          owned = [...new Set([...owned, ...actual])].sort();
          await noOtherHosts(route.claim.peer, owned);
        } else {
          // Retry after an ambiguous return may find the root already on the
          // original peer, or unloaded from both. Never resume a second owner.
          await noOtherHosts(route.original, owned);
          if (originalIds.includes(scope.nativeThreadId)) await ownedIdle(route.original, scope.nativeThreadId);
        }
        if (!await deps.host.ownersCheckpointed(scope, owned)) throw new Error('diagnostic-owner-unknown');
        check();
        route.owned = owned;
        for (const id of owned.filter(id => id !== scope.nativeThreadId).concat(scope.nativeThreadId)) {
          if (!dedicatedIds.includes(id)) continue;
          check(); mutated = true; expectedClose = id;
          await route.claim.execution.unsubscribeOwned(id, owned);
          expectedClose = null; check();
        }
        if ((await loaded(route.claim.peer)).length !== 0) throw new Error('diagnostic-return-owner-retained');
        await noOtherHosts(route.original, owned); check();
        const retained = await loaded(route.original);
        for (const id of [scope.nativeThreadId, ...owned.filter(id => id !== scope.nativeThreadId)]) {
          if (retained.includes(id)) continue;
          check(); mutated = true; await resume(route.original, id); check();
        }
        const restored = await ownedIdle(route.original, scope.nativeThreadId);
        if (owned.some(id => !restored.includes(id))) throw new Error('diagnostic-return-descendants-unknown');
        await noOtherHosts(route.original, restored);
        if (!await deps.host.ownersCheckpointed(scope, restored)) throw new Error('diagnostic-owner-unknown');
        const final = await createCodexRestartAdmissionObserver({ capture: deps.capture, now: deps.now }).observe();
        if (!final.nativeThreadsIdle) throw new Error('diagnostic-return-not-idle');
        check();
        // Listener latch and admission remain held until targeted cleanup has
        // verified the dedicated peer empty/idle. Never stop a held/active peer.
        if (!await route.claim.cleanup(() => { try { check(); return true; } catch { return false; } })) throw new Error('diagnostic-return-cleanup-unknown');
        routes.delete(scope.appSessionId);
        return { returned: true };
      } catch {
        route.phase = mutated || previousPhase === 'quarantined' ? 'quarantined' : previousPhase;
        return { returned: false, reason: route.phase === 'quarantined' ? 'quarantined' as const : 'deferred' as const };
      } finally {
        releaseListeners.forEach(release => release()); lease?.release(); pending.delete(scope.appSessionId);
      }
    },
    acquire(scope: CodexDiagnosticScope, purpose: 'turn' | 'history' | 'idle', ordinary: () => Peer) {
      scope = Object.freeze({ ...scope });
      const bound = find(scope);
      if ([...routes.values()].some(route => route.scope.nativeThreadId === scope.nativeThreadId && route.scope.appSessionId !== scope.appSessionId)) throw new Error('diagnostic-route-rebound');
      if (scope.private || scope.side) { const peer = ordinary(); return { peer, request: ordinaryRequest(peer), release() {} }; }
      if (pending.has(scope.appSessionId)) throw new Error('diagnostic-transfer-pending');
      const route = bound;
      if (!route) { const peer = ordinary(); return { peer, request: ordinaryRequest(peer), release() {} }; }
      if (route.phase !== 'diagnostic' || route.claim.peer.closed) throw new Error('diagnostic-route-unavailable');
      if (purpose === 'turn') deps.bindings.standby(route.handle, scope); // expiry denies fresh diagnostic admissions
      route.holds++;
      let released = false;
      let inFlight = 0;
      let counted = true;
      const dropHold = () => { if (released && inFlight === 0 && counted) { counted = false; route.holds--; } };
      const request = async (method: string, params: Record<string, unknown>, timeoutMs = 1500) => {
        params = { ...params };
        if (released || find(scope) !== route || route.phase !== 'diagnostic') throw new Error('diagnostic-route-unavailable');
        if (params.threadId !== scope.nativeThreadId) throw new Error('diagnostic-execution-scope');
        if (purpose !== 'turn' && !['thread/read', 'thread/turns/list'].includes(method)) throw new Error('diagnostic-readonly-purpose');
        if (!['thread/read', 'thread/turns/list', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(method)) throw new Error('diagnostic-route-method');
        if (method === 'turn/start') deps.bindings.standby(route.handle, scope);
        inFlight++;
        try {
          if (method === 'thread/read') return await route.claim.peer.request(method, params, timeoutMs);
          return await route.claim.execution.request(method, params, timeoutMs);
        } finally { inFlight--; dropHold(); }
      };
      return { peer: route.claim.peer, request,
        release() { released = true; dropHold(); } };
    },
    state(scope: CodexDiagnosticScope) { const route = find(scope); return route ? { phase: route.phase, holds: route.holds } : null; },
    // Explicit return is dormant/source-only. No timer or runtime retry invokes
    // it; ordinary expiry cleanup still cannot stop claimed peers independently.
  };
}
function ordinaryRequest(peer: Peer) { return (method: string, params: Record<string, unknown>, timeoutMs = 1500) => peer.request(method, params, timeoutMs); }
