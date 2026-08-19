import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { getOpenCodeDatabasePath } from './utils.js';

/**
 * Reader for OpenCode's todo ledger: the `todo` table in opencode.db, keyed by
 * session id, written by the model's own `todowrite` calls. Read-only — this
 * module only asks "is anything still open?" so the task-continuation service
 * can decide whether a finished turn is actually the end of the session.
 *
 * `activity` counts the session's tool parts. The continuation stall detector
 * compares it across nudges to tell "worked but didn't update the ledger yet"
 * from "did nothing at all" — message counts won't do, because every
 * continuation leg appends messages even when the model just shrugs.
 */
export function readOpenCodeTaskState(sessionId, dbPath = getOpenCodeDatabasePath()) {
  const empty = { open: [], activity: 0 };
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return empty;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const open = db.prepare(`
      SELECT content, status, position FROM todo
      WHERE session_id = ? AND status IN ('pending', 'in_progress')
      ORDER BY position
    `).all(sessionId).map((row) => ({
      id: String(row.position),
      subject: row.content,
      status: row.status,
    }));
    const activity = db.prepare(`
      SELECT COUNT(*) AS n FROM part
      WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
    `).get(sessionId)?.n ?? 0;
    return { open, activity };
  } catch {
    // Older schema without the todo table, or a locked/foreign database —
    // read as "nothing open" rather than guessing.
    return empty;
  } finally {
    if (db) {
      db.close();
    }
  }
}
