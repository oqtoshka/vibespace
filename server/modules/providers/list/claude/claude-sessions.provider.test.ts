import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { ClaudeSessionsProvider } from './claude-sessions.provider.js';

/**
 * Regression coverage for inline subagent nesting.
 *
 * Claude keeps Task/subagent transcripts at
 *   <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl
 * The history provider must discover them there (the old code only looked in
 * the flat <projectDir>, so nesting silently produced nothing) and attach the
 * parsed tools to the parent tool_use message as `subagentTools`.
 */
async function withIsolatedDatabase(runTest: (tempDir: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'claude-provider-'));
  const databasePath = path.join(tempDir, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest(tempDir);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDir, { recursive: true, force: true });
  }
}

function jsonl(...records: Array<Record<string, unknown>>): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

const SESSION = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = 'aaaa1111bbbb2222';

test('fetchHistory nests subagent tools discovered under <sessionId>/subagents/', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const projectDir = path.join(tempDir, 'projects', '-demo');
    const subagentDir = path.join(projectDir, SESSION, 'subagents');
    await mkdir(subagentDir, { recursive: true });

    const mainFile = path.join(projectDir, `${SESSION}.jsonl`);
    await writeFile(mainFile, jsonl(
      {
        type: 'assistant',
        sessionId: SESSION,
        cwd: '/demo',
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'Task', input: { description: 'do work' } }] },
      },
      {
        type: 'user',
        sessionId: SESSION,
        cwd: '/demo',
        uuid: 'u1',
        timestamp: '2026-01-01T00:00:02.000Z',
        toolUseResult: { agentId: AGENT_ID },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'done' }] },
      },
    ));

    // The subagent transcript lives one level down, in the session's subfolder.
    await writeFile(path.join(subagentDir, `agent-${AGENT_ID}.jsonl`), jsonl({
      type: 'assistant',
      sessionId: SESSION,
      isSidechain: true,
      uuid: 's1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'subtool1', name: 'Bash', input: { command: 'ls' } }] },
    }));

    sessionsDb.createSession(SESSION, 'claude', '/demo', 'Demo', undefined, undefined, mainFile);

    const result = await new ClaudeSessionsProvider().fetchHistory(SESSION, { limit: null });
    const toolUse = result.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'tool1');

    assert.ok(toolUse, 'parent Task tool_use should be present');
    assert.ok(Array.isArray(toolUse?.subagentTools), 'subagentTools must be attached to the parent tool call');
    assert.equal((toolUse?.subagentTools as unknown[]).length, 1, 'the one subagent tool should be nested inline');
    assert.equal((toolUse?.subagentTools as Array<{ toolName: string }>)[0].toolName, 'Bash');
  });
});

const CLEANED_SESSION = '44444444-4444-4444-8444-444444444444';

test('fetchHistory flags transcriptMissing when the indexed JSONL was deleted from disk', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    // Claude Code's cleanupPeriodDays cleanup deletes old transcripts while the
    // DB row (and its jsonl_path) stays behind — the flag is what lets the UI
    // tell that apart from a genuinely empty session.
    const goneFile = path.join(tempDir, 'projects', '-demo', `${CLEANED_SESSION}.jsonl`);
    sessionsDb.createSession(CLEANED_SESSION, 'claude', '/demo', 'Demo', undefined, undefined, goneFile);

    const result = await new ClaudeSessionsProvider().fetchHistory(CLEANED_SESSION, { limit: null });

    assert.equal(result.transcriptMissing, true);
    assert.deepEqual(result.messages, []);
    assert.equal(result.total, 0);
  });
});

test('fetchHistory does not flag transcriptMissing for a transcript that exists', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const projectDir = path.join(tempDir, 'projects', '-demo');
    await mkdir(projectDir, { recursive: true });
    const mainFile = path.join(projectDir, `${CLEANED_SESSION}.jsonl`);
    await writeFile(mainFile, jsonl(
      { type: 'user', sessionId: CLEANED_SESSION, uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
    ));
    sessionsDb.createSession(CLEANED_SESSION, 'claude', '/demo', 'Demo', undefined, undefined, mainFile);

    const result = await new ClaudeSessionsProvider().fetchHistory(CLEANED_SESSION, { limit: null });

    assert.equal(result.transcriptMissing, undefined);
    assert.equal(result.messages.length, 1);
  });
});

const SHUTDOWN_SESSION = '55555555-5555-4555-8555-555555555555';

// A tool that was in flight when the CLI was shut down (here: the watchdog
// kickstarting a momentarily unresponsive vibespace) is written to the
// transcript with the *same* result text as a real refusal — "The user doesn't
// want to proceed…" — and `interruptedByShutdown: true`. Only that flag
// separates the two, so it has to survive into the message the UI renders;
// without it the transcript tells the reader they declined a prompt they were
// never shown.
test('fetchHistory carries interruptedByShutdown onto a tool result the CLI closed out', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const projectDir = path.join(tempDir, 'projects', '-demo');
    await mkdir(projectDir, { recursive: true });
    const mainFile = path.join(projectDir, `${SHUTDOWN_SESSION}.jsonl`);
    await writeFile(mainFile, jsonl(
      {
        type: 'assistant',
        sessionId: SHUTDOWN_SESSION,
        cwd: '/demo',
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'sleep 30' } }] },
      },
      {
        type: 'user',
        sessionId: SHUTDOWN_SESSION,
        cwd: '/demo',
        uuid: 'u1',
        timestamp: '2026-01-01T00:00:01.000Z',
        toolUseResult: 'User rejected tool use',
        toolDenialKind: 'user-rejected',
        interruptedByShutdown: true,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool1',
            is_error: true,
            content: "The user doesn't want to proceed with this tool use.",
          }],
        },
      },
    ));

    sessionsDb.createSession(SHUTDOWN_SESSION, 'claude', '/demo', 'Demo', undefined, undefined, mainFile);

    const result = await new ClaudeSessionsProvider().fetchHistory(SHUTDOWN_SESSION, { limit: null });
    const toolUse = result.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'tool1');

    assert.ok(toolUse, 'the tool_use message should be present');
    assert.equal(toolUse?.toolResult?.isError, true);
    assert.equal(toolUse?.toolResult?.interruptedByShutdown, true);
  });
});

const REWIND_SESSION = '33333333-3333-4333-8333-333333333333';

function conversationJsonl(): string {
  return jsonl(
    { type: 'user', sessionId: REWIND_SESSION, uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first question' } },
    { type: 'assistant', sessionId: REWIND_SESSION, uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: 'first answer' } },
    { type: 'user', sessionId: REWIND_SESSION, uuid: 'u2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'second question' } },
    { type: 'assistant', sessionId: REWIND_SESSION, uuid: 'a2', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: 'second answer' } },
  );
}

test('rewindHistory truncates the transcript at the edited message and backs it up', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const projectDir = path.join(tempDir, 'projects', '-demo');
    await mkdir(projectDir, { recursive: true });
    const mainFile = path.join(projectDir, `${REWIND_SESSION}.jsonl`);
    await writeFile(mainFile, conversationJsonl());
    sessionsDb.createSession(REWIND_SESSION, 'claude', '/demo', 'Demo', undefined, undefined, mainFile);

    const provider = new ClaudeSessionsProvider();
    // Rewind to the SECOND user turn — u2 and everything after it must go.
    const result = await provider.rewindHistory(REWIND_SESSION, 'u2');

    assert.deepEqual(result, { ok: true, startFresh: false, removed: 2 });

    const remaining = await provider.fetchHistory(REWIND_SESSION, { limit: null });
    const contents = remaining.messages.map((m) => m.content);
    assert.deepEqual(contents, ['first question', 'first answer'], 'only the kept prefix remains');

    // The original transcript is preserved as a backup beside the truncated file.
    const backups = (await readdir(projectDir)).filter((f) => f.includes('.rewind-') && f.endsWith('.bak'));
    assert.equal(backups.length, 1, 'a single backup was written');
    const backupBody = await readFile(path.join(projectDir, backups[0]), 'utf8');
    assert.match(backupBody, /second answer/, 'backup retains the discarded tail');
  });
});

test('rewindHistory reports startFresh (and leaves the file intact) for the first user turn', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const projectDir = path.join(tempDir, 'projects', '-demo');
    await mkdir(projectDir, { recursive: true });
    const mainFile = path.join(projectDir, `${REWIND_SESSION}.jsonl`);
    const original = conversationJsonl();
    await writeFile(mainFile, original);
    sessionsDb.createSession(REWIND_SESSION, 'claude', '/demo', 'Demo', undefined, undefined, mainFile);

    const provider = new ClaudeSessionsProvider();
    const result = await provider.rewindHistory(REWIND_SESSION, 'u1');

    assert.equal(result.ok, true);
    assert.equal(result.startFresh, true, 'editing the first turn starts fresh');
    assert.equal(await readFile(mainFile, 'utf8'), original, 'the transcript is untouched');
    const backups = (await readdir(projectDir)).filter((f) => f.includes('.rewind-'));
    assert.equal(backups.length, 0, 'no backup needed when nothing is truncated');
  });
});

test('rewindHistory resolves app-allocated sessions through the provider-native id', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const projectDir = path.join(tempDir, 'projects', '-demo');
    await mkdir(projectDir, { recursive: true });
    const mainFile = path.join(projectDir, `${REWIND_SESSION}.jsonl`);
    await writeFile(mainFile, conversationJsonl());

    // App-created session: DB row keyed by an app id, provider id mapped later
    // (the transcript keeps using the provider-native id). The chat runtime
    // passes the PROVIDER id to rewindHistory.
    const APP_SESSION = '99999999-9999-4999-8999-999999999999';
    sessionsDb.createAppSession(APP_SESSION, 'claude', '/demo');
    sessionsDb.assignProviderSessionId(APP_SESSION, REWIND_SESSION);
    // Synchronizer indexes the transcript from disk onto the same row.
    sessionsDb.createSession(REWIND_SESSION, 'claude', '/demo', undefined, undefined, undefined, mainFile);

    const provider = new ClaudeSessionsProvider();
    const result = await provider.rewindHistory(REWIND_SESSION, 'u2');

    assert.deepEqual(result, { ok: true, startFresh: false, removed: 2 });
    const body = await readFile(mainFile, 'utf8');
    assert.match(body, /first answer/);
    assert.doesNotMatch(body, /second question/, 'the edited turn and its tail were truncated');
  });
});

test('rewindHistory returns ok:false for an unknown message uuid', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const projectDir = path.join(tempDir, 'projects', '-demo');
    await mkdir(projectDir, { recursive: true });
    const mainFile = path.join(projectDir, `${REWIND_SESSION}.jsonl`);
    await writeFile(mainFile, conversationJsonl());
    sessionsDb.createSession(REWIND_SESSION, 'claude', '/demo', 'Demo', undefined, undefined, mainFile);

    const result = await new ClaudeSessionsProvider().rewindHistory(REWIND_SESSION, 'does-not-exist');
    assert.deepEqual(result, { ok: false, startFresh: false, removed: 0 });
  });
});

/**
 * Compaction boundaries.
 *
 * The live SDK stream and the JSONL transcript describe the same seam with
 * different casing (`compact_metadata` vs `compactMetadata`), and normalization
 * runs on both. If either spelling falls through, a compaction renders as an
 * unexplained gap: the turns above it silently stop being in context.
 */
test('normalizeMessage maps a live compact_boundary event', () => {
  const provider = new ClaudeSessionsProvider();
  const [message] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'cb1',
    timestamp: '2026-01-01T00:00:00.000Z',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 180_000,
      post_tokens: 12_000,
      duration_ms: 91_000,
    },
  }, SESSION);

  assert.equal(message.kind, 'compact_boundary');
  assert.equal(message.id, 'cb1');
  assert.deepEqual(message.compaction, {
    trigger: 'auto',
    preTokens: 180_000,
    postTokens: 12_000,
    durationMs: 91_000,
  });
});

test('normalizeMessage maps a transcript compact boundary with camelCase metadata', () => {
  const provider = new ClaudeSessionsProvider();
  const [message] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'manual', preTokens: 90_000 },
  }, SESSION);

  assert.equal(message.kind, 'compact_boundary');
  // Absent optional fields stay absent rather than being reported as zero —
  // the divider must not claim the context shrank to nothing.
  assert.deepEqual(message.compaction, { trigger: 'manual', preTokens: 90_000 });
});

test('normalizeMessage defaults an unknown compaction trigger to manual', () => {
  const provider = new ClaudeSessionsProvider();
  const [message] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
  }, SESSION);

  assert.deepEqual(message.compaction, { trigger: 'manual' });
});

/**
 * Compaction summaries must never reach the transcript as a bubble.
 *
 * Claude replays the summary as a synthetic *user* turn so the next turn starts
 * with it in context. Rendered literally that is a wall of text the reader never
 * typed, sitting right under the divider that already says the same thing — the
 * exact duplication this normalization exists to prevent. The row arrives as a
 * plain string from the JSONL transcript and as a text-block array from the live
 * SDK stream, and old transcripts carry no flag at all, so all three shapes are
 * covered here.
 */
const COMPACT_SUMMARY_TEXT = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Did a thing.';

test('normalizeMessage folds a flagged string compact summary into a boundary', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'cs1',
    isCompactSummary: true,
    message: { role: 'user', content: COMPACT_SUMMARY_TEXT },
  }, SESSION);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'compact_boundary');
  assert.equal(messages[0].role, undefined);
  assert.equal(messages[0].compaction?.summary, COMPACT_SUMMARY_TEXT);
});

test('normalizeMessage folds a live array-shaped compact summary into a boundary', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'cs2',
    isCompactSummary: true,
    message: { role: 'user', content: [{ type: 'text', text: COMPACT_SUMMARY_TEXT }] },
  }, SESSION);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'compact_boundary');
  assert.equal(messages[0].compaction?.summary, COMPACT_SUMMARY_TEXT);
});

test('normalizeMessage recognizes an unflagged compact summary by its preamble', () => {
  const provider = new ClaudeSessionsProvider();
  const [message] = provider.normalizeMessage({
    type: 'user',
    uuid: 'cs3',
    message: { role: 'user', content: COMPACT_SUMMARY_TEXT },
  }, SESSION);

  assert.equal(message.kind, 'compact_boundary');
});

test('normalizeMessage leaves an ordinary user turn alone', () => {
  const provider = new ClaudeSessionsProvider();
  const [message] = provider.normalizeMessage({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: 'continue where we left off' },
  }, SESSION);

  assert.equal(message.kind, 'text');
  assert.equal(message.role, 'user');
  assert.equal(message.content, 'continue where we left off');
});

test('fetchHistory collapses repeated 529 supervisor retries into one clean bubble', async () => {
  await withIsolatedDatabase(async (tempDir) => {
    const retrySession = '99999999-9999-4999-8999-999999999999';
    const projectDir = path.join(tempDir, 'projects', '-retry-demo');
    await mkdir(projectDir, { recursive: true });
    const mainFile = path.join(projectDir, `${retrySession}.jsonl`);
    const prompt = '[session supervisor] Claude returned HTTP 529. Continue the unfinished work. <!-- vibespace-retry:incident_529 -->';
    await writeFile(mainFile, jsonl(
      { type: 'user', sessionId: retrySession, uuid: 'retry-raw-1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: prompt } },
      { type: 'user', sessionId: retrySession, uuid: 'retry-raw-2', timestamp: '2026-01-01T00:05:00.000Z', message: { role: 'user', content: prompt } },
    ));
    sessionsDb.createSession(retrySession, 'claude', '/retry-demo', 'Retry demo', undefined, undefined, mainFile);

    const result = await new ClaudeSessionsProvider().fetchHistory(retrySession, { limit: null });
    assert.equal(result.messages.length, 1);
    assert.equal(result.total, 1);
    assert.equal(result.messages[0].id, 'vibespace_retry_incident_529');
    assert.equal(result.messages[0].content, '[session supervisor] Claude returned HTTP 529. Continue the unfinished work.');
  });
});
