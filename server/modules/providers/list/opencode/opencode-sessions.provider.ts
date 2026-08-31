import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { createCompactBoundaryMessage } from '@/shared/compaction.js';
import { extractToolResultImages, parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage, RewindResult } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  getOpenCodeDatabasePath,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const PROVIDER = 'opencode';

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const openOpenCodeDatabase = (): Database.Database | null => {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

/**
 * Groups the text of every compaction-summary message, keyed by message id.
 *
 * OpenCode marks the assistant message that *is* a compaction summary with
 * `summary: true` (distinct from the `summary: {diffs: […]}` object it hangs on
 * ordinary user turns — hence the strict comparison). The text can be split
 * across parts, and the parts arrive as separate joined rows, so they are
 * gathered in one pass before normalization decides what to emit.
 */
const collectOpenCodeCompactSummaries = (rows: OpenCodeHistoryRow[]): Map<string, string> => {
  const partsByMessage = new Map<string, string[]>();

  for (const row of rows) {
    const messageInfo = readJsonRecord(row.message_data);
    if (messageInfo?.summary !== true) {
      continue;
    }

    const parts = partsByMessage.get(row.message_id) ?? [];
    const partData = readJsonRecord(row.part_data);
    if (readOptionalString(partData?.type) === 'text') {
      const text = extractText(partData);
      if (text.trim()) {
        parts.push(text);
      }
    }
    partsByMessage.set(row.message_id, parts);
  }

  return new Map([...partsByMessage].map(([messageId, parts]) => [messageId, parts.join('\n\n')]));
};

/**
 * Renders an OpenCode `error` event into one readable line.
 *
 * OpenCode does not send a flat string: a failed run emits
 * `{"type":"error","error":{"name":"UnknownError","data":{"message":"…","ref":"err_…"}}}`.
 * Reading only `raw.error`/`raw.message` as strings therefore threw away the
 * whole payload and left the chat showing a bare "Unknown OpenCode error" —
 * which is what a run against a model the server no longer serves looked like.
 * The `ref` is kept because it is the id to grep for in OpenCode's own log.
 */
const formatOpenCodeError = (raw: AnyRecord): string => {
  const flat = readOptionalString(raw.error) ?? readOptionalString(raw.message);
  if (flat) {
    return flat;
  }

  const error = readObjectRecord(raw.error);
  const data = readObjectRecord(error?.data);
  const name = readOptionalString(error?.name);
  const message = readOptionalString(data?.message)
    ?? readOptionalString(error?.message)
    ?? readOptionalString(data?.error);
  const ref = readOptionalString(data?.ref);

  const detail = [name, message].filter(Boolean).join(': ');
  if (!detail) {
    return 'Unknown OpenCode error';
  }

  return ref ? `${detail} (ref ${ref})` : detail;
};

/**
 * Unwraps the `part` envelope every streamed OpenCode event carries.
 *
 * `opencode run --format json` prints `{type, timestamp, sessionID, part}` for
 * text, reasoning, tool and step events — only `error` is flat. Reading the
 * payload off the event itself found nothing, so tool calls arrived as a
 * nameless "Tool" with `{}` for input and no result, and streamed text and
 * reasoning were dropped entirely. Falling back to the event keeps flat
 * payloads working.
 */
const readEventPart = (raw: AnyRecord): AnyRecord => readObjectRecord(raw.part) ?? raw;

type ToolMessageMeta = {
  id: string;
  sessionId: string | null;
  timestamp: string;
  toolIdFallback: string;
};

/**
 * Builds a tool message from an OpenCode `tool` part.
 *
 * Shared by the live stream and the history reader because both are handed the
 * same part shape — the two diverged once already, and only the history side
 * knew that name, input and output live under `part`/`part.state`.
 */
const buildToolUseMessage = (part: AnyRecord, meta: ToolMessageMeta): NormalizedMessage => {
  const state = readObjectRecord(part.state) ?? {};
  const status = readOptionalString(state.status);
  const output = state.output ?? part.output;
  const error = state.error ?? part.error;

  const message = createNormalizedMessage({
    id: meta.id,
    sessionId: meta.sessionId,
    timestamp: meta.timestamp,
    provider: PROVIDER,
    kind: 'tool_use',
    toolName: readOptionalString(part.tool) ?? readOptionalString(part.name) ?? 'Tool',
    toolInput: state.input ?? part.input ?? part.arguments ?? {},
    toolId: readOptionalString(part.callID) ?? readOptionalString(part.toolCallId) ?? meta.toolIdFallback,
  });

  // A part that reports its status is authoritative: a running tool has no
  // result yet even if it already carries partial output.
  const hasResult = status
    ? status === 'completed' || status === 'error'
    : output !== undefined || error !== undefined;
  if (hasResult) {
    const isError = status === 'error' || (!status && error !== undefined);
    const resultValue = isError ? error ?? output : output ?? error;
    const images = extractToolResultImages(resultValue);
    message.toolResult = {
      content: formatToolContent(resultValue),
      isError,
      ...(images ? { images } : {}),
    };
  }

  return message;
};

const hasUserRole = (value: unknown): boolean => {
  const record = readObjectRecord(value);
  return readOptionalString(record?.role) === 'user';
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
};

const buildTokenUsage = (totals: OpenCodeTokenTotals | undefined): AnyRecord | undefined => {
  if (!totals) {
    return undefined;
  }

  const inputTokens = totals.inputTokens;
  const displayInputTokens = inputTokens + totals.cacheReadTokens;
  const outputTokens = totals.outputTokens;
  const used = inputTokens
    + outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens: displayInputTokens,
    outputTokens,
    breakdown: {
      input: displayInputTokens,
      output: outputTokens,
    },
  };
};

const readOpenCodeSessionColumnTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return undefined;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM session
    WHERE id = ?
  `).get(sessionId) as OpenCodeTokenTotals | undefined;

  if (!row) {
    return undefined;
  }

  return buildTokenUsage({
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
  });
};

/**
 * OpenCode stores per-message token counts on assistant `message.data` objects
 * (see MessageV2.Assistant). Older DBs also had session-level counters; this
 * matches current `opencode.db` layouts that only persist message JSON.
 */
const aggregateOpenCodeSessionTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionColumnUsage = readOpenCodeSessionColumnTokenUsage(db, sessionId);
  if (sessionColumnUsage) {
    return sessionColumnUsage;
  }

  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(info?.tokens);
    if (!tokens) {
      continue;
    }

    inputTokens += Number(tokens.input ?? 0);
    outputTokens += Number(tokens.output ?? 0);
    reasoningTokens += Number(tokens.reasoning ?? 0);
    const cache = readObjectRecord(tokens.cache);
    cacheReadTokens += Number(cache?.read ?? 0);
    cacheWriteTokens += Number(cache?.write ?? 0);
  }

  return buildTokenUsage({
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
};

export class OpenCodeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live `opencode run --format json` events into frontend messages.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const part = readEventPart(raw);
    const eventSessionId = readOptionalString(raw.sessionID)
      ?? readOptionalString(raw.sessionId)
      ?? readOptionalString(part.sessionID)
      ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const baseId = readOptionalString(raw.id)
      ?? readOptionalString(part.id)
      ?? readOptionalString(raw.messageID)
      ?? readOptionalString(part.messageID)
      ?? generateMessageId('opencode');

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw)) {
        return [];
      }

      const content = extractText(part.text ?? part.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content,
      })];
    }

    if (type === 'reasoning') {
      const content = extractText(part.text ?? part.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      return [buildToolUseMessage(part, {
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        toolIdFallback: baseId,
      })];
    }

    if (type === 'error') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: formatOpenCodeError(raw),
      })];
    }

    if (type === 'step_finish') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history from the shared SQLite session database.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // OpenCode's shared sqlite database keys messages by the provider-native
    // session id, not the app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openOpenCodeDatabase();
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const rows = db.prepare(`
        SELECT
          m.id AS message_id,
          m.time_created AS message_time_created,
          m.data AS message_data,
          p.id AS part_id,
          p.time_created AS part_time_created,
          p.data AS part_data
        FROM message m
        LEFT JOIN part p
          ON p.session_id = m.session_id
         AND p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY
          COALESCE(m.time_created, 0),
          m.id,
          COALESCE(p.time_created, 0),
          p.id
      `).all(providerSessionId) as OpenCodeHistoryRow[];

      const normalized = this.normalizeHistoryRows(rows, sessionId);
      const tokenUsage = aggregateOpenCodeSessionTokenUsage(db, providerSessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  private normalizeHistoryRows(rows: OpenCodeHistoryRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();
    const compactSummaries = collectOpenCodeCompactSummaries(rows);
    const emittedCompactBoundaries = new Set<string>();

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);

      // The message OpenCode compacted the conversation into. It reads like an
      // assistant answer but is really a context reset, so it collapses to one
      // boundary marker for the whole message rather than a bubble per part.
      if (compactSummaries.has(row.message_id)) {
        if (!emittedCompactBoundaries.has(row.message_id)) {
          emittedCompactBoundaries.add(row.message_id);
          normalized.push(createCompactBoundaryMessage({
            id: `${row.message_id}_compact`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            summary: compactSummaries.get(row.message_id),
          }));
        }
        continue;
      }

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        normalized.push(createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      if (!row.part_id) {
        continue;
      }

      const partData = readJsonRecord(row.part_data) ?? {};
      const partType = readOptionalString(partData.type);
      if (!partType) {
        continue;
      }

      if (partType === 'text') {
        const rawContent = extractText(partData);
        // User prompts sent with attachments carry an <images_input> path
        // list; strip it for display and surface the paths as images.
        const parsedImages = messageRole === 'user'
          ? parseImagesInputTag(rawContent)
          : { text: rawContent, attachments: [] };
        const parsedFiles = messageRole === 'user'
          ? parseFilesInputTag(parsedImages.text)
          : { text: rawContent, attachments: [] };
        if (
          parsedFiles.text.trim()
          || parsedImages.attachments.length > 0
          || parsedFiles.attachments.length > 0
        ) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            uuid: messageRole === 'user' ? row.message_id : undefined,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content: parsedFiles.text,
            images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
        continue;
      }

      if (partType === 'reasoning') {
        const content = extractText(partData);
        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          }));
        }
        continue;
      }

      if (partType === 'tool') {
        normalized.push(buildToolUseMessage(partData, {
          id: baseId,
          sessionId,
          timestamp,
          toolIdFallback: row.part_id,
        }));
        continue;
      }

      if (partType === 'step-finish') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
        continue;
      }

      if (partType === 'patch' || partType === 'agent') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: partType === 'patch' ? 'Patch' : 'Agent',
          toolInput: partData,
          toolId: row.part_id,
        }));
      }
    }

    return normalized;
  }

  /**
   * Erases one session from `opencode.db`.
   *
   * OpenCode keeps every session in one shared database, so a permanent delete
   * in the app used to leave the conversation behind: it stayed resumable
   * through `opencode --session`, and the synchronizer imported it back into
   * the sidebar on the next scan. The `part`/`message` rows are removed
   * explicitly rather than left to `ON DELETE CASCADE`, which only fires while
   * `PRAGMA foreign_keys` is on; the remaining per-session tables
   * (`session_input`, `todo`, …) do cascade off the `session` row.
   */
  async deleteSession(providerSessionId: string): Promise<boolean> {
    const dbPath = getOpenCodeDatabasePath();
    if (!fsSync.existsSync(dbPath)) {
      return false;
    }

    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.pragma('foreign_keys = ON');
      const remove = db.transaction((sessionId: string) => {
        db.prepare('DELETE FROM part WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM message WHERE session_id = ?').run(sessionId);
        return db.prepare('DELETE FROM session WHERE id = ?').run(sessionId).changes;
      });

      return remove(providerSessionId) > 0;
    } catch (error) {
      console.warn(`[OpenCodeProvider] Failed to delete session ${providerSessionId}:`, error);
      return false;
    } finally {
      db.close();
    }
  }

  /**
   * Rewinds an OpenCode session by deleting every `message` (and its `part`
   * rows) at or after the anchor message, in the same `(time_created, id)` order
   * the history reader uses. Resuming `opencode run --session <id>` then reads
   * the truncated history and continues in-place.
   *
   * If nothing resumable precedes the anchor (it was the first user turn) the
   * rows are left intact and `startFresh` is returned so the caller starts a new
   * session instead.
   */
  async rewindHistory(sessionId: string, messageUuid: string): Promise<RewindResult> {
    const dbPath = getOpenCodeDatabasePath();
    if (!fsSync.existsSync(dbPath)) {
      return { ok: false, startFresh: false, removed: 0 };
    }

    const db = new Database(dbPath, { fileMustExist: true });
    try {
      const edited = db
        .prepare('SELECT id, time_created FROM message WHERE id = ? AND session_id = ?')
        .get(messageUuid, sessionId) as { id: string; time_created: number | null } | undefined;
      if (!edited) {
        return { ok: false, startFresh: false, removed: 0 };
      }

      const editedTime = edited.time_created ?? 0;

      // Count user turns strictly before the anchor in (time_created, id) order.
      const priorRows = db
        .prepare(
          'SELECT data FROM message WHERE session_id = ? AND (COALESCE(time_created, 0) < ? OR (COALESCE(time_created, 0) = ? AND id < ?))',
        )
        .all(sessionId, editedTime, editedTime, edited.id) as Array<{ data: string | null }>;
      let priorUserTurns = 0;
      for (const row of priorRows) {
        const info = readJsonRecord(row.data);
        if (readOptionalString(info?.role) === 'user') {
          priorUserTurns += 1;
        }
      }

      // Messages at or after the anchor (inclusive).
      const condition = '(COALESCE(time_created, 0) > ? OR (COALESCE(time_created, 0) = ? AND id >= ?))';
      const toRemove = db
        .prepare(`SELECT id FROM message WHERE session_id = ? AND ${condition}`)
        .all(sessionId, editedTime, editedTime, edited.id) as Array<{ id: string }>;
      const removed = toRemove.length;

      if (priorUserTurns === 0) {
        // Nothing resumable precedes the anchor — leave history intact; the caller
        // starts a brand-new session.
        return { ok: true, startFresh: true, removed };
      }

      const delParts = db.prepare('DELETE FROM part WHERE session_id = ? AND message_id = ?');
      const delMessage = db.prepare('DELETE FROM message WHERE session_id = ? AND id = ?');
      const truncate = db.transaction((ids: string[]) => {
        for (const id of ids) {
          delParts.run(sessionId, id);
          delMessage.run(sessionId, id);
        }
      });
      truncate(toRemove.map((row) => row.id));

      return { ok: true, startFresh: false, removed };
    } catch (error) {
      console.warn(`[OpenCodeProvider] Failed to rewind session ${sessionId}:`, error);
      return { ok: false, startFresh: false, removed: 0 };
    } finally {
      db.close();
    }
  }
}
