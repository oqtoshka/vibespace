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
