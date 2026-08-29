import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectSession } from '../types/app';

import { reconcileSelectedSession } from './projectSessionSelection';

test('reconciles generated title and recap into the active session snapshot', () => {
  const selectedSession: ProjectSession = {
    id: 'session-1',
    summary: 'Untitled Codex Session',
    recap: '',
    __provider: 'codex',
  };
  const refreshedSession: ProjectSession = {
    id: 'session-1',
    summary: 'Repair live recap titles',
    recap: 'Kept the active pane in sync with background recap generation.',
    provider: 'codex',
  };

  assert.deepEqual(reconcileSelectedSession(selectedSession, refreshedSession, 'codex'), {
    ...refreshedSession,
    __provider: 'codex',
  });
});

test('preserves object identity when active session metadata is already current', () => {
  const selectedSession: ProjectSession = {
    id: 'session-1',
    summary: 'Repair live recap titles',
    recap: 'Kept the active pane in sync with background recap generation.',
    provider: 'opencode',
    __provider: 'opencode',
  };

  assert.equal(
    reconcileSelectedSession(selectedSession, selectedSession, 'opencode'),
    selectedSession,
  );
});
