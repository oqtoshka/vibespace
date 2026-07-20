import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedHome(
  runTest: (ctx: { homeDir: string; transcript: (lines: unknown[]) => Promise<string> }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-names-'));
  const homeDir = path.join(tempDirectory, 'home');
  const projectDir = path.join(homeDir, '.claude', 'projects', 'proj');
  await mkdir(projectDir, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const restoreHome = patchHomeDir(homeDir);

  const transcript = async (lines: unknown[]): Promise<string> => {
    const filePath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    return filePath;
  };

  try {
    await runTest({ homeDir, transcript });
  } finally {
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

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const PROJECT_PATH = '/tmp/claude-names-project';

const head = { sessionId: SESSION_ID, cwd: PROJECT_PATH, type: 'user' };
const lastPrompt = (text: string) => ({ type: 'last-prompt', lastPrompt: text, sessionId: SESSION_ID });
const aiTitle = (text: string) => ({ type: 'ai-title', aiTitle: text, sessionId: SESSION_ID });

test('a generated title wins over the prompts that follow it in the transcript', async () => {
  await withIsolatedHome(async ({ transcript }) => {
    // The CLI appends a `last-prompt` on every turn, so the AI title is almost
    // never the last title-ish line in the file.
    const filePath = await transcript([
      head,
      lastPrompt('fix the thing please'),
      aiTitle('Fix voice settings persistence'),
      lastPrompt('now also ship it'),
    ]);

    await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, 'Fix voice settings persistence');
  });
});

test('a prompt-derived name is upgraded once the generated title appears', async () => {
  await withIsolatedHome(async ({ transcript }) => {
    const synchronizer = new ClaudeSessionSynchronizer();

    // Early in the session only the prompt exists.
    await synchronizer.synchronizeFile(await transcript([head, lastPrompt('fix the thing please')]));
    let row = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(row?.custom_name, 'fix the thing please');
    assert.equal(row?.name_source, 'derived');

    // A few turns later the CLI writes its title — which must replace it.
    await synchronizer.synchronizeFile(await transcript([
      head,
      lastPrompt('fix the thing please'),
      aiTitle('Fix voice settings persistence'),
    ]));
    row = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(row?.custom_name, 'Fix voice settings persistence');
    assert.equal(row?.name_source, 'ai');
  });
});

test('an explicit rename is never overwritten by a later sync', async () => {
  await withIsolatedHome(async ({ transcript }) => {
    const synchronizer = new ClaudeSessionSynchronizer();
    await synchronizer.synchronizeFile(await transcript([head, lastPrompt('fix the thing please')]));

    sessionsDb.updateSessionCustomName(SESSION_ID, 'My own name');

    await synchronizer.synchronizeFile(await transcript([
      head,
      lastPrompt('fix the thing please'),
      aiTitle('Fix voice settings persistence'),
    ]));

    const row = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(row?.custom_name, 'My own name');
    assert.equal(row?.name_source, 'user');
  });
});

test('a generated title is not downgraded back to a newer prompt', async () => {
  await withIsolatedHome(async ({ transcript }) => {
    const synchronizer = new ClaudeSessionSynchronizer();
    await synchronizer.synchronizeFile(await transcript([head, aiTitle('Fix voice settings persistence')]));

    await synchronizer.synchronizeFile(await transcript([
      head,
      aiTitle('Fix voice settings persistence'),
      lastPrompt('unrelated follow-up question'),
    ]));

    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, 'Fix voice settings persistence');
  });
});
