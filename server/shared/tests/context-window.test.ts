import assert from 'node:assert/strict';
import test from 'node:test';

import { clearContextUsageCache, recallContextUsage, rememberContextUsage } from '@/shared/context-usage-cache.js';
import type { ContextUsage } from '@/shared/types.js';
import { readFiniteNumber, resolveConfiguredContextWindow } from '@/shared/utils.js';

const usage = (maxTokens: number): ContextUsage => ({
  totalTokens: 1000,
  maxTokens,
  percentage: 1,
  isAutoCompactEnabled: false,
});

/**
 * There is deliberately no built-in window default: the same model id answers
 * 1,000,000 through one deployment and 200,000 through another, and this value
 * drives a percentage the user acts on. Guessing produced "83% full" for a
 * context that was actually 3% full.
 */
test('resolveConfiguredContextWindow reports unknown when nothing is configured', () => {
  const previous = process.env.CONTEXT_WINDOW;
  delete process.env.CONTEXT_WINDOW;
  try {
    assert.equal(resolveConfiguredContextWindow(), null);
  } finally {
    if (previous !== undefined) process.env.CONTEXT_WINDOW = previous;
  }
});

test('resolveConfiguredContextWindow honors an explicit CONTEXT_WINDOW', () => {
  const previous = process.env.CONTEXT_WINDOW;
  process.env.CONTEXT_WINDOW = '64000';
  try {
    assert.equal(resolveConfiguredContextWindow(), 64_000);
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_WINDOW;
    else process.env.CONTEXT_WINDOW = previous;
  }
});

test('resolveConfiguredContextWindow ignores an unusable CONTEXT_WINDOW value', () => {
  const previous = process.env.CONTEXT_WINDOW;
  for (const value of ['', 'lots', '0', '-1']) {
    process.env.CONTEXT_WINDOW = value;
    assert.equal(resolveConfiguredContextWindow(), null, `for CONTEXT_WINDOW=${value}`);
  }
  if (previous === undefined) delete process.env.CONTEXT_WINDOW;
  else process.env.CONTEXT_WINDOW = previous;
});

test('context usage cache round-trips the last reading for a session', () => {
  clearContextUsageCache();
  assert.equal(recallContextUsage('s1'), null);

  rememberContextUsage('s1', usage(1_000_000));
  assert.equal(recallContextUsage('s1')?.maxTokens, 1_000_000);

  // A later turn's reading replaces the earlier one.
  rememberContextUsage('s1', usage(200_000));
  assert.equal(recallContextUsage('s1')?.maxTokens, 200_000);

  // A session id we never recorded stays unknown rather than borrowing
  // another session's window.
  assert.equal(recallContextUsage('s2'), null);
  assert.equal(recallContextUsage(null), null);
  assert.equal(recallContextUsage(undefined), null);
  clearContextUsageCache();
});

test('context usage cache evicts least-recently-recorded sessions', () => {
  clearContextUsageCache();
  for (let i = 0; i < 205; i += 1) {
    rememberContextUsage(`s${i}`, usage(1000 + i));
  }

  // Oldest entries dropped, newest kept — a bounded map, not a leak.
  assert.equal(recallContextUsage('s0'), null);
  assert.equal(recallContextUsage('s4'), null);
  assert.equal(recallContextUsage('s204')?.maxTokens, 1204);
  clearContextUsageCache();
});

/**
 * The distinction that matters for compaction metadata: a missing
 * `post_tokens` must not be reported as a context that shrank to zero.
 */
test('readFiniteNumber separates absent from zero', () => {
  assert.equal(readFiniteNumber(0), 0);
  assert.equal(readFiniteNumber('12'), 12);
  assert.equal(readFiniteNumber(null), null);
  assert.equal(readFiniteNumber(undefined), null);
  assert.equal(readFiniteNumber(''), null);
  assert.equal(readFiniteNumber('nope'), null);
  assert.equal(readFiniteNumber(Number.NaN), null);
});
