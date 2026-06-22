/**
 * File shares repository.
 *
 * Persists public, unguessable share links to project files. A share points at
 * an absolute file path within a project; expiry is optional (NULL = permanent
 * until the file is deleted). The public-facing routes re-validate the path and
 * the file's existence at access time, so this layer just stores/looks up rows.
 */

import { getConnection } from '@/modules/database/connection.js';

export type FileShareRow = {
  share_id: string;
  project_id: string;
  file_path: string;
  created_by_user_id: number;
  created_at: string;
  expires_at: string | null;
  view_count: number;
  last_accessed: string | null;
};

type CreateShareParams = {
  shareId: string;
  projectId: string;
  filePath: string;
  userId: number;
  /** ISO-8601 string, or null for a permanent link. */
  expiresAt: string | null;
};

export const fileSharesDb = {
  /** Inserts a new share link. */
  createShare({ shareId, projectId, filePath, userId, expiresAt }: CreateShareParams): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO file_shares (share_id, project_id, file_path, created_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(shareId, projectId, filePath, userId, expiresAt);
  },

  /** Returns a share if it exists and has not expired, else null. */
  getActiveShare(shareId: string): FileShareRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT * FROM file_shares
         WHERE share_id = ?
           AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`
      )
      .get(shareId) as FileShareRow | undefined;
    return row ?? null;
  },

  /** Lists all (including expired) shares for a given file, newest first. */
  listSharesForFile(projectId: string, filePath: string): FileShareRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT * FROM file_shares
         WHERE project_id = ? AND file_path = ?
         ORDER BY created_at DESC`
      )
      .all(projectId, filePath) as FileShareRow[];
  },

  /** Deletes a share owned by the given user. Returns true if a row was removed. */
  deleteShare(shareId: string, userId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM file_shares WHERE share_id = ? AND created_by_user_id = ?')
      .run(shareId, userId);
    return result.changes > 0;
  },

  /** Bumps the view counter and last-accessed timestamp for a share. */
  recordAccess(shareId: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE file_shares
       SET view_count = view_count + 1, last_accessed = CURRENT_TIMESTAMP
       WHERE share_id = ?`
    ).run(shareId);
  },
};
