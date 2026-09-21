import { getClaudeSDKBackgroundTasks, isClaudeSDKSessionAlive } from '@/modules/providers/list/claude/claude-runtime.provider.js';

/** What the native client may learn about one session's background jobs. */
export type NativeBackgroundSnapshot =
  | { kind: 'native.background'; available: true; observedAt: number; running: { taskId: string; description: string }[] }
  | { kind: 'native.background'; available: false; observedAt: number; reason: 'unsupported-provider' | 'not-live' };

export type BackgroundRuntime = {
  tasks: (providerSessionId: string) => { taskId: string; description: string }[];
  alive: (providerSessionId: string) => boolean;
};

/** Claude's SDK is the only runtime that tracks background jobs: `task_started` adds a
 * task, `task_notification` and stop_task remove it. Nothing else is inventoried. */
export const claudeBackgroundRuntime: BackgroundRuntime = {
  tasks: id => getClaudeSDKBackgroundTasks(id),
  alive: id => isClaudeSDKSessionAlive(id),
};

/**
 * The authoritative running set for ONE session, never a guess. A provider without a
 * runtime inventory, or a Claude session not loaded in memory (restart, idle-reaped),
 * reports `available: false` — an empty list there would read as "everything finished".
 */
export function nativeBackgroundSnapshot(row: { id: string; provider: string; provider_session_id?: string | null },
  runtime: BackgroundRuntime = claudeBackgroundRuntime, now = Date.now()): NativeBackgroundSnapshot {
  if (row.provider !== 'claude') return { kind: 'native.background', available: false, observedAt: now, reason: 'unsupported-provider' };
  const id = row.provider_session_id || row.id;
  if (!runtime.alive(id)) return { kind: 'native.background', available: false, observedAt: now, reason: 'not-live' };
  const running = runtime.tasks(id).slice(0, 500)
    .filter(task => typeof task.taskId === 'string' && task.taskId)
    .map(task => ({ taskId: task.taskId.slice(0, 200), description: String(task.description ?? '').slice(0, 200) }));
  return { kind: 'native.background', available: true, observedAt: now, running };
}
