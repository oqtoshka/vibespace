import assert from 'node:assert/strict';
import test from 'node:test';

const { queryClaudeSDK, __setClaudeQueryImpl } = await import('./claude-sdk.js');
const { registerAgentEnvContributor } = await import('./shared/agent-env.js');

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

// Host plugins decide what a helper or private spawn means for the outside
// world (a presence reporter's opt-out, say). The runtime's contract is to
// tell them exactly what kind of spawn this is, and to merge whatever they
// return over the host env rather than replacing it: since SDK 0.2.113
// `options.env` is the whole environment, so dropping the rest would strip
// ANTHROPIC_BASE_URL and friends from the subprocess.
const seen = [];
const unregister = registerAgentEnvContributor((context) => {
  seen.push(context);
  return context.private || context.ephemeral ? { TEST_OPT_OUT: '1' } : null;
});
test.after(() => unregister());

test('an ephemeral helper turn is tagged for contributors and not persisted', async () => {
  seen.length = 0;
  const options = await optionsForTurn({ sessionId: 'helper-env', ephemeral: true });

  assert.equal(options.env.TEST_OPT_OUT, '1');
  assert.equal(options.env.PATH, process.env.PATH);
  assert.equal(options.persistSession, false);
  assert.deepEqual(seen.at(-1), {
    provider: 'claude', scope: 'session', private: false, ephemeral: true, sessionId: 'helper-env',
  });
});

test('an ordinary turn is tagged as neither private nor ephemeral', async () => {
  seen.length = 0;
  const options = await optionsForTurn({ sessionId: 'helper-env-real', ephemeral: false });

  assert.equal(options.env.TEST_OPT_OUT, undefined);
  assert.notEqual(options.persistSession, false);
  assert.equal(seen.at(-1).ephemeral, false);
  assert.equal(seen.at(-1).private, false);
});

// A private session is the user's own choice to stay off external channels
// (FEAT-INGEST-006), decided before the first turn. Unlike a helper turn the
// session itself is real and resumable, so persistence must stay on.
test('a private session is tagged for contributors but still persisted', async () => {
  seen.length = 0;
  const options = await optionsForTurn({ sessionId: 'helper-env-private', private: true });

  assert.equal(options.env.TEST_OPT_OUT, '1');
  assert.equal(options.env.PATH, process.env.PATH);
  assert.notEqual(options.persistSession, false);
  assert.equal(seen.at(-1).private, true);
});

test('a non-private, non-ephemeral turn gets nothing from an opt-out contributor', async () => {
  const options = await optionsForTurn({ sessionId: 'helper-env-plain', private: false, ephemeral: false });

  assert.equal(options.env.TEST_OPT_OUT, undefined);
});
