import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptSequencedEvent, replayPosition, type ReplayCursorMap } from './chatReplayCursor';

test('a replay of already applied events is dropped', () => {
  const cursors: ReplayCursorMap = new Map();
  assert.equal(acceptSequencedEvent(cursors, 's', 1, 'run-a'), true);
  assert.equal(acceptSequencedEvent(cursors, 's', 2, 'run-a'), true);
  // Tab refocus resubscribes and the server replays from lastSeq 0 or twice.
  assert.equal(acceptSequencedEvent(cursors, 's', 1, 'run-a'), false);
  assert.equal(acceptSequencedEvent(cursors, 's', 2, 'run-a'), false);
  assert.equal(acceptSequencedEvent(cursors, 's', 3, 'run-a'), true);
  assert.deepEqual(replayPosition(cursors, 's'), { lastSeq: 3, runId: 'run-a' });
});

test('a new run restarts the sequence instead of being dropped', () => {
  const cursors: ReplayCursorMap = new Map();
  for (let seq = 1; seq <= 50; seq += 1) acceptSequencedEvent(cursors, 's', seq, 'run-a');
  assert.equal(acceptSequencedEvent(cursors, 's', 1, 'run-b'), true);
  assert.equal(acceptSequencedEvent(cursors, 's', 2, 'run-b'), true);
  assert.deepEqual(replayPosition(cursors, 's'), { lastSeq: 2, runId: 'run-b' });
});

test('sessions keep separate positions', () => {
  const cursors: ReplayCursorMap = new Map();
  acceptSequencedEvent(cursors, 'a', 5, 'run-a');
  assert.equal(acceptSequencedEvent(cursors, 'b', 1, 'run-b'), true);
  assert.deepEqual(replayPosition(cursors, 'c'), { lastSeq: 0 });
});

test('events from a server without run ids are never dropped', () => {
  const cursors: ReplayCursorMap = new Map();
  assert.equal(acceptSequencedEvent(cursors, 's', 4, null), true);
  assert.equal(acceptSequencedEvent(cursors, 's', 1, null), true);
  assert.deepEqual(replayPosition(cursors, 's'), { lastSeq: 4 });
});
