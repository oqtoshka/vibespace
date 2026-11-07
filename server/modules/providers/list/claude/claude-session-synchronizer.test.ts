import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

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
  // An existing empty file prevents importing the installation's legacy database.
  await writeFile(databasePath, '');
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

// ---------------------------
//----------------- BACKGROUND RUNS ------------

const DEMO_PROJECT_DIR = '-Users-dev-projects-demo';

/**
 * A transcript head shaped like the CLI's: a bookkeeping line that names the
 * session but no cwd, then the first entry with both, which carries the
 * CLI's `entrypoint` label (spread in from `label`).
 */
function transcriptHead(sessionId: string, label: Record<string, unknown>, prompt: string): Array<Record<string, unknown>> {
  return [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-01-01T00:00:00.000Z', sessionId },
    {
      type: 'user',
      sessionId,
      cwd: CWD,
      uuid: `${sessionId}-u1`,
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      version: '2.0.0',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: prompt },
      ...label,
    },
  ];
}

async function writeTranscript(projectsDir: string, sessionId: string, content: string): Promise<string> {
  const projectDir = path.join(projectsDir, DEMO_PROJECT_DIR);
  await mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(file, content);
  return file;
}

function listedIds(showBackgroundRuns: boolean): string[] {
  return sessionsDb.getRecentSessionsPage(50, 0, showBackgroundRuns).sessions.map((row) => row.session_id).sort();
}

test('Claude background classification reads the transcript entrypoint, never prompt text', async () => {
  await withIsolatedHomeAndDb(async ({ projectsDir }) => {
    const fixtures = [
      // `claude -p`: the one label that marks a background run.
      ['claude-print', { entrypoint: 'sdk-cli' }, 'Summarise the build log', 1],
      // Agent SDK sessions, which is what VibeSpace's own chats are.
      ['claude-sdk', { entrypoint: 'sdk-ts' }, 'Run claude -p in the background', 0],
      // The interactive terminal CLI.
      ['claude-terminal', { entrypoint: 'cli' }, 'You are a sub-agent; run headless', 0],
      // No label (older CLIs), or one in a shape the CLI never writes.
      ['claude-unlabelled', {}, 'Summarise the build log', 0],
      ['claude-odd-label', { entrypoint: ['sdk-cli'] }, 'Summarise the build log', 0],
    ] as const;

    const { ClaudeSessionSynchronizer } = await import('./claude-session-synchronizer.provider.js');
    const synchronizer = new ClaudeSessionSynchronizer();
    for (const [id, label, prompt, expected] of fixtures) {
      const file = await writeTranscript(projectsDir, id, jsonl(...transcriptHead(id, label, prompt)));
      assert.equal(await synchronizer.synchronizeFile(file), id);
      assert.equal(sessionsDb.getSessionById(id)?.is_background, expected, id);
    }

    // A `claude -p --resume` continuation appends more print-mode turns; it is
    // still a background run.
    const continued = path.join(projectsDir, DEMO_PROJECT_DIR, 'claude-print.jsonl');
    await writeFile(continued, jsonl(
      ...transcriptHead('claude-print', { entrypoint: 'sdk-cli' }, 'Summarise the build log'),
      { type: 'user', sessionId: 'claude-print', cwd: CWD, entrypoint: 'sdk-cli', uuid: 'claude-print-u2', message: { role: 'user', content: 'And the test log' } },
    ));
    await synchronizer.synchronizeFile(continued);

    // A full rescan reaches the same verdicts.
    await new ClaudeSessionSynchronizer().synchronize();
    for (const [id, , , expected] of fixtures) {
      assert.equal(sessionsDb.getSessionById(id)?.is_background, expected, id);
    }

    assert.deepEqual(listedIds(false), ['claude-odd-label', 'claude-sdk', 'claude-terminal', 'claude-unlabelled']);
    assert.deepEqual(listedIds(true), ['claude-odd-label', 'claude-print', 'claude-sdk', 'claude-terminal', 'claude-unlabelled']);
  });
});

test('a Claude transcript with a malformed first line is never hidden', async () => {
  await withIsolatedHomeAndDb(async ({ projectsDir }) => {
    const garbled = (id: string) => '{"type":"queue-operation",\n'
      + jsonl(...transcriptHead(id, { entrypoint: 'sdk-cli' }, 'Summarise the build log'));
    const { ClaudeSessionSynchronizer } = await import('./claude-session-synchronizer.provider.js');
    const synchronizer = new ClaudeSessionSynchronizer();

    // Found on disk: the head cannot be read, so nothing is indexed to hide.
    const file = await writeTranscript(projectsDir, 'claude-garbled', garbled('claude-garbled'));
    assert.equal(await synchronizer.synchronizeFile(file), null);
    assert.equal(sessionsDb.getSessionById('claude-garbled'), null);

    // A chat VibeSpace already lists keeps showing when its transcript head
    // turns out unreadable.
    sessionsDb.createAppSession('app-chat', 'claude', CWD, false, false, 'App chat');
    sessionsDb.assignProviderSessionId('app-chat', 'claude-garbled-bound');
    const bound = await writeTranscript(projectsDir, 'claude-garbled-bound', garbled('claude-garbled-bound'));
    await synchronizer.synchronizeFile(bound);
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById('app-chat')?.is_background, 0);
    assert.deepEqual(listedIds(false), ['app-chat']);
  });
});

test('Claude terminal prompt history permanently promotes a claude -p run, even outside the scan window', async () => {
  await withIsolatedHomeAndDb(async ({ home, projectsDir }) => {
    const historyPath = path.join(home, '.claude', 'history.jsonl');
    const prompt = (sessionId: string) => JSON.stringify({
      display: 'A terminal follow-up', pastedContents: {}, timestamp: 1800000000000, project: CWD, sessionId,
    }) + '\n';
    const { ClaudeSessionSynchronizer } = await import('./claude-session-synchronizer.provider.js');
    const synchronizer = new ClaudeSessionSynchronizer();

    await writeTranscript(projectsDir, 'claude-resumed', jsonl(...transcriptHead('claude-resumed', { entrypoint: 'sdk-cli' }, 'Scripted first turn')));
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById('claude-resumed')?.is_background, 1);

    // `claude --resume` in a terminal: the prompt lands in the journal. The
    // transcript is older than the scan cursor, so only the journal pass sees it.
    await writeFile(historyPath, prompt('claude-resumed'));
    await synchronizer.synchronize(new Date('2099-01-01'));
    assert.equal(sessionsDb.getSessionById('claude-resumed')?.is_background, 0);

    // Promotion outlives the journal entry and a full rescan of the transcript.
    await writeFile(historyPath, '');
    await new ClaudeSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById('claude-resumed')?.is_background, 0, 'a rescan cannot hide a promoted run');

    // A run first indexed after its terminal resume is never hidden at all.
    await writeFile(historyPath, prompt('claude-resumed-early'));
    const late = await writeTranscript(projectsDir, 'claude-resumed-early', jsonl(...transcriptHead('claude-resumed-early', { entrypoint: 'sdk-cli' }, 'Scripted first turn')));
    await synchronizer.synchronizeFile(late);
    assert.equal(sessionsDb.getSessionById('claude-resumed-early')?.is_background, 0);
    assert.deepEqual(listedIds(false), ['claude-resumed', 'claude-resumed-early']);
  });
});

test('a chat started in VibeSpace stays visible even when its transcript is labelled like claude -p', async () => {
  await withIsolatedHomeAndDb(async ({ projectsDir }) => {
    // A VibeSpace server started from a Claude Code terminal hands the label on
    // to its own chats; the chat row it created is what counts.
    const { ClaudeSessionSynchronizer } = await import('./claude-session-synchronizer.provider.js');
    const synchronizer = new ClaudeSessionSynchronizer();

    // Bound before the transcript is indexed.
    sessionsDb.createAppSession('app-chat', 'claude', CWD, false, false, 'App chat');
    sessionsDb.assignProviderSessionId('app-chat', 'claude-app-bound');
    const bound = await writeTranscript(projectsDir, 'claude-app-bound', jsonl(...transcriptHead('claude-app-bound', { entrypoint: 'sdk-cli' }, 'Plan the release')));
    assert.equal(await synchronizer.synchronizeFile(bound), 'app-chat');
    assert.equal(sessionsDb.getSessionById('app-chat')?.is_background, 0);

    // Indexed first (flagged as the run it looks like), then claimed by the
    // chat that started it: the merged chat is a conversation.
    const early = await writeTranscript(projectsDir, 'claude-app-early', jsonl(...transcriptHead('claude-app-early', { entrypoint: 'sdk-cli' }, 'Plan the release')));
    await synchronizer.synchronizeFile(early);
    assert.equal(sessionsDb.getSessionById('claude-app-early')?.is_background, 1);
    sessionsDb.createAppSession('app-chat-early', 'claude', CWD, false, false, 'Early chat');
    sessionsDb.assignProviderSessionId('app-chat-early', 'claude-app-early');
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById('app-chat-early')?.is_background, 0);
    assert.deepEqual(listedIds(false), ['app-chat', 'app-chat-early']);
  });
});
