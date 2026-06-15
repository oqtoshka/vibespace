import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

/**
 * Regression coverage for the subagent-transcript indexing bug.
 *
 * Claude stores Task/subagent transcripts at
 *   ~/.claude/projects/<proj>/<SESSION_UUID>/subagents/agent-<id>.jsonl
 * and those files carry the PARENT session's `sessionId` + `cwd`. The
 * synchronizer used to index them as sessions, and the
 * `ON CONFLICT(session_id) DO UPDATE SET jsonl_path` upsert then clobbered the
 * real session's pointer to aim at a subagent file — the main transcript
 * "disappeared" and the session rendered the subagent's history instead.
 *
 * These tests pin the fix: subagent files under a `subagents/` segment must
 * never be indexed, and must never overwrite the parent session's jsonl_path.
 */
async function withIsolatedHomeAndDb(
  runTest: (env: { home: string; projectsDir: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;

  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-sync-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const home = path.join(tempDirectory, 'home');
  const projectsDir = path.join(home, '.claude', 'projects');
  await mkdir(projectsDir, { recursive: true });
  // buildLookupMap reads ~/.claude/history.jsonl; provide an empty one so the
  // lookup is a clean no-op rather than relying on missing-file tolerance.
  await writeFile(path.join(home, '.claude', 'history.jsonl'), '');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  // os.homedir() honors $HOME on POSIX, which is what the synchronizer reads in
  // its constructor — so HOME must be set before the class is imported/built.
  process.env.HOME = home;
  await initializeDatabase();

  try {
    await runTest({ home, projectsDir });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function jsonl(...records: Array<Record<string, unknown>>): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

const MAIN_SESSION = '11111111-1111-4111-8111-111111111111';
const CWD = '/Users/dev/projects/demo';

async function writeMainAndSubagent(projectsDir: string): Promise<{ mainFile: string; subagentFile: string }> {
  const encodedProject = '-Users-dev-projects-demo';
  const projectDir = path.join(projectsDir, encodedProject);
  const subagentDir = path.join(projectDir, MAIN_SESSION, 'subagents');
  await mkdir(subagentDir, { recursive: true });

  const mainFile = path.join(projectDir, `${MAIN_SESSION}.jsonl`);
  await writeFile(mainFile, jsonl({
    type: 'user',
    sessionId: MAIN_SESSION,
    cwd: CWD,
    uuid: 'm1',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'real main session' },
  }));

  // Subagent transcript: note it carries the PARENT sessionId + cwd.
  const subagentFile = path.join(subagentDir, 'agent-aaaa1111bbbb2222.jsonl');
  await writeFile(subagentFile, jsonl({
    type: 'user',
    sessionId: MAIN_SESSION,
    cwd: CWD,
    isSidechain: true,
    uuid: 's1',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'subagent work' }] },
  }));

  return { mainFile, subagentFile };
}

test('synchronize() does not index a subagent-only directory as a session', async () => {
  // Deterministic guard (order-independent): a session dir that contains ONLY
  // subagent transcripts — no real top-level <UUID>.jsonl — must produce zero
  // sessions. This mirrors the real orphan case where the parent transcript was
  // never flushed. Without the guard the subagent file (carrying the parent
  // sessionId) becomes a phantom session.
  await withIsolatedHomeAndDb(async ({ projectsDir }) => {
    const subagentDir = path.join(projectsDir, '-Users-dev-projects-demo', MAIN_SESSION, 'subagents');
    await mkdir(subagentDir, { recursive: true });
    await writeFile(path.join(subagentDir, 'agent-aaaa1111bbbb2222.jsonl'), jsonl({
      type: 'user',
      sessionId: MAIN_SESSION,
      cwd: CWD,
      isSidechain: true,
      uuid: 's1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent work' }] },
    }));

    const { ClaudeSessionSynchronizer } = await import('./claude-session-synchronizer.provider.js');
    await new ClaudeSessionSynchronizer().synchronize();

    assert.equal(sessionsDb.getAllSessions().length, 0, 'subagent transcripts must never become sessions');
    assert.equal(sessionsDb.getSessionById(MAIN_SESSION), null, 'no row should exist for a subagent-only directory');
  });
});

test('synchronize() keeps a real session pointed at its own transcript, not its subagents', async () => {
  await withIsolatedHomeAndDb(async ({ projectsDir }) => {
    const { mainFile } = await writeMainAndSubagent(projectsDir);

    const { ClaudeSessionSynchronizer } = await import('./claude-session-synchronizer.provider.js');
    await new ClaudeSessionSynchronizer().synchronize();

    const row = sessionsDb.getSessionById(MAIN_SESSION);
    assert.ok(row, 'main session should be indexed');
    assert.equal(row?.jsonl_path, mainFile, 'jsonl_path must point at the real transcript, not the subagent file');
    assert.ok(!row?.jsonl_path?.includes('/subagents/'), 'jsonl_path must never reference a subagents/ file');

    // The subagent file shares the parent sessionId, so it must not spawn a
    // second row either — exactly one session exists.
    assert.equal(sessionsDb.getAllSessions().length, 1, 'subagent transcripts must not create extra sessions');
  });
});

test('synchronizeFile() ignores a subagent transcript path and does not hijack the parent', async () => {
  await withIsolatedHomeAndDb(async ({ projectsDir }) => {
    const { mainFile, subagentFile } = await writeMainAndSubagent(projectsDir);

    const { ClaudeSessionSynchronizer } = await import('./claude-session-synchronizer.provider.js');
    const synchronizer = new ClaudeSessionSynchronizer();

    // Index the real session first…
    await synchronizer.synchronizeFile(mainFile);
    // …then simulate a live subagent write landing on the watcher.
    const result = await synchronizer.synchronizeFile(subagentFile);

    assert.equal(result, null, 'subagent files must be skipped by single-file sync');
    assert.equal(sessionsDb.getSessionById(MAIN_SESSION)?.jsonl_path, mainFile, 'parent jsonl_path must stay intact');
  });
});
