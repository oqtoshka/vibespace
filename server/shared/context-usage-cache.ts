import type { ContextUsage } from '@/shared/types.js';

/**
 * Last known context reading per provider session.
 *
 * A session's real context window is only knowable while a runtime is alive to
 * be asked, but the gauge should survive the things that happen constantly in
 * a web UI — a page reload, switching to another session and back — none of
 * which restart the server. Remembering the last reading lets those restore a
 * real gauge instead of dropping to a bare token count until the user sends
 * another message.
 *
 * Deliberately in-memory and lossy: a server restart forgets, and the next
 * turn re-reads. Persisting it would mean a schema migration to cache a number
 * that the runtime hands over for free the moment work resumes.
 */
const readings = new Map<string, ContextUsage>();

/**
 * Bound on remembered sessions. Insertion-ordered eviction (a Map preserves
 * insertion order, and re-recording deletes first), so this keeps the most
 * recently active sessions — the ones a user is plausibly switching between.
 */
const MAX_REMEMBERED_SESSIONS = 200;

export function rememberContextUsage(sessionId: string | null | undefined, usage: ContextUsage): void {
  if (!sessionId) return;

  // Re-insert so the entry counts as most-recent for eviction purposes.
  readings.delete(sessionId);
  readings.set(sessionId, usage);

  while (readings.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = readings.keys().next().value;
    if (oldest === undefined) break;
    readings.delete(oldest);
  }
}

export function recallContextUsage(sessionId: string | null | undefined): ContextUsage | null {
  if (!sessionId) return null;
  return readings.get(sessionId) ?? null;
}

/** Test seam. */
export function clearContextUsageCache(): void {
  readings.clear();
}
