import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexAppServerClient, getCodexAppServer, stopCodexAppServer } from '../codex-app-server.service.js';

/**
 * Lifecycle of the app-server child (2026-09-29 pipe exhaustion, P6):
 * a failed initialize must not orphan the process, and stop() must reap a
 * child that ignores SIGTERM and release the parent's pipe ends.
 */

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/** Writes its pid, then answers initialize per `mode`; optionally ignores SIGTERM. */
async function createFakeCodex(scriptPath, { mode, ignoreTerm }) {
  await writeFile(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.VIBESPACE_CODEX_CAPTURE, process.pid + '\\n');
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
// Stay alive regardless of stdin EOF, like a wedged native binary would.
setInterval(() => {}, 1_000);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') return;
  if (${JSON.stringify(mode)} === 'error') {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'boom' } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n');
  }
});
`, 'utf8');
  await chmod(scriptPath, 0o755);
}

async function withFake(options, run) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-lifecycle-'));
  const executable = path.join(tempRoot, 'fake-codex');
  const capture = path.join(tempRoot, 'pids');
  await writeFile(capture, '');
  const saved = {
    path: process.env.VIBESPACE_CODEX_PATH,
    capture: process.env.VIBESPACE_CODEX_CAPTURE,
    grace: process.env.VIBESPACE_CODEX_STOP_GRACE_MS,
  };
  const pids = async () => (await readFile(capture, 'utf8')).split('\n').filter(Boolean).map(Number);
  try {
    await createFakeCodex(executable, options);
    process.env.VIBESPACE_CODEX_PATH = executable;
    process.env.VIBESPACE_CODEX_CAPTURE = capture;
    process.env.VIBESPACE_CODEX_STOP_GRACE_MS = '200';
    await run({ pids });
  } finally {
    stopCodexAppServer();
    // Reap anything this test started, by the recorded PID only.
    for (const pid of await pids().catch(() => [])) {
      if (isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    for (const [key, env] of [['path', 'VIBESPACE_CODEX_PATH'], ['capture', 'VIBESPACE_CODEX_CAPTURE'], ['grace', 'VIBESPACE_CODEX_STOP_GRACE_MS']]) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('a failed initialize stops the candidate instead of orphaning it', async () => {
  await withFake({ mode: 'error', ignoreTerm: false }, async ({ pids }) => {
    await assert.rejects(getCodexAppServer(), /boom/);
    await assert.rejects(getCodexAppServer(), /boom/);
    const spawned = await pids();
    assert.equal(spawned.length, 2, 'each retry spawns one candidate');
    assert.ok(
      await waitFor(() => spawned.every((pid) => !isAlive(pid))),
      `failed candidates must be reaped, still alive: ${spawned.filter(isAlive).join(',')}`,
    );
  });
});

test('stop() escalates to SIGKILL when the child ignores SIGTERM, and releases stdio', async () => {
  await withFake({ mode: 'ok', ignoreTerm: true }, async ({ pids }) => {
    const client = new CodexAppServerClient({ env: process.env });
    await client.ready;
    const [pid] = await pids();
    assert.ok(isAlive(pid));

    client.stop();
    assert.equal(client.closed, true, 'the transport closes at once');
    assert.equal(client.child.stdout.destroyed, true, 'parent stdout end released');
    assert.equal(client.child.stdin.destroyed, true, 'parent stdin end released');
    assert.equal(client.child.stderr.destroyed, true, 'parent stderr end released');
    await assert.rejects(client.request('thread/resume', {}), /not running/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(isAlive(pid), 'still inside the SIGTERM grace');
    assert.ok(await waitFor(() => !isAlive(pid), 3_000), 'SIGKILL after the grace');
    assert.equal(client.child.signalCode, 'SIGKILL');
  });
});

test('stop() on a well-behaved child needs no SIGKILL', async () => {
  await withFake({ mode: 'ok', ignoreTerm: false }, async ({ pids }) => {
    const client = await getCodexAppServer();
    const [pid] = await pids();
    stopCodexAppServer();
    assert.ok(await waitFor(() => !isAlive(pid), 3_000));
    assert.equal(client.child.signalCode, 'SIGTERM');
  });
});
