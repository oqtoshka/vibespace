import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, projectsDb, userDb } from '@/modules/database/index.js';
import { getProjectSessionsPage } from '../services/projects-with-sessions-fetch.service.js';
import { sessionsService, sessionConversationsSearchService } from '@/modules/providers/index.js';

// Integration checks cover filtering before pagination, totals, direct links,
// search and irreversible promotion using the same rows the API serves.
test('background lists filter before paging and count; search and direct links retain every run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'background-run-lists-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    userDb.createUser('example-operator', 'unused');
    for (const [id, provider, date] of [
      ['chat', 'codex', '2026-07-01T00:00:00Z'],
      ['background', 'codex', '2026-07-02T00:00:00Z'],
      ['other', 'claude', '2026-06-01T00:00:00Z'],
      // A Claude `claude -p` run: the same switch hides it.
      ['headless', 'claude', '2026-07-03T00:00:00Z'],
    ]) sessionsDb.createSession(id, provider, root, `Example ${id}`, date, date);
    sessionsDb.setSessionBackground('background', true);
    sessionsDb.setSessionBackground('headless', true);
    const project = projectsDb.getProjectPath(root)!;
    const hidden = await getProjectSessionsPage(project.project_id, { limit: 1 });
    assert.deepEqual(hidden.sessions.map(row => row.id), ['chat']);
    assert.deepEqual(hidden.sessionMeta, { total: 2, hasMore: true });
    const shown = await getProjectSessionsPage(project.project_id, { limit: 1, showBackgroundRuns: true });
    assert.deepEqual(shown.sessions.map(row => [row.id, row.isBackground]), [['headless', true]]);
    assert.deepEqual(shown.sessionMeta, { total: 4, hasMore: true });
    const everything = await getProjectSessionsPage(project.project_id, { showBackgroundRuns: true });
    assert.deepEqual(everything.sessions.map(row => [row.id, row.isBackground]),
      [['headless', true], ['background', true], ['chat', false], ['other', false]]);
    assert.equal(sessionsService.listRecentSessions(1, 0).conversations[0].sessionId, 'chat');
    assert.equal(sessionsService.listRecentSessions(1, 0).total, 2);
    assert.deepEqual(sessionsService.listRecentSessions(2, 0, true).conversations.map(row => [row.sessionId, row.isBackground]),
      [['headless', true], ['background', true]]);
    assert.equal(sessionsService.listRecentSessions(1, 0, true).total, 4);
    for (const id of ['background', 'headless']) {
      assert.equal(sessionsService.locateSessionById(id).sessionId, id);
      assert.equal(sessionsService.getSessionDetailsById(id).sessionId, id);
      const search = await sessionConversationsSearchService.searchPage({ query: id });
      assert.ok(search.results.some(row => row.sessionId === id && row.isBackground), id);
    }
    sessionsDb.updateSessionIsArchived('background', true);
    assert.equal(sessionsService.listArchivedSessions().length, 0);
    assert.equal(sessionsService.listArchivedSessions(true)[0].isBackground, true);
    sessionsDb.updateSessionIsArchived('background', false);
    sessionsDb.promoteBackgroundSession('background');
    sessionsDb.setSessionBackground('background', true);
    assert.equal(sessionsService.listRecentSessions(1, 0).conversations[0].sessionId, 'background');
    assert.equal((await getProjectSessionsPage(project.project_id)).sessionMeta.total, 3);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});
