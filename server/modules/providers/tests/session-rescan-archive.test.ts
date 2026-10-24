import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The synchronizers resolve ~/.claude and ~/.codex from os.homedir() when they
// are built, so the scratch home is in place before any of them load.
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'session-rescan-archive-'));
const homeDir = path.join(tempRoot, 'home');
process.env.HOME = homeDir;
process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');

const { closeConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { ClaudeSessionSynchronizer } = await import('@/modules/providers/list/claude/claude-session-synchronizer.provider.js');
const { CodexSessionSynchronizer } = await import('@/modules/providers/list/codex/codex-session-synchronizer.provider.js');
const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');

test.before(async () => {
  await mkdir(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  await writeFile(path.join(homeDir, '.claude', 'history.jsonl'), '');
  await initializeDatabase();
});

test.after(async () => {
  closeConnection();
  await rm(tempRoot, { recursive: true, force: true });
});

const PROJECT = '/Users/dev/projects/demo';

function jsonl(...records: Array<Record<string, unknown>>): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function isArchived(sessionId: string): boolean {
  return Boolean(sessionsDb.getSessionById(sessionId)?.isArchived);
}

async function writeClaudeTranscript(sessionId: string): Promise<string> {
  const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-dev-projects-demo');
  await mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(filePath, jsonl(
    { type: 'user', sessionId, cwd: PROJECT, uuid: 'u1', timestamp: '2026-07-18T10:00:00.000Z', message: { role: 'user', content: 'tidy the README' } },
    { type: 'assistant', sessionId, cwd: PROJECT, uuid: 'a1', timestamp: '2026-07-18T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ));
  return filePath;
}

async function writeCodexTranscript(sessionId: string): Promise<string> {
  const dayDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '18');
  await mkdir(dayDir, { recursive: true });
  const filePath = path.join(dayDir, `rollout-2026-07-18T10-00-00-${sessionId}.jsonl`);
  await writeFile(filePath, jsonl(
    { type: 'session_meta', payload: { id: sessionId, cwd: PROJECT } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tidy the README' }] } },
  ));
  return filePath;
}

test('claude: an archived session re-scanned with no new messages stays archived', async () => {
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const transcript = await writeClaudeTranscript(sessionId);
  const synchronizer = new ClaudeSessionSynchronizer();

  await synchronizer.synchronize();
  assert.equal(isArchived(sessionId), false, 'a newly found session is active');
  sessionsDb.updateSessionIsArchived(sessionId, true);

  // The full scan (no cursor) re-reads every transcript, this one included.
  await synchronizer.synchronize();
  assert.equal(isArchived(sessionId), true);
  // So does the watcher when the file is touched.
  assert.equal(await synchronizer.synchronizeFile(transcript), sessionId);
  assert.equal(isArchived(sessionId), true);
  assert.deepEqual(sessionsDb.getAllSessions().map((row) => row.session_id), []);

  // A message written outside VibeSpace (the CLI resumed it) is still only
  // indexing: it updates the row and leaves the archive alone.
  await appendFile(transcript, jsonl({ type: 'user', sessionId, cwd: PROJECT, uuid: 'u2', timestamp: '2026-07-18T11:00:00.000Z', message: { role: 'user', content: 'one more thing' } }));
  await synchronizer.synchronizeFile(transcript);
  assert.equal(isArchived(sessionId), true);

  // Restore is the user's way back, and the next scan keeps it active.
  sessionsService.restoreSessionById(sessionId);
  await synchronizer.synchronize();
  assert.equal(isArchived(sessionId), false);
});

test('codex: an archived session re-scanned with no new messages stays archived', async () => {
  const sessionId = 'codex-rescan-archive';
  const transcript = await writeCodexTranscript(sessionId);
  const synchronizer = new CodexSessionSynchronizer();

  await synchronizer.synchronize();
  assert.equal(isArchived(sessionId), false);
  sessionsDb.updateSessionIsArchived(sessionId, true);

  await synchronizer.synchronize();
  assert.equal(isArchived(sessionId), true);
  assert.equal(await synchronizer.synchronizeFile(transcript), sessionId);
  assert.equal(isArchived(sessionId), true);
});
