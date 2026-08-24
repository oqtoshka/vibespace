import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  __resetSessionShredDependencies,
  registerSessionShredDependencies,
  sessionShredService,
  type ShredRoots,
} from '@/modules/providers/services/session-shred.service.js';

/**
 * Shred removes the harness's own records for ONE session and reports what it
 * could not remove. Every fixture below has a neighbour session that must
 * survive: the rule under test is "keyed on the session's ids, nothing else".
 */

const exists = (target: string): boolean => fsSync.existsSync(target);

async function withFixture(
  runTest: (context: { home: string; roots: ShredRoots }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const home = await mkdtemp(path.join(tmpdir(), 'shred-home-'));
  const vibespaceDataDir = path.join(home, '.vibespace');
  await mkdir(vibespaceDataDir, { recursive: true });

  closeConnection();
  __resetSessionShredDependencies();
  process.env.DATABASE_PATH = path.join(vibespaceDataDir, 'auth.db');
  await initializeDatabase();

  const roots: ShredRoots = {
    claudeDir: path.join(home, '.claude'),
    codexHome: path.join(home, '.codex'),
    opencodeDataDir: path.join(home, '.local', 'share', 'opencode'),
    vibespaceDataDir,
  };

  try {
    await runTest({ home, roots });
  } finally {
    closeConnection();
    __resetSessionShredDependencies();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(home, { recursive: true, force: true });
  }
}

const write = async (file: string, content = ''): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
};

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test('shred removes every Claude record keyed by the session id and nothing of its neighbour', async () => {
  await withFixture(async ({ roots }) => {
    const id = '11111111-aaaa-4aaa-8aaa-111111111111';
    const other = '22222222-bbbb-4bbb-8bbb-222222222222';
    const projectDir = path.join(roots.claudeDir, 'projects', '-workspace-demo');
    const transcript = path.join(projectDir, `${id}.jsonl`);

    await write(transcript, '{"type":"user"}\n');
    await write(path.join(projectDir, id, 'agent-1.jsonl'), '{}');
    await write(path.join(projectDir, `${other}.jsonl`), '{"type":"user"}\n');
    await write(path.join(projectDir, other, 'agent-1.jsonl'), '{}');
    await write(path.join(roots.claudeDir, 'tasks', id, '1.json'), '{}');
    await write(path.join(roots.claudeDir, 'tasks', other, '1.json'), '{}');
    await write(path.join(roots.claudeDir, 'debug', `${id}.txt`), 'log');
    await write(path.join(roots.claudeDir, 'file-history', id, 'abc@v1'), 'x');
    await write(path.join(roots.claudeDir, 'sessions', '100.json'), JSON.stringify({ sessionId: id }));
    await write(path.join(roots.claudeDir, 'sessions', '200.json'), JSON.stringify({ sessionId: other }));
    await write(
      path.join(roots.claudeDir, 'history.jsonl'),
      [
        JSON.stringify({ display: 'mine', sessionId: id }),
        JSON.stringify({ display: 'theirs', sessionId: other }),
        JSON.stringify({ display: 'mine too', sessionId: id }),
      ].join('\n') + '\n',
    );

    sessionsDb.createAppSession('app-claude', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-claude', id);
    sessionsDb.updateSessionRecap('app-claude', 'secret recap', 4);

    // The restore-on-boot registry holds this session and the other. The
    // real hook lives in server/services (wired at boot); here a fake one
    // records what it was asked to forget and edits the file the same way.
    const registry = path.join(roots.vibespaceDataDir, 'active-claude-sessions.json');
    await write(registry, JSON.stringify([{ sessionId: id, cwd: '/workspace/demo' }, { sessionId: other, cwd: '/workspace/demo' }]));
    const forgotten: string[] = [];
    const cancelledRecaps: string[] = [];
    registerSessionShredDependencies({
      forgetRestoreEntry: async (sessionId) => {
        forgotten.push(sessionId);
        const entries = JSON.parse(await readFile(registry, 'utf8')) as Array<{ sessionId: string }>;
        await writeFile(registry, JSON.stringify(entries.filter((entry) => entry.sessionId !== sessionId)));
        return true;
      },
      cancelSessionRecap: (sessionId) => { cancelledRecaps.push(sessionId); },
    });

    const row = sessionsDb.getSessionById('app-claude');
    assert.ok(row);
    // The row's transcript path is what the synchronizer indexed.
    (row as { jsonl_path: string | null }).jsonl_path = transcript;

    const plan = await sessionShredService.plan(row, roots);
    const planned = plan.filter((item) => item.willDelete).map((item) => item.what);
    assert.ok(planned.includes(transcript));
    assert.ok(planned.includes(path.join(projectDir, id)));
    assert.ok(planned.includes(path.join(roots.claudeDir, 'tasks', id)));
    assert.ok(planned.includes(path.join(roots.claudeDir, 'debug', `${id}.txt`)));
    assert.ok(planned.includes(path.join(roots.claudeDir, 'sessions', '100.json')));
    assert.ok(!planned.some((what) => what.includes(other)), 'the neighbour is never in the plan');
    assert.ok(!planned.includes(path.join(roots.claudeDir, 'sessions', '200.json')));

    const report = await sessionShredService.execute(row, roots);

    assert.ok(!exists(transcript));
    assert.ok(!exists(path.join(projectDir, id)));
    assert.ok(!exists(path.join(roots.claudeDir, 'tasks', id)));
    assert.ok(!exists(path.join(roots.claudeDir, 'debug', `${id}.txt`)));
    assert.ok(!exists(path.join(roots.claudeDir, 'file-history', id)));
    assert.ok(!exists(path.join(roots.claudeDir, 'sessions', '100.json')));
    // The neighbour is intact.
    assert.ok(exists(path.join(projectDir, `${other}.jsonl`)));
    assert.ok(exists(path.join(projectDir, other)));
    assert.ok(exists(path.join(roots.claudeDir, 'tasks', other)));
    assert.ok(exists(path.join(roots.claudeDir, 'sessions', '200.json')));

    const history = (await readFile(path.join(roots.claudeDir, 'history.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(history.map((entry) => entry.sessionId), [other]);

    const registryAfter = JSON.parse(await readFile(registry, 'utf8')) as Array<{ sessionId: string }>;
    assert.deepEqual(registryAfter.map((entry) => entry.sessionId), [other]);
    assert.ok(forgotten.includes(id));
    assert.ok(!forgotten.includes(other));
    assert.ok(cancelledRecaps.includes('app-claude') && cancelledRecaps.includes(id));

    assert.equal(sessionsDb.getSessionById('app-claude'), null);
    assert.equal(report.sessionId, 'app-claude');
    assert.ok(report.deleted.some((entry) => entry.kind === 'vibespace-row'));
    assert.ok(report.deleted.some((entry) => entry.kind === 'registry-entry'));

    // The fixed caveats are always reported, because they are always true.
    const caveats = report.notRemoved.map((entry) => entry.what);
    assert.ok(caveats.includes("other sessions' transcripts that mention this one"));
    assert.ok(caveats.includes('provider-side logs'));
    assert.ok(caveats.includes('Time Machine backups'));
  });
});

test('shred refuses a transcript path that is not named after the session id', async () => {
  await withFixture(async ({ roots }) => {
    const id = '33333333-cccc-4ccc-8ccc-333333333333';
    const stranger = path.join(roots.claudeDir, 'projects', '-workspace-demo', 'someone-else.jsonl');
    await write(stranger, '{}');

    sessionsDb.createAppSession('app-odd', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-odd', id);
    const row = sessionsDb.getSessionById('app-odd');
    assert.ok(row);
    (row as { jsonl_path: string | null }).jsonl_path = stranger;

    const report = await sessionShredService.execute(row, roots);
    assert.ok(exists(stranger));
    assert.ok(report.notRemoved.some((entry) => entry.what === stranger && /not named after/.test(entry.reason)));
  });
});

test('a session that never produced a provider id has nothing harness-side and says so', async () => {
  await withFixture(async ({ roots }) => {
    sessionsDb.createAppSession('app-fresh', 'claude', '/workspace/demo');
    const row = sessionsDb.getSessionById('app-fresh');
    assert.ok(row);

    const report = await sessionShredService.execute(row, roots);
    assert.ok(report.notRemoved.some((entry) => /never produced a provider session id/.test(entry.reason)));
    assert.equal(sessionsDb.getSessionById('app-fresh'), null);
  });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test('shred removes the Codex rollout and only the schema-confirmed sqlite rows', async () => {
  await withFixture(async ({ roots }) => {
    const id = '019f9f73-7168-75c1-a5dc-1d9601b7afd4';
    const other = '019f9f50-4399-7a13-82da-819ac6eb414a';
    const day = path.join(roots.codexHome, 'sessions', '2026', '07', '26');
    const rollout = path.join(day, `rollout-2026-07-26T20-22-50-${id}.jsonl`);
    const otherRollout = path.join(day, `rollout-2026-07-26T19-44-25-${other}.jsonl`);
    await write(rollout, '{"type":"session_meta"}\n');
    await write(otherRollout, '{"type":"session_meta"}\n');
    await write(path.join(roots.codexHome, 'shell_snapshots', `${id}.1787241740129567000.sh`), '#');
    await write(path.join(roots.codexHome, 'shell_snapshots', `${other}.1787241740129567001.sh`), '#');

    // state_5.sqlite with the real thread tables (cascade on dynamic tools).
    const state = new Database(path.join(roots.codexHome, 'state_5.sqlite'));
    state.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL);
      CREATE TABLE thread_dynamic_tools (
        thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
        PRIMARY KEY(thread_id, position),
        FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);
    `);
    state.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id, rollout, 'mine');
    state.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(other, otherRollout, 'theirs');
    state.prepare('INSERT INTO thread_dynamic_tools VALUES (?, 0, ?)').run(id, 'tool');
    state.prepare('INSERT INTO thread_dynamic_tools VALUES (?, 0, ?)').run(other, 'tool');
    state.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(other, id, 'done');
    state.close();

    // logs_2.sqlite keyed by thread_id.
    const logs = new Database(path.join(roots.codexHome, 'logs_2.sqlite'));
    logs.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, thread_id TEXT)');
    logs.prepare('INSERT INTO logs (ts, level, thread_id) VALUES (1, ?, ?)').run('info', id);
    logs.prepare('INSERT INTO logs (ts, level, thread_id) VALUES (2, ?, ?)').run('info', other);
    logs.prepare('INSERT INTO logs (ts, level, thread_id) VALUES (3, ?, NULL)').run('info');
    logs.close();

    // memories are never touched, whatever they hold.
    const memories = new Database(path.join(roots.codexHome, 'memories_1.sqlite'));
    memories.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, thread_id TEXT, body TEXT)');
    memories.prepare('INSERT INTO memories (thread_id, body) VALUES (?, ?)').run(id, 'remember');
    memories.close();

    sessionsDb.createAppSession('app-codex', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-codex', id);
    const row = sessionsDb.getSessionById('app-codex');
    assert.ok(row);

    const report = await sessionShredService.execute(row, roots);

    assert.ok(!exists(rollout));
    assert.ok(exists(otherRollout));
    assert.ok(!exists(path.join(roots.codexHome, 'shell_snapshots', `${id}.1787241740129567000.sh`)));
    assert.ok(exists(path.join(roots.codexHome, 'shell_snapshots', `${other}.1787241740129567001.sh`)));

    const stateAfter = new Database(path.join(roots.codexHome, 'state_5.sqlite'), { readonly: true });
    assert.deepEqual(stateAfter.prepare('SELECT id FROM threads').all(), [{ id: other }]);
    assert.deepEqual(stateAfter.prepare('SELECT thread_id FROM thread_dynamic_tools').all(), [{ thread_id: other }]);
    assert.deepEqual(stateAfter.prepare('SELECT COUNT(*) AS n FROM thread_spawn_edges').get(), { n: 0 });
    stateAfter.close();

    const logsAfter = new Database(path.join(roots.codexHome, 'logs_2.sqlite'), { readonly: true });
    assert.deepEqual(logsAfter.prepare('SELECT thread_id FROM logs ORDER BY ts').all(), [{ thread_id: other }, { thread_id: null }]);
    logsAfter.close();

    const memoriesAfter = new Database(path.join(roots.codexHome, 'memories_1.sqlite'), { readonly: true });
    assert.deepEqual(memoriesAfter.prepare('SELECT COUNT(*) AS n FROM memories').get(), { n: 1 });
    memoriesAfter.close();

    assert.ok(report.notRemoved.some((entry) => entry.reason === 'Codex memories are not keyed by session'));
    assert.ok(report.deleted.some((entry) => /threads row/.test(entry.what)));
    assert.ok(report.deleted.some((entry) => /logs row/.test(entry.what)));
  });
});

test('a Codex table without a thread column is reported, not guessed at', async () => {
  await withFixture(async ({ roots }) => {
    const id = '019f0000-0000-7000-8000-000000000001';
    await mkdir(roots.codexHome, { recursive: true });
    const logs = new Database(path.join(roots.codexHome, 'logs_2.sqlite'));
    logs.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, body TEXT)');
    logs.prepare('INSERT INTO logs (ts, body) VALUES (1, ?)').run(`mentions ${id}`);
    logs.close();

    sessionsDb.createAppSession('app-codex-2', 'codex', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-codex-2', id);
    const row = sessionsDb.getSessionById('app-codex-2');
    assert.ok(row);

    const report = await sessionShredService.execute(row, roots);
    assert.ok(report.notRemoved.some((entry) => entry.what === 'logs_2.sqlite: logs' && /no session-keyed column/.test(entry.reason)));

    const after = new Database(path.join(roots.codexHome, 'logs_2.sqlite'), { readonly: true });
    assert.deepEqual(after.prepare('SELECT COUNT(*) AS n FROM logs').get(), { n: 1 });
    after.close();
  });
});

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

function createOpenCodeDb(dbPath: string): Database.Database {
  fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL);
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, parent_id text, title text NOT NULL,
      CONSTRAINT fk_session_project FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
    CREATE TABLE message (
      id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL,
      CONSTRAINT fk_message_session FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, data text NOT NULL,
      CONSTRAINT fk_part_message FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY, session_id text NOT NULL, seq integer NOT NULL, data text NOT NULL,
      CONSTRAINT fk_sm_session FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE session_input (
      id text PRIMARY KEY, session_id text NOT NULL, prompt text NOT NULL,
      CONSTRAINT fk_si_session FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE session_share (
      session_id text PRIMARY KEY, id text NOT NULL, url text NOT NULL,
      CONSTRAINT fk_ss_session FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE session_context_epoch (
      session_id text PRIMARY KEY, baseline text NOT NULL,
      CONSTRAINT fk_sce_session FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE todo (
      session_id text NOT NULL, content text NOT NULL, position integer NOT NULL,
      CONSTRAINT todo_pk PRIMARY KEY(session_id, position),
      CONSTRAINT fk_todo_session FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
  `);
  return db;
}

test('shred removes the OpenCode rows, the child sessions, and the spilled tool output they point at', async () => {
  await withFixture(async ({ roots }) => {
    const id = 'ses_0038c240cffeVsFhZOAzJRl7cM';
    const child = 'ses_0038c240cffeCHILD00000000';
    const other = 'ses_00392035cffeAXGfdkLpiVKH3r';
    const dbPath = path.join(roots.opencodeDataDir, 'opencode.db');
    const toolOutputDir = path.join(roots.opencodeDataDir, 'tool-output');
    const mine = path.join(toolOutputDir, 'tool_mine000000000000000000');
    const childs = path.join(toolOutputDir, 'tool_child00000000000000000');
    const theirs = path.join(toolOutputDir, 'tool_theirs0000000000000000');
    await write(mine, 'mine');
    await write(childs, 'child');
    await write(theirs, 'theirs');
    await write(path.join(roots.opencodeDataDir, 'snapshot', 'deadbeef', 'HEAD'), 'ref');

    const db = createOpenCodeDb(dbPath);
    db.prepare('INSERT INTO project VALUES (?, ?)').run('prj', '/workspace/demo');
    db.prepare('INSERT INTO session VALUES (?, ?, NULL, ?)').run(id, 'prj', 'mine');
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(child, 'prj', id, 'subagent');
    db.prepare('INSERT INTO session VALUES (?, ?, NULL, ?)').run(other, 'prj', 'theirs');
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('msg_1', id, '{}');
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('msg_c', child, '{}');
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('msg_2', other, '{}');
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'prt_1', 'msg_1', id, JSON.stringify({ type: 'tool', state: { metadata: { outputPath: mine } } }),
    );
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'prt_c', 'msg_c', child, JSON.stringify({ type: 'tool', state: { metadata: { outputPath: childs } } }),
    );
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'prt_2', 'msg_2', other, JSON.stringify({ type: 'tool', state: { metadata: { outputPath: theirs } } }),
    );
    db.prepare('INSERT INTO session_message VALUES (?, ?, 1, ?)').run('sm_1', id, '{}');
    db.prepare('INSERT INTO session_input VALUES (?, ?, ?)').run('si_1', id, 'hello');
    db.prepare('INSERT INTO session_share VALUES (?, ?, ?)').run(id, 'share', 'https://x');
    db.prepare('INSERT INTO session_context_epoch VALUES (?, ?)').run(id, 'b');
    db.prepare('INSERT INTO todo VALUES (?, ?, 0)').run(id, 'todo');
    db.prepare('INSERT INTO todo VALUES (?, ?, 0)').run(other, 'their todo');
    db.close();

    sessionsDb.createAppSession('app-oc', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-oc', id);
    const row = sessionsDb.getSessionById('app-oc');
    assert.ok(row);

    const plan = await sessionShredService.plan(row, roots);
    const planned = plan.filter((item) => item.willDelete).map((item) => item.what);
    assert.ok(planned.includes(mine));
    assert.ok(planned.includes(childs));
    assert.ok(!planned.includes(theirs));
    assert.ok(plan.some((item) => !item.willDelete && item.what === path.join(roots.opencodeDataDir, 'snapshot')));

    const report = await sessionShredService.execute(row, roots);

    assert.ok(!exists(mine));
    assert.ok(!exists(childs));
    assert.ok(exists(theirs));
    assert.ok(exists(path.join(roots.opencodeDataDir, 'snapshot', 'deadbeef', 'HEAD')));

    const after = new Database(dbPath, { readonly: true });
    assert.deepEqual(after.prepare('SELECT id FROM session ORDER BY id').all(), [{ id: other }]);
    assert.deepEqual(after.prepare('SELECT id FROM message').all(), [{ id: 'msg_2' }]);
    assert.deepEqual(after.prepare('SELECT id FROM part').all(), [{ id: 'prt_2' }]);
    assert.deepEqual(after.prepare('SELECT COUNT(*) AS n FROM session_message').get(), { n: 0 });
    assert.deepEqual(after.prepare('SELECT COUNT(*) AS n FROM session_input').get(), { n: 0 });
    assert.deepEqual(after.prepare('SELECT COUNT(*) AS n FROM session_share').get(), { n: 0 });
    assert.deepEqual(after.prepare('SELECT COUNT(*) AS n FROM session_context_epoch').get(), { n: 0 });
    assert.deepEqual(after.prepare('SELECT session_id FROM todo').all(), [{ session_id: other }]);
    after.close();

    assert.ok(report.notRemoved.some((entry) => /snapshots are keyed by project/.test(entry.reason)));
    assert.ok(report.deleted.some((entry) => /1 child session/.test(entry.what)));
  });
});

test('a locked OpenCode database is retried, then reported as locked', async () => {
  await withFixture(async ({ roots }) => {
    const id = 'ses_locked0000000000000000';
    const dbPath = path.join(roots.opencodeDataDir, 'opencode.db');
    const db = createOpenCodeDb(dbPath);
    db.prepare('INSERT INTO project VALUES (?, ?)').run('prj', '/workspace/demo');
    db.prepare('INSERT INTO session VALUES (?, ?, NULL, ?)').run(id, 'prj', 'mine');
    db.close();

    sessionsDb.createAppSession('app-oc-locked', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-oc-locked', id);
    const row = sessionsDb.getSessionById('app-oc-locked');
    assert.ok(row);

    // Hold an exclusive lock for longer than the retry budget.
    const holder = new Database(dbPath);
    holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
    holder.prepare('INSERT INTO project VALUES (?, ?)').run('prj2', '/x');
    try {
      const report = await sessionShredService.execute(row, roots);
      assert.ok(report.notRemoved.some((entry) => entry.reason === 'database locked' && entry.what.includes(dbPath)));
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    const after = new Database(dbPath, { readonly: true });
    assert.deepEqual(after.prepare('SELECT id FROM session').all(), [{ id }]);
    after.close();
  });
});
