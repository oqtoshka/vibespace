import { getClaudeSDKLiveBackgroundTasks, isClaudeSDKSessionAlive } from '@/modules/providers/index.js';

/** What the native client may learn about one session's background jobs. */
export type NativeBackgroundSnapshot =
  | { kind: 'native.background'; available: true; observedAt: number; running: { taskId: string; description: string }[] }
  | { kind: 'native.background'; available: false; observedAt: number; reason: 'unsupported-provider' | 'not-live' };

export type BackgroundRuntime = {
  tasks: (providerSessionId: string) => { taskId: string; description: string }[];
  alive: (providerSessionId: string) => boolean;
};

/** Claude's SDK is the only runtime that inventories background jobs. This reads its
 * `background_tasks_changed` level signal (replace semantics), not the start/notification
 * edges: the edges also bracket long FOREGROUND commands and a missed bookend would wedge
 * a stale entry. Task ids equal the receipts' `agentId` / `backgroundTaskId`. */
export const claudeBackgroundRuntime: BackgroundRuntime = {
  tasks: id => getClaudeSDKLiveBackgroundTasks(id),
  alive: id => isClaudeSDKSessionAlive(id),
};

/**
 * The authoritative running set for ONE session, never a guess. A provider without a
 * runtime inventory, or a Claude session not loaded in memory (restart, idle-reaped),
 * reports `available: false` — an empty list there would read as "everything finished".
 */
export function nativeBackgroundSnapshot(sessionId: string, row: { provider: string; provider_session_id?: string | null },
  runtime: BackgroundRuntime = claudeBackgroundRuntime, now = Date.now()): NativeBackgroundSnapshot {
  if (row.provider !== 'claude') return { kind: 'native.background', available: false, observedAt: now, reason: 'unsupported-provider' };
  const id = row.provider_session_id || sessionId;
  if (!runtime.alive(id)) return { kind: 'native.background', available: false, observedAt: now, reason: 'not-live' };
  const running = runtime.tasks(id).slice(0, 500)
    .filter(task => typeof task.taskId === 'string' && task.taskId)
    .map(task => ({ taskId: task.taskId.slice(0, 200), description: String(task.description ?? '').slice(0, 200) }));
  return { kind: 'native.background', available: true, observedAt: now, running };
}
