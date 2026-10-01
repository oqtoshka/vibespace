import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '../../modules/database/index.js';
import { chatRunRegistry } from '../../modules/websocket/services/chat-run-registry.service.js';
import { registerChatDependenciesAtBoot, serverEnqueueMessage } from '../../modules/websocket/index.js';
import { readExternalTaskLedger, registerTaskLedgerSource } from '../../shared/task-ledger-sources.js';
import {
  __resetSessionRestoreState,
  createQueuedRestoreStarter,
  recordSessionActivity,
  restoreInterruptedSessions,
} from '../session-restore.service.js';

/*
 * A restart, end to end across two processes.
 *
 * Before: a separate node process (fixtures/restart-first-boot.js) plays the
 * server that is about to be restarted. It writes the session rows, records an
 * idle Mission Control briefing session (and an ordinary idle one) through the
 * real restore registry, persists the briefing session's card plan with open
 * steps, and is then SIGKILLed — nothing it held in memory survives.
 *
 * After: this process boots against the same data dir the way server/index.js
 * does — the real database, the real boot restore pass, the entrypoint's real
 * startTurn (createQueuedRestoreStarter over serverEnqueueMessage), the real
 * chat-run queue — with the provider runtime replaced by a recorder, so no
 * agent CLI is ever spawned. The task-ledger source stands in for the Mission
 * Control plugin's (host/mission-control-ledger.js): it reads the persisted
 * plan from disk on every call, and it is registered only after the first
 * process is gone, as a host module registers it at activation.
 *
 * Not covered: server/index.js itself (its listen sequence, host-module
 * activation and the 8 s timer), the real plugin and reporter that keep the
 * card plan, and a real provider runtime resuming the transcript.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixture = path.join(here, 'fixtures', 'restart-first-boot.js');

/** Runs the first boot to READY, then kills it by its own pid. */
async function runFirstBootAndKill(env) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 30_000;
    while (!stdout.includes('READY')) {
      if (child.exitCode !== null) throw new Error(`first boot exited early (${child.exitCode}): ${stderr}`);
      if (Date.now() > deadline) throw new Error(`first boot never got ready: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    if (child.exitCode === null) process.kill(pid, 'SIGKILL');
  }
  return exited;
}

/** The Mission Control card plan as a host plugin's ledger source would read it. */
function cardPlanSource(planDir) {
  return ({ sessionId }) => {
    const file = path.join(planDir, `${sessionId}.json`);
    if (!existsSync(file)) return null;
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    return {
      listName: 'Mission Control card plan',
      guidance: 'Update it with `mcp__mc__plan`.',
      activity: plan.activity,
      open: plan.steps
        .filter((step) => step.status === 'pending' || step.status === 'in_progress')
        .map((step) => ({ id: step.id, subject: step.content, status: step.status, waitingOnUser: false, updatedAt: null })),
    };
  };
}

test('after a restart, an idle briefing session with open card-plan steps is resumed and sees its plan', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'vs-restart-resume-'));
  const cwd = path.join(tmp, 'workspace');
  const planDir = path.join(tmp, 'card-plans');
  const previousDatabasePath = process.env.DATABASE_PATH;
  const databasePath = path.join(tmp, 'data', 'auth.db');
  let unregisterLedger = () => {};
  t.after(async () => {
    unregisterLedger();
    chatRunRegistry.clearAll();
    closeConnection();
    __resetSessionRestoreState();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tmp, { recursive: true, force: true });
  });

  // --- before the restart: another process ---
  const childEnv = { ...process.env, NODE_ENV: 'test', DATABASE_PATH: databasePath,
    TSX_TSCONFIG_PATH: path.join(repoRoot, 'server', 'tsconfig.json'),
    RESTART_FIXTURE: JSON.stringify({ cwd, planDir }) };
  // A plain script, not a test file: it must not talk the runner's protocol.
  delete childEnv.NODE_TEST_CONTEXT;
  const firstBoot = await runFirstBootAndKill(childEnv);
  assert.equal(firstBoot.signal, 'SIGKILL', 'the first boot was killed, not shut down cleanly');
  const persisted = JSON.parse(await readFile(path.join(tmp, 'data', 'active-agent-sessions.json'), 'utf8'));
  assert.deepEqual(persisted.map((entry) => [entry.sessionId, entry.turnActive]).sort(),
    [['native-briefing', false], ['native-idle', false]]);

  // --- after the restart: this process, fresh module state ---
  __resetSessionRestoreState();
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  const runs = [];
  registerChatDependenciesAtBoot({
    runtime: {
      hasRuntime: () => true,
      run: async (provider, content, options) => {
        // What the resumed turn would read first: its task ledger.
        const ledger = readExternalTaskLedger({ provider, sessionId: options.providerSessionId });
        runs.push({ provider, content, options, ledger });
      },
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    },
  });
  unregisterLedger = registerTaskLedgerSource(cardPlanSource(planDir));

  const resumed = await restoreInterruptedSessions(null, {
    ready: Promise.resolve(),
    startTurn: createQueuedRestoreStarter({
      findSessionByProviderSessionId: (providerSessionId) => sessionsDb.getSessionByProviderSessionId(providerSessionId),
      enqueueMessage: serverEnqueueMessage,
    }),
  });

  assert.deepEqual(resumed, ['native-briefing'], 'only the session with open card steps came back');
  for (let i = 0; i < 100 && runs.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runs.length, 1, 'one turn reached the provider runtime');
  const [run] = runs;
  assert.equal(run.provider, 'claude');
  assert.match(run.content, /^\[session supervisor\] The vibespace server was restarted/);
  assert.equal(run.options.sessionId, 'app-briefing', 'queued on the session row that owns the native id');
  assert.equal(run.options.providerSessionId, 'native-briefing');
  assert.equal(run.options.resume, true);
  assert.equal(run.options.cwd, cwd);
  assert.equal(run.options.permissionMode, 'bypassPermissions');
  assert.equal(run.ledger?.listName, 'Mission Control card plan');
  assert.equal(run.ledger?.activity, 7);
  assert.deepEqual(run.ledger?.open.map((step) => [step.id, step.status, step.subject]), [
    ['s2', 'in_progress', 'Confirm the new release on vs.dudin.net'],
    ['s3', 'pending', 'Report the cutover on the card'],
  ], 'the continuation sees the plan the first boot persisted');
});

test('the boot pass waits for host plugins before it reads any ledger', async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'vs-restart-ready-'));
  const planDir = path.join(tmp, 'card-plans');
  const previousDatabasePath = process.env.DATABASE_PATH;
  let unregisterLedger = () => {};
  t.after(async () => {
    unregisterLedger();
    __resetSessionRestoreState();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tmp, { recursive: true, force: true });
  });
  process.env.DATABASE_PATH = path.join(tmp, 'data', 'auth.db');
  __resetSessionRestoreState();
  await mkdir(planDir, { recursive: true });
  await writeFile(path.join(planDir, 'native-late.json'), JSON.stringify({
    activity: 1, steps: [{ id: 's1', content: 'still open', status: 'pending' }],
  }));
  await recordSessionActivity({ provider: 'claude', sessionId: 'native-late', cwd: tmp, turnActive: false });

  let activate = () => {};
  const ready = new Promise((resolve) => { activate = resolve; });
  const started = [];
  const pass = restoreInterruptedSessions(null, {
    ready,
    startTurn: (entry, prompt) => { started.push({ entry, prompt }); return true; },
  });
  // The host module registers its ledger only now, after the pass began.
  await new Promise((resolve) => setTimeout(resolve, 20));
  unregisterLedger = registerTaskLedgerSource(cardPlanSource(planDir));
  activate();

  assert.deepEqual(await pass, ['native-late']);
  assert.equal(started.length, 1);
  assert.match(started[0].prompt, /^\[session supervisor\]/);
});
