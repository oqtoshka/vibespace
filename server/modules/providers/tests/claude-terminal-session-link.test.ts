import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import {
  __clearPendingCliSessions,
  claimPendingCliSession,
  registerPendingCliSession,
} from '@/modules/providers/services/pending-cli-sessions.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const CLI_SESSION_ID = '61e691fc-0000-4000-8000-000000000001';
const APP_SESSION_ID = 'd5e4a2ec-0000-4000-8000-000000000002';
const PROJECT_PATH = '/tmp/claude-terminal-link-project';

async function withIsolatedHome(
  runTest: (ctx: { transcript: (lines: unknown[]) => Promise<string> }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-terminal-link-'));
  const homeDir = path.join(tempDirectory, 'home');
  const projectDir = path.join(homeDir, '.claude', 'projects', 'proj');
  await mkdir(projectDir, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const restoreHome = patchHomeDir(homeDir);
  __clearPendingCliSessions();

  const transcript = async (lines: unknown[]): Promise<string> => {
    const filePath = path.join(projectDir, `${CLI_SESSION_ID}.jsonl`);
    await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    return filePath;
  };

  try {
    await runTest({ transcript });
  } finally {
    __clearPendingCliSessions();
    restoreHome();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const transcriptLines = [
  { sessionId: CLI_SESSION_ID, cwd: PROJECT_PATH, type: 'user' },
  { type: 'last-prompt', lastPrompt: 'hey', sessionId: CLI_SESSION_ID },
];

test('a terminal-born CLI session attaches to the app session waiting for it', async () => {
  await withIsolatedHome(async ({ transcript }) => {
    // The user opened /session/<app-id> and switched to the Terminal tab: the
    // shell registered the app session, then the CLI allocated its own id.
    sessionsDb.createAppSession(APP_SESSION_ID, 'claude', PROJECT_PATH);
    registerPendingCliSession('claude', APP_SESSION_ID, PROJECT_PATH);

    await new ClaudeSessionSynchronizer().synchronizeFile(await transcript(transcriptLines));

    const appRow = sessionsDb.getSessionById(APP_SESSION_ID);
    assert.equal(appRow?.provider_session_id, CLI_SESSION_ID, 'app session adopts the CLI id');
    assert.ok(appRow?.jsonl_path?.endsWith(`${CLI_SESSION_ID}.jsonl`), 'transcript lands on the app row');
    assert.equal(appRow?.custom_name, 'hey', 'named from the transcript');
    // No duplicate sidebar row keyed by the CLI-native id.
    assert.equal(sessionsDb.getSessionById(CLI_SESSION_ID), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId(CLI_SESSION_ID)?.session_id, APP_SESSION_ID);
  });
});

test('the bulk rescan never claims a waiting terminal', async () => {
  await withIsolatedHome(async ({ transcript }) => {
    sessionsDb.createAppSession(APP_SESSION_ID, 'claude', PROJECT_PATH);
    registerPendingCliSession('claude', APP_SESSION_ID, PROJECT_PATH);

    await transcript(transcriptLines);
    // synchronize() is the startup walk over every historical transcript —
    // those must index as their own rows, not attach to fresh empty chats.
    await new ClaudeSessionSynchronizer().synchronize();

    assert.equal(sessionsDb.getSessionById(APP_SESSION_ID)?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById(CLI_SESSION_ID)?.session_id, CLI_SESSION_ID);
  });
});

test('an unrelated project or provider cannot claim the registration', async () => {
  __clearPendingCliSessions();
  registerPendingCliSession('claude', APP_SESSION_ID, PROJECT_PATH);

  assert.equal(claimPendingCliSession('claude', '/tmp/some-other-project'), null);
  assert.equal(claimPendingCliSession('codex', PROJECT_PATH), null);
  assert.equal(claimPendingCliSession('claude', PROJECT_PATH), APP_SESSION_ID);
  // A claim consumes the entry.
  assert.equal(claimPendingCliSession('claude', PROJECT_PATH), null);
  __clearPendingCliSessions();
});
