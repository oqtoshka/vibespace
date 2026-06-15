import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
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
