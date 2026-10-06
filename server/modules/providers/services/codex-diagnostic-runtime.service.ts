import type { CodexDiagnosticScope } from '../../../shared/index.js';

import type { createCodexDiagnosticRouting } from './codex-diagnostic-routing.service.js';

type Routing = Pick<ReturnType<typeof createCodexDiagnosticRouting>, 'acquire' | 'state' | 'transfer'>;
type Entry = { scope: Readonly<CodexDiagnosticScope>; routing: Routing; ready: boolean; transferring: boolean };
const entries = new Map<string, Entry>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Trusted source-only bootstrap/tests own this transaction. No startup, HTTP,
 * environment switch or plugin calls it. The fail-closed legacy selector is
 * installed before routing can release its host admission lease. Binary review,
 * preparation and explicit owner checkpoints remain the routing host's gates. */
export async function transferCodexDiagnosticRuntime(scope: CodexDiagnosticScope,
  handle: Parameters<Routing['transfer']>[1], routing: Routing) {
  scope = Object.freeze({ ...scope });
  if (scope.private || scope.side || !UUID.test(scope.appSessionId) || !UUID.test(scope.nativeThreadId)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.generation) || handle.appSessionId !== scope.appSessionId
    || handle.nativeThreadId !== scope.nativeThreadId || handle.generation !== scope.generation
    || routing.state(scope) !== null || entries.has(scope.appSessionId)
    || [...entries.values()].some(entry => entry.scope.nativeThreadId === scope.nativeThreadId)) {
    throw new Error('diagnostic-runtime-registration-refused');
  }
  const entry: Entry = { scope, routing, ready: false, transferring: true };
  entries.set(scope.appSessionId, entry);
  try {
    await routing.transfer(scope, handle);
    if (entries.get(scope.appSessionId) !== entry || routing.state(scope)?.phase !== 'diagnostic') {
      throw new Error('diagnostic-runtime-transfer-unknown');
    }
    entry.ready = true;
    return () => releaseCodexDiagnosticRuntime(scope);
  } catch {
    // Confirmed null means no remaining diagnostic owner (including successful
    // rollback). UNKNOWN, rebound or quarantine preserves the refusal gate.
    try { if (entries.get(scope.appSessionId) === entry && routing.state(scope) === null) entries.delete(scope.appSessionId); }
    catch { /* Ownership cannot be inferred from a failed observation. */ }
    throw new Error('diagnostic-runtime-transfer-refused');
  } finally { entry.transferring = false; }
}

/** Trusted coordinated-return/reconciliation callers and tests remove an exact
 * registration only after the routing adapter proves it no longer owns it. */
export function releaseCodexDiagnosticRuntime(scope: CodexDiagnosticScope) {
  const entry = entries.get(scope.appSessionId);
  if (!entry) return;
  if (entry.scope.nativeThreadId !== scope.nativeThreadId || entry.scope.generation !== scope.generation
    || scope.private || scope.side || entry.transferring || entry.routing.state(entry.scope) !== null) {
    throw new Error('diagnostic-runtime-still-owned');
  }
  entries.delete(scope.appSessionId);
}

/** Legacy turn/reverted-history execution uses this dormant selector. The
 * ordinary code path runs unchanged when no exact scope has been mounted. */
export const codexDiagnosticRuntime = {
  acquire(input: { appSessionId?: string; nativeThreadId?: string; private?: boolean; side?: boolean; rewind?: unknown }, purpose: 'turn' | 'history') {
    const byApp = input.appSessionId ? entries.get(input.appSessionId) : undefined;
    const byNative = [...entries.values()].find(entry => entry.scope.nativeThreadId === input.nativeThreadId);
    const entry = byApp ?? byNative;
    if (!entry) return null;
    if ((byApp && byNative && byApp !== byNative) || input.nativeThreadId !== entry.scope.nativeThreadId
      || (input.appSessionId && input.appSessionId !== entry.scope.appSessionId) || input.private || input.side) {
      throw new Error('diagnostic-runtime-scope-refused');
    }
    if (input.rewind) throw new Error('diagnostic-runtime-rewind-unavailable');
    if (!entry.ready || entry.routing.state(entry.scope)?.phase !== 'diagnostic') throw new Error('diagnostic-runtime-unavailable');
    const held = entry.routing.acquire(entry.scope, purpose, () => { throw new Error('diagnostic-runtime-ordinary-fallback-refused'); });
    // Never expose the raw peer request: steer, interrupt and history must all
    // keep the immutable selector's scope and expiry checks.
    const appServer = {
      get closed() { return held.peer.closed; },
      request: held.request,
      subscribe: held.peer.subscribe.bind(held.peer),
    };
    return { appServer, release: held.release };
  },
};
