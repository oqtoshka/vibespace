import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { getConnection, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import type { NormalizedMessage } from '@/shared/index.js';

import { sessionsService } from './sessions.service.js';

type ArchiveFilter = 'all' | 'active' | 'archived';
type MatchType = 'all' | 'phrase' | 'prefix' | 'title' | 'content';

type SearchInput = {
  query: string;
  sessionId?: string;
  projectId?: string;
  provider?: string;
  archived?: ArchiveFilter;
  from?: string;
  to?: string;
  matchType?: MatchType;
  limit?: number;
  cursor?: string;
};

type IndexedSession = ReturnType<typeof sessionsDb.getAllSessionsIncludingArchived>[number];
type SearchRow = {
  rowid: number;
  session_id: string;
  project_id: string | null;
  project_path: string | null;
  provider: string;
  archived: number;
  occurred_at: string | null;
  message_id: string | null;
  role: string | null;
  kind: string;
  display_title: string;
  display_summary: string;
  model: string | null;
  effort: string | null;
  compressed_content: Buffer;
  rank: number;
};

const MATCH_TYPES = new Set<MatchType>(['all', 'phrase', 'prefix', 'title', 'content']);
const ARCHIVE_FILTERS = new Set<ArchiveFilter>(['all', 'active', 'archived']);
// Continuations are local to this process. Restarting refuses old pages rather
// than silently resuming against a different source/authentication lifecycle.
const CURSOR_SECRET = randomBytes(32);
const CURSOR_TTL_MS = 10 * 60 * 1000;
type ScopedPageSnapshot = {
  connection: ReturnType<typeof getConnection>;
  createdAt: number;
  token: string;
  rows: Array<Pick<SearchRow, 'rowid' | 'rank'>>;
};
// Keep only compact row identities/scores, never transcript buffers. Unrelated
// FTS updates can change BM25 statistics even when this session did not change.
const scopedSnapshots = new Map<string, ScopedPageSnapshot>();
const MAX_SCOPED_SNAPSHOTS = 32;
const MAX_SCOPED_SNAPSHOT_ROWS = 250_000;
function pruneScopedSnapshots(now: number): void {
  for (const [key, snapshot] of scopedSnapshots) {
    if (now - snapshot.createdAt >= CURSOR_TTL_MS || now < snapshot.createdAt) scopedSnapshots.delete(key);
  }
  let count = Array.from(scopedSnapshots.values()).reduce((sum, snapshot) => sum + snapshot.rows.length, 0);
  for (const [key, snapshot] of scopedSnapshots) {
    if (scopedSnapshots.size <= MAX_SCOPED_SNAPSHOTS && count <= MAX_SCOPED_SNAPSHOT_ROWS) break;
    scopedSnapshots.delete(key);
    count -= snapshot.rows.length;
  }
}
// Tool results can contain megabytes of duplicated JSON, images or command
// output. Keep useful leading context and terminal errors without letting a
// single message turn the local FTS database into another transcript store.
const MAX_INDEXED_MESSAGE_CHARS = 32 * 1024;
const MAX_INDEXED_TOOL_CHARS = 8 * 1024;
const MAX_INDEXED_COMPACTION_CHARS = 16 * 1024;

function isoDate(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${name} date`);
  return date.toISOString();
}

function terms(query: string): string[] {
  return query.normalize('NFKC').match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function quoteFts(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function ftsExpression(query: string, matchType: MatchType): string {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) throw new Error('Search query must contain a letter or number');
  let expression: string;
  if (matchType === 'prefix') expression = queryTerms.map(term => `${quoteFts(term)}*`).join(' AND ');
  else expression = queryTerms.map(quoteFts).join(' AND ');
  if (matchType === 'title') return `title : (${expression})`;
  if (matchType === 'content') return `{summary content} : (${expression})`;
  return expression;
}

function boundedText(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const tail = Math.floor(limit / 4);
  const marker = `\n[… ${text.length - limit} characters omitted …]\n`;
  return `${text.slice(0, limit - tail - marker.length)}${marker}${text.slice(-tail)}`;
}

function searchableJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, (key, item) => {
      if (typeof item === 'string' && item.length > 1024 && /(base64|bytes|data|image)/i.test(key)) {
        return `[${item.length} encoded characters omitted]`;
      }
      if (typeof item === 'string' && item.length > 4096) {
        const compact = item.replace(/\s/g, '');
        if (compact.length > 4096 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
          return `[${item.length} encoded characters omitted]`;
        }
      }
      return item;
    });
  } catch { return ''; }
}

function messageText(message: NormalizedMessage): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) return;
    seen.add(value); parts.push(value.trim());
  };
  for (const value of [
    message.content, message.displayText, message.commandName, message.commandMessage,
    message.commandArgs, message.toolName, message.compaction?.summary,
    message.text, message.summary, message.reason,
  ]) add(value);
  for (const value of [message.toolInput, message.input, message.context]) {
    add(typeof value === 'string' ? value : searchableJson(value));
  }
  // Normalizers attach a result to its tool_use row and also emit the same
  // tool_result as a row of its own. Index the result only on that second row.
  if (message.kind !== 'tool_use') {
    for (const value of [message.toolResult?.content, message.toolResult?.toolUseResult, message.toolUseResult]) {
      add(typeof value === 'string' ? value : searchableJson(value));
    }
  }
  const limit = message.kind === 'tool_use' || message.kind === 'tool_result'
    ? MAX_INDEXED_TOOL_CHARS
    : message.kind === 'compact_boundary' ? MAX_INDEXED_COMPACTION_CHARS : MAX_INDEXED_MESSAGE_CHARS;
  return boundedText(parts.join('\n'), limit);
}

function fieldMatches(value: string, query: string, matchType: MatchType): boolean {
  const queryTerms = terms(query).map(term => term.toLocaleLowerCase());
  if (matchType === 'phrase') {
    const fieldTerms = terms(value).map(term => term.toLocaleLowerCase());
    return fieldTerms.some((_, at) => queryTerms.every((term, index) => fieldTerms[at + index] === term));
  }
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  return queryTerms.every(term => normalized.includes(term));
}

function snippet(value: string, query: string): { text: string; highlights: Array<{ start: number; end: number }> } {
  const queryTerms = terms(query);
  const folded = value.toLocaleLowerCase();
  const positions = queryTerms.map(term => folded.indexOf(term.toLocaleLowerCase())).filter(index => index >= 0);
  const anchor = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, anchor - 80);
  const end = Math.min(value.length, start + 320);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < value.length ? '…' : '';
  const text = prefix + value.slice(start, end) + suffix;
  const searchable = text.toLocaleLowerCase();
  const highlights: Array<{ start: number; end: number }> = [];
  for (const term of queryTerms) {
    const needle = term.toLocaleLowerCase();
    let at = 0;
    while (needle && highlights.length < 20 && (at = searchable.indexOf(needle, at)) >= 0) {
      highlights.push({ start: at, end: at + term.length });
      at += Math.max(needle.length, 1);
    }
  }
  highlights.sort((left, right) => left.start - right.start || left.end - right.end);
  return { text, highlights };
}

function compressed(value: string): Buffer {
  return deflateRawSync(Buffer.from(value), { level: 6 });
}

function uncompressed(value: Buffer): string {
  return inflateRawSync(value).toString('utf8');
}

async function sourceFingerprint(session: IndexedSession, userId: number): Promise<string> {
  let source = '';
  if (session.jsonl_path) {
    try {
      const info = await stat(session.jsonl_path);
      source = `${info.size}:${info.mtimeMs}`;
    } catch { source = 'missing'; }
  }
  const project = session.project_path ? projectsDb.getProjectPath(session.project_path) : null;
  return createHash('sha256').update(JSON.stringify([
    userId, session.session_id, session.provider_session_id, session.provider,
    session.project_path, session.custom_name, session.recap, session.topic_memory,
    session.model, session.effort, session.isArchived, session.updated_at, source,
    project?.project_id, project?.custom_project_name, project?.isArchived,
  ])).digest('hex');
}

function searchGeneration(sessionId?: string): string {
  const rows = getConnection().prepare(
    `SELECT session_id, source_fingerprint FROM session_search_state
     ${sessionId ? 'WHERE session_id = ?' : ''} ORDER BY session_id`,
  ).all(...(sessionId ? [sessionId] : [])) as Array<{ session_id: string; source_fingerprint: string }>;
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 20);
}

function nextCursor(offset: number, generation: string, binding: string): string {
  const payload = Buffer.from(JSON.stringify({ version: 1, offset, generation, binding, issuedAt: Date.now() })).toString('base64url');
  return `${payload}.${createHmac('sha256', CURSOR_SECRET).update(payload).digest('hex')}`;
}

function cursorOffset(cursor: string | undefined, generation: string, binding: string): number {
  if (cursor === undefined) return 0;
  try {
    if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error();
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature)) throw new Error();
    const expected = createHmac('sha256', CURSOR_SECRET).update(payload).digest();
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      version?: unknown; offset?: unknown; generation?: unknown; binding?: unknown; issuedAt?: unknown;
    };
    const age = Date.now() - Number(decoded.issuedAt);
    if (decoded.version !== 1 || decoded.generation !== generation || decoded.binding !== binding
      || !Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 0
      || !Number.isSafeInteger(decoded.issuedAt) || age < 0 || age >= CURSOR_TTL_MS) {
      throw new Error();
    }
    return Number(decoded.offset);
  } catch {
    throw new Error('Search cursor is invalid or stale; restart from the first page');
  }
}

/**
 * Persistent full-transcript lexical index used by both the browser search
 * route and the native-control/Commander API. A mandatory sync before every
 * query makes rename/archive/delete/import visible atomically; unchanged
 * transcripts are skipped by source fingerprint, which is the incremental
 * update path and the startup/first-query path is the backfill.
 *
 * The result advertises its engine. A future vector backend can fuse scores at
 * this boundary without changing filters, cursors, snippets, or callers.
 */
export const sessionSearchIndexService = {
  async sync(): Promise<{ generation: string; indexed: number }> {
    const user = userDb.getSingleActiveUser();
    if (!user) throw new Error('Operator is unavailable');
    const userId = Number(user.id);
    const sessions = sessionsDb.getAllSessionsIncludingArchived().filter(row => !row.is_private);
    const liveIds = new Set(sessions.map(row => row.session_id));
    const db = getConnection();

    const stale = db.prepare('SELECT session_id FROM session_search_state').all() as Array<{ session_id: string }>;
    const remove = db.transaction((ids: string[]) => {
      for (const id of ids) {
        db.prepare(`DELETE FROM session_search_fts WHERE rowid IN (
          SELECT rowid FROM session_search_documents WHERE session_id = ?
        )`).run(id);
        db.prepare('DELETE FROM session_search_documents WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM session_search_state WHERE session_id = ?').run(id);
      }
    });
    remove(stale.filter(row => !liveIds.has(row.session_id)).map(row => row.session_id));

    let indexed = 0;
    for (const session of sessions) {
      const fingerprint = await sourceFingerprint(session, userId);
      const current = db.prepare('SELECT source_fingerprint FROM session_search_state WHERE session_id = ?')
        .get(session.session_id) as { source_fingerprint: string } | undefined;
      if (current?.source_fingerprint === fingerprint) continue;

      const project = session.project_path ? projectsDb.getProjectPath(session.project_path) : null;
      const archived = Boolean(session.isArchived || project?.isArchived);
      const title = session.custom_name?.trim() || session.session_id;
      const summary = [session.recap, session.topic_memory].filter(Boolean).join('\n');
      let messages: NormalizedMessage[] = [];
      let transcriptLoaded = true;
      try { messages = await sessionsService.fetchFullHistoryForIndex(session.session_id); }
      catch { transcriptLoaded = false; /* metadata remains searchable and the next sync retries */ }
      const seen = new Set<string>();
      const insert = db.prepare(`INSERT INTO session_search_documents (
        user_id, session_id, project_id, project_path, provider, archived,
        occurred_at, message_id, role, kind, display_title, display_summary,
        model, effort, compressed_content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertFts = db.prepare('INSERT INTO session_search_fts(rowid, title, summary, content) VALUES (?, ?, ?, ?)');
      const addDocument = (values: unknown[], indexedTitle: string, indexedSummary: string, content: string) => {
        const result = insert.run(...values, compressed(content));
        insertFts.run(result.lastInsertRowid, indexedTitle, indexedSummary, content);
      };
      const replace = db.transaction(() => {
        db.prepare(`DELETE FROM session_search_fts WHERE rowid IN (
          SELECT rowid FROM session_search_documents WHERE session_id = ?
        )`).run(session.session_id);
        db.prepare('DELETE FROM session_search_documents WHERE session_id = ?').run(session.session_id);
        const metadata = [project?.custom_project_name, session.project_path, session.provider, session.session_id]
          .filter(Boolean).join('\n');
        addDocument([userId, session.session_id, project?.project_id ?? null, session.project_path,
          session.provider, archived ? 1 : 0, session.updated_at || session.created_at,
          null, null, 'metadata', title, summary, session.model, session.effort,
        ], title, summary, metadata);
        for (const message of messages) {
          const content = messageText(message);
          if (!content) continue;
          const key = `${message.id}:${message.role ?? ''}:${message.kind}:${content}`;
          if (seen.has(key)) continue;
          seen.add(key);
          addDocument([userId, session.session_id, project?.project_id ?? null, session.project_path,
            session.provider, archived ? 1 : 0, message.timestamp || session.updated_at,
            message.uuid || message.id, message.role ?? null, message.kind, '', '',
            session.model, session.effort,
          ], '', '', content);
        }
        if (transcriptLoaded) {
          db.prepare(`INSERT INTO session_search_state(session_id, source_fingerprint, indexed_at)
            VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(session_id) DO UPDATE SET
            source_fingerprint=excluded.source_fingerprint, indexed_at=CURRENT_TIMESTAMP`)
            .run(session.session_id, fingerprint);
        }
      });
      replace();
      indexed += 1;
    }
    return { generation: searchGeneration(), indexed };
  },

  async search(input: SearchInput) {
    if (!input || typeof input.query !== 'string' || input.query.trim().length < 1 || input.query.length > 500) {
      throw new Error('Search query must be between 1 and 500 characters');
    }
    const matchType = input.matchType ?? 'all';
    const archived = input.archived ?? 'all';
    if (!MATCH_TYPES.has(matchType)) throw new Error('Invalid match type');
    if (!ARCHIVE_FILTERS.has(archived)) throw new Error('Invalid archive filter');
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be between 1 and 100');
    const from = isoDate(input.from, 'from');
    const to = isoDate(input.to, 'to');
    if (from && to && from > to) throw new Error('Search date range is reversed');
    if (input.sessionId !== undefined && (typeof input.sessionId !== 'string'
      || !input.sessionId.trim() || input.sessionId.length > 200)) throw new Error('Invalid session restriction');
    const sessionId = input.sessionId?.trim();
    const user = userDb.getSingleActiveUser();
    if (!user) throw new Error('Operator is unavailable');
    const synced = await this.sync();
    // Refresh awaits provider I/O. Never return the old operator's rows if the
    // active account changed while that work was in flight.
    if (Number(userDb.getSingleActiveUser()?.id) !== Number(user.id)) {
      throw new Error('Operator changed during search; restart from the first page');
    }
    const binding = createHash('sha256').update(JSON.stringify([
      Number(user.id), input.query.normalize('NFKC').trim(), sessionId ?? null,
      input.projectId ?? null, input.provider ?? null, archived, from ?? null, to ?? null, matchType, limit,
    ])).digest('hex');
    let generation = sessionId ? searchGeneration(sessionId) : synced.generation;
    let offset = sessionId ? 0 : cursorOffset(input.cursor, generation, binding);

    const clauses = ['session_search_fts MATCH ?', 'documents.user_id = ?'];
    const args: unknown[] = [ftsExpression(input.query, matchType), Number(user.id)];
    if (sessionId) { clauses.push('documents.session_id = ?'); args.push(sessionId); }
    if (input.projectId) { clauses.push('documents.project_id = ?'); args.push(input.projectId); }
    if (input.provider) { clauses.push('documents.provider = ?'); args.push(input.provider); }
    if (archived !== 'all') { clauses.push('documents.archived = ?'); args.push(archived === 'archived' ? 1 : 0); }
    if (from) { clauses.push('documents.occurred_at >= ?'); args.push(from); }
    if (to) { clauses.push('documents.occurred_at <= ?'); args.push(to); }
    const where = clauses.join(' AND ');
    const db = getConnection();
    const joined = `FROM session_search_fts JOIN session_search_documents AS documents
      ON documents.rowid = session_search_fts.rowid`;
    const select = `SELECT documents.*,
      bm25(session_search_fts) - CASE WHEN instr(lower(documents.display_title), lower(?)) > 0 THEN 10 ELSE 0 END AS rank
      ${joined} WHERE ${where}
      ORDER BY rank ASC, datetime(documents.occurred_at) DESC, documents.session_id ASC, documents.rowid ASC`;
    let total: number;
    let rows: SearchRow[];
    if (sessionId) {
      const key = `${binding}:${generation}`;
      pruneScopedSnapshots(Date.now());
      let snapshot = scopedSnapshots.get(key);
      if (snapshot?.connection !== db) snapshot = undefined;
      if (!snapshot) {
        // A missing/evicted snapshot must never be replaced under an old offset.
        if (input.cursor !== undefined) throw new Error('Search cursor is invalid or stale; restart from the first page');
        let ranked: Array<Pick<SearchRow, 'rowid' | 'rank'>>;
        if (matchType === 'phrase') {
          ranked = (db.prepare(select).all(input.query.trim(), ...args) as SearchRow[]).filter(row =>
            fieldMatches(uncompressed(row.compressed_content), input.query, matchType)
            || (row.kind === 'metadata' && (fieldMatches(row.display_title, input.query, matchType)
              || fieldMatches(row.display_summary, input.query, matchType))))
            .map(({ rowid, rank }) => ({ rowid, rank }));
        } else {
          ranked = db.prepare(select.replace('documents.*', 'documents.rowid'))
            .all(input.query.trim(), ...args) as Array<Pick<SearchRow, 'rowid' | 'rank'>>;
        }
        snapshot = { connection: db, createdAt: Date.now(), token: randomBytes(12).toString('hex'), rows: ranked };
        scopedSnapshots.set(key, snapshot);
        pruneScopedSnapshots(Date.now());
        if (!scopedSnapshots.has(key)) throw new Error('Search result exceeds the continuation snapshot limit; narrow the query');
      }
      // A fresh first page after eviction gets a new identity: an older cursor
      // cannot silently resume against its replacement under the same source hash.
      generation = createHash('sha256').update(`${generation}:${snapshot.token}`).digest('hex').slice(0, 20);
      offset = cursorOffset(input.cursor, generation, binding);
      total = snapshot.rows.length;
      const getRow = db.prepare('SELECT * FROM session_search_documents WHERE rowid = ? AND user_id = ? AND session_id = ?');
      rows = snapshot.rows.slice(offset, offset + limit).map(({ rowid, rank }) => {
        const row = getRow.get(rowid, Number(user.id), sessionId) as SearchRow | undefined;
        if (!row) throw new Error('Search cursor is invalid or stale; restart from the first page');
        return { ...row, rank };
      });
    } else if (matchType === 'phrase') {
      const candidates = db.prepare(select).all(input.query.trim(), ...args) as SearchRow[];
      const phraseMatches = candidates.filter(row => {
        const contentMatches = fieldMatches(uncompressed(row.compressed_content), input.query, matchType);
        return contentMatches || (row.kind === 'metadata'
          && (fieldMatches(row.display_title, input.query, matchType)
            || fieldMatches(row.display_summary, input.query, matchType)));
      });
      total = phraseMatches.length;
      rows = phraseMatches.slice(offset, offset + limit);
    } else {
      total = Number((db.prepare(`SELECT count(*) AS count ${joined} WHERE ${where}`)
        .get(...args) as { count: number }).count);
      rows = db.prepare(`${select} LIMIT ? OFFSET ?`).all(input.query.trim(), ...args, limit, offset) as SearchRow[];
    }
    const results = rows.map(row => {
      const content = uncompressed(row.compressed_content);
      const session = sessionsDb.getSessionById(row.session_id);
      const displayTitle = row.display_title || session?.custom_name?.trim() || row.session_id;
      const displaySummary = row.display_summary
        || [session?.recap, session?.topic_memory].filter(Boolean).join('\n');
      const titleMatched = row.kind === 'metadata' && matchType !== 'content'
        && fieldMatches(displayTitle, input.query, matchType);
      const summaryMatched = row.kind === 'metadata' && matchType !== 'title'
        && fieldMatches(displaySummary, input.query, matchType);
      const chosen = snippet(titleMatched ? displayTitle : summaryMatched ? displaySummary : content, input.query);
      const matchedField = titleMatched ? 'title' : summaryMatched ? 'summary'
        : row.kind === 'metadata' ? 'metadata' : 'transcript';
      return {
        sessionId: row.session_id,
        provider: row.provider,
        projectId: row.project_id,
        projectPath: row.project_path,
        title: displayTitle,
        summary: displaySummary || null,
        archived: Number(row.archived) === 1,
        isBackground: Boolean(session?.is_background),
        model: row.model,
        effort: row.effort,
        matchedField,
        role: row.role,
        messageKind: row.kind,
        messageId: row.message_id,
        occurredAt: row.occurred_at,
        snippet: chosen.text,
        highlights: chosen.highlights,
        score: Number((-row.rank).toFixed(6)),
        openPath: `/session/${encodeURIComponent(row.session_id)}`,
      };
    });
    const nextOffset = offset + rows.length;
    return {
      query: input.query.trim(),
      engine: { lexical: 'sqlite-fts5', semantic: 'unavailable', mode: 'lexical' },
      index: { generation, updatedSessions: synced.indexed },
      total,
      results,
      nextCursor: nextOffset < total
        ? nextCursor(nextOffset, generation, binding)
        : null,
    };
  },
};
