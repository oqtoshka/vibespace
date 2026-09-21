import { getConnection } from '@/modules/database/connection.js';
import type { PeerOutboxRecord, PeerOutboxStatus } from '@/shared/types.js';

type PeerOutboxRow = {
  sender_session_id: string;
  request_id: string;
  recipient_session_id: string;
  project_path: string;
  content: string;
  fingerprint: string;
  status: PeerOutboxStatus;
  reason: string | null;
  accepted_at: string;
  dispatched_at: string | null;
  updated_at: string;
};

/** Internal shape: the record plus the stored message and project. */
export type PeerOutboxEntry = PeerOutboxRecord & { content: string; projectPath: string };

function toEntry(row: PeerOutboxRow): PeerOutboxEntry {
  return {
    senderSessionId: row.sender_session_id,
    requestId: row.request_id,
    recipientSessionId: row.recipient_session_id,
    fingerprint: row.fingerprint,
    status: row.status,
    reason: row.reason,
    acceptedAt: row.accepted_at,
    dispatchedAt: row.dispatched_at,
    updatedAt: row.updated_at,
    content: row.content,
    projectPath: row.project_path,
  };
}

const now = () => new Date().toISOString();

/**
 * Persistence for the peer-message outbox (see PEER_OUTBOX_TABLE_SCHEMA_SQL).
 * Consumer: the websocket module's peer outbox service. Every state change is
 * a conditional UPDATE on the current status, so a row can only move
 * pending → dispatched or pending → cancelled, once.
 */
export const peerOutboxDb = {
  get(senderSessionId: string, requestId: string): PeerOutboxEntry | null {
    const row = getConnection()
      .prepare('SELECT * FROM peer_outbox WHERE sender_session_id = ? AND request_id = ?')
      .get(senderSessionId, requestId) as PeerOutboxRow | undefined;
    return row ? toEntry(row) : null;
  },

  /** Inserts a pending row; returns false when the key already exists. */
  insertPending(entry: {
    senderSessionId: string;
    requestId: string;
    recipientSessionId: string;
    projectPath: string;
    content: string;
    fingerprint: string;
  }): boolean {
    const at = now();
    const result = getConnection()
      .prepare(`INSERT OR IGNORE INTO peer_outbox
        (sender_session_id, request_id, recipient_session_id, project_path, content, fingerprint, status, reason, accepted_at, dispatched_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`)
      .run(entry.senderSessionId, entry.requestId, entry.recipientSessionId, entry.projectPath,
        entry.content, entry.fingerprint, at, at);
    return result.changes === 1;
  },

  countPending(recipientSessionId: string): number {
    const row = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM peer_outbox WHERE recipient_session_id = ? AND status = 'pending'")
      .get(recipientSessionId) as { n: number };
    return row.n;
  },

  /** Oldest pending row for a recipient, or null. */
  nextPending(recipientSessionId: string): PeerOutboxEntry | null {
    const row = getConnection()
      .prepare(`SELECT * FROM peer_outbox WHERE recipient_session_id = ? AND status = 'pending'
        ORDER BY accepted_at, rowid LIMIT 1`)
      .get(recipientSessionId) as PeerOutboxRow | undefined;
    return row ? toEntry(row) : null;
  },

  recipientsWithPending(): string[] {
    const rows = getConnection()
      .prepare("SELECT DISTINCT recipient_session_id AS id FROM peer_outbox WHERE status = 'pending'")
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  },

  /** pending → dispatched. Returns false if the row was not pending. */
  markDispatched(senderSessionId: string, requestId: string): boolean {
    const at = now();
    return getConnection()
      .prepare(`UPDATE peer_outbox SET status = 'dispatched', dispatched_at = ?, updated_at = ?
        WHERE sender_session_id = ? AND request_id = ? AND status = 'pending'`)
      .run(at, at, senderSessionId, requestId).changes === 1;
  },

  /** pending → cancelled. Never touches a dispatched row. */
  cancel(senderSessionId: string, requestId: string, reason: string): boolean {
    return getConnection()
      .prepare(`UPDATE peer_outbox SET status = 'cancelled', reason = ?, updated_at = ?
        WHERE sender_session_id = ? AND request_id = ? AND status = 'pending'`)
      .run(reason, now(), senderSessionId, requestId).changes === 1;
  },

  cancelPendingForRecipient(recipientSessionId: string, reason: string): number {
    return getConnection()
      .prepare(`UPDATE peer_outbox SET status = 'cancelled', reason = ?, updated_at = ?
        WHERE recipient_session_id = ? AND status = 'pending'`)
      .run(reason, now(), recipientSessionId).changes;
  },

  /** Expires pending rows accepted at or before the cutoff (age >= bound). */
  cancelPendingAcceptedAtOrBefore(cutoffIso: string, reason: string): number {
    return getConnection()
      .prepare(`UPDATE peer_outbox SET status = 'cancelled', reason = ?, updated_at = ?
        WHERE status = 'pending' AND accepted_at <= ?`)
      .run(reason, now(), cutoffIso).changes;
  },
};
