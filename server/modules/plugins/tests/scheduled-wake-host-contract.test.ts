/**
 * Contract between this host and the dudin-integrations plugin's scheduled plan wake.
 *
 * The plugin's own suite drives its wake against a hand-written host object, which is how a
 * shape mismatch shipped: the stub answered `enqueueMessageChecked` with `{ accepted: true }`
 * while this host answers a `CheckedEnqueueResult`. Here the plugin's real module runs against
 * the host object `buildHost` hands a plugin, wired to the real run registry, the real
 * idle-only and checked admissions and a real session database. Only two things are fixtures:
 * the provider runtime (no CLI is spawned) and the plugin's clock, which runs 1000x so that
 * the plugin's 30 s retry cadence fits in a test.
 *
 * Opt-in: set MC_SCHEDULER_PLUGIN_ROOT to a plugin checkout or installed release, e.g.
 *   MC_SCHEDULER_PLUGIN_ROOT=~/.vibespace/plugin-releases/<release>/plugin npx tsx \
 *     --tsconfig server/tsconfig.json --test server/modules/plugins/tests/scheduled-wake-host-contract.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import type express from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { activateHostExtensions, deactivateHostExtensions } from '@/modules/plugins/index.js';
import { __clearTaskContinuationState, __setTaskLedgerReader, planTaskContinuation } from '@/modules/task-continuation/index.js';
import {
  chatRunRegistry,
  registerChatDependenciesAtBoot,
  serverEnqueueMessage,
  serverEnqueueMessageChecked,
  serverEnqueueMessageIfIdle,
} from '@/modules/websocket/index.js';

const PLUGIN_ROOT = process.env.MC_SCHEDULER_PLUGIN_ROOT;
const SCALE = 1000;
const STEP_LEAD_MS = 60_000; // virtual: the step falls due one minute after it is parked

type LedgerModule = {
  missionControlTaskLedger: (context: { provider: string; sessionId: string }, options: { read: (id: string) => unknown }) => unknown;
};

type WakeModule = {
  createScheduledPlanWake: (options: Record<string, unknown>) => { start(): { started: boolean; stop(): void } };
};

/** A reporter-shaped card ledger with one scheduled step that falls due at `until`. */
function ledger(until: number) {
  return (providerSessionId: string, at: Date) => {
    if (!providerSessionId) return null;
    const due = at.getTime() >= until;
    return {
      open: [{
        id: 's1', subject: 'Проверить сборку', status: 'pending', waitingOnUser: !due, updatedAt: null,
        scheduled: { until: new Date(until).toISOString(), owner: 'self', due, ...(due ? { reason: 'clock' } : {}) },
      }],
      activity: 1,
      ...(due ? {} : { wakeAt: until }),
    };
  };
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) return false;
    await settle(5);
  }
  return true;
}

test('scheduled wake runs against the real host contract', { skip: !PLUGIN_ROOT && 'MC_SCHEDULER_PLUGIN_ROOT not set' }, async (t) => {
  const pluginRoot = path.resolve(PLUGIN_ROOT!.replace(/^~(?=\/)/, os.homedir()));
  const wakeModule = await import(pathToFileURL(path.join(pluginRoot, 'host', 'scheduled-plan-wake.js')).href) as WakeModule;
  const ledgerModule = await import(pathToFileURL(path.join(pluginRoot, 'host', 'mission-control-ledger.js')).href) as LedgerModule;

  const previousDb = process.env.DATABASE_PATH;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vs-wake-contract-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporary, 'auth.db');
  await initializeDatabase();

  // The provider runtime is the one fixture on the host side: record each turn the drain starts.
  const turns: Array<{ provider: string; content: string; permissionMode: unknown }> = [];
  const releases: Array<() => void> = [];
  registerChatDependenciesAtBoot({ runtime: {
    hasRuntime: () => true,
    run: async (provider: string, content: string, options: { permissionMode?: unknown }) => {
      turns.push({ provider, content, permissionMode: options.permissionMode });
      await new Promise<void>(resolve => releases.push(resolve));
    },
    abort: async () => true,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  } } as unknown as Parameters<typeof registerChatDependenciesAtBoot>[0]);

  // The host a plugin receives: activate a probe plugin through the real buildHost and keep it.
  const pluginsDir = path.join(temporary, 'plugins');
  fs.mkdirSync(path.join(pluginsDir, 'probe', 'host'), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'probe', 'host', 'index.js'),
    'export function activate(host) { globalThis.__wakeContractHost = host; }');
  await activateHostExtensions({
    scanPlugins: () => [{ name: 'probe', dirName: 'probe', enabled: true, hostModule: 'host/index.js' }],
    getPluginsDir: () => pluginsDir,
    authenticateToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    getSigningSecret: () => 'secret',
    sessions: {
      getById: (id: string) => sessionsDb.getSessionById(id),
      getPermissionMode: (id: string) => sessionsDb.getSessionPermissionMode(id),
      createAppSession: () => ({ sessionId: 'unused' }),
      deleteOrArchiveById: async () => undefined,
      rename: () => undefined,
    },
    runs: {
      // Same projection as server/index.js.
      get: (id: string) => {
        const run = chatRunRegistry.getRun(id);
        return run ? { status: run.status, providerSessionId: run.providerSessionId, lastAssistantText: '' } : null;
      },
      abort: async () => false,
      onCompleted: (callback: (sessionId: string) => void) => chatRunRegistry.addRunCompleteListener((sessionId) => callback(sessionId)),
    },
    interactions: { getPending: () => [], resolve: () => false },
    enqueueMessage: (id: string, prompt: string, options?: Record<string, unknown>) => serverEnqueueMessage(id, prompt, options),
    enqueueMessageIfIdle: serverEnqueueMessageIfIdle,
    enqueueMessageChecked: (id: string, prompt: string, options?: Record<string, unknown>) => serverEnqueueMessageChecked(id, prompt, options),
  } as unknown as Parameters<typeof activateHostExtensions>[0]);
  const host = (globalThis as Record<string, unknown>).__wakeContractHost as Record<string, unknown>;
  assert.ok(host, 'probe plugin activated');
  assert.equal(typeof (host.runs as Record<string, unknown>).onCompleted, 'function');
  assert.equal(typeof host.enqueueMessageIfIdle, 'function');
  assert.equal(typeof host.enqueueMessageChecked, 'function');

  // The plugin's clock runs SCALE times faster than the wall; the host's does not need to.
  const origin = Date.now();
  const now = () => origin + (Date.now() - origin) * SCALE;
  const setTimer = (fn: () => void, ms: number) => setTimeout(fn, Math.max(0, ms / SCALE));
  const wakes: Array<{ stop(): void }> = [];

  function park(id: string, { provider = 'claude', beforeCompletion }: { provider?: string; beforeCompletion?: (read: ReturnType<typeof ledger>) => boolean } = {}) {
    sessionsDb.createSession(id, provider, '/workspace/fixture', id);
    sessionsDb.setSessionPermissionMode(id, 'bypassPermissions');
    const run = chatRunRegistry.startRun({ appSessionId: id, provider, providerSessionId: id,
      connection: { readyState: 1, send() {} }, userId: null } as Parameters<typeof chatRunRegistry.startRun>[0]);
    assert.ok(run);
    const file = path.join(temporary, `${id}-wakes.json`);
    const read = ledger(now() + STEP_LEAD_MS);
    const wake = wakeModule.createScheduledPlanWake({
      host, read, file, now, setTimer, clearTimer: clearTimeout,
    }).start();
    assert.equal(wake.started, true, 'the real host offers what the wake needs');
    wakes.push(wake);
    // A per-turn runtime (Codex) withholds `complete` while its supervisor continues the turn.
    if (beforeCompletion && !beforeCompletion(read)) return file;
    // The turn that parked the step ends through the registry, which notifies the plugin.
    chatRunRegistry.completeRun(id, { exitCode: 0 });
    return file;
  }
  const keyState = (file: string, id: string) => {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.values(store.sessions?.[id]?.keys ?? {}).map(value => (value as { s: string }).s);
  };

  try {
    await t.test('idle-only admission: a completed run takes the wake once, and its turn acknowledges it', async () => {
      const file = park('wake-idle');
      assert.ok(await waitFor(() => turns.length === 1), 'wake was delivered through enqueueMessageIfIdle');
      assert.match(turns[0].content, /Проверить сборку/);
      assert.equal(turns[0].permissionMode, 'bypassPermissions', 'the session\'s permission mode is kept');
      assert.deepEqual(keyState(file, 'wake-idle'), ['queued']);
      await settle(120); // > 3 virtual retry periods
      assert.equal(turns.length, 1, 'no duplicate wake');
      chatRunRegistry.completeRun('wake-idle', { exitCode: 0 });
      assert.ok(await waitFor(() => keyState(file, 'wake-idle')[0] === 'acked'), 'completion of the woken turn acknowledges the key');
    });

    await t.test('checked admission: with the run evicted the wake is queued once, never re-sent', async () => {
      const before = turns.length;
      const file = park('wake-evicted');
      await settle(10);
      chatRunRegistry.clearAll(); // the registry evicts completed runs; nothing is processing
      assert.equal(chatRunRegistry.getRun('wake-evicted'), undefined);
      assert.ok(await waitFor(() => turns.length === before + 1), 'wake was delivered through enqueueMessageChecked');
      await settle(150); // > 4 virtual retry periods
      assert.equal(turns.length, before + 1, 'an accepted CheckedEnqueueResult is not retried as a refusal');
      assert.deepEqual(keyState(file, 'wake-evicted'), ['queued']);
    });
    await t.test('codex: a card-only scheduled step ends the turn despite a stale native plan, so the wake is armed', async () => {
      // Live failure 2026-09-29 (s155): the host had no registerTaskLedgerSource, so the Codex
      // continuation read the session's stale native update_plan (#112–115), resumed the turn and
      // withheld `complete`; onCompleted never fired and the wake never saw the parked step.
      const before = turns.length;
      __setTaskLedgerReader('codex', () => ({ activity: 1, open: [
        { id: 112, status: 'pending', subject: 'stale native item' },
        { id: 113, status: 'in_progress', subject: 'another stale item' },
      ] }));
      let unregister: (() => void) | undefined;
      try {
        const file = park('wake-codex', { provider: 'codex', beforeCompletion: (read) => {
          // As the plugin's activate() does: only when the host offers the hook.
          if (typeof host.registerTaskLedgerSource === 'function') {
            unregister = (host.registerTaskLedgerSource as (s: unknown) => () => void)(
              (context: { provider: string; sessionId: string }) => ledgerModule.missionControlTaskLedger(context, { read: (id: string) => read(id, new Date(now())) }));
          }
          // What openai-codex.js asks at turn end: null ends the turn with `complete`.
          const continuation = planTaskContinuation({ provider: 'codex', sessionId: 'wake-codex' });
          assert.equal(continuation, null, 'the parked card step is not nudged and the stale native plan is not read');
          return continuation === null;
        } });
        assert.ok(await waitFor(() => fs.existsSync(file) && keyState(file, 'wake-codex').length === 1), 'completion reached the wake and it recorded the step');
        assert.ok(await waitFor(() => turns.length === before + 1), 'the step fell due and the wake was delivered');
        assert.match(turns[before].content, /Проверить сборку/);
        assert.deepEqual(keyState(file, 'wake-codex'), ['queued']);
      } finally {
        unregister?.();
        __setTaskLedgerReader('codex', null);
        __clearTaskContinuationState();
      }
    });
  } finally {
    for (const wake of wakes) wake.stop();
    for (const release of releases) release();
    await settle(10);
    await deactivateHostExtensions();
    chatRunRegistry.clearAll();
    closeConnection();
    delete (globalThis as Record<string, unknown>).__wakeContractHost;
    if (previousDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDb;
    await rm(temporary, { recursive: true, force: true });
  }
});
