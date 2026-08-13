import assert from 'node:assert/strict';
import test from 'node:test';

import { isDatabaseLockedError, stripAnsi } from '@/shared/utils.js';

// The exact bytes `opencode run` writes to stderr when opencode.db is held by
// another process — captured from a run that lost the race.
const COLOURED_LOCK_ERROR = '\u001B[91m\u001B[1mError: \u001B[0mUnexpected error\n\ndatabase is locked\n';

test('stripAnsi removes the colour codes opencode writes to a non-terminal stderr', () => {
  assert.equal(stripAnsi(COLOURED_LOCK_ERROR), 'Error: Unexpected error\n\ndatabase is locked\n');
});

test('stripAnsi leaves ordinary text alone', () => {
  assert.equal(stripAnsi('plain [not ansi] text'), 'plain [not ansi] text');
});

test('isDatabaseLockedError sees through the colour codes', () => {
  assert.equal(isDatabaseLockedError(COLOURED_LOCK_ERROR), true);
  assert.equal(isDatabaseLockedError(new Error(COLOURED_LOCK_ERROR)), true);
});

test('isDatabaseLockedError recognises better-sqlite3 busy errors by code', () => {
  const error = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  assert.equal(isDatabaseLockedError(error), true);

  // A busy error can also arrive with a message that never spells it out.
  const codeOnly = Object.assign(new Error('failed'), { code: 'SQLITE_BUSY_SNAPSHOT' });
  assert.equal(isDatabaseLockedError(codeOnly), true);
});

test('isDatabaseLockedError does not claim unrelated failures', () => {
  assert.equal(isDatabaseLockedError(new Error('opencode: command not found')), false);
  assert.equal(isDatabaseLockedError(null), false);
  assert.equal(isDatabaseLockedError(undefined), false);
});
