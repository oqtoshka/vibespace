import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexTokenBudget } from '@/shared/codex-token-usage.js';

test('Codex context meter uses last usage instead of cumulative session spend', () => {
  const budget = buildCodexTokenBudget({
    total_token_usage: {
      input_tokens: 1_273_395,
      output_tokens: 19_337,
      total_tokens: 1_292_732,
    },
    last_token_usage: {
      input_tokens: 92_832,
      output_tokens: 68,
      total_tokens: 92_900,
    },
    model_context_window: 258_400,
  });

  assert.ok(budget);
  assert.equal(budget.used, 92_900);
  assert.equal(budget.total, 258_400);
  assert.equal(budget.sessionTotalTokens, 1_292_732);
  assert.equal(budget.inputTokens, 1_273_395);
  assert.equal(budget.outputTokens, 19_337);
  assert.ok((budget.used / budget.total) * 100 < 36);
});

test('legacy Codex usage never divides cumulative spend by a context window', () => {
  const budget = buildCodexTokenBudget({
    total_token_usage: {
      input_tokens: 300_000,
      output_tokens: 20_000,
      total_tokens: 320_000,
    },
    model_context_window: 200_000,
  });

  assert.ok(budget);
  assert.equal(budget.used, 320_000);
  assert.equal(budget.total, 0);
  assert.equal(budget.sessionTotalTokens, 320_000);
});

test('Codex token usage ignores empty or malformed readings', () => {
  assert.equal(buildCodexTokenBudget(null), null);
  assert.equal(buildCodexTokenBudget({}), null);
  assert.equal(buildCodexTokenBudget({ total_token_usage: { total_tokens: 'nope' } }), null);
});
