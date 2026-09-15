import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { getOpenCodeDatabasePath } from '@/shared/utils.js';

//----------------- OPENCODE SESSION TOKEN USAGE ------------

/**
 * Cumulative token spend of one OpenCode session, in the shape the chat
 * composer and the `/cost` command read. `inputTokens` includes cache reads,
 * `used` additionally counts reasoning and cache writes.
 */
export type OpenCodeTokenUsage = {
  used: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: {
    input: number;
    output: number;
  };
};

/**
 * Result of looking a session up in opencode.db. `unsupported` means the
 * database has no token store this reader understands; `missing` means the
 * session row does not exist.
 */
export type OpenCodeTokenUsageLookup =
  | { status: 'found'; usage: OpenCodeTokenUsage }
  | { status: 'missing' }
  | { status: 'unsupported' };

type OpenCodeTokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

const SESSION_TOKEN_COLUMNS = [
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
];

function readTokenNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function sumTokenTotals(totals: OpenCodeTokenTotals): number {
  return totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite;
}

function hasTable(database: Database.Database, tableName: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

/**
 * Totals `opencode run` writes onto the session row. The v2 HTTP server
 * (`opencode serve`, 1.18.x) leaves these columns at zero.
 */
function readSessionRowTotals(database: Database.Database, sessionId: string): OpenCodeTokenTotals {
  const row = database.prepare(`
    SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
    FROM session
    WHERE id = ?
  `).get(sessionId) as Record<string, unknown> | undefined;

  return {
    input: readTokenNumber(row?.tokens_input),
    output: readTokenNumber(row?.tokens_output),
    reasoning: readTokenNumber(row?.tokens_reasoning),
    cacheRead: readTokenNumber(row?.tokens_cache_read),
    cacheWrite: readTokenNumber(row?.tokens_cache_write),
  };
}

/**
 * Totals summed from the v2 event log. The HTTP server records usage only on
 * each assistant step in `session_message.data.tokens`; the legacy `message`
 * table holds a partial copy of those steps and must not be summed with it.
 */
function readEventLogTotals(database: Database.Database, sessionId: string): OpenCodeTokenTotals {
  const row = database.prepare(`
    SELECT
      SUM(json_extract(data, '$.tokens.input')) AS input,
      SUM(json_extract(data, '$.tokens.output')) AS output,
      SUM(json_extract(data, '$.tokens.reasoning')) AS reasoning,
      SUM(json_extract(data, '$.tokens.cache.read')) AS cacheRead,
      SUM(json_extract(data, '$.tokens.cache.write')) AS cacheWrite
    FROM session_message
    WHERE session_id = ? AND type = 'assistant' AND json_valid(data)
  `).get(sessionId) as Record<string, unknown> | undefined;

  return {
    input: readTokenNumber(row?.input),
    output: readTokenNumber(row?.output),
    reasoning: readTokenNumber(row?.reasoning),
    cacheRead: readTokenNumber(row?.cacheRead),
    cacheWrite: readTokenNumber(row?.cacheWrite),
  };
}

/**
 * Reads a session's cumulative token spend from an open opencode.db.
 *
 * Both transports write the same database but record usage in different
 * places, so the larger of the two sources wins. Taking the maximum rather
 * than the sum keeps the figure correct if a later OpenCode starts filling
 * the session row from the event log as well.
 *
 * Consumers: `readOpenCodeTokenUsage` below (post-turn `token_budget` for both
 * OpenCode runners) and the providers module's token-usage service (the
 * `/token-usage` endpoint behind the composer badge and `/cost`).
 */
export function lookupOpenCodeTokenUsage(
  database: Database.Database,
  sessionId: string,
): OpenCodeTokenUsageLookup {
  const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const hasSessionRowTotals = SESSION_TOKEN_COLUMNS.every((column) => columnNames.has(column));
  const hasEventLog = hasTable(database, 'session_message');
  if (!hasSessionRowTotals && !hasEventLog) {
    return { status: 'unsupported' };
  }

  if (!database.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId)) {
    return { status: 'missing' };
  }

  const candidates = [
    hasSessionRowTotals ? readSessionRowTotals(database, sessionId) : null,
    hasEventLog ? readEventLogTotals(database, sessionId) : null,
  ].filter((totals): totals is OpenCodeTokenTotals => totals !== null);
  const totals = candidates.reduce((best, current) => (
    sumTokenTotals(current) > sumTokenTotals(best) ? current : best
  ));
  const inputTokens = totals.input + totals.cacheRead;

  return {
    status: 'found',
    usage: {
      used: sumTokenTotals(totals),
      inputTokens,
      outputTokens: totals.output,
      breakdown: { input: inputTokens, output: totals.output },
    },
  };
}

/**
 * Reads a finished session's token totals out of the local opencode.db.
 *
 * OpenCode reports cumulative usage nowhere in its streamed output, so both
 * runners (`server/opencode-cli.js` and `server/services/opencode-http-runner.js`)
 * call this once a turn is over. Returns null when nothing has been spent yet
 * or the database cannot be read, so callers can fall back to a step reading.
 */
export function readOpenCodeTokenUsage(sessionId: string): OpenCodeTokenUsage | null {
  const databasePath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(databasePath)) {
    return null;
  }

  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const lookup = lookupOpenCodeTokenUsage(database, sessionId);
    return lookup.status === 'found' && lookup.usage.used > 0 ? lookup.usage : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
