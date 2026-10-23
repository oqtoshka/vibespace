import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOpenCodeSystemInstructions } from '../services/opencode-system-instructions.service.js';

test('native instructions preserve inline config and append to the selected agent prompt', () => {
  const config = {
    model: 'local/model', permission: { edit: 'ask' },
    agent: { build: { prompt: 'Existing guidance', temperature: 0.2 }, plan: { prompt: 'Plan guidance' } },
  };
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PERMISSION: '{"edit":"allow"}' };
  const result = applyOpenCodeSystemInstructions(env, 'Card tools only', undefined);
  assert.deepEqual(JSON.parse(result.OPENCODE_CONFIG_CONTENT!), {
    ...config,
    agent: { ...config.agent, build: { ...config.agent.build, prompt: 'Existing guidance\n\nCard tools only' } },
  });
  assert.equal(result.OPENCODE_PERMISSION, env.OPENCODE_PERMISSION);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), config, 'input remains unchanged');
});

test('plan launches keep their plan agent while receiving the native override', () => {
  const result = applyOpenCodeSystemInstructions({}, 'Card tools only', 'plan');
  assert.deepEqual(JSON.parse(result.OPENCODE_CONFIG_CONTENT!), { agent: { plan: { prompt: 'Card tools only' } } });
});

test('ordinary launches keep their environment and malformed native config fails visibly', () => {
  const env = { OPENCODE_CONFIG_CONTENT: '{bad' };
  assert.equal(applyOpenCodeSystemInstructions(env, undefined, 'plan'), env);
  assert.throws(() => applyOpenCodeSystemInstructions(env, 'Card tools only', 'plan'), SyntaxError);
  assert.throws(() => applyOpenCodeSystemInstructions({ OPENCODE_CONFIG_CONTENT: '[]' }, 'Card tools only', 'plan'), /JSON object/);
});
