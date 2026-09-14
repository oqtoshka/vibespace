import crypto from 'node:crypto';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { isWaitingOnUserSubject } from './waiting-on-user.js';

/**
 * Reader for Cursor's todo ledger — the list the model keeps with TodoWrite.
 *
 * cursor-agent stores a conversation as a content-addressed blob DAG:
 *
 *   ~/.cursor/chats/<md5(realpath(cwd))>/<cursor-session-id>/store.db
 *     meta(key, value)  key '0' = hex-encoded JSON { agentId, latestRootBlobId, … }
 *     blobs(id, data)   id = hex sha256 of the blob
 *
 * The root blob is an `agent.v1.ConversationStateStructure` protobuf whose
 * field 3 repeats the 32-byte ids of the current todos; each of those blobs is
 * an `agent.v1.TodoItem` (1 id, 2 content, 3 status enum). Status 1 PENDING and
 * 2 IN_PROGRESS are open; 3 COMPLETED, 4 CANCELLED are not. Measured against
 * cursor-agent 2025.11.25 and the 2026.09.10 bundle (same proto).
 *
 * `activity` counts stored tool results, for the continuation stall detector.
 */
type OpenTask = { id: string; subject: string; status: 'pending' | 'in_progress'; waitingOnUser: boolean };
type TaskState = { open: OpenTask[]; activity: number };

type Field = { field: number; wire: number; value: number | Buffer };

function readVarint(buffer: Buffer, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let index = start;
  for (;;) {
    if (index >= buffer.length) throw new Error('truncated varint');
    const byte = buffer[index];
    index += 1;
    // Multiplication, not <<: timestamps exceed 32 bits.
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [result, index];
  }
}

function readFields(buffer: Buffer): Field[] {
  const fields: Field[] = [];
  let index = 0;
  while (index < buffer.length) {
    const [key, afterKey] = readVarint(buffer, index);
    index = afterKey;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const [value, next] = readVarint(buffer, index);
      fields.push({ field, wire, value });
      index = next;
    } else if (wire === 2) {
      const [length, next] = readVarint(buffer, index);
      fields.push({ field, wire, value: buffer.subarray(next, next + length) });
      index = next + length;
    } else if (wire === 1) {
      index += 8;
    } else if (wire === 5) {
      index += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

const STATUS: Record<number, OpenTask['status']> = { 1: 'pending', 2: 'in_progress' };

/** Every directory hash cursor-agent may have used for this cwd. */
function storeCandidates(sessionId: string, cwd: string, home: string): string[] {
  const paths = new Set<string>();
  for (const dir of [(() => { try { return fsSync.realpathSync(cwd); } catch { return null; } })(), cwd]) {
    if (!dir) continue;
    const hash = crypto.createHash('md5').update(dir).digest('hex');
    paths.add(path.join(home, '.cursor', 'chats', hash, sessionId, 'store.db'));
  }
  return [...paths];
}

export function readCursorTaskState(
  sessionId: string | null | undefined,
  cwd: string | null | undefined,
  home: string = os.homedir(),
): TaskState {
  const empty: TaskState = { open: [], activity: 0 };
  // The id is a directory name: refuse anything that could walk out of it.
  if (!sessionId || !cwd || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return empty;

  const storePath = storeCandidates(sessionId, cwd, home).find((candidate) => fsSync.existsSync(candidate));
  if (!storePath) return empty;

  let db: Database.Database | null = null;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true });
    const metaValue = (db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string } | undefined)?.value;
    if (!metaValue) return empty;
    const metaText = /^[0-9a-f]+$/i.test(metaValue) ? Buffer.from(metaValue, 'hex').toString('utf8') : metaValue;
    const rootId = JSON.parse(metaText)?.latestRootBlobId;
    if (typeof rootId !== 'string') return empty;

    const blob = db.prepare('SELECT data FROM blobs WHERE id = ?');
    const rootData = (blob.get(rootId) as { data?: Buffer } | undefined)?.data;
    if (!rootData) return empty;

    const open: OpenTask[] = [];
    let position = 0;
    for (const entry of readFields(Buffer.from(rootData))) {
      if (entry.field !== 3 || !Buffer.isBuffer(entry.value)) continue;
      position += 1;
      const todoData = (blob.get(entry.value.toString('hex')) as { data?: Buffer } | undefined)?.data;
      if (!todoData) continue;
      let content = '';
      let status = 0;
      for (const todoField of readFields(Buffer.from(todoData))) {
        if (todoField.field === 2 && Buffer.isBuffer(todoField.value)) content = todoField.value.toString('utf8');
        if (todoField.field === 3 && typeof todoField.value === 'number') status = todoField.value;
      }
      const openStatus = STATUS[status];
      if (!openStatus) continue;
      const subject = content || '(untitled)';
      open.push({ id: String(position), subject, status: openStatus, waitingOnUser: isWaitingOnUserSubject(subject) });
    }

    const activity = (db.prepare(
      "SELECT COUNT(*) AS n FROM blobs WHERE CAST(substr(data, 1, 15) AS TEXT) = '{\"role\":\"tool\",'",
    ).get() as { n?: number } | undefined)?.n ?? 0;
    return { open, activity };
  } catch {
    // A store mid-write, an unknown proto revision: "nothing open", never a guess.
    return empty;
  } finally {
    db?.close();
  }
}
