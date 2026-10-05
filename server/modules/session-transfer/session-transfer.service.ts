import { getConnection, sessionsDb } from '@/modules/database/index.js';

type Transfer = { requestId: string; sourceNativeId: string; successorSessionId: string; successorNativeId: string };
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/;

function connection() {
  const db = getConnection();
  db.exec(`CREATE TABLE IF NOT EXISTS session_transfer (
    source_session_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
    source_native_id TEXT NOT NULL UNIQUE, successor_session_id TEXT NOT NULL,
    successor_native_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  return db;
}

/** Native control commits a handoff; providers, restore and queue dispatch consult it.
 * Synchronous SQLite reads/commit keep guard checking and turn admission in one event-loop turn.
 * The caller must reject an already processing source before calling transfer(). */
export const sessionTransferService = {
  successor(id: string) {
    if (typeof id !== 'string' || !id) return undefined;
    return connection().prepare('SELECT * FROM session_transfer WHERE source_session_id=? OR source_native_id=?').get(id, id) as {
      source_session_id: string; source_native_id: string; successor_session_id: string; successor_native_id: string; request_id: string;
    } | undefined;
  },
  transfer(sourceSessionId: string, input: Transfer, processing: boolean) {
    if (![sourceSessionId, input?.requestId, input?.sourceNativeId, input?.successorSessionId, input?.successorNativeId]
      .every(id => typeof id === 'string' && identifier.test(id))) throw new Error('Invalid transfer addresses');
    if (sourceSessionId === input.successorSessionId || input.sourceNativeId === input.successorNativeId) throw new Error('A session cannot succeed itself');
    const db = connection();
    return db.transaction(() => {
      const previous = this.successor(sourceSessionId);
      if (previous) {
        if (previous.request_id !== input.requestId || previous.source_native_id !== input.sourceNativeId ||
            previous.successor_session_id !== input.successorSessionId || previous.successor_native_id !== input.successorNativeId) {
          throw new Error('Source was transferred by another request');
        }
        return previous;
      }
      const source = sessionsDb.getSessionById(sourceSessionId);
      const successor = sessionsDb.getSessionById(input.successorSessionId);
      if (!source || !successor || source.provider_session_id !== input.sourceNativeId || successor.provider_session_id !== input.successorNativeId ||
          source.is_private || source.is_side || successor.is_private || successor.is_side || successor.isArchived) throw new Error('Session addresses do not match available conversations');
      if (this.successor(input.successorSessionId)) throw new Error('Successor has itself been transferred');
      if (processing) throw new Error('Source is processing a turn or its Claude runner is still alive; wait for its ordinary idle reaper before transferring');
      db.prepare(`INSERT INTO session_transfer (source_session_id,request_id,source_native_id,successor_session_id,successor_native_id)
        VALUES (?,?,?,?,?)`).run(sourceSessionId, input.requestId, input.sourceNativeId, input.successorSessionId, input.successorNativeId);
      return this.successor(sourceSessionId)!;
    })();
  },
};
