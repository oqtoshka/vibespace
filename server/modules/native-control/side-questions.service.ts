import { createHash } from 'node:crypto';

import { appConfigDb, getConnection, sessionsDb } from '@/modules/database/index.js';
import { issueSideCapability } from '@/modules/session-capabilities/index.js';
import { sessionShredService, sessionsService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/index.js';

/**
 * Native side questions (Mission Control FEAT-SESSION-030): a `/btw` side
 * session asked from the phone under a parent session. VibeSpace owns the row;
 * Mission Control only relays these calls and proxies the chat socket.
 *
 * A side session is an `is_side` row with a `parent_session_id`. It is never a
 * board card (its runs carry the private-variant env), it only reads (the send
 * path forces plan mode and a deny list), and it is removed on close or after
 * 24 hours without a turn, unless it was promoted to an ordinary session.
 */

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sessionIdPattern = /^[a-zA-Z0-9._-]{1,120}$/;
export const SIDE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type SideContextMode = 'fork' | 'excerpt' | 'none';

/** What the send path needs to know about a side row; null for anything else. */
export type SideSessionContext = {
  parentId: string;
  parentProviderSessionId: string | null;
  parentJsonlPath: string | null;
  contextMode: SideContextMode;
};

type SideRunControl = {
  /** Aborts the side session's own run; never the parent's. */
  abort: (sessionId: string) => Promise<unknown>;
  isRunning: (sessionId: string) => boolean;
};

// Injected by the composition root: the websocket module imports this one, so
// importing it back would be a cycle.
let runControl: SideRunControl | null = null;
export function registerSideRunControl(next: SideRunControl): void { runControl = next; }

function contextModeFor(sideProvider: string, parentProviderSessionId: string | null): SideContextMode {
  if (!parentProviderSessionId) return 'none';
  return sideProvider === 'claude' ? 'fork' : 'excerpt';
}

/** Parent eligibility is checked on create and on every send: a parent that
 * turned private, was archived or deleted takes its side questions with it. */
function eligibleParent(parentId: string) {
  const parent = sessionsDb.getSessionById(parentId);
  if (!parent || parent.is_private !== 0 || parent.is_side !== 0 || parent.isArchived) return null;
  return parent;
}

/** The send path's view of a side row. Returns null for a non-side row or a
 * browser `/btw` row (no parent), which keeps the parentless behaviour. */
export function sideSessionContext(sessionId: string): SideSessionContext | null {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.is_side !== 1) return null;
  const parentId = sessionsDb.getSideParent(sessionId);
  if (!parentId) return null;
  const parent = sessionsDb.getSessionById(parentId);
  const parentProviderSessionId = parent && parent.provider === row.provider ? parent.provider_session_id : null;
  return {
    parentId,
    parentProviderSessionId,
    parentJsonlPath: parent?.jsonl_path ?? null,
    contextMode: contextModeFor(row.provider, parentProviderSessionId),
  };
}

function sideRow(id: string) {
  if (!sessionIdPattern.test(id)) throw new Error('Invalid session ID');
  const row = sessionsDb.getSessionById(id);
  if (!row || row.is_side !== 1 || !sessionsDb.getSideParent(id)) throw new Error('Side question is unavailable');
  return row;
}

/** Deletes a side row and its provider records. A side row that somehow shares
 * the parent's provider session keeps the records: they are the parent's. */
async function removeSide(id: string): Promise<void> {
  const row = sessionsDb.getSessionById(id);
  if (!row) return;
  const parentId = sessionsDb.getSideParent(id);
  const parent = parentId ? sessionsDb.getSessionById(parentId) : null;
  if (row.provider_session_id && parent?.provider_session_id === row.provider_session_id) {
    sessionsDb.deleteSessionById(id); return;
  }
  await sessionShredService.execute(row);
  sessionsDb.deleteSessionById(id);
}

export const sideQuestionsService = {
  create(parentId: string, input: unknown) {
    if (!sessionIdPattern.test(parentId)) throw new Error('Invalid session ID');
    const requestId = input && typeof input === 'object' ? (input as Record<string, unknown>).requestId : undefined;
    if (typeof requestId !== 'string' || !uuid.test(requestId)) throw new Error('Invalid side question request');
    // Private sessions never get side questions: the side run would read a
    // conversation the operator kept off every external channel.
    const parent = eligibleParent(parentId);
    if (!parent) throw new Error('Side questions are unavailable for this session');
    if (!parent.project_path) throw new Error('Session has no working directory');
    const receiptKey = `native_side:${createHash('sha256').update(`${parentId}\u0000${requestId}`).digest('hex')}`;
    const id = getConnection().transaction(() => {
      const previous = appConfigDb.get(receiptKey);
      if (previous) {
        const receipt = JSON.parse(previous) as { id: string; parentId: string };
        if (receipt.parentId !== parentId) throw new Error('This request ID was already used for a different session');
        sideRow(receipt.id);
        return receipt.id;
      }
      const created = sessionsService.createAppSession(parent.provider as LLMProvider, parent.project_path!, true, false);
      sessionsDb.setSideParent(created.sessionId, parentId);
      if (parent.model) sessionsDb.setSessionModel(created.sessionId, parent.model);
      if (parent.effort) sessionsDb.setSessionEffort(created.sessionId, parent.effort);
      appConfigDb.set(receiptKey, JSON.stringify({ id: created.sessionId, parentId }));
      return created.sessionId;
    })();
    const row = sideRow(id);
    return {
      sessionId: id,
      provider: row.provider,
      contextMode: sideSessionContext(id)?.contextMode ?? 'none',
      capability: issueSideCapability(id),
    };
  },

  /** Turns the side question into an ordinary session; idempotent. */
  promote(id: string) {
    if (!sessionIdPattern.test(id)) throw new Error('Invalid session ID');
    const row = sessionsDb.getSessionById(id);
    if (!row || !sessionsDb.getSideParent(id)) throw new Error('Side question is unavailable');
    if (row.is_side === 1) sessionsService.promoteSideSession(id, 'Side question');
    const promoted = sessionsDb.getSessionById(id)!;
    return { sessionId: id, id, name: promoted.custom_name || 'Side question', provider: promoted.provider };
  },

  /** Panel closed: stop the side run and delete the side session now. */
  async close(id: string) {
    sideRow(id);
    if (runControl?.isRunning(id)) await runControl.abort(id);
    await removeSide(id);
    return { ok: true };
  },

  /** Removes unpromoted native side questions idle for 24 hours. A running side
   * turn is skipped; the next pass sees it again once it has settled. */
  async sweep(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const row of sessionsDb.listStaleSideSessions(new Date(now - SIDE_SESSION_TTL_MS))) {
      if (runControl?.isRunning(row.session_id) ?? true) continue;
      try { await removeSide(row.session_id); removed.push(row.session_id); }
      catch (error) { console.warn('[side-questions] sweep failed for', row.session_id, (error as Error)?.message ?? error); }
    }
    return removed;
  },
};

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Started by the composition root once the schema exists; hourly. */
export function startSideQuestionSweeper(intervalMs = 60 * 60 * 1000): void {
  if (sweepTimer) return;
  const pass = () => { sideQuestionsService.sweep().catch(error => console.warn('[side-questions] sweep failed:', error?.message ?? error)); };
  pass();
  sweepTimer = setInterval(pass, intervalMs);
  sweepTimer.unref();
}
