import { existingCodexTransports } from '../list/codex/codex-runtime.provider.js';

// Internal dependencies deliberately expose no prompt or environment to HTTP.
type Transport = {
  variant: string;
  client: {
    child?: { pid?: number };
    closed: boolean;
    request: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
    subscribe: (listener: (message: { method?: string }) => void) => () => void;
  };
};
type Dependencies = { capture: () => Transport[]; now: () => number; monotonicNow?: () => number };
type VariantObservation = { variant: string; pid: number | null; loadedThreads: number;
  activeThreads: number; childThreads: number; activeChildThreads: number; unknownThreads: number;
  observation: 'observed' | 'unknown'; reason?: string };

/** Providers route and deterministic tests use this non-spawning status-only service. */
export function createCodexRestartAdmissionObserver(deps: Dependencies = {
  capture: existingCodexTransports, now: Date.now,
}) {
  return {
    async observe() {
      const startedAt = deps.now();
      const monotonicNow = deps.monotonicNow ?? (() => performance.now());
      const deadline = monotonicNow() + 8000;
      const entries = deps.capture();
      let activityChanged = false;
      const unsubscribers = entries.map(({ client }) => client.subscribe(message => {
        // During a snapshot any lifecycle change makes the result conservative.
        if (/^(turn\/|thread\/)/.test(message.method ?? '')) activityChanged = true;
      }));
      const variants: VariantObservation[] = [];
      try {
        for (const { variant, client } of entries) {
          const result: VariantObservation = { variant, pid: client.child?.pid ?? null,
            loadedThreads: 0, activeThreads: 0, childThreads: 0, activeChildThreads: 0,
            unknownThreads: 0, observation: 'observed' };
          variants.push(result);
          try {
            if (client.closed || !result.pid) throw new Error('transport-unavailable');
            async function request(method: string, params: Record<string, unknown>) {
              const remaining = deadline - monotonicNow();
              if (remaining <= 0) throw new Error('observation-deadline');
              const timeoutMs = Math.min(remaining, 1500);
              // Client.request may await its readiness handshake before starting
              // its own timeout. Bound that wait too, without replacing transport.
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                return await Promise.race([
                  client.request(method, params, timeoutMs),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('observation-deadline')), timeoutMs);
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
            async function loaded() {
              const ids: string[] = [];
              const cursors = new Set<string>();
              let cursor: string | undefined;
              do {
                const page = await request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }) as { data?: unknown; nextCursor?: unknown };
                if (!Array.isArray(page?.data) || page.data.some(id => typeof id !== 'string' || !id)) throw new Error('invalid-loaded-list');
                ids.push(...page.data as string[]);
                if (ids.length > 500 || new Set(ids).size !== ids.length) throw new Error('loaded-inventory-bound');
                if (page.nextCursor != null && typeof page.nextCursor !== 'string') throw new Error('invalid-pagination');
                cursor = page.nextCursor ? page.nextCursor as string : undefined;
                if (cursor && cursors.has(cursor)) throw new Error('pagination-cycle');
                if (cursor) cursors.add(cursor);
              } while (cursor);
              return ids.sort();
            }
            const before = await loaded();
            result.loadedThreads = before.length;
            for (const id of before) {
              // includeTurns:false: no replayed messages. Discard preview/name/cwd
              // and all other returned fields immediately; never log the response.
              const response = await request('thread/read', { threadId: id, includeTurns: false }) as {
                thread?: { id?: unknown; status?: { type?: unknown }; parentThreadId?: unknown } };
              const thread = response?.thread;
              if (thread?.id !== id) throw new Error('thread-identity-mismatch');
              const child = typeof thread.parentThreadId === 'string' && Boolean(thread.parentThreadId);
              if (child) result.childThreads++;
              if (thread.status?.type === 'active') {
                result.activeThreads++;
                if (child) result.activeChildThreads++;
              } else if (thread.status?.type !== 'idle') {
                result.unknownThreads++;
              }
            }
            const after = await loaded();
            if (JSON.stringify(before) !== JSON.stringify(after) || client.closed) throw new Error('loaded-inventory-changed');
          } catch (error) {
            result.observation = 'unknown';
            // Exception message might contain provider payload/secrets. Only our
            // finite reason vocabulary is allowed into the status response.
            const allowed = ['transport-unavailable', 'observation-deadline', 'invalid-loaded-list',
              'loaded-inventory-bound', 'invalid-pagination', 'pagination-cycle',
              'thread-identity-mismatch', 'loaded-inventory-changed'];
            const reason = error instanceof Error ? error.message : '';
            result.reason = allowed.includes(reason) ? reason : 'native-observation-failed';
          }
        }
        const after = deps.capture();
        if (after.length !== entries.length || after.some((entry, i) => entry.variant !== entries[i]?.variant || entry.client !== entries[i]?.client)) activityChanged = true;
        const observed = !activityChanged && variants.every(v => v.observation === 'observed' && v.unknownThreads === 0);
        return { startedAt, finishedAt: deps.now(), source: 'existing-same-client-native-rpc' as const,
          observation: observed ? 'observed' as const : 'unknown' as const,
          activityChanged, variants,
          nativeThreadsIdle: observed && variants.every(v => v.activeThreads === 0),
          // Snapshot is evidence, not an admission lock or permission to restart.
          restartAuthorized: false as const };
      } finally {
        for (const unsubscribe of unsubscribers) unsubscribe();
      }
    },
  };
}

/** Only the authenticated Providers diagnostic route consumes the singleton. */
export const codexRestartAdmissionObserver = createCodexRestartAdmissionObserver();
