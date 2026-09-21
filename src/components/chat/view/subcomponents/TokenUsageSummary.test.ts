import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveContextGauge } from './TokenUsageSummary';

test('estimated gauge draws the compaction mark a Codex budget carries', () => {
  const gauge = resolveContextGauge({ used: 90_100, total: 258_400, autoCompactThreshold: 160_000 });
  assert.ok(gauge);
  assert.equal(gauge.estimated, true);
  assert.equal(gauge.compactAtPercent, 62);
  assert.equal(gauge.autoCompactEnabled, true);
});

test('estimated gauge without a threshold still promises no compaction', () => {
  const gauge = resolveContextGauge({ used: 90_100, total: 258_400 });
  assert.ok(gauge);
  assert.equal(gauge.compactAtPercent, null);
  assert.equal(gauge.autoCompactEnabled, false);
});
