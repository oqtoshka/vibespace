import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { CodexDiagnosticScope as Scope, CodexDiagnosticHandle as Handle, CodexDiagnosticLease } from '../../../shared/index.js';
import { buildAgentEnv } from '../../../shared/index.js';

import { CodexDiagnosticPeer } from './codex-diagnostic-peer.service.js';
import { createCodexRestartAdmissionObserver } from './codex-restart-admission.service.js';

type Capture = NonNullable<Parameters<typeof createCodexRestartAdmissionObserver>[0]>['capture'];
type Review = { executable: string; sha256: string; captureDirectory: string;
  // Only a host-reviewed binary with the actual native UTC/monotonic expiry
  // overlay may declare this. The old full CLI does not meet this contract.
  observerContract: 'exec-fingerprint-utc-v1'; environment: NodeJS.ProcessEnv };
type Dependencies = { capture: Capture; now: () => number; monotonicNow: () => number;
  reserve: (scope: Scope, resourceId: string) => CodexDiagnosticLease | null;
  ownersCheckpointed: (scope: Scope, nativeThreadIds: string[]) => Promise<boolean> };
type Entry = { handle: Handle; peer: CodexDiagnosticPeer; until: number; monotonicUntil: number;
  reviewId: string; routed?: boolean; timer?: ReturnType<typeof setTimeout> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function verifyExecutable(review: Review) {
  if (!path.isAbsolute(review.executable) || await realpath(review.executable) !== review.executable) throw new Error('diagnostic-review-path');
  const file = await open(review.executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || (before.mode & 0o222n) !== 0n || (before.mode & 0o100n) === 0n) throw new Error('diagnostic-review-not-readonly-executable');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await file.stat({ bigint: true });
    const named = await lstat(review.executable, { bigint: true });
    if (before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || hash.digest('hex') !== review.sha256) throw new Error('diagnostic-review-changed');
  } finally { await file.close(); }
}

/** Dormant routing and tests consume this engine; no public route, plugin hook, or runtime selector is registered. */
export function createCodexDiagnosticBindings(deps: Dependencies) {
  const reviews = new Map<string, Review>();
  const entries = new Map<string, Entry>();
  const preparing = new Set<string>();
  const preparingNative = new Set<string>();
  function validate(scope: Scope) {
    if (!UUID.test(scope.appSessionId) || !UUID.test(scope.nativeThreadId)
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.generation) || scope.private !== false || scope.side !== false) throw new Error('diagnostic-scope-refused');
  }
  function matches(handle: Handle, scope: Scope) {
    return handle.appSessionId === scope.appSessionId && handle.nativeThreadId === scope.nativeThreadId && handle.generation === scope.generation;
  }
  function live(entry: Entry) {
    return deps.now() < entry.until && deps.monotonicNow() < entry.monotonicUntil && !entry.peer.closed;
  }
  function entryFor(handle: Handle) {
    const entry = entries.get(handle.appSessionId);
    if (!entry || entry.handle !== handle) throw new Error('diagnostic-handle-mismatch');
    return entry;
  }
  async function cleanup(handle: Handle, owned = false) {
    const entry = entryFor(handle);
    if (entry.routed && !owned) return false;
    // The standby cannot start/resume turns. Still do not stop on a failed
    // observation or unexpected active native work; retain an expired entry.
    const result = await createCodexRestartAdmissionObserver({ capture: () => [{ variant: 'diagnostic-standby', client: entry.peer }], now: deps.now }).observe();
    if (!result.nativeThreadsIdle || entries.get(handle.appSessionId) !== entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entries.delete(handle.appSessionId); entry.peer.stop(); return true;
  }
  return {
    // Trusted host bootstrap only: request payloads get an opaque review ID,
    // never an executable path/env. There is currently no bootstrap caller.
    async reviewExecutable(input: Review) {
      input = Object.freeze({ ...input, environment: Object.freeze({ ...input.environment }) });
      if (input.observerContract !== 'exec-fingerprint-utc-v1' || !/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error('diagnostic-observer-contract');
      await verifyExecutable(input);
      if (!path.isAbsolute(input.captureDirectory) || await realpath(input.captureDirectory) !== input.captureDirectory) throw new Error('diagnostic-capture-directory');
      const directory = await lstat(input.captureDirectory);
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('diagnostic-capture-permissions');
      const id = randomUUID();
      reviews.set(id, Object.freeze({ ...input, environment: Object.freeze({ ...input.environment }) }));
      return id;
    },
    async prepare(scope: Scope, reviewId: string, deadlineUTC: string): Promise<Handle> {
      validate(scope);
      scope = Object.freeze({ ...scope });
      const until = Date.parse(deadlineUTC);
      const remaining = until - deps.now();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(deadlineUTC) || !Number.isFinite(until)
        || new Date(until).toISOString().replace('.000Z', 'Z') !== deadlineUTC || remaining <= 0 || remaining > 900000) throw new Error('diagnostic-deadline');
      const review = reviews.get(reviewId);
      if (!review) throw new Error('diagnostic-review-missing');
      const existing = entries.get(scope.appSessionId);
      if (existing) {
        if (!matches(existing.handle, scope) || !live(existing) || existing.reviewId !== reviewId || existing.until !== until) throw new Error('diagnostic-binding-rebound-or-expired');
        return existing.handle;
      }
      if (preparing.has(scope.appSessionId) || preparingNative.has(scope.nativeThreadId)
        || [...entries.values()].some(entry => entry.handle.nativeThreadId === scope.nativeThreadId)) throw new Error('diagnostic-binding-busy');
      preparing.add(scope.appSessionId);
      preparingNative.add(scope.nativeThreadId);
      const id = randomUUID();
      let lease: ReturnType<Dependencies['reserve']> = null;
      let peer: CodexDiagnosticPeer | undefined;
      let unsubscribe: (() => void) | undefined;
      let changed = false;
      let leaseMonotonicUntil = 0;
      const monotonicUntil = deps.monotonicNow() + remaining;
      const check = () => {
        if (changed || deps.now() >= until || deps.monotonicNow() >= monotonicUntil || !lease
          || deps.now() >= lease.expiresAt || deps.monotonicNow() >= leaseMonotonicUntil) throw new Error('diagnostic-admission-stale');
      };
      try {
        lease = deps.reserve(scope, id);
        if (!lease || lease.expiresAt <= deps.now() || lease.expiresAt - deps.now() > 60000) throw new Error('diagnostic-host-admission');
        leaseMonotonicUntil = deps.monotonicNow() + lease.expiresAt - deps.now();
        const original = deps.capture().find(entry => entry.variant === 'shared');
        if (!original || original.client.closed) throw new Error('diagnostic-old-transport-missing');
        unsubscribe = original.client.subscribe(method => { if (/^(turn\/|thread\/|transport\/)/.test(method)) changed = true; });
        // Conservative preparation: all loaded threads in the old shared peer
        // must be idle. No target is moved/unsubscribed by this partial slice.
        const observed = await createCodexRestartAdmissionObserver({ capture: () => [original], now: deps.now }).observe();
        if (!observed.nativeThreadsIdle) throw new Error('diagnostic-native-not-idle');
        const inventory = await original.client.request('thread/loaded/list', { limit: 100 }, 1500) as { data?: string[]; nextCursor?: unknown };
        if (!Array.isArray(inventory.data) || inventory.nextCursor || inventory.data.length > 100
          || inventory.data.some(id => !UUID.test(id)) || new Set(inventory.data).size !== inventory.data.length
          || !inventory.data.includes(scope.nativeThreadId)) throw new Error('diagnostic-target-inventory');
        const parents = new Map<string, string | null>();
        for (const nativeId of inventory.data) {
          check();
          const read = await original.client.request('thread/read', { threadId: nativeId, includeTurns: false }, 1500) as {
            thread?: { id?: string; status?: { type?: string }; parentThreadId?: string | null } };
          if (read.thread?.id !== nativeId || read.thread.status?.type !== 'idle'
            || (read.thread.parentThreadId != null && !UUID.test(read.thread.parentThreadId))) throw new Error('diagnostic-native-not-idle');
          parents.set(nativeId, read.thread.parentThreadId ?? null);
        }
        const owned = new Set([scope.nativeThreadId]);
        for (let pass = 0; pass < parents.size; pass++) for (const [nativeId, parent] of parents) if (parent && owned.has(parent)) owned.add(nativeId);
        let ownerTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const checkpointed = await Promise.race([
            deps.ownersCheckpointed(scope, [...owned].sort()),
            new Promise<never>((_, reject) => { ownerTimer = setTimeout(() => reject(new Error('diagnostic-owner-unknown')), 1500); }),
          ]);
          if (!checkpointed) throw new Error('diagnostic-owner-unknown');
        } finally { if (ownerTimer) clearTimeout(ownerTimer); }
        await verifyExecutable(review);
        const outputPath = path.join(review.captureDirectory, `${id}.jsonl`);
        try { await lstat(outputPath); throw new Error('diagnostic-capture-exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        check();
        peer = new CodexDiagnosticPeer(review.executable, { ...buildAgentEnv({}, review.environment),
          CODEX_EXEC_FINGERPRINT_THREAD: scope.nativeThreadId,
          CODEX_EXEC_FINGERPRINT_PATH: outputPath,
          CODEX_EXEC_FINGERPRINT_DEADLINE_UTC: deadlineUTC });
        await peer.ready;
        const fresh = await original.client.request('thread/loaded/list', { limit: 100 }, 1500) as { data?: string[]; nextCursor?: unknown };
        if (original.client.closed || fresh.nextCursor || JSON.stringify(fresh.data?.slice().sort()) !== JSON.stringify(inventory.data.slice().sort())
          || deps.capture().find(entry => entry.variant === 'shared')?.client !== original.client) throw new Error('diagnostic-native-inventory-changed');
        check();
        const handle = Object.freeze({ id, appSessionId: scope.appSessionId, nativeThreadId: scope.nativeThreadId, generation: scope.generation });
        const entry: Entry = { handle, peer, until, monotonicUntil, reviewId };
        entries.set(scope.appSessionId, entry);
        entry.timer = setTimeout(() => { void cleanup(handle).catch(() => undefined); }, Math.max(1, Math.min(until - deps.now(), monotonicUntil - deps.monotonicNow())));
        entry.timer.unref();
        return handle;
      } catch (error) { peer?.stop(); throw error; }
      finally { unsubscribe?.(); lease?.release(); preparing.delete(scope.appSessionId); preparingNative.delete(scope.nativeThreadId); }
    },
    standby(handle: Handle, scope: Scope) {
      validate(scope);
      const entry = entryFor(handle);
      if (!matches(handle, scope) || !live(entry)) throw new Error('diagnostic-binding-rebound-or-expired');
      return entry.peer;
    },
    // Dormant serialized routing owns cleanup after claiming a standby. Its
    // expiry timer must not race host admission or interrupt a new turn.
    claim(handle: Handle, scope: Scope) {
      validate(scope);
      const entry = entryFor(handle);
      if (!matches(handle, scope) || !live(entry) || entry.routed) throw new Error('diagnostic-binding-claimed-or-expired');
      entry.routed = true;
      const execution = entry.peer.execution(scope.nativeThreadId);
      return Object.freeze({ peer: entry.peer, execution, cleanup: () => cleanup(handle, true) });
    },
    // Only internal readiness checks may inventory dedicated peers. No IDs,
    // paths, environments or prompts are turned into an HTTP response here.
    capture() { return [...entries.values()].map(entry => ({ variant: 'diagnostic-standby', client: entry.peer })); },
    cleanup,
  };
}
