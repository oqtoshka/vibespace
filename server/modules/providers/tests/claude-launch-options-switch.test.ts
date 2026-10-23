import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerAgentLaunchContributor, registerAgentEnvContributor } from '../../../shared/agent-env.js';

const dbRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-launch-switch-db-'));
process.env.DATABASE_PATH = path.join(dbRoot, 'auth.db');
// eslint-disable-next-line boundaries/no-unknown -- Actual persistent provider integration without any provider request.
const { queryClaudeSDK, launchOptionsChanged, abortClaudeSDKSession, __setClaudeQueryImpl } = await import('../../../claude-sdk.js');
const { initializeDatabase, closeConnection } = await import('../../database/index.js');
test.before(() => initializeDatabase());
test.after(async () => { closeConnection(); await rm(dbRoot, { recursive: true, force: true }); });

/**
 * Switching a session between chat and briefing mid-session (a switchable
 * launch option): the live Claude process was spawned with the old plugin
 * contributions — env, MCP servers, system prompt — so the next turn that
 * states different options relaunches it, resuming the same transcript.
 */
test('launchOptionsChanged compares only what a caller states, independent of key order', () => {
  assert.equal(launchOptionsChanged({ launchOptions: null }, {}), false, 'a legacy caller states no options');
  assert.equal(launchOptionsChanged({ launchOptions: { a: true } }, { launchOptions: undefined }), true);
  assert.equal(launchOptionsChanged({ launchOptions: null }, { launchOptions: null }), false);
  assert.equal(launchOptionsChanged({}, { launchOptions: {} }), false, 'empty equals none');
  assert.equal(launchOptionsChanged({ launchOptions: null }, { launchOptions: { a: true } }), true);
  assert.equal(launchOptionsChanged({ launchOptions: { a: true, b: { x: 1, y: 2 } } }, { launchOptions: { b: { y: 2, x: 1 }, a: true } }), false);
  assert.equal(launchOptionsChanged({ launchOptions: { a: true } }, { launchOptions: null }), true);
});

test('a turn with switched launch options relaunches the live Claude process with resume', { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-launch-switch-'));
  const sid = 'claude-launch-switch';
  const spawns: any[] = [];
  const stopLaunch = registerAgentLaunchContributor((c) => (c.launchOptions?.['acme.briefing'] === true
    ? { instructions: 'ACME_BRIEFING_INSTRUCTIONS', systemInstructions: 'ACME_HARNESS_OVERRIDE', mcpServers: { acme: { type: 'stdio', command: 'acme-mcp' } }, allowedTools: ['mcp__acme__reply'] }
    : null));
  const stopEnv = registerAgentEnvContributor((c) => (c.launchOptions?.['acme.briefing'] === true ? { ACME_BRIEFING: '1' } : null));
  __setClaudeQueryImpl(({ prompt, options }: any) => {
    spawns.push(options);
    const reader = prompt[Symbol.asyncIterator]();
    const gen = (async function* () {
      for (;;) {
        const next = await reader.next();
        if (next.done) return;
        yield { type: 'system', subtype: 'init', session_id: sid };
        yield { type: 'result', subtype: 'success', session_id: sid };
      }
    })();
    (gen as any).interrupt = async () => {};
    (gen as any).setModel = async () => {};
    (gen as any).setPermissionMode = async () => {};
    return gen;
  });
  const ws = { send() {}, setSessionId() {}, userId: null };
  try {
    await queryClaudeSDK('chat turn', { sessionId: sid, cwd, launchOptions: null }, ws);
    assert.equal(spawns.length, 1);
    assert.doesNotMatch(String(spawns[0].systemPrompt?.append ?? ''), /ACME_BRIEFING_INSTRUCTIONS/);
    assert.equal(spawns[0].env.ACME_BRIEFING, undefined);

    await queryClaudeSDK('same mode again', { sessionId: sid, cwd, launchOptions: null }, ws);
    assert.equal(spawns.length, 1, 'unchanged options keep reusing the live process');

    await queryClaudeSDK('now in briefing', { sessionId: sid, cwd, launchOptions: { 'acme.briefing': true } }, ws);
    assert.equal(spawns.length, 2, 'switched options relaunch');
    const relaunched = spawns[1];
    assert.equal(relaunched.resume, sid, 'the relaunch resumes the same transcript');
    assert.match(String(relaunched.systemPrompt?.append ?? ''), /ACME_BRIEFING_INSTRUCTIONS/);
    assert.match(String(relaunched.systemPrompt?.append ?? ''), /ACME_HARNESS_OVERRIDE$/);
    assert.equal(relaunched.env.ACME_BRIEFING, '1');
    assert.ok(relaunched.allowedTools.includes('mcp__acme__reply'));
    assert.ok(JSON.stringify(relaunched.mcpServers ?? {}).includes('acme-mcp'), 'the plugin MCP server is attached');

    await queryClaudeSDK('legacy caller', { sessionId: sid, cwd }, ws);
    assert.equal(spawns.length, 2, 'a caller that states no options never relaunches');

    await queryClaudeSDK('back to chat', { sessionId: sid, cwd, launchOptions: null }, ws);
    assert.equal(spawns.length, 3, 'switching back relaunches again');
    assert.equal(spawns[2].resume, sid);
    assert.doesNotMatch(String(spawns[2].systemPrompt?.append ?? ''), /ACME_BRIEFING_INSTRUCTIONS/);
    assert.equal(spawns[2].env.ACME_BRIEFING, undefined);
  } finally {
    stopLaunch();
    stopEnv();
    abortClaudeSDKSession(sid);
    __setClaudeQueryImpl(null);
    await rm(cwd, { recursive: true, force: true });
  }
});
