import { randomUUID } from 'node:crypto';

import type { CodexDiagnosticScope } from '../../../shared/index.js';

type OwnerSnapshot = { scope: Readonly<CodexDiagnosticScope>; ownerId: string; residencyRevision: string; nativeIds: readonly string[] };
type Challenge = Readonly<{ scope: Readonly<CodexDiagnosticScope>; ownerId: string; residencyRevision: string;
  nativeIds: readonly string[]; nonce: string; purpose: 'native-diagnostic-handoff'; issuedAt: number; expiresAt: number }>;
type Acknowledgement = { authenticatedOwnerId: string; payload: Challenge & { acknowledged: true } };
type Dependencies = {
  /** Trusted host inventory, including the complete actual owned descendant set. Not an idle-derived checkpoint. */
  observeOwner: (scope: Readonly<CodexDiagnosticScope>) => Promise<OwnerSnapshot | null>;
  /** Must prove the exact owner independently of payload fields. No production bridge is supplied by this factory. */
  requestAcknowledgement: (challenge: Challenge) => Promise<Acknowledgement | null>;
  /** Covers owner disconnect, lifecycle and membership/residency changes for root AND every descendant. */
  subscribeInvalidation: (scope: Readonly<CodexDiagnosticScope>, invalidate: () => void) => () => void;
  now?: () => number;
  monotonicNow?: () => number;
  ttlMs?: number;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
function scopeKey(scope: CodexDiagnosticScope): string {
  if (!scope || !identity(scope.appSessionId) || !uuid.test(scope.nativeThreadId)
    || !identity(scope.generation) || scope.private !== false || scope.side !== false) throw new Error('Invalid checkpoint scope');
  return JSON.stringify([scope.appSessionId, scope.nativeThreadId, scope.generation, scope.private, scope.side]);
}
function idsKey(ids: readonly string[], nativeId: string): string {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.includes(nativeId)
    || ids.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(ids).size !== ids.length) throw new Error('Incomplete checkpoint inventory');
  return JSON.stringify([...ids].sort());
}

/** Dormant host-compatible adapter, consumed by focused tests. A future internal host
 * registration must supply authenticated owner ACK transport; this creates no route,
 * provider call, checkpoint producer, timer-driven wakeup or automatic approval. */
export function createCodexOwnerCheckpoints(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const ttlMs = deps.ttlMs ?? 1000;
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 1500) throw new Error('Checkpoint deadline must be at most 1500ms');
  const pending = new Set<string>();
  return {
    async checkpointed(input: CodexDiagnosticScope, suppliedIds: string[]): Promise<boolean> {
      let key: string;
      let expectedIds: string;
      let scope: Readonly<CodexDiagnosticScope>;
      try {
        key = scopeKey(input);
        scope = Object.freeze({ ...input });
        if (scopeKey(scope) !== key) throw new Error('Checkpoint scope changed');
        expectedIds = idsKey(suppliedIds, scope.nativeThreadId);
      } catch { return false; }
      // One challenge per application owner, including across routing generations.
      if (pending.has(scope.appSessionId)) return false;
      pending.add(scope.appSessionId);
      let invalidated = false;
      let unsubscribe: (() => void) | undefined;
      let accepted = false;
      let fresh = () => false;
      try {
        const startedAt = now();
        const startedMonotonic = monotonicNow();
        const expiresAt = startedAt + ttlMs;
        const cutoff = startedMonotonic + ttlMs;
        function remaining(): number {
          const wall = now();
          const monotonic = monotonicNow();
          if (invalidated || !Number.isFinite(wall) || !Number.isFinite(monotonic)
            || wall < startedAt || monotonic < startedMonotonic) throw new Error('Checkpoint invalidated');
          const value = Math.min(expiresAt - wall, cutoff - monotonic);
          if (!Number.isFinite(value) || value <= 0) throw new Error('Checkpoint expired');
          return value;
        }
        fresh = () => { try { remaining(); return true; } catch { return false; } };
        async function bounded<T>(operation: () => Promise<T>): Promise<T> {
          const duration = remaining();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([operation(), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Checkpoint observation unavailable')), duration);
            })]);
            remaining();
            return result;
          } finally { if (timer) clearTimeout(timer); }
        }
        unsubscribe = deps.subscribeInvalidation(scope, () => { invalidated = true; });
        if (typeof unsubscribe !== 'function') throw new Error('Checkpoint invalidation unavailable');
        const before = await bounded(() => deps.observeOwner(scope));
        function snapshotKey(snapshot: OwnerSnapshot | null): string {
          if (!snapshot || scopeKey(snapshot.scope) !== key || !identity(snapshot.ownerId)
            || !identity(snapshot.residencyRevision) || idsKey(snapshot.nativeIds, scope.nativeThreadId) !== expectedIds) throw new Error('Owner identity unavailable');
          return JSON.stringify([key, snapshot.ownerId, snapshot.residencyRevision, expectedIds]);
        }
        const observed = snapshotKey(before);
        if (!before) throw new Error('Owner unavailable');
        // Copy immediately: the observer cannot mutate our challenge while delivery is pending.
        const challenge: Challenge = Object.freeze({ scope, ownerId: before.ownerId, residencyRevision: before.residencyRevision,
          nativeIds: Object.freeze(JSON.parse(expectedIds) as string[]), nonce: randomUUID(),
          purpose: 'native-diagnostic-handoff', issuedAt: startedAt, expiresAt });
        const acknowledgement = await bounded(() => deps.requestAcknowledgement(challenge));
        const payload = acknowledgement?.payload;
        if (!payload || acknowledgement.authenticatedOwnerId !== challenge.ownerId || payload.acknowledged !== true
          || payload.nonce !== challenge.nonce || payload.purpose !== challenge.purpose
          || payload.issuedAt !== challenge.issuedAt || payload.expiresAt !== challenge.expiresAt
          || snapshotKey(payload) !== observed) throw new Error('Explicit owner acknowledgement missing');
        // This response is consumed once. It never enters a reusable cache or grants future admission.
        const after = await bounded(() => deps.observeOwner(scope));
        if (snapshotKey(after) !== observed) throw new Error('Owner inventory changed');
        remaining();
        accepted = true;
      } catch { accepted = false; }
      finally {
        try { unsubscribe?.(); } catch { accepted = false; }
        pending.delete(scope.appSessionId);
      }
      return accepted && !invalidated && fresh();
    },
  };
}
