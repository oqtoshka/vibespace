import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(path.join(tmpdir(), 'codex-live-recap-'));
process.env.DATABASE_PATH = path.join(directory, 'auth.db');
process.env.VS_RECAP_DEBOUNCE_MS = '25';
process.env.MC_DISABLE = '1';
const { initializeDatabase, closeConnection, sessionsDb } = await import('@/modules/database/index.js');
const { sessionsService, cancelSessionRecap, closeSessionsWatcher } = await import('../index.js');
// eslint-disable-next-line boundaries/no-unknown -- Integration coverage for the legacy runtime outside modules.
const { queryCodex, injectCodexMessage } = await import('../../../openai-codex.js');
// eslint-disable-next-line boundaries/no-unknown -- Shut down the legacy runtime's real test transport.
const { stopCodexAppServer } = await import('../../../services/codex-app-server.service.js');

test('Codex generates title and recap while the first turn is still running, using its selected model', async () => {
  const executable = path.join(directory, 'codex');
  const capture = path.join(directory, 'requests.jsonl');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
let serial = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
 const req = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(capture)}, line + '\\n');
 if (req.method === 'initialize') send({ id: req.id, result: {} });
 if (req.method === 'thread/resume' || req.method === 'thread/start') {
  send({ id: req.id, result: { thread: { id: req.params.threadId || 'helper-' + process.pid + '-' + (++serial) } } });
 }
 if (req.method === 'model/list') send({ id: req.id, result: { data: [] } });
 if (req.method === 'turn/start') {
  const threadId = req.params.threadId;
  const helper = threadId !== 'live';
  send({ id: req.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
  send({ method: 'turn/started', params: { threadId, turn: { id: 'turn' } } });
  send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: {
   id: 'prose', type: 'agentMessage', text: helper
     ? '{"title":"Live Recap Test","recap":"Investigating live updates while work continues."}'
     : 'Found the cause; now working on the fix.'
  } } });
  if (helper) send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
 }
 if (req.method === 'turn/steer') {
  send({ id: req.id, result: { turnId: 'turn' } });
  send({ method: 'turn/completed', params: { threadId: req.params.threadId, turn: { id: 'turn', status: 'completed' } } });
 }
});
`);
  await chmod(executable, 0o755);
  process.env.VIBESPACE_CODEX_PATH = executable;
  await initializeDatabase();
  sessionsDb.createAppSession('live', 'codex', directory, 'first words');
  sessionsDb.assignProviderSessionId('live', 'live');
  const originalHistory = sessionsService.fetchHistory;
  sessionsService.fetchHistory = async () => ({ total: 2, messages: [
    { kind: 'text', role: 'user', content: 'Fix live recap updates' },
    { kind: 'text', role: 'assistant', content: 'Found the cause; now working on the fix.' },
  ] }) as Awaited<ReturnType<typeof originalHistory>>;
  let completed = false;
  try {
    const running = queryCodex('Fix live recap updates', {
      sessionId: 'live', cwd: directory, model: 'gpt-5.6-sol', permissionMode: 'plan',
    }, { send() {}, setSessionId() {} }, {
      resolveProviderSessionId: () => 'live',
      resolveResumeModel: async () => 'gpt-5.6-sol',
      getProviderModels: async () => ({ DEFAULT: 'gpt-5.6-sol', OPTIONS: [{ value: 'gpt-5.4-mini', label: 'Mini' }, { value: 'gpt-5.6-sol', label: 'Sol' }] }),
      normalizeMessage: () => [], isProviderInstalled: async () => true,
    }).then(() => { completed = true; });
    const deadline = Date.now() + 10_000;
    while (!sessionsDb.getSessionById('live')?.recap && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(completed, false, 'the main turn has not finished');
    assert.equal(sessionsDb.getSessionById('live')?.recap, 'Investigating live updates while work continues.');
    const requests = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const helpers = requests.filter(req => req.method === 'thread/start');
    assert.ok(helpers.length >= 2, 'both the title and recap helpers ran');
    assert.ok(helpers.every(req => req.params.ephemeral === true));
    assert.ok(helpers.every(req => req.params.model === 'gpt-5.6-sol'), 'a mini catalog entry must not override the selected model');
    await injectCodexMessage('live', 'Finish now.', { cwd: directory });
    await running;
  } finally {
    cancelSessionRecap('live');
    await closeSessionsWatcher();
    stopCodexAppServer();
    sessionsService.fetchHistory = originalHistory;
    closeConnection();
    await rm(directory, { recursive: true, force: true });
  }
});
