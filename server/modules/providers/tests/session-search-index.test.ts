import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { inflateRawSync } from 'node:zlib';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import { sessionSearchIndexService } from '../services/session-search-index.service.js';
import { sessionsService } from '../services/sessions.service.js';

const message = (id: string, text: string, timestamp: string) => ({
  type: 'response_item',
  timestamp,
  payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] },
});

test('exact source scope and signed continuation never broaden or substitute a page', { concurrency: false }, async t => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-search-scope-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'scope.db');
  try {
    await initializeDatabase();
    userDb.createUser('scope-operator', 'unused');
    const project = projectsDb.createProjectPath(directory, 'Scope fixture').project!;
    for (const id of ['selected-session', 'stronger-session']) {
      const transcript = path.join(directory, `${id}.jsonl`);
      await writeFile(transcript, Array.from({ length: 16 }, (_, index) => JSON.stringify(
        message(`${id}-${index}`, `Alpha beta retained occurrence ${index}`, '2026-01-01T00:00:00.000Z'),
      )).join('\n') + '\n');
      sessionsDb.createSession(id, 'codex', directory,
        id === 'selected-session' ? 'Selected conversation' : 'Alpha beta alpha beta', undefined, undefined, transcript);
    }
    sessionsDb.createAppSession('private-scope', 'codex', directory, false, true, 'Alpha beta private');
    const input = { query: 'alpha beta', sessionId: 'selected-session', limit: 3, projectId: project.project_id };
    const first = await sessionSearchIndexService.search(input);
    assert.ok(first.nextCursor);
    const cursor = first.nextCursor;
    const generation = first.index.generation;

    await t.test('session restriction precedes count, ranking and both phrase and ordinary paging', async () => {
      assert.equal(first.total, 16);
      assert.equal(first.results.length, 3);
      assert.ok(first.results.every(row => row.sessionId === input.sessionId));
      const second = await sessionSearchIndexService.search({ ...input, cursor });
      assert.equal(new Set([...first.results, ...second.results].map(row => row.messageId)).size, 6);
      assert.ok(second.results.every(row => row.sessionId === input.sessionId));
      const phrase = await sessionSearchIndexService.search({ ...input, matchType: 'phrase' });
      assert.equal(phrase.total, 16);
      assert.ok(phrase.results.every(row => row.sessionId === input.sessionId));
      const global = await sessionSearchIndexService.search({ query: input.query });
      assert.ok(global.total > first.total);
      assert.equal(global.results[0]?.sessionId, 'stronger-session');
      for (const sessionId of ['missing-session', 'private-scope']) {
        const missing = await sessionSearchIndexService.search({ ...input, sessionId });
        assert.equal(missing.total, 0);
        assert.deepEqual(missing.results, []);
        assert.equal(missing.nextCursor, null);
      }
      assert.equal((await sessionSearchIndexService.search({ ...input, projectId: 'another-project' })).total, 0);
      assert.equal((await sessionSearchIndexService.search({ ...input, archived: 'archived' })).total, 0);
    });

    await t.test('unrelated live updates preserve scoped order, scores and continuation', async () => {
      for (const matchType of ['all', 'phrase', 'content', 'prefix'] as const) {
        const scoped = { ...input, matchType };
        const expected = await sessionSearchIndexService.search({ ...scoped, limit: 100 });
        const page = await sessionSearchIndexService.search(scoped);
        assert.ok(page.nextCursor);
        const globalBefore = await sessionSearchIndexService.sync();
        sessionsDb.updateSessionCustomName('stronger-session', `Unrelated active ${matchType}`);
        await writeFile(path.join(directory, 'stronger-session.jsonl'), Array.from({ length: 40 }, (_, index) =>
          JSON.stringify(message(`updated-${index}`, `${'alpha '.repeat(index + 1)}beta unrelated live update`,
            '2026-01-02T00:00:00.000Z'))).join('\n') + '\n');
        const globalAfter = await sessionSearchIndexService.sync();
        assert.notEqual(globalAfter.generation, globalBefore.generation);
        const continued = await sessionSearchIndexService.search({ ...scoped, cursor: page.nextCursor });
        assert.equal(continued.index.generation, page.index.generation);
        assert.equal(continued.total, page.total);
        assert.deepEqual([...page.results, ...continued.results].map(row => [row.messageId, row.score]),
          expected.results.slice(0, 6).map(row => [row.messageId, row.score]));
      }
    });

    const changes: Array<[string, Partial<Parameters<typeof sessionSearchIndexService.search>[0]>]> = [
      ['query', { query: 'retained' }], ['session', { sessionId: 'stronger-session' }],
      ['all-session scope', { sessionId: undefined }], ['project', { projectId: undefined }],
      ['provider', { provider: 'codex' }], ['archive filter', { archived: 'active' }],
      ['start date', { from: '2025-01-01T00:00:00Z' }], ['end date', { to: '2027-01-01T00:00:00Z' }],
      ['match type', { matchType: 'phrase' }], ['page size', { limit: 4 }],
    ];
    for (const [name, change] of changes) await t.test(`continuation rejects changed ${name}`, async () => {
      await assert.rejects(sessionSearchIndexService.search({ ...input, ...change, cursor }), /invalid or stale/);
    });

    await t.test('blank and malformed session restrictions fail rather than widening the query', async () => {
      for (const sessionId of ['', ' ', 'x'.repeat(201), ['selected-session'], 1]) {
        await assert.rejects(sessionSearchIndexService.search({ ...input, sessionId: sessionId as string }), /Invalid session restriction/);
      }
    });
    await t.test('position and signature tampering, legacy cursors and oversized tokens are refused', async () => {
      const [payload, signature] = cursor.split('.');
      const changed = JSON.parse(Buffer.from(payload, 'base64url').toString());
      changed.offset = 10;
      const forged = `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`;
      for (const token of ['', forged, `${payload}.${'0'.repeat(64)}`, `${cursor}.extra`, 'x'.repeat(4097),
        Buffer.from(JSON.stringify({ offset: 3, generation })).toString('base64url')]) {
        await assert.rejects(sessionSearchIndexService.search({ ...input, cursor: token }), /invalid or stale/);
      }
    });
    await t.test('cursor expires and refuses clocks moving behind its issuance', async () => {
      const issued = Date.now();
      const clock = mock.method(Date, 'now', () => issued + 10 * 60 * 1000 + 1000);
      try {
        await assert.rejects(sessionSearchIndexService.search({ ...input, cursor }), /invalid or stale/);
        clock.mock.mockImplementation(() => issued - 60_000);
        await assert.rejects(sessionSearchIndexService.search({ ...input, cursor }), /invalid or stale/);
      } finally { clock.mock.restore(); }
    });
    await t.test('cursor binds the active operator even when the source generation stays identical', async () => {
      const user = userDb.getSingleActiveUser()!;
      const account = mock.method(userDb, 'getSingleActiveUser', () => ({ ...user, id: Number(user.id) + 1 }));
      const sync = mock.method(sessionSearchIndexService, 'sync', async () => ({ generation, indexed: 0 }));
      try { await assert.rejects(sessionSearchIndexService.search({ ...input, cursor }), /invalid or stale/); }
      finally { account.mock.restore(); sync.mock.restore(); }
    });
    await t.test('operator change during provider refresh returns no rows, even on a first page', async () => {
      const user = userDb.getSingleActiveUser()!;
      let reads = 0;
      const account = mock.method(userDb, 'getSingleActiveUser', () => reads++ === 0 ? user : { ...user, id: Number(user.id) + 1 });
      const sync = mock.method(sessionSearchIndexService, 'sync', async () => ({ generation, indexed: 0 }));
      try { await assert.rejects(sessionSearchIndexService.search(input), /Operator changed during search/); }
      finally { account.mock.restore(); sync.mock.restore(); }
    });
    await t.test('a new source process refuses continuation signed by the previous process', async () => {
      const restarted = await import(new URL('../services/session-search-index.service.ts?restart-fixture', import.meta.url).href);
      await assert.rejects(restarted.sessionSearchIndexService.search({ ...input, cursor }), /invalid or stale/);
    });
    await t.test('eviction and a replacement first page never substitute an old cursor snapshot', async () => {
      const page = await sessionSearchIndexService.search({ ...input, limit: 1 });
      assert.ok(page.nextCursor);
      for (let index = 1; index <= 33; index++) {
        await sessionSearchIndexService.search({ ...input, query: `${'alpha '.repeat(index)}beta`, limit: 2 });
      }
      await assert.rejects(sessionSearchIndexService.search({ ...input, limit: 1, cursor: page.nextCursor }), /invalid or stale/);
      const replacement = await sessionSearchIndexService.search({ ...input, limit: 1 });
      assert.notEqual(replacement.index.generation, page.index.generation);
      await assert.rejects(sessionSearchIndexService.search({ ...input, limit: 1, cursor: page.nextCursor }), /invalid or stale/);
      const continued = await sessionSearchIndexService.search({ ...input, limit: 1, cursor: replacement.nextCursor! });
      assert.notEqual(continued.results[0]?.messageId, replacement.results[0]?.messageId);
    });

    await t.test('archive changes invalidate old pages and preserve exact scope on a new page', async () => {
      sessionsDb.updateSessionIsArchived(input.sessionId, true);
      await assert.rejects(sessionSearchIndexService.search({ ...input, cursor }), /invalid or stale/);
      assert.equal((await sessionSearchIndexService.search({ ...input, archived: 'active' })).total, 0);
      const archived = await sessionSearchIndexService.search({ ...input, archived: 'archived' });
      assert.equal(archived.total, 16);
      assert.ok(archived.results.every(row => row.sessionId === input.sessionId && row.archived));
    });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('indexed search covers old pages, archives and titles without duplicates or private leakage', { concurrency: false }, async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-search-index-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'search.db');
  try {
    await initializeDatabase();
    userDb.createUser('search-operator', 'unused');
    const project = projectsDb.createProjectPath(directory, 'Search fixture').project;
    assert.ok(project);

    const longTranscript = path.join(directory, 'long.jsonl');
    const longEntries = [
      message('legacy-only', 'The legacy migration lives only on the oldest page.', '2025-01-01T00:00:00.000Z'),
      message('huge-output', `Useful beginning ${'x'.repeat(100_000)} terminalfailure`, '2025-01-01T00:01:00.000Z'),
      message('phrase-exact', 'The alpha beta wording is contiguous.', '2025-01-01T00:02:00.000Z'),
      message('phrase-split', 'Alpha has an intervening word before beta.', '2025-01-01T00:03:00.000Z'),
    ];
    for (let index = 0; index < 620; index += 1) {
      longEntries.push(message(`recent-${index}`, `Routine recent note ${index}`, `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`));
    }
    await writeFile(longTranscript, longEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    sessionsDb.createSession('long-session', 'codex', directory, 'Long transcript', undefined, undefined, longTranscript);
    const newest = await sessionsService.fetchHistory('long-session', { limit: 500, offset: 0 });
    const oldest = await sessionsService.fetchHistory('long-session', { limit: 500, offset: newest.messages.length });
    assert.equal(newest.messages.length, 500);
    const legacyHistoryMessage = oldest.messages.find(item => item.content?.includes('legacy migration'));
    assert.ok(legacyHistoryMessage, JSON.stringify({
      newest: [newest.total, newest.hasMore, newest.messages[0]?.content, newest.messages.at(-1)?.content],
      oldest: [oldest.total, oldest.hasMore, oldest.messages.length, oldest.messages[0]?.content, oldest.messages.at(-1)?.content],
    }));
    assert.equal(legacyHistoryMessage.id, 'legacy-only');

    const archivedTranscript = path.join(directory, 'archived.jsonl');
    const archivedLine = message('archived-hit', 'Only the moonarchive session contains this token.', '2024-02-01T00:00:00.000Z');
    await writeFile(archivedTranscript, `${JSON.stringify(archivedLine)}\n${JSON.stringify(archivedLine)}\n`);
    const archivedId = sessionsDb.createSession('archived-session', 'codex', directory, 'Archived evidence', undefined, undefined, archivedTranscript);
    sessionsDb.updateSessionIsArchived(archivedId, true);

    sessionsDb.createAppSession('title-session', 'codex', directory, 'Needle title only');
    sessionsDb.createAppSession('private-session', 'codex', directory, false, true, 'privateleak title');

    const legacy = await sessionSearchIndexService.search({ query: 'legacy', archived: 'all', limit: 10 });
    assert.equal(legacy.results.length, 1);
    assert.equal(legacy.results[0]?.sessionId, 'long-session');
    assert.equal(legacy.results[0]?.messageId, 'legacy-only');
    assert.equal(legacy.results[0]?.title, 'Long transcript');
    const bounded = await sessionSearchIndexService.search({ query: 'terminalfailure', archived: 'all', limit: 10 });
    assert.equal(bounded.results[0]?.messageId, 'huge-output', 'the tail of oversized command output remains searchable');
    const indexedPayloads = getConnection().prepare('SELECT compressed_content FROM session_search_documents')
      .all() as Array<{ compressed_content: Buffer }>;
    assert.ok(Math.max(...indexedPayloads.map(row => inflateRawSync(row.compressed_content).length)) < 33_000,
      'the index does not duplicate unbounded tool output');
    const phrase = await sessionSearchIndexService.search({ query: 'alpha beta', matchType: 'phrase' });
    assert.deepEqual(phrase.results.map(result => result.messageId), ['phrase-exact']);

    const activeOnly = await sessionSearchIndexService.search({ query: 'moonarchive', archived: 'active' });
    assert.equal(activeOnly.total, 0);
    const archivedOnly = await sessionSearchIndexService.search({ query: 'moonarchive', archived: 'archived' });
    assert.equal(archivedOnly.total, 1, 'duplicate provider records are indexed once');
    assert.equal(archivedOnly.results[0]?.sessionId, archivedId);
    assert.equal(archivedOnly.results[0]?.archived, true);
    assert.equal((await sessionSearchIndexService.search({ query: 'moonarc', matchType: 'prefix', archived: 'archived' })).total, 1);
    assert.equal((await sessionSearchIndexService.search({ query: 'moonarchive', provider: 'opencode' })).total, 0);

    const title = await sessionSearchIndexService.search({ query: 'Needle title', matchType: 'title' });
    assert.equal(title.total, 1);
    assert.equal(title.results[0]?.matchedField, 'title');
    assert.equal(title.results[0]?.openPath, '/session/title-session');
    assert.equal((await sessionSearchIndexService.search({ query: 'privateleak' })).total, 0);

    const first = await sessionSearchIndexService.search({ query: 'routine', limit: 7, projectId: project.project_id });
    assert.equal(first.results.length, 7);
    assert.ok(first.nextCursor);
    const second = await sessionSearchIndexService.search({ query: 'routine', limit: 7, cursor: first.nextCursor!, projectId: project.project_id });
    assert.equal(second.results.length, 7);
    assert.equal(new Set([...first.results, ...second.results].map(row => row.messageId)).size, 14);
    assert.equal((await sessionSearchIndexService.search({ query: 'routine', to: '2025-12-31T23:59:59Z' })).total, 0);

    sessionsDb.updateSessionCustomName('title-session', 'Renamed searchable title');
    assert.equal((await sessionSearchIndexService.search({ query: 'Renamed searchable', matchType: 'title' })).total, 1);
    await assert.rejects(sessionSearchIndexService.search({ query: 'routine', limit: 7, cursor: first.nextCursor!,
      projectId: project.project_id }), /invalid or stale/);
    sessionsDb.deleteSessionById('title-session');
    assert.equal((await sessionSearchIndexService.search({ query: 'Renamed searchable', matchType: 'title' })).total, 0);
    assert.equal(Number((getConnection().prepare('SELECT count(*) AS count FROM session_search_state WHERE session_id = ?')
      .get('title-session') as { count: number }).count), 0);

    const retryTranscript = path.join(directory, 'retry.jsonl');
    await writeFile(retryTranscript, `${JSON.stringify(message('retry-hit', 'Eventually indexed after a transient read failure.', '2026-02-01T00:00:00.000Z'))}\n`);
    sessionsDb.createSession('retry-session', 'codex', directory, 'Retry transcript', undefined, undefined, retryTranscript);
    const realFetch = sessionsService.fetchFullHistoryForIndex.bind(sessionsService);
    let retryAttempts = 0;
    const fetch = mock.method(sessionsService, 'fetchFullHistoryForIndex', async (sessionId: string) => {
      if (sessionId === 'retry-session' && retryAttempts++ === 0) throw new Error('temporary read failure');
      return realFetch(sessionId);
    });
    try {
      assert.equal((await sessionSearchIndexService.search({ query: 'Eventually indexed' })).total, 0);
      assert.equal(getConnection().prepare('SELECT source_fingerprint FROM session_search_state WHERE session_id = ?')
        .get('retry-session'), undefined, 'a failed transcript read is not marked indexed');
      assert.equal((await sessionSearchIndexService.search({ query: 'Eventually indexed' })).total, 1);
      assert.equal(retryAttempts, 2);
    } finally {
      fetch.mock.restore();
    }
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
