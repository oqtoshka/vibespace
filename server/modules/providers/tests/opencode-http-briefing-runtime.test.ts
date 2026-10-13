import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const dir = await mkdtemp(path.join(os.tmpdir(), 'http-briefing-'));
const previousDb = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(dir, 'auth.db');
const { registerTaskLedgerSource } = await import('../../../shared/index.js');
const { initializeDatabase, closeConnection } = await import('../../database/index.js');
const { spawnOpenCode, injectOpenCodeServerForTests } = await import('../list/opencode/opencode-runtime.provider.js');
const previousPath = process.env.PATH;
const originalHomedir = os.homedir;
test.before(async () => {
  await initializeDatabase();
  await writeFile(path.join(dir, 'opencode'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  process.env.PATH = dir + path.delimiter + previousPath;
  os.homedir = () => dir;
});
test.after(async () => {
  await new Promise(r => setTimeout(r, 100));
  process.env.PATH = previousPath; os.homedir = originalHomedir;
  closeConnection();
  if (previousDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDb;
  await rm(dir, { recursive: true, force: true });
});
for (const scenario of ['repair', 'repeat', 'missing', 'late', 'plain', 'helper']) test(`actual OpenCode HTTP: ${scenario}`, { timeout: 15000 }, async () => {
  const sid = 'http-policy-' + scenario;
  const streams = new Set<http.ServerResponse>();
  const prompts: string[] = [], sent: any[] = [];
  let sidecarReady = false;
  const broadcast = (type: string, data: Record<string, unknown>) => {
    for (const stream of streams) stream.write('data: ' + JSON.stringify({ type, data: { sessionID: sid, ...data } }) + '\n\n');
  };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    const send = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: value })); };
    if (req.url?.startsWith('/api/model')) return send([{ id: 'local', providerID: 'homelab' }]);
    if (req.url === '/api/session') return send({ id: sid });
    if (req.url === `/api/session/${sid}/prompt`) {
      prompts.push(data.prompt.text); send({ id: data.id, sessionID: sid, prompt: data.prompt });
      const serial = prompts.length;
      setTimeout(() => {
        broadcast('session.next.tool.called', { callID: 'card-' + serial, tool: 'reply', input: {} });
        broadcast('session.next.tool.success', { callID: 'card-' + serial, content: [{ type: 'text', text: 'Card accepted' }] });
        if (serial === 1 || scenario === 'repeat') broadcast('session.next.text.delta', { assistantMessageID: 'assistant-' + serial, textID: 'text-' + serial, delta: 'FORBIDDEN_HTTP' });
        broadcast('session.next.step.ended', { assistantMessageID: 'assistant-' + serial, finish: 'stop' });
      }, 25); return;
    }
    return send({});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const restore = injectOpenCodeServerForTests({ baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, authorization: 'Basic fixture' });
  const unregister = registerTaskLedgerSource(c => {
    if (c.sessionId !== sid || scenario === 'plain' || (scenario === 'late' && !sidecarReady)) return null;
    return { listName: 'card', guidance: '', open: [], activity: 0, agentTextPolicy: 'reject', ...(scenario === 'missing' ? { completion: { turnId: 'human', prompt: 'exact card reply' } } : {}) };
  });
  try {
    await spawnOpenCode('human request', { cwd: dir, model: 'homelab/local', enableMidTurnInjection: true, ephemeral: scenario === 'helper' }, {
      send(m: any) { sent.push(m); if (m.kind === 'tool_use') sidecarReady = true; }, setSessionId() {},
    });
    assert.equal(prompts.length, ['repair', 'repeat', 'missing', 'late'].includes(scenario) ? 2 : 1);
    assert.equal(sent.some(m => ['text', 'stream_delta'].includes(m.kind) && String(m.content).includes('FORBIDDEN_HTTP')), ['plain', 'helper'].includes(scenario));
    assert.ok(sent.some(m => m.kind === 'tool_use' && m.toolName === 'reply'), 'actual named card tool remains visible');
    assert.deepEqual(sent.filter(m => m.kind === 'complete').map(m => m.success), [!['repeat', 'missing'].includes(scenario)]);
    if (['repeat', 'missing'].includes(scenario)) assert.ok(sent.some(m => m.kind === 'error' && /AGENT_TEXT_POLICY_VIOLATION/.test(m.content)));
  } finally {
    unregister(); restore(); for (const stream of streams) stream.end(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
