import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  CODEX_PREDEFINED_MODELS,
  CodexProviderModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

test('the Codex catalog offers GPT-6 Astra with every supported effort', () => {
  const astra = CODEX_PREDEFINED_MODELS.OPTIONS.find((model) => model.value === 'gpt-6-astra');

  assert.ok(astra);
  assert.equal(astra.label, 'GPT-6 Astra');
  assert.equal(astra.effort?.default, 'medium');
  assert.deepEqual(
    astra.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

test('the Codex catalog offers GPT-6 Sol and Luna with the supported effort levels', () => {
  const sol = CODEX_PREDEFINED_MODELS.OPTIONS.find((model) => model.value === 'gpt-6-sol');
  const luna = CODEX_PREDEFINED_MODELS.OPTIONS.find((model) => model.value === 'gpt-6-luna');

  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(CODEX_PREDEFINED_MODELS.DEFAULT, 'gpt-6-sol');
});

test('the bundled Codex CLI knows the GPT-6 Sol and Luna model metadata', () => {
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);

  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});

test('the Codex catalog fingerprint invalidates persisted catalogs from older releases', async () => {
  const provider = new CodexProviderModels();

  assert.equal(await provider.getCatalogFingerprint(), JSON.stringify(CODEX_PREDEFINED_MODELS));
});
