import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeBackgroundSnapshot, type BackgroundRuntime } from '../services/native-background.service.js';

const runtime = (live: Record<string, { taskId: string; description: string }[]>): BackgroundRuntime => ({
  tasks: id => live[id] ?? [],
  alive: id => id in live,
});

test('only a live Claude session reports its own running set', () => {
  const rt = runtime({ 'prov-a': [{ taskId: 'bash_1', description: 'tail log' }], 'prov-b': [] });
  const a = nativeBackgroundSnapshot({ id: 'app-a', provider: 'claude', provider_session_id: 'prov-a' }, rt, 7);
  assert.deepEqual(a, { kind: 'native.background', available: true, observedAt: 7, running: [{ taskId: 'bash_1', description: 'tail log' }] });
  // Session B is live with nothing running: an authoritative empty set, not A's.
  const b = nativeBackgroundSnapshot({ id: 'app-b', provider: 'claude', provider_session_id: 'prov-b' }, rt, 7);
  assert.deepEqual(b, { kind: 'native.background', available: true, observedAt: 7, running: [] });
});

test('a session not in memory is unavailable, never an empty running set', () => {
  const snap = nativeBackgroundSnapshot({ id: 'app-c', provider: 'claude', provider_session_id: 'gone' }, runtime({}), 1);
  assert.deepEqual(snap, { kind: 'native.background', available: false, observedAt: 1, reason: 'not-live' });
  assert.equal('running' in snap, false);
});

test('providers without a runtime inventory stay unknown', () => {
  for (const provider of ['codex', 'cursor', 'opencode', 'gemini']) {
    const snap = nativeBackgroundSnapshot({ id: 'x', provider }, runtime({ x: [{ taskId: 't', description: '' }] }), 1);
    assert.equal(snap.available, false);
    assert.equal(snap.available === false && snap.reason, 'unsupported-provider');
  }
});

test('falls back to the app id and bounds hostile task fields', () => {
  const long = 'x'.repeat(1000);
  const snap = nativeBackgroundSnapshot({ id: 'app-d', provider: 'claude', provider_session_id: null },
    runtime({ 'app-d': [{ taskId: long, description: long }, { taskId: '', description: 'nameless' }] }), 1);
  assert.equal(snap.available, true);
  assert.equal(snap.available && snap.running.length, 1);
  assert.equal(snap.available && snap.running[0].taskId.length, 200);
});
