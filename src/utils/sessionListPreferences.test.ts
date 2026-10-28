import assert from 'node:assert/strict';
import test from 'node:test';

import { readShowBackgroundRuns, writeShowBackgroundRuns, visibleListSessions } from './sessionListPreferences';

test('background visibility defaults off, persists per user, and announces changes', () => {
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const values = new Map<string, string>();
  const events: Event[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => events.push(event) } });
  try {
    assert.equal(readShowBackgroundRuns('first'), false);
    writeShowBackgroundRuns('first', true);
    assert.equal(readShowBackgroundRuns('first'), true);
    assert.equal(readShowBackgroundRuns('second'), false);
    assert.equal(events.length, 1);
    const sessions = [{ id: 'exec', isBackground: true }, { id: 'interactive', isBackground: false }, { id: 'legacy' }];
    assert.deepEqual(visibleListSessions(sessions).map(row => row.id), ['interactive', 'legacy']);
    assert.equal(visibleListSessions(sessions, true), sessions);
    writeShowBackgroundRuns('first', false);
    assert.equal(readShowBackgroundRuns('first'), false);
    assert.equal(visibleListSessions([{ id: 'resumed', isBackground: false }]).length, 1);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  }
});
