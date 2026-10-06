import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import type { CodexDiagnosticScope } from '../../../shared/index.js';
import type { createCodexDiagnosticRouting } from '../services/codex-diagnostic-routing.service.js';
import { codexDiagnosticRuntime, transferCodexDiagnosticRuntime, releaseCodexDiagnosticRuntime } from '../services/codex-diagnostic-runtime.service.js';

const directory = await mkdtemp(path.join(process.env.TEST_ARTIFACT_ROOT ?? tmpdir(), 'diagnostic-legacy-'));
process.env.DATABASE_PATH = path.join(directory, 'test.db');
process.env.MC_DISABLE = '1';
process.env.VIBESPACE_CODEX_PATH = path.join(directory, 'MUST-NOT-SPAWN');
const { initializeDatabase, closeConnection, getConnection, sessionsDb } = await import('../../database/index.js');
const { closeSessionsWatcher } = await import('../index.js');
const { __setTaskLedgerReader, __clearTaskContinuationState } = await import('../../task-continuation/index.js');
const { markCodexRevertedHistory, readCodexRevertedHistory } = await import('../services/codex-reverted-history.service.js');
// eslint-disable-next-line boundaries/no-unknown -- Actual legacy execution is the integration surface under test.
const { queryCodex, injectCodexMessage, abortCodexSession, getCodexThreadResidency } = await import('../../../openai-codex.js');
await initializeDatabase();
__setTaskLedgerReader('codex', () => ({ open: [], activity: 0 }));
test.after(async () => { __setTaskLedgerReader('codex', null); __clearTaskContinuationState(); closeSessionsWatcher(); closeConnection(); await rm(directory, { recursive: true, force: true }); });

const scope: CodexDiagnosticScope = { appSessionId: '11111111-1111-4111-8111-111111111111',
  nativeThreadId: '22222222-2222-4222-8222-222222222222', generation: 'review-1', private: false, side: false };
const handle = { ...scope, id: '55555555-5555-4555-8555-555555555555' };
type Routing = Pick<ReturnType<typeof createCodexDiagnosticRouting>, 'acquire' | 'state' | 'transfer'>;
function fixture() {
  let phase: 'diagnostic' | 'quarantined' | null = null;
  let holds = 0; let released = 0; let closed = false;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const emit = (method: string, params: Record<string, unknown>) => { for (const listener of listeners) listener(method, params); };
  const routing = {
    state: () => phase ? { phase, holds } : null,
    async transfer(_scope: CodexDiagnosticScope, handle: { id: string }) { phase = 'diagnostic'; return handle; },
    acquire: (_scope: CodexDiagnosticScope, purpose: string) => {
      assert.deepEqual(_scope, scope); holds++;
      let done = false;
      return { peer: { get closed() { return closed; }, subscribe(listener: (method: string, params: Record<string, unknown>) => void) {
        listeners.add(listener); return () => listeners.delete(listener);
      } }, release() { if (!done) { done = true; holds--; released++; } },
      async request(method: string, params: Record<string, unknown>) {
        assert.equal(params.threadId, scope.nativeThreadId);
        if (purpose === 'history') assert.equal(method, 'thread/turns/list');
        calls.push({ method, params });
        if (method === 'turn/start') { queueMicrotask(() => emit('turn/started', { threadId: scope.nativeThreadId, turn: { id: 'synthetic-turn' } })); return { turn: { id: 'synthetic-turn', status: 'inProgress' } }; }
        if (method === 'turn/interrupt') emit('turn/completed', { threadId: scope.nativeThreadId, turn: { id: 'synthetic-turn', status: 'interrupted' } });
        if (method === 'thread/turns/list') return { data: [] };
        return {};
      } };
    },
  } as unknown as Routing;
  return { routing, calls, listeners, emit, setPhase(value: typeof phase) { phase = value; }, setClosed() { closed = true; }, get released() { return released; } };
}

test('disabled diagnostics leave unrelated new, private and side execution to the ordinary path', () => {
  assert.equal(codexDiagnosticRuntime.acquire({}, 'turn'), null);
  assert.equal(codexDiagnosticRuntime.acquire({ nativeThreadId: scope.nativeThreadId, private: true, side: true }, 'turn'), null);
});

test('only a matching prepared handle can transfer; mismatches and rewind refuse before acquisition', async () => {
  const f = fixture();
  await assert.rejects(transferCodexDiagnosticRuntime(scope, { ...handle, generation: 'wrong' }, f.routing), /registration-refused/);
  const remove = await transferCodexDiagnosticRuntime(scope, handle, f.routing);
  try {
    await assert.rejects(transferCodexDiagnosticRuntime(scope, handle, f.routing), /registration-refused/);
    for (const input of [{ appSessionId: scope.appSessionId }, { nativeThreadId: scope.nativeThreadId, private: true },
      { nativeThreadId: scope.nativeThreadId, side: true }, { nativeThreadId: scope.nativeThreadId, appSessionId: 'other' }]) {
      assert.throws(() => codexDiagnosticRuntime.acquire(input, 'turn'), /scope-refused/);
    }
    assert.throws(() => codexDiagnosticRuntime.acquire({ nativeThreadId: scope.nativeThreadId, rewind: 'turn-1' }, 'turn'), /rewind-unavailable/);
    assert.throws(remove, /still-owned/); assert.equal(f.released, 0); assert.deepEqual(f.calls, []);
    f.setPhase('quarantined'); assert.throws(() => codexDiagnosticRuntime.acquire({ nativeThreadId: scope.nativeThreadId }, 'history'), /unavailable/);
  } finally { f.setPhase(null); remove(); }
});

test('actual legacy turn, steer, abort and history share the mounted selector without resume or ordinary idle residency', async () => {
  const f = fixture(); const remove = await transferCodexDiagnosticRuntime(scope, handle, f.routing);
  const events: Array<Record<string, unknown>> = [];
  const context = { resolveProviderSessionId: () => scope.nativeThreadId, resolveResumeModel: async () => 'fixture-model',
    getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [{ value: 'fixture-model', label: 'Synthetic fixture' }] }), normalizeMessage: () => [], isProviderInstalled: async () => true };
  try {
    sessionsDb.createAppSession(scope.appSessionId, 'codex', directory);
    sessionsDb.assignProviderSessionId(scope.appSessionId, scope.nativeThreadId);
    getConnection().prepare('UPDATE sessions SET custom_name = ?, name_source = ? WHERE session_id = ?').run('Synthetic fixture', 'user', scope.appSessionId);
    const run = queryCodex('Synthetic input', { sessionId: scope.appSessionId, cwd: directory },
      { isWebSocketWriter: true, send(event: Record<string, unknown>) { events.push(event); }, setSessionId() {} }, context);
    for (let i = 0; i < 100 && !f.calls.some(call => call.method === 'turn/start'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.calls.some(call => call.method === 'turn/start'));
    await injectCodexMessage(scope.appSessionId, 'Synthetic follow-up');
    assert.equal(await abortCodexSession(scope.appSessionId), true);
    await run;
    assert.deepEqual(f.calls.map(call => call.method), ['turn/start', 'turn/steer', 'turn/interrupt']);
    assert.equal(f.released, 1); assert.equal(f.listeners.size, 0);
    assert.equal(getCodexThreadResidency().some((entry: { threadId: string }) => entry.threadId === scope.nativeThreadId), false);
    markCodexRevertedHistory(scope.nativeThreadId);
    assert.deepEqual(await readCodexRevertedHistory(scope.nativeThreadId, false), []);
    assert.equal(f.calls.at(-1)?.method, 'thread/turns/list'); assert.equal(f.released, 2);
    assert.equal(events.some(event => event.kind === 'error'), false);
  } finally { f.setPhase(null); remove(); }
});

test('actual legacy diagnostic rejection does not invoke an ordinary provider or retain a lease', async () => {
  const fresh = { ...scope, appSessionId: '33333333-3333-4333-8333-333333333333', nativeThreadId: '44444444-4444-4444-8444-444444444444' };
  const f = fixture(); const remove = await transferCodexDiagnosticRuntime(fresh, { ...handle, ...fresh }, f.routing);
  const events: Array<Record<string, unknown>> = [];
  try {
    await queryCodex('Synthetic rejected edit', { sessionId: fresh.nativeThreadId, appSessionId: fresh.appSessionId, rewind: 'replace', cwd: directory },
      { isWebSocketWriter: true, send(event: Record<string, unknown>) { events.push(event); } },
      { resolveProviderSessionId: id => id ?? null, normalizeMessage: () => [], resolveResumeModel: async () => 'fixture-model',
        getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [] }), isProviderInstalled: async () => true });
    assert.ok(events.some(event => event.kind === 'error' && event.content === 'diagnostic-runtime-rewind-unavailable'));
    assert.deepEqual(f.calls, []); assert.equal(f.released, 0);
  } finally { f.setPhase(null); remove(); }
});

test('actual early legacy query cannot resume the ordinary peer while transfer is awaiting admission', async () => {
  const pendingScope = { ...scope, appSessionId: '66666666-6666-4666-8666-666666666666', nativeThreadId: '77777777-7777-4777-8777-777777777777' };
  const f = fixture();
  let finish!: () => void;
  const checkpoint = new Promise<void>(resolve => { finish = resolve; });
  f.routing.transfer = async (_scope, prepared) => { await checkpoint; f.setPhase('diagnostic'); return prepared; };
  const transfer = transferCodexDiagnosticRuntime(pendingScope, { ...handle, ...pendingScope }, f.routing);
  const events: Array<Record<string, unknown>> = [];
  try {
    assert.throws(() => releaseCodexDiagnosticRuntime(pendingScope), /still-owned/);
    await queryCodex('Synthetic pending transfer', { sessionId: pendingScope.nativeThreadId, appSessionId: pendingScope.appSessionId, cwd: directory },
      { isWebSocketWriter: true, send(event: Record<string, unknown>) { events.push(event); } },
      { resolveProviderSessionId: id => id ?? null, normalizeMessage: () => [], resolveResumeModel: async () => 'fixture-model',
        getProviderModels: async () => ({ DEFAULT: 'fixture-model', OPTIONS: [] }), isProviderInstalled: async () => true });
    assert.ok(events.some(event => event.kind === 'error' && event.content === 'diagnostic-runtime-unavailable'));
    assert.deepEqual(f.calls, []); assert.equal(f.released, 0);
    finish(); const remove = await transfer;
    assert.throws(remove, /still-owned/);
  } finally { finish(); await transfer; f.setPhase(null); releaseCodexDiagnosticRuntime(pendingScope); }
});

for (const outcome of ['confirmed-null', 'quarantined', 'unreadable'] as const) {
  test(`rejected transfer ${outcome} ${outcome === 'confirmed-null' ? 'restores ordinary selection' : 'retains fail-closed selection'}`, async () => {
    const f = fixture(); const state = f.routing.state; let unreadable = false;
    f.routing.state = current => { if (unreadable) throw new Error('synthetic-owner-observation-unavailable'); return state(current); };
    f.routing.transfer = async () => { f.setPhase(outcome === 'quarantined' ? 'quarantined' : null); unreadable = outcome === 'unreadable'; throw new Error('synthetic-transfer-refusal'); };
    try {
      await assert.rejects(transferCodexDiagnosticRuntime(scope, handle, f.routing), /transfer-refused/);
      if (outcome === 'confirmed-null') assert.equal(codexDiagnosticRuntime.acquire({ nativeThreadId: scope.nativeThreadId }, 'turn'), null);
      else assert.throws(() => codexDiagnosticRuntime.acquire({ nativeThreadId: scope.nativeThreadId }, 'turn'), /unavailable/);
      assert.deepEqual(f.calls, []); assert.equal(f.released, 0);
    } finally { unreadable = false; f.setPhase(null); releaseCodexDiagnosticRuntime(scope); }
  });
}

test('generation rebound cannot acquire or remove a mounted scope through a failed host observation', async () => {
  const f = fixture(); const remove = await transferCodexDiagnosticRuntime(scope, handle, f.routing);
  const state = f.routing.state;
  try {
    f.routing.state = () => { throw new Error('diagnostic-route-rebound'); };
    assert.throws(() => codexDiagnosticRuntime.acquire({ nativeThreadId: scope.nativeThreadId }, 'history'), /route-rebound/);
    assert.throws(remove, /route-rebound/);
    assert.throws(() => releaseCodexDiagnosticRuntime({ ...scope, generation: 'replacement' }), /still-owned/);
    assert.deepEqual(f.calls, []);
  } finally { f.routing.state = state; f.setPhase(null); remove(); }
});
