import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const dir = await mkdtemp(path.join(os.tmpdir(), 'opencode-noop-loop-'));
process.env.DATABASE_PATH = path.join(dir, 'auth.db');
const { registerTaskLedgerSource } = await import('../../../shared/index.js');
const { NOOP_TOOL_LOOP_LIMIT } = await import('../index.js');
const { initializeDatabase, closeConnection } = await import('../../database/index.js');
// eslint-disable-next-line boundaries/no-unknown -- Actual owned executable CLI fixture, no provider connection.
const { spawnOpenCode } = await import('../../../opencode-cli.js');
const { OpenCodeSessionsProvider } = await import('../list/opencode/opencode-sessions.provider.js');
const prevPath = process.env.PATH;
test.before(() => initializeDatabase());
test.after(async () => { process.env.PATH = prevPath; await new Promise(r => setTimeout(r, 100)); closeConnection(); await rm(dir, { recursive: true, force: true }); });

// The 2026-11-08 loop: a finished briefing turn alternating reasoning with bash `true`, forever.
for (const briefing of [true, false]) test(`actual opencode CLI: a no-op tool loop is stopped as a completed turn (briefing ${briefing})`, { timeout: 15000 }, async () => {
  const bin = path.join(dir, `loop-${briefing}`); await mkdir(bin);
  const capture = path.join(bin, 'calls'); const sid = `opencode-loop-${briefing}`;
  await writeFile(path.join(bin, 'opencode'), `#!/usr/bin/env node
const fs=require('node:fs');if(process.argv[2]==='models'){process.exit(0)}
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
const send=v=>console.log(JSON.stringify(v));let n=0;
send({type:'tool_use',sessionID:${JSON.stringify(sid)},part:{type:'tool',callID:'card',tool:'mc_status',state:{status:'completed',input:{status:'done'},output:'recorded'}}});
setInterval(()=>{n++;send({type:'reasoning',sessionID:${JSON.stringify(sid)},part:{text:"I'll stop with no text. (End.)"}});
send({type:'tool_use',sessionID:${JSON.stringify(sid)},part:{type:'tool',callID:'noop'+n,tool:'bash',state:{status:'completed',input:{command:'true'},output:''}}});
fs.writeFileSync(${JSON.stringify(path.join(bin, 'steps'))},String(n));},20);
`, { mode: 0o755 });
  process.env.PATH = bin + path.delimiter + prevPath;
  const unregister = registerTaskLedgerSource(c => briefing && c.sessionId === sid ? { listName: 'card', guidance: '', open: [], activity: 0, agentTextPolicy: 'reject', turnComplete: { turnId: c.turnId!, activity: 0 } } : null);
  const normalizer = new OpenCodeSessionsProvider();
  const runtime: any = { resolveProviderSessionId: (id: string) => id || null, resolveResumeModel: async () => undefined, getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }), normalizeMessage: (raw: any, id: string) => normalizer.normalizeMessage(raw, id), isProviderInstalled: async () => true };
  const sent: any[] = [];
  try {
    await spawnOpenCode('request', { sessionId: sid, cwd: dir, skipPermissions: true }, { send: (m: any) => sent.push(m), setSessionId() {} }, runtime);
    const calls = (await readFile(capture, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 1, 'no repair and no continuation re-enters the loop');
    const steps = Number(await readFile(path.join(bin, 'steps'), 'utf8'));
    assert.ok(steps < NOOP_TOOL_LOOP_LIMIT + 10, `stopped within a few steps, not left running (${steps})`);
    const stopped = sent.filter(m => m.kind === 'status' && m.text === 'opencode_noop_loop_stopped');
    assert.equal(stopped.length, 1, 'the stop is recorded visibly in the chat');
    assert.match(stopped[0].content, /consecutive no-op tool calls.*bash `true`/);
    const completed = sent.filter(m => m.kind === 'complete');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].success, true, 'a guard stop is a completed turn, never a crash');
    assert.ok(!sent.some(m => m.kind === 'error'), 'no error bubble');
    assert.ok(!sent.some(m => m.text === 'Resuming — open tasks remain'));
  } finally { unregister(); process.env.PATH = prevPath; }
});
