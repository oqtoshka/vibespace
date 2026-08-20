import assert from 'node:assert/strict';
import test from 'node:test';

const { queryClaudeSDK, __setClaudeQueryImpl } = await import('./claude-sdk.js');

const nullWriter = () => ({ userId: null, setSessionId() {}, send() {} });

/**
 * Runs one turn against a stubbed SDK and hands back the options the runtime
 * built for it. The stub yields a bare `result` so the turn settles at once.
 */
async function optionsForTurn(callOptions) {
  let captured;
  __setClaudeQueryImpl(({ prompt, options }) => {
    captured = options;
    const gen = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: 'result', subtype: 'success', session_id: 'helper-env' };
    })();
    gen.interrupt = async () => {};
    gen.setModel = async () => {};
    gen.setPermissionMode = async () => {};
    return gen;
  });

  try {
    await queryClaudeSDK('summarise this', callOptions, nullWriter());
  } finally {
    __setClaudeQueryImpl(null);
  }
  return captured;
}

// A helper turn fires the same agent hooks a real one does, so presence boards
// (mc-reporter -> Mission Control) register every recap and commit message as
// a session: alive ~20s, no tasks, and unopenable, because `persistSession:
// false` means there is nothing to open. MC_DISABLE is the reporter's own
// documented opt-out for scripted one-shots.
test('an ephemeral helper turn is opted out of presence reporting', async () => {
  const options = await optionsForTurn({ sessionId: 'helper-env', ephemeral: true });

  assert.equal(options.env.MC_DISABLE, '1');
  // The opt-out rides on the host env rather than replacing it: since SDK
  // 0.2.113 `options.env` is the whole environment, so dropping the rest would
  // strip ANTHROPIC_BASE_URL and friends from the subprocess.
  assert.equal(options.env.PATH, process.env.PATH);
  assert.equal(options.persistSession, false);
});

test('an ordinary turn is left visible to presence reporting', async () => {
  const options = await optionsForTurn({ sessionId: 'helper-env-real', ephemeral: false });

  assert.equal(options.env.MC_DISABLE, undefined);
  assert.notEqual(options.persistSession, false);
});
