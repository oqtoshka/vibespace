import assert from 'node:assert/strict';
import test from 'node:test';

import {
  queryClaudeSDK,
  abortClaudeSDKSession,
  getClaudeSDKBackgroundTasks,
  getClaudeSDKLiveBackgroundTasks,
  __setClaudeQueryImpl,
} from './claude-sdk.js';

// Shapes recorded from one controlled run of SDK 0.3.219 / CLI 2.1.219: the level
// signal lists only BACKGROUND tasks, keyed by the same id the tool receipt carries
// (async Agent `agentId` a16c…, background Bash `backgroundTaskId` bwsy…), while a
// long foreground Bash still gets task_started/task_notification edges.
const sys = (subtype, fields, sessionId) => ({ type: 'system', subtype, session_id: sessionId, ...fields });
const levelOf = (tasks, sessionId) => sys('background_tasks_changed', { tasks }, sessionId);

function makeWriter() {
  return { userId: null, isWebSocketWriter: true, ws: { readyState: 1, send() {} }, setSessionId() {}, send() {} };
}

test('the live background set follows the level signal, not the edges', async () => {
  const sessionId = 'bg-level-1';
  const checkpoints = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  __setClaudeQueryImpl(({ prompt }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      await reader.next();
      yield levelOf([{ task_id: 'a16c1dbd9667427e8', task_type: 'local_agent', description: 'pong probe' }], sessionId);
      yield sys('task_started', { task_id: 'a16c1dbd9667427e8', tool_use_id: 'toolu_a', description: 'pong probe', task_type: 'local_agent' }, sessionId);
      yield levelOf([
        { task_id: 'a16c1dbd9667427e8', task_type: 'local_agent', description: 'pong probe' },
        { task_id: 'bwsyb1ohh', task_type: 'local_bash', description: 'Sleep 6 seconds' },
      ], sessionId);
      yield sys('task_started', { task_id: 'bwsyb1ohh', tool_use_id: 'toolu_b', description: 'Sleep 6 seconds', task_type: 'local_bash' }, sessionId);
      // A long foreground command: edges only, never in the level set.
      yield sys('task_started', { task_id: 'b9o17ohva', tool_use_id: 'toolu_c', description: 'sleep 30', task_type: 'local_bash' }, sessionId);
      checkpoints.push('mid');
      await gate;
      // The agent finishes; the level is replaced, and its bookend may never arrive.
      yield levelOf([{ task_id: 'bwsyb1ohh', task_type: 'local_bash', description: 'Sleep 6 seconds' }], sessionId);
      yield levelOf([], sessionId);
      checkpoints.push('cleared');
      await finished;
      yield { type: 'result', subtype: 'success', session_id: sessionId };
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  });

  try {
    const done = queryClaudeSDK('probe', { sessionId, ephemeral: false }, makeWriter());
    while (!checkpoints.includes('mid')) await new Promise((resolve) => { setTimeout(resolve, 5); });
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.deepEqual(getClaudeSDKLiveBackgroundTasks(sessionId).map((task) => task.taskId).sort(),
      ['a16c1dbd9667427e8', 'bwsyb1ohh']);
    // The edge map over-reports the foreground command; the level set does not.
    assert.ok(getClaudeSDKBackgroundTasks(sessionId).some((task) => task.taskId === 'b9o17ohva'));
    assert.deepEqual(getClaudeSDKLiveBackgroundTasks(sessionId).find((task) => task.taskId === 'bwsyb1ohh'),
      { taskId: 'bwsyb1ohh', description: 'Sleep 6 seconds', taskType: 'local_bash' });

    release();
    while (!checkpoints.includes('cleared')) await new Promise((resolve) => { setTimeout(resolve, 5); });
    await new Promise((resolve) => { setImmediate(resolve); });
    // Still the same live session: no task_notification was ever sent, yet the level
    // says nothing is running while the edge map stays wedged.
    assert.deepEqual(getClaudeSDKLiveBackgroundTasks(sessionId), []);
    assert.ok(getClaudeSDKBackgroundTasks(sessionId).length > 0, 'the edge map is still wedged without bookends');
    finish();
    await done;
  } finally {
    await abortClaudeSDKSession(sessionId).catch(() => {});
    __setClaudeQueryImpl(null);
  }
  assert.deepEqual(getClaudeSDKLiveBackgroundTasks('never-started'), []);
});
