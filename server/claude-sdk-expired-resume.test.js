import assert from 'node:assert/strict';
import test from 'node:test';

const { queryClaudeSDK, __setClaudeQueryImpl, getActiveClaudeSDKSessions } = await import('./claude-sdk.js');

/**
 * A session whose transcript Claude Code's cleanup deleted cannot be resumed
 * ("No conversation found"). The message must then start a new conversation —
 * not vanish into the failed process, which still answered to the app id while
 * the retry looked it up (2026-10-18: the chat sat on "Connecting" forever).
 */
test('a message to a session whose transcript is gone starts a new conversation that carries the recap', async () => {
  const calls = [];
  __setClaudeQueryImpl(({ prompt, options }) => {
    const call = { options, content: null };
    calls.push(call);
    const gen = (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      call.content = first.value?.message?.content;
      if (options.resume) {
        throw new Error(`Claude Code returned an error result: No conversation found with session ID: ${options.resume}`);
      }
      yield { type: 'system', subtype: 'init', session_id: 'fresh-provider', model: 'claude-opus' };
      yield { type: 'result', subtype: 'success', session_id: 'fresh-provider' };
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  });
  const frames = [];
  const writer = { userId: null, setSessionId() {}, send(frame) { frames.push(frame); } };
  const context = {
    resolveProviderSessionId: (id) => (id === 'app-expired' ? 'expired-provider' : id),
    describePriorConversation: async (id) => (id === 'app-expired'
      ? 'Earlier session: Инфраструктурные сервисы\nRecap of where it stood: registry GC deployed'
      : null),
  };
  try {
    await queryClaudeSDK('Прошло уже много времени, актуализируй вопросы', { sessionId: 'app-expired', permissionMode: 'bypassPermissions' }, writer, context);
    for (let i = 0; i < 50 && calls.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    __setClaudeQueryImpl(null);
  }

  assert.equal(calls.length, 2, 'the failed resume is followed by a fresh query');
  assert.equal(calls[0].options.resume, 'expired-provider');
  assert.equal(calls[1].options.resume, undefined);
  assert.equal(JSON.stringify(calls[1].content).includes('Прошло уже много времени'), true, 'the message reaches the new conversation as typed');
  assert.match(calls[1].options.systemPrompt.append, /registry GC deployed/);
  assert.match(calls[1].options.systemPrompt.append, /no longer exists/);
  assert.ok(frames.some((frame) => frame.kind === 'error' && /transcript is gone/.test(frame.content)));
  assert.ok(!getActiveClaudeSDKSessions().includes('expired-provider'), 'the dead process is no longer reachable');
});
