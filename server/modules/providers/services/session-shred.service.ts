import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { findCodexRolloutPath } from '@/shared/codex-plan-ledger.js';
import { getDataDir } from '@/shared/utils.js';

/**
 * Shredding a session.
 *
 * Deleting a session in VibeSpace normally removes VibeSpace's row and, for a
 * force-delete, the transcript file it indexed. The harness that ran the
 * session keeps a good deal more than that — Claude Code its task ledger,
 * subagent transcripts and per-session caches; Codex its rollout and state
 * rows; OpenCode its database rows and spilled tool output — and a user who
 * wants a conversation gone wants those gone too.
 *
 * THE ONE RULE: everything here is keyed on the session's own ids. A path is a
 * candidate only because the session id is in its name, a row only because a
 * column holding session/thread ids equals the session id, and the column is
 * confirmed against the live schema before any statement runs. Nothing is
 * selected by age, by project, by "looks related". Anything that cannot be
 * attributed to the session with certainty is left alone and REPORTED as not
 * removed, with the reason — including the things nobody can remove from
 * here (other transcripts that mention this one, provider-side logs, backups).
 *
 * `plan` is pure: it lists what `execute` would do. `execute` performs the
 * plan and returns the report. Both take the session row, and both accept the
 * same `ShredRoots` override so tests can point them at a fake home.
 */

export type Harness = 'claude' | 'codex' | 'opencode' | 'vibespace';

export type ShredItemKind =
  | 'file'
  | 'directory'
  | 'db-rows'
  | 'file-entries'
  | 'registry-entry'
  | 'vibespace-row';

export type ShredPlanItem = {
  harness: Harness;
  kind: ShredItemKind;
  /** A path, or a `<db>: <table> rows where <col> = <id>` spec. */
  what: string;
  willDelete: boolean;
  /** Why it is left alone. Present iff `willDelete` is false. */
  reason?: string;
  /** Performs the deletion. Present iff `willDelete` is true. */
  run?: () => Promise<void>;
};

export type ShredReport = {
  sessionId: string;
  provider: string;
  providerSessionId: string | null;
  deleted: Array<{ harness: Harness; kind: ShredItemKind; what: string }>;
  notRemoved: Array<{ harness: Harness; what: string; reason: string }>;
};

export type ShredRoots = {
  /** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeDir: string;
  /** `$CODEX_HOME`, else `~/.codex`. */
  codexHome: string;
  /** `~/.local/share/opencode`. */
  opencodeDataDir: string;
  /** VibeSpace's own data dir (where auth.db lives). */
  vibespaceDataDir: string;
};

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

/**
 * The legacy runtime registries (`server/services/*`) sit outside the module
 * graph, so the boot sequence hands their hooks in rather than this module
 * importing them. Each hook removes ONE session's entry by its id and
 * flushes the file. Until registration, those registries are reported as not
 * removed rather than silently skipped.
 */
export type SessionShredDependencies = {
  /** Restore-on-boot registry (`active-claude-sessions.json`), by Claude provider id. */
  forgetRestoreEntry?: (sessionId: string) => Promise<boolean>;
  /** Usage-limit wake registry (`rate-limited-sessions.json`), by provider session id. */
  forgetRateLimitWake?: (providerSessionId: string) => Promise<boolean>;
  /** Drops a pending recap timer for the id (app or provider), so none lands after the row is gone. */
  cancelSessionRecap?: (sessionId: string) => void;
};

let dependencies: SessionShredDependencies = {};

export function registerSessionShredDependencies(next: SessionShredDependencies): void {
  dependencies = { ...dependencies, ...next };
}

/** Test seam. */
export function __resetSessionShredDependencies(): void {
  dependencies = {};
}

const SQLITE_BUSY_RETRY_DELAYS_MS = [100, 300, 900];

const FIXED_CAVEATS: Array<{ harness: Harness; what: string; reason: string }> = [
  {
    harness: 'vibespace',
    what: "other sessions' transcripts that mention this one",
    reason: 'another session may have quoted this one (a resume, a subagent, a paste); those transcripts are theirs and are not touched',
  },
  {
    harness: 'vibespace',
    what: 'provider-side logs',
    reason: 'whatever the model provider retained server-side is outside this machine',
  },
  {
    harness: 'vibespace',
    what: 'Time Machine backups',
    reason: 'backups and snapshots taken while the session existed still hold it',
  },
];

export function defaultShredRoots(): ShredRoots {
  const home = os.homedir();
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  const codexHome = process.env.CODEX_HOME?.trim();
  return {
    claudeDir: claudeConfigDir || path.join(home, '.claude'),
    codexHome: codexHome || path.join(home, '.codex'),
    opencodeDataDir: path.join(home, '.local', 'share', 'opencode'),
    vibespaceDataDir: getDataDir(),
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function isSafeId(id: string): boolean {
  // Session ids are UUIDs (Claude, Codex) or `ses_…` tokens (OpenCode). A
  // separator or a dot would let an id reach outside its own entry.
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function existsSync(target: string): 'file' | 'directory' | null {
  try {
    const stat = fsSync.lstatSync(target);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return null;
  } catch {
    return null;
  }
}

function fileItem(harness: Harness, target: string): ShredPlanItem | null {
  const kind = existsSync(target);
  if (kind !== 'file') return null;
  return {
    harness,
    kind: 'file',
    what: target,
    willDelete: true,
    run: () => fsp.unlink(target),
  };
}

function directoryItem(harness: Harness, target: string): ShredPlanItem | null {
  const kind = existsSync(target);
  if (kind !== 'directory') return null;
  return {
    harness,
    kind: 'directory',
    what: target,
    willDelete: true,
    run: () => fsp.rm(target, { recursive: true, force: true }),
  };
}

function listDirSafe(dir: string): string[] {
  try {
    return fsSync.readdirSync(dir);
  } catch {
    return [];
  }
}

function listDirsSafe(dir: string): string[] {
  try {
    return fsSync
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * A JSONL file shared across sessions where each line carries the session id
 * (Claude's `history.jsonl`). Only the lines whose `sessionId` equals the id
 * are dropped; every other line is written back byte-for-byte.
 */
function jsonlEntriesItem(harness: Harness, file: string, id: string): ShredPlanItem | null {
  if (existsSync(file) !== 'file') return null;
  let lines: string[];
  try {
    lines = fsSync.readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  const matches = lines.filter((line) => {
    if (!line.includes(id)) return false;
    try {
      return JSON.parse(line)?.sessionId === id;
    } catch {
      return false;
    }
  });
  if (matches.length === 0) return null;
  return {
    harness,
    kind: 'file-entries',
    what: `${file}: ${matches.length} entr${matches.length === 1 ? 'y' : 'ies'} with sessionId = ${id}`,
    willDelete: true,
    run: async () => {
      // Re-read at execution time: the harness may have appended since the plan.
      const current = (await fsp.readFile(file, 'utf8')).split('\n');
      const kept = current.filter((line) => {
        if (!line.includes(id)) return true;
        try {
          return JSON.parse(line)?.sessionId !== id;
        } catch {
          return true;
        }
      });
      const tmp = `${file}.shred-tmp`;
      await fsp.writeFile(tmp, kept.join('\n'), 'utf8');
      await fsp.rename(tmp, file);
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

type SqliteColumnCheck = {
  table: string;
  column: string;
  /** Extra tables expected to go with the row through ON DELETE CASCADE. */
  cascades?: string[];
};

function isBusyError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens a database read-write for one short transaction, retrying on
 * SQLITE_BUSY with backoff. Throws the last error when the lock never clears;
 * the caller turns that into a "not removed: database locked" entry.
 */
async function withSqlite<T>(dbPath: string, work: (db: Database.Database) => T): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_DELAYS_MS.length; attempt += 1) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { fileMustExist: true, timeout: 50 });
      db.pragma('foreign_keys = ON');
      return work(db);
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === SQLITE_BUSY_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(SQLITE_BUSY_RETRY_DELAYS_MS[attempt]);
    } finally {
      db?.close();
    }
  }
  throw lastError;
}

function tableColumns(db: Database.Database, table: string): Set<string> | null {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return null;
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function countRows(db: Database.Database, table: string, column: string, id: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`)
    .get(id) as { n: number };
  return Number(row?.n ?? 0);
}

/**
 * Plans row deletions in one SQLite file. Each `(table, column)` pair is
 * confirmed against the live schema: a table that is missing is skipped
 * silently (an older harness simply does not have it), a table that exists
 * but lacks the column is reported as not removed. Rows are counted at plan
 * time so the report says how many went.
 */
async function sqliteRowsItems(
  harness: Harness,
  dbPath: string,
  id: string,
  checks: SqliteColumnCheck[],
): Promise<ShredPlanItem[]> {
  if (existsSync(dbPath) !== 'file') return [];
  const label = path.basename(dbPath);
  const items: ShredPlanItem[] = [];

  let confirmed: Array<SqliteColumnCheck & { count: number }>;
  try {
    confirmed = await withSqlite(dbPath, (db) => {
      const out: Array<SqliteColumnCheck & { count: number }> = [];
      for (const check of checks) {
        const columns = tableColumns(db, check.table);
        if (!columns) continue;
        if (!columns.has(check.column)) {
          items.push({
            harness,
            kind: 'db-rows',
            what: `${label}: ${check.table}`,
            willDelete: false,
            reason: `no session-keyed column (expected "${check.column}")`,
          });
          continue;
        }
        out.push({ ...check, count: countRows(db, check.table, check.column, id) });
      }
      return out;
    });
  } catch (error) {
    const reason = isBusyError(error) ? 'database locked' : `could not be read: ${(error as Error).message}`;
    return [
      ...checks.map((check) => ({
        harness,
        kind: 'db-rows' as const,
        what: `${label}: ${check.table} rows where ${check.column} = ${id}`,
        willDelete: false,
        reason,
      })),
    ];
  }

  const present = confirmed.filter((check) => check.count > 0);
  if (present.length === 0) return items;

  for (const check of present) {
    const cascade = check.cascades?.length ? ` (cascades to ${check.cascades.join(', ')})` : '';
    items.push({
      harness,
      kind: 'db-rows',
      what: `${label}: ${check.count} ${check.table} row${check.count === 1 ? '' : 's'} where ${check.column} = ${id}${cascade}`,
      willDelete: true,
      run: () =>
        withSqlite(dbPath, (db) => {
          db.prepare(`DELETE FROM "${check.table}" WHERE "${check.column}" = ?`).run(id);
        }),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/**
 * Everything Claude Code keeps under its config dir that carries the session
 * id in its name, plus the transcript VibeSpace indexed. The transcript's
 * sibling directory `<dir>/<id>/` holds subagent transcripts and spilled tool
 * results for the same session.
 */
function planClaude(row: SessionRow, id: string, roots: ShredRoots): ShredPlanItem[] {
  const items: ShredPlanItem[] = [];
  const dir = roots.claudeDir;
  const push = (item: ShredPlanItem | null) => {
    if (item) items.push(item);
  };

  // The transcript. The row's path is trusted only when it is this session's
  // own file — the name must be the id — otherwise it is reported, not removed.
  const transcriptPaths = new Set<string>();
  if (row.jsonl_path) {
    if (path.basename(row.jsonl_path) === `${id}.jsonl`) {
      transcriptPaths.add(row.jsonl_path);
    } else if (existsSync(row.jsonl_path)) {
      items.push({
        harness: 'claude',
        kind: 'file',
        what: row.jsonl_path,
        willDelete: false,
        reason: `indexed transcript path is not named after the session id ${id}`,
      });
    }
  }
  for (const project of listDirsSafe(path.join(dir, 'projects'))) {
    transcriptPaths.add(path.join(dir, 'projects', project, `${id}.jsonl`));
  }
  for (const transcript of transcriptPaths) {
    push(fileItem('claude', transcript));
    push(directoryItem('claude', path.join(path.dirname(transcript), id)));
  }

  push(directoryItem('claude', path.join(dir, 'tasks', id)));
  push(fileItem('claude', path.join(dir, 'debug', `${id}.txt`)));
  push(directoryItem('claude', path.join(dir, 'file-history', id)));
  push(directoryItem('claude', path.join(dir, 'session-env', id)));
  push(directoryItem('claude', path.join(dir, 'uploads', id)));
  for (const name of listDirSafe(path.join(dir, 'telemetry'))) {
    if (name.includes(`.${id}.`)) push(fileItem('claude', path.join(dir, 'telemetry', name)));
  }
  push(jsonlEntriesItem('claude', path.join(dir, 'history.jsonl'), id));

  // sessions/*.json are per-process lock files; one referring to this session
  // by id belongs to it.
  for (const name of listDirSafe(path.join(dir, 'sessions'))) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, 'sessions', name);
    try {
      if (fsSync.readFileSync(file, 'utf8').includes(id)) push(fileItem('claude', file));
    } catch {
      // Unreadable: not ours to decide about.
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

async function planCodex(id: string, roots: ShredRoots): Promise<ShredPlanItem[]> {
  const items: ShredPlanItem[] = [];
  const home = roots.codexHome;
  const push = (item: ShredPlanItem | null) => {
    if (item) items.push(item);
  };

  const rollout = findCodexRolloutPath(id, path.join(home, 'sessions')) as string | null;
  if (rollout) push(fileItem('codex', rollout));

  for (const name of listDirSafe(path.join(home, 'shell_snapshots'))) {
    if (name.startsWith(`${id}.`)) push(fileItem('codex', path.join(home, 'shell_snapshots', name)));
  }

  items.push(
    ...(await sqliteRowsItems('codex', path.join(home, 'state_5.sqlite'), id, [
      { table: 'threads', column: 'id', cascades: ['thread_dynamic_tools'] },
      { table: 'thread_spawn_edges', column: 'child_thread_id' },
      { table: 'thread_spawn_edges', column: 'parent_thread_id' },
    ])),
    ...(await sqliteRowsItems('codex', path.join(home, 'logs_2.sqlite'), id, [
      { table: 'logs', column: 'thread_id' },
    ])),
    ...(await sqliteRowsItems('codex', path.join(home, 'goals_1.sqlite'), id, [
      { table: 'thread_goals', column: 'thread_id', cascades: ['thread_goal_continuation_deferrals'] },
    ])),
  );

  const memories = path.join(home, 'memories_1.sqlite');
  if (existsSync(memories)) {
    items.push({
      harness: 'codex',
      kind: 'db-rows',
      what: memories,
      willDelete: false,
      reason: 'Codex memories are not keyed by session',
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

const TOOL_OUTPUT_REF = /tool-output[\\/](tool_[A-Za-z0-9_-]+)/g;

type OpenCodeScan = {
  /** The session and every descendant (`parent_id` chain) — all its own. */
  ids: string[];
  toolOutputNames: Set<string>;
  /** table -> rows matched across `ids`; tables confirmed against the schema. */
  rowCounts: Array<{ table: string; column: string; count: number }>;
  unkeyed: string[];
};

function scanOpenCode(db: Database.Database, id: string): OpenCodeScan {
  const sessionColumns = tableColumns(db, 'session');
  const ids = [id];
  if (sessionColumns?.has('parent_id') && sessionColumns.has('id')) {
    const children = db.prepare('SELECT id FROM "session" WHERE parent_id = ?');
    for (let i = 0; i < ids.length; i += 1) {
      for (const child of children.all(ids[i]) as Array<{ id: string }>) {
        if (!ids.includes(child.id)) ids.push(child.id);
      }
    }
  }

  const toolOutputNames = new Set<string>();
  const partColumns = tableColumns(db, 'part');
  if (partColumns?.has('session_id') && partColumns.has('data')) {
    const parts = db.prepare('SELECT data FROM "part" WHERE session_id = ?');
    for (const sessionId of ids) {
      for (const part of parts.all(sessionId) as Array<{ data: string }>) {
        for (const match of String(part.data ?? '').matchAll(TOOL_OUTPUT_REF)) {
          toolOutputNames.add(match[1]);
        }
      }
    }
  }

  // Child tables first, `session` last: the row order the deletes run in.
  const checks: SqliteColumnCheck[] = [
    { table: 'part', column: 'session_id' },
    { table: 'message', column: 'session_id' },
    { table: 'session_message', column: 'session_id' },
    { table: 'session_input', column: 'session_id' },
    { table: 'session_share', column: 'session_id' },
    { table: 'session_context_epoch', column: 'session_id' },
    { table: 'todo', column: 'session_id' },
    { table: 'session', column: 'id' },
  ];
  const rowCounts: OpenCodeScan['rowCounts'] = [];
  const unkeyed: string[] = [];
  for (const check of checks) {
    const columns = tableColumns(db, check.table);
    if (!columns) continue;
    if (!columns.has(check.column)) {
      unkeyed.push(check.table);
      continue;
    }
    let count = 0;
    for (const sessionId of ids) count += countRows(db, check.table, check.column, sessionId);
    rowCounts.push({ table: check.table, column: check.column, count });
  }

  return { ids, toolOutputNames, rowCounts, unkeyed };
}

async function planOpenCode(id: string, roots: ShredRoots): Promise<ShredPlanItem[]> {
  const items: ShredPlanItem[] = [];
  const dataDir = roots.opencodeDataDir;
  const dbPath = path.join(dataDir, 'opencode.db');
  const push = (item: ShredPlanItem | null) => {
    if (item) items.push(item);
  };

  let scan: OpenCodeScan | null = null;
  if (existsSync(dbPath) === 'file') {
    try {
      scan = await withSqlite(dbPath, (db) => scanOpenCode(db, id));
    } catch (error) {
      items.push({
        harness: 'opencode',
        kind: 'db-rows',
        what: `${dbPath}: rows for session ${id}`,
        willDelete: false,
        reason: isBusyError(error) ? 'database locked' : `could not be read: ${(error as Error).message}`,
      });
    }
  }

  if (scan) {
    for (const table of scan.unkeyed) {
      items.push({
        harness: 'opencode',
        kind: 'db-rows',
        what: `${dbPath}: ${table}`,
        willDelete: false,
        reason: 'no session-keyed column',
      });
    }

    const present = scan.rowCounts.filter((entry) => entry.count > 0);
    if (present.length > 0) {
      const ids = scan.ids;
      const idLabel = ids.length > 1 ? `${id} and ${ids.length - 1} child session${ids.length > 2 ? 's' : ''}` : id;
      const summary = present.map((entry) => `${entry.count} ${entry.table}`).join(', ');
      items.push({
        harness: 'opencode',
        kind: 'db-rows',
        what: `${dbPath}: ${summary} rows for ${idLabel}`,
        willDelete: true,
        run: () =>
          withSqlite(dbPath, (db) => {
            const remove = db.transaction(() => {
              for (const entry of present) {
                const statement = db.prepare(`DELETE FROM "${entry.table}" WHERE "${entry.column}" = ?`);
                for (const sessionId of ids) statement.run(sessionId);
              }
            });
            remove();
          }),
      });
    }

    // Spilled tool output: files the session's own `part` rows point at, and
    // only those that really live inside the tool-output directory.
    const toolOutputDir = path.join(dataDir, 'tool-output');
    for (const name of scan.toolOutputNames) {
      const target = path.join(toolOutputDir, name);
      if (path.dirname(target) !== toolOutputDir) continue;
      push(fileItem('opencode', target));
    }
  }

  // The pre-database JSON store, keyed by session id in its layout.
  const storage = path.join(dataDir, 'storage');
  for (const project of listDirsSafe(path.join(storage, 'session'))) {
    push(fileItem('opencode', path.join(storage, 'session', project, `${id}.json`)));
  }
  const messageDir = path.join(storage, 'message', id);
  for (const name of listDirSafe(messageDir)) {
    const messageId = name.replace(/\.json$/, '');
    if (messageId && isSafeId(messageId)) push(directoryItem('opencode', path.join(storage, 'part', messageId)));
  }
  push(directoryItem('opencode', messageDir));
  push(fileItem('opencode', path.join(storage, 'session_diff', `${id}.json`)));

  const snapshots = path.join(dataDir, 'snapshot');
  if (existsSync(snapshots) === 'directory') {
    items.push({
      harness: 'opencode',
      kind: 'directory',
      what: snapshots,
      willDelete: false,
      reason: 'OpenCode snapshots are keyed by project, not by session — no safe mapping',
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// VibeSpace
// ---------------------------------------------------------------------------

function planVibespace(row: SessionRow, roots: ShredRoots): ShredPlanItem[] {
  const items: ShredPlanItem[] = [];
  const ids = [row.session_id, row.provider_session_id].filter((value): value is string => Boolean(value));

  // The restore-on-boot registry is keyed by the Claude provider id.
  const registry = path.join(roots.vibespaceDataDir, 'active-claude-sessions.json');
  if (row.provider === 'claude' && existsSync(registry) === 'file') {
    let referenced = false;
    try {
      const raw = JSON.parse(fsSync.readFileSync(registry, 'utf8'));
      referenced = Array.isArray(raw) && raw.some((entry) => entry && ids.includes(entry.sessionId));
    } catch {
      referenced = false;
    }
    if (referenced) {
      const forget = dependencies.forgetRestoreEntry;
      items.push(forget
        ? {
          harness: 'vibespace',
          kind: 'registry-entry',
          what: `${registry}: entry for ${row.provider_session_id ?? row.session_id}`,
          willDelete: true,
          run: async () => {
            for (const id of ids) await forget(id);
          },
        }
        : {
          harness: 'vibespace',
          kind: 'registry-entry',
          what: `${registry}: entry for ${row.provider_session_id ?? row.session_id}`,
          willDelete: false,
          reason: 'restore registry hook not registered in this process',
        });
    }
  }

  // The usage-limit wake registry is keyed by provider session id (any provider).
  const wakeRegistry = path.join(roots.vibespaceDataDir, 'rate-limited-sessions.json');
  if (existsSync(wakeRegistry) === 'file') {
    let referenced = false;
    try {
      const raw = JSON.parse(fsSync.readFileSync(wakeRegistry, 'utf8'));
      referenced = Array.isArray(raw) && raw.some((entry) => entry && ids.includes(entry.providerSessionId));
    } catch {
      referenced = false;
    }
    if (referenced) {
      const forget = dependencies.forgetRateLimitWake;
      items.push(forget
        ? {
          harness: 'vibespace',
          kind: 'registry-entry',
          what: `${wakeRegistry}: entry for ${row.provider_session_id ?? row.session_id}`,
          willDelete: true,
          run: async () => {
            for (const id of ids) await forget(id);
          },
        }
        : {
          harness: 'vibespace',
          kind: 'registry-entry',
          what: `${wakeRegistry}: entry for ${row.provider_session_id ?? row.session_id}`,
          willDelete: false,
          reason: 'rate-limit wake registry hook not registered in this process',
        });
    }
  }

  // Per-session resume-model overrides, keyed `<provider>:<session id>`.
  const modelChanges = path.join(roots.vibespaceDataDir, 'provider-session-active-model-changes.json');
  if (existsSync(modelChanges) === 'file') {
    const keys = ids.map((id) => `${row.provider}:${id}`);
    let present: string[] = [];
    try {
      const entries = JSON.parse(fsSync.readFileSync(modelChanges, 'utf8'))?.entries ?? {};
      present = keys.filter((key) => Object.prototype.hasOwnProperty.call(entries, key));
    } catch {
      present = [];
    }
    if (present.length > 0) {
      items.push({
        harness: 'vibespace',
        kind: 'file-entries',
        what: `${modelChanges}: ${present.join(', ')}`,
        willDelete: true,
        run: async () => {
          const parsed = JSON.parse(await fsp.readFile(modelChanges, 'utf8'));
          for (const key of present) delete parsed?.entries?.[key];
          const tmp = `${modelChanges}.shred-tmp`;
          await fsp.writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
          await fsp.rename(tmp, modelChanges);
        },
      });
    }
  }

  // The row itself goes last, so a failure anywhere above leaves a session the
  // user can still see and retry.
  items.push({
    harness: 'vibespace',
    kind: 'vibespace-row',
    what: `sessions row ${row.session_id} (title, recap, transcript path)`,
    willDelete: true,
    run: async () => {
      // A recap timer armed before the delete would otherwise write a
      // summary of the conversation back into a row that no longer exists
      // — or, worse, into a re-created one.
      for (const id of ids) dependencies.cancelSessionRecap?.(id);
      sessionsDb.deleteSessionById(row.session_id);
    },
  });

  return items;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const sessionShredService = {
  /**
   * Lists what `execute` would remove and what it would leave, and why.
   *
   * The harness-side entries need the provider-native id; an app session
   * that never produced one (no turn ever ran) has nothing on the harness
   * side to shred and says so.
   */
  async plan(row: SessionRow, roots: ShredRoots = defaultShredRoots()): Promise<ShredPlanItem[]> {
    const items: ShredPlanItem[] = [];
    const providerId = row.provider_session_id;
    const harness = row.provider as Harness;

    if (!providerId) {
      items.push({
        harness,
        kind: 'file',
        what: `${row.provider} records for ${row.session_id}`,
        willDelete: false,
        reason: 'the session never produced a provider session id, so the harness has nothing keyed to it',
      });
    } else if (!isSafeId(providerId)) {
      items.push({
        harness,
        kind: 'file',
        what: `${row.provider} records for ${providerId}`,
        willDelete: false,
        reason: 'provider session id contains characters that are not safe to use as a path or key',
      });
    } else if (row.provider === 'claude') {
      items.push(...planClaude(row, providerId, roots));
    } else if (row.provider === 'codex') {
      items.push(...(await planCodex(providerId, roots)));
    } else if (row.provider === 'opencode') {
      items.push(...(await planOpenCode(providerId, roots)));
    } else {
      items.push({
        harness,
        kind: 'file',
        what: `${row.provider} records for ${providerId}`,
        willDelete: false,
        reason: `no shred support for provider "${row.provider}"`,
      });
    }

    items.push(...planVibespace(row, roots));

    for (const caveat of FIXED_CAVEATS) {
      items.push({ ...caveat, kind: 'file', willDelete: false });
    }

    return items;
  },

  /**
   * Performs the plan. Every item is attempted even when an earlier one
   * fails; a failed deletion is reported as not removed with the error.
   */
  async execute(row: SessionRow, roots: ShredRoots = defaultShredRoots()): Promise<ShredReport> {
    const plan = await this.plan(row, roots);
    const report: ShredReport = {
      sessionId: row.session_id,
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      deleted: [],
      notRemoved: [],
    };

    for (const item of plan) {
      if (!item.willDelete || !item.run) {
        report.notRemoved.push({ harness: item.harness, what: item.what, reason: item.reason ?? 'not selected' });
        continue;
      }
      try {
        await item.run();
        report.deleted.push({ harness: item.harness, kind: item.kind, what: item.what });
      } catch (error) {
        const reason = isBusyError(error)
          ? 'database locked'
          : (error as Error)?.message || String(error);
        report.notRemoved.push({ harness: item.harness, what: item.what, reason });
      }
    }

    return report;
  },
};
