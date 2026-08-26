import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  recordSessionActivity,
  recordSessionEnd,
  recordPendingInteraction,
  restoreInterruptedSessions,
  __resetSessionRestoreState,
} from '../session-restore.service.js';

// Point both the registry (getDataDir → DATABASE_PATH's parent) and the task
// ledger (CLAUDE_CONFIG_DIR) at throwaway dirs before any service call.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'session-restore-'));
process.env.DATABASE_PATH = path.join(tmp, 'data', 'auth.db');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');

const stateFile = path.join(tmp, 'data', 'active-agent-sessions.json');
const legacyStateFile = path.join(tmp, 'data', 'active-claude-sessions.json');

async function seedOpenTask(sessionId, { id = '1', metadata } = {}) {
  const dir = path.join(tmp, 'claude', 'tasks', sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({
    id, subject: 'open item', status: 'pending', blocks: [], blockedBy: [],
    ...(metadata ? { metadata } : {}),
  }));
}

function spawnRecorder(calls) {
  return async (prompt, options, writer) => { calls.push({ prompt, options, writer }); };
}

beforeEach(async () => {
  __resetSessionRestoreState();
  await fs.rm(path.join(tmp, 'data'), { recursive: true, force: true });
  await fs.rm(path.join(tmp, 'claude'), { recursive: true, force: true });
  await fs.rm(path.join(tmp, 'codex'), { recursive: true, force: true });
});

test('a session recorded mid-turn is resumed with its spawn options', async () => {
  await recordSessionActivity({
    sessionId: 's-midturn', cwd: '/proj', permissionMode: 'bypassPermissions', userId: 7, turnActive: true,
  });
  const calls = [];
  const resumed = await restoreInterruptedSessions(spawnRecorder(calls));
  assert.deepEqual(resumed, ['s-midturn']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.sessionId, 's-midturn');
  assert.equal(calls[0].options.resume, true);
  assert.equal(calls[0].options.cwd, '/proj');
  assert.equal(calls[0].options.permissionMode, 'bypassPermissions');
  assert.equal(calls[0].writer.userId, 7);
  assert.match(calls[0].prompt, /\[session supervisor\]/);
});

test('a cleanly ended session is not resumed', async () => {
  await recordSessionActivity({ sessionId: 's-done', cwd: '/proj', turnActive: true });
  await recordSessionEnd('s-done');
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), []);
  assert.equal(calls.length, 0);
});

test('a Codex session recorded mid-turn is restored through the provider starter', async () => {
  await recordSessionActivity({
    provider: 'codex', sessionId: 'codex-midturn', cwd: '/proj', userId: 9, turnActive: true,
  });
  const claudeCalls = [];
  const codexCalls = [];
  const resumed = await restoreInterruptedSessions({
    claude: spawnRecorder(claudeCalls),
    codex: spawnRecorder(codexCalls),
  });
  assert.deepEqual(resumed, ['codex-midturn']);
  assert.equal(claudeCalls.length, 0);
  assert.equal(codexCalls.length, 1);
  assert.equal(codexCalls[0].options.sessionId, 'codex-midturn');
  assert.equal(codexCalls[0].writer.userId, 9);
});

test('an idle session with no open ledger tasks is dropped, not woken', async () => {
  await recordSessionActivity({ sessionId: 's-idle', cwd: '/proj', turnActive: false });
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), []);
  assert.equal(calls.length, 0);
});

test('an idle session with open ledger tasks is resumed', async () => {
  await seedOpenTask('s-ledger');
  await recordSessionActivity({ sessionId: 's-ledger', cwd: '/proj', turnActive: false });
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), ['s-ledger']);
  assert.equal(calls.length, 1);
});

test('an idle session whose open tasks all wait on the user is not resumed', async () => {
  await seedOpenTask('s-parked', { metadata: { waitingOnUser: true } });
  await recordSessionActivity({ sessionId: 's-parked', cwd: '/proj', turnActive: false });
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), []);
  assert.equal(calls.length, 0);
});

test('a user-parked task does not block resuming for other open tasks', async () => {
  await seedOpenTask('s-parked-mixed', { id: '1', metadata: { waitingOnUser: true } });
  await seedOpenTask('s-parked-mixed', { id: '2' });
  await recordSessionActivity({ sessionId: 's-parked-mixed', cwd: '/proj', turnActive: false });
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), ['s-parked-mixed']);
  assert.equal(calls.length, 1);
});

test('stale entries beyond the max age are skipped', async () => {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify([{
    sessionId: 's-old', cwd: '/proj', turnActive: true, updatedAt: Date.now() - 48 * 60 * 60 * 1000,
  }]));
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), []);
  assert.equal(calls.length, 0);
});

test('the registry survives a process restart via the state file', async () => {
  await recordSessionActivity({ sessionId: 's-persist', cwd: '/proj', turnActive: true });
  // The mirror write is debounced — wait for it, then simulate a new process.
  await new Promise((r) => setTimeout(r, 700));
  __resetSessionRestoreState();
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), ['s-persist']);
});

test('the provider-neutral registry migrates the legacy Claude state file', async () => {
  await fs.mkdir(path.dirname(legacyStateFile), { recursive: true });
  await fs.writeFile(legacyStateFile, JSON.stringify([{
    sessionId: 'legacy-claude', cwd: '/proj', turnActive: true, updatedAt: Date.now(),
  }]));
  const calls = [];
  assert.deepEqual(await restoreInterruptedSessions(spawnRecorder(calls)), ['legacy-claude']);
  assert.equal(calls.length, 1);
});

test('a startTurn hook that takes the turn suppresses the detached spawn', async () => {
  await recordSessionActivity({ sessionId: 's-hooked', cwd: '/proj', turnActive: true });
  const calls = [];
  const hooked = [];
  const resumed = await restoreInterruptedSessions(spawnRecorder(calls), {
    startTurn: (entry, prompt) => { hooked.push({ entry, prompt }); return true; },
  });
  assert.deepEqual(resumed, ['s-hooked']);
  assert.equal(hooked.length, 1);
  assert.equal(hooked[0].entry.sessionId, 's-hooked');
  assert.match(hooked[0].prompt, /\[session supervisor\]/);
  assert.equal(calls.length, 0);
});

test('a startTurn hook that declines or throws falls back to the detached spawn', async () => {
  await recordSessionActivity({ sessionId: 's-declined', cwd: '/proj', turnActive: true });
  await recordSessionActivity({ sessionId: 's-threw', cwd: '/proj', turnActive: true });
  const calls = [];
  let first = true;
  const resumed = await restoreInterruptedSessions(spawnRecorder(calls), {
    startTurn: () => {
      if (first) { first = false; return false; }
      throw new Error('registry unavailable');
    },
  });
  assert.equal(resumed.length, 2);
  assert.equal(calls.length, 2);
});

test('a parked interactive prompt survives a hard kill and is re-asked on resume', async () => {
  await recordSessionActivity({ sessionId: 's-question', cwd: '/proj', turnActive: true });
  await recordPendingInteraction('s-question', {
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Restore the cron?' }] },
  });
  const calls = [];
  await restoreInterruptedSessions(spawnRecorder(calls));
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /AskUserQuestion/);
  assert.match(calls[0].prompt, /Restore the cron\?/);
  assert.match(calls[0].prompt, /NOT the user declining/);
});

test('an interactive prompt answered in-process leaves no re-ask rider', async () => {
  await recordSessionActivity({ sessionId: 's-answered', cwd: '/proj', turnActive: true });
  await recordPendingInteraction('s-answered', { toolName: 'AskUserQuestion', input: { q: 1 } });
  await recordPendingInteraction('s-answered', null);
  // Activity updates (turn start/settle) must not resurrect a cleared prompt.
  await recordSessionActivity({ sessionId: 's-answered', turnActive: true });
  const calls = [];
  await restoreInterruptedSessions(spawnRecorder(calls));
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].prompt, /AskUserQuestion/);
});
