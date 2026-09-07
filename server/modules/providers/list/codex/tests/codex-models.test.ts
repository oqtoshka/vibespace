import assert from 'node:assert/strict';
import test from 'node:test';

import { CODEX_PREDEFINED_MODELS } from '@/modules/providers/list/codex/codex-models.provider.js';

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
