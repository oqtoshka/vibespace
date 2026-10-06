import { sessionsDb } from '../../database/index.js';
import { chatRunRegistry } from '../../websocket/index.js';
import type { CodexDiagnosticScope, CodexDiagnosticLease } from '../../../shared/index.js';

type Dependencies = {
  generationFor: (appSessionId: string) => string | null;
  // Required trusted owner checkpoint source. DB identity or native idle alone
  // cannot establish that external native owners have checkpointed.
  checkpointed: (scope: CodexDiagnosticScope, nativeIds: string[]) => Promise<boolean>;
};

/** The dormant routing factory and tests use actual host admission/session identity;
 * no HTTP or runtime bootstrap registers this adapter. */
export function createCodexDiagnosticHost(deps: Dependencies) {
  function current(scope: CodexDiagnosticScope) {
    try {
      const row = sessionsDb.getSessionById(scope.appSessionId);
      return Boolean(row && row.provider === 'codex' && row.provider_session_id === scope.nativeThreadId
        && row.is_private === 0 && row.is_side === 0 && row.isArchived === 0
        && scope.private === false && scope.side === false
        && deps.generationFor(scope.appSessionId) === scope.generation);
    } catch { return false; }
  }
  return {
    current,
    reserve(scope: CodexDiagnosticScope, resourceId: string): CodexDiagnosticLease | null {
      if (!current(scope)) return null;
      const lease = chatRunRegistry.reserveAdmission({ appSessionId: scope.appSessionId, providerSessionId: scope.nativeThreadId,
        resourceId, generation: scope.generation, ttlMs: 15000 });
      if (lease && !current(scope)) { lease.release(); return null; }
      return lease;
    },
    async ownersCheckpointed(scope: CodexDiagnosticScope, nativeIds: string[]) {
      if (!current(scope) || !nativeIds.includes(scope.nativeThreadId) || new Set(nativeIds).size !== nativeIds.length) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const checkpointed = await Promise.race([deps.checkpointed(Object.freeze({ ...scope }), [...nativeIds]),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
        return checkpointed && current(scope);
      } catch { return false; }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
