import assert from 'node:assert/strict';
import test from 'node:test';

const { queryClaudeSDK, __setClaudeQueryImpl } = await import('./claude-sdk.js');

/**
 * Native side questions (Mission Control FEAT-SESSION-030): the first turn
 * forks the parent's provider session instead of resuming (and so reusing) it,
 * and anything outside the read-only allow list is denied without a prompt.
 */
async function turn(callOptions) {
  let captured;
  const frames = [];
  __setClaudeQueryImpl(({ prompt, options }) => {
    captured = options;
    const gen = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: 'result', subtype: 'success', session_id: 'side-fork-new' };
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  });
  try {
    await queryClaudeSDK('side question', callOptions, { userId: null, setSessionId() {}, send(frame) { frames.push(frame); } });
  } finally {
    __setClaudeQueryImpl(null);
  }
  return { options: captured, frames };
}

test('a side question forks the parent on its first turn and never resumes it in place', async () => {
  const { options } = await turn({
    forkFrom: 'parent-provider-id', sideSession: true, private: true, permissionMode: 'plan',
    toolsSettings: { allowedTools: [], disallowedTools: ['Edit', 'Bash'], skipPermissions: false },
  });
  assert.equal(options.resume, 'parent-provider-id');
  assert.equal(options.forkSession, true);
  assert.equal(options.permissionMode, 'plan');
  assert.ok(options.disallowedTools.includes('Edit'));
});

test('a side question with its own provider session resumes itself, not the parent', async () => {
  const { options } = await turn({ sessionId: 'side-own-provider', forkFrom: 'parent-provider-id', sideSession: true, permissionMode: 'plan' });
  assert.equal(options.resume, 'side-own-provider');
  assert.equal(options.forkSession, undefined);
});

test('a side question denies tools outside its allow list without asking anyone', async () => {
  const { options, frames } = await turn({ forkFrom: 'parent-provider-id', sideSession: true, permissionMode: 'plan',
    toolsSettings: { allowedTools: [], disallowedTools: ['Edit'], skipPermissions: false } });
  const signal = new AbortController().signal;
  assert.equal((await options.canUseTool('Edit', {}, { signal })).behavior, 'deny');
  assert.equal((await options.canUseTool('mcp__fixture__write', {}, { signal })).behavior, 'deny');
  assert.equal((await options.canUseTool('AskUserQuestion', { questions: [] }, { signal })).behavior, 'deny');
  assert.equal((await options.canUseTool('Read', { file_path: '/tmp/x' }, { signal })).behavior, 'allow');
  assert.ok(!frames.some(frame => frame.kind === 'permission_request'));
});

/**
 * Regression (2026-10-19, fork 20d7ed12): the forked parent had stopped on a tool
 * result, so the runtime first answered that leftover context ("No response
 * requested."), then submitted a stale `<task-notification>` without a query —
 * each ending in a `result` — and only then started the turn holding our
 * prompt. The run settled on the first `result`, so the thread got an empty
 * answer and the real one went nowhere.
 */
function forkReplay({ capabilities = ['msg_lifecycle_v1'], promptState = 'started' } = {}) {
  return ({ prompt }) => {
    const gen = (async function* () {
      const { value: first } = await prompt[Symbol.asyncIterator]().next();
      const uuid = first.uuid;
      yield { type: 'system', subtype: 'init', session_id: 'side-fork-new', capabilities };
      // 1. A turn answering the parent's leftover context.
      yield { type: 'assistant', session_id: 'side-fork-new', message: { id: 'm-leftover', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } };
      yield { type: 'result', subtype: 'success', session_id: 'side-fork-new', num_turns: 1, result: 'No response requested.' };
      // 2. The stale notification, submitted without a query.
      yield { type: 'result', subtype: 'success', session_id: 'side-fork-new', num_turns: 0, result: '' };
      // 3. The turn that consumes our prompt.
      yield { type: 'command_lifecycle', command_uuid: uuid, state: promptState };
      if (promptState !== 'started') return;
      yield { type: 'assistant', session_id: 'side-fork-new', message: { id: 'm-answer', role: 'assistant', content: [{ type: 'text', text: 'The real answer.' }] } };
      yield { type: 'result', subtype: 'success', session_id: 'side-fork-new', num_turns: 2, result: 'The real answer.' };
      yield { type: 'command_lifecycle', command_uuid: uuid, state: 'completed' };
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  };
}

async function runFork(impl, callOptions = { forkFrom: 'parent-provider-id', sideSession: true, permissionMode: 'plan' }) {
  const frames = [];
  __setClaudeQueryImpl(impl);
  try {
    await queryClaudeSDK('fork question', callOptions, { userId: null, setSessionId() {}, send(frame) { frames.push(frame); } });
  } finally {
    __setClaudeQueryImpl(null);
  }
  return frames;
}

const texts = frames => frames.filter(f => f.kind === 'text' && (f.role ?? 'assistant') === 'assistant').map(f => f.content);

test('a fork run completes only on the turn that consumed its prompt', async () => {
  const frames = await runFork(forkReplay());
  const completes = frames.filter(f => f.kind === 'complete');
  assert.equal(completes.length, 1, 'one completion for the run');
  assert.deepEqual(texts(frames), ['The real answer.'], 'turns before the prompt are not shown to the reader');
  const answerAt = frames.findIndex(f => f.kind === 'text' && f.content === 'The real answer.');
  assert.ok(answerAt >= 0 && answerAt < frames.indexOf(completes[0]), 'the answer streams before the completion');
});

test('a fork prompt the runtime cancels ends the run without an answer', async () => {
  const frames = await runFork(forkReplay({ promptState: 'cancelled' }));
  assert.equal(frames.filter(f => f.kind === 'complete').length, 1);
  assert.deepEqual(texts(frames), []);
});

test('a runtime without lifecycle narration keeps the first-result behaviour', async () => {
  const frames = await runFork(forkReplay({ capabilities: [] }));
  assert.ok(frames.some(f => f.kind === 'complete'));
  assert.deepEqual(texts(frames).slice(0, 1), ['No response requested.']);
});
