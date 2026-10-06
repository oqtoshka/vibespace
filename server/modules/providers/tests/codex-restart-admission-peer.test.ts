import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line boundaries/no-unknown -- Exercise the actual cached legacy transport, not a replacement callback fixture.
import { getCodexAppServer, getExistingCodexAppServerTransports, stopCodexAppServer } from '../../../services/codex-app-server.service.js';
import { createCodexRestartAdmissionObserver } from '../services/codex-restart-admission.service.js';

// A stdio-only native peer sends the real JSON-RPC notification shape. It keeps
// returning identical loaded IDs and idle status, so inventory/status checks
// cannot accidentally mask a missed lifecycle notification.
for (const method of ['turn/started', 'thread/status/changed', null]) {
  for (const phase of method ? ['read', 'final-list'] : ['read']) {
    test(`cached native peer ${method ?? 'without lifecycle change'} during ${phase}`, async () => {
      const dir = await mkdtemp(path.join(process.env.TEST_ARTIFACT_ROOT ?? os.tmpdir(), 'codex-admission-peer-'));
      const executable = path.join(dir, 'fake-codex');
      const capture = path.join(dir, 'peer-receipts.jsonl');
      const previous = process.env.VIBESPACE_CODEX_PATH;
      const peers: Awaited<ReturnType<typeof getCodexAppServer>>[] = [];
      const retainedSubscriptions: Array<() => void> = [];
      try {
        await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const capture = ${JSON.stringify(capture)};
const method = ${JSON.stringify(method)};
const phase = ${JSON.stringify(phase)};
let lists = 0;
fs.appendFileSync(capture, JSON.stringify({ kind: 'spawn', pid: process.pid }) + '\\n');
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { userAgent: 'offline-regression-peer' };
  else if (message.method === 'thread/loaded/list') {
    lists++;
    result = { data: ['idle-thread'], nextCursor: null };
  } else if (message.method === 'thread/read') {
    fs.appendFileSync(capture, JSON.stringify({ kind: 'read', includeTurns: message.params.includeTurns }) + '\\n');
    result = { thread: { id: message.params.threadId, status: { type: 'idle' }, preview: 'DO_NOT_EXPOSE_PRIVATE_DETAILS' } };
  } else throw new Error('Unexpected regression request');
  const notify = method && ((phase === 'read' && message.method === 'thread/read') ||
    (phase === 'final-list' && message.method === 'thread/loaded/list' && lists === 2));
  if (notify) {
    fs.appendFileSync(capture, JSON.stringify({ kind: 'notify', method }) + '\\n');
    process.stdout.write(JSON.stringify({ method, params: { threadId: 'idle-thread' } }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`);
        await chmod(executable, 0o755);
        process.env.VIBESPACE_CODEX_PATH = executable;
        peers.push(await getCodexAppServer(), await getCodexAppServer({ private: true }));
        assert.equal(getExistingCodexAppServerTransports().length, 2);
        for (const peer of peers) {
          // Observer cleanup must preserve listeners belonging to other callers.
          retainedSubscriptions.push(peer.subscribe(() => undefined));
          assert.equal(peer.listeners.size, 1);
        }

        const result = await createCodexRestartAdmissionObserver().observe();
        assert.equal(result.activityChanged, method !== null);
        assert.equal(result.observation, method ? 'unknown' : 'observed');
        assert.equal(result.nativeThreadsIdle, method === null);
        assert.equal(result.restartAuthorized, false);
        assert.equal(result.variants.length, 2);
        for (const variant of result.variants) {
          assert.equal(variant.loadedThreads, 1);
          assert.equal(variant.activeThreads, 0);
          assert.equal(variant.unknownThreads, 0);
        }
        const cached = getExistingCodexAppServerTransports();
        assert.deepEqual(cached.map(entry => entry.variant), ['shared', 'private']);
        for (const [i, entry] of cached.entries()) {
          assert.equal(entry.client, peers[i]);
          assert.equal(entry.client.listeners.size, 1);
          assert.equal(entry.client.closed, false);
        }
        const receipts = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(receipts.filter(row => row.kind === 'spawn').length, 2);
        assert.equal(receipts.filter(row => row.kind === 'read').length, 2);
        assert.ok(receipts.filter(row => row.kind === 'read').every(row => row.includeTurns === false));
        assert.equal(receipts.filter(row => row.kind === 'notify').length, method ? 2 : 0);
        assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE_PRIVATE_DETAILS'));
      } finally {
        for (const unsubscribe of retainedSubscriptions) unsubscribe();
        const exits = peers.filter(peer => !peer.exited).map(peer => new Promise<void>(resolve => peer.child.once('exit', () => resolve())));
        stopCodexAppServer();
        await Promise.all(exits);
        assert.equal(getExistingCodexAppServerTransports().length, 0);
        if (previous === undefined) delete process.env.VIBESPACE_CODEX_PATH;
        else process.env.VIBESPACE_CODEX_PATH = previous;
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
