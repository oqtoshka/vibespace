import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runRegistryChild } from '@/modules/plugins/plugin-registry.service.js';

/**
 * Registry children (git clone/pull, npm install/build) must never block on
 * an unread pipe nor outlive their timeout — both kept pipes open for the
 * server's lifetime before (2026-09-29 pipe exhaustion, P6).
 */

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a child writing far more than a pipe buffer to stdout completes', async () => {
  // 1 MiB on stdout plus 64 KiB on stderr: with an undrained stdout the child
  // blocks in write() after 64 KiB and never exits.
  const script = "process.stdout.write('x'.repeat(1 << 20)); process.stderr.write('e'.repeat(65536) + 'TAIL');";
  const result = await runRegistryChild(process.execPath, ['-e', script], {
    timeoutMs: 10_000,
    label: 'burst',
  });
  assert.equal(result.code, 0);
  assert.ok(result.stderr.endsWith('TAIL'));
  assert.ok(result.stderr.length <= 8_000, 'only the stderr tail is kept');
});

test('a child that ignores SIGTERM is SIGKILLed after the grace; the promise rejects at the timeout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'registry-child-'));
  const pidFile = path.join(dir, 'pid');
  let pid = 0;
  try {
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`
      + " process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const started = Date.now();
    await assert.rejects(
      runRegistryChild(process.execPath, ['-e', script], { timeoutMs: 300, killGraceMs: 200, label: 'stubborn' }),
      /stubborn timed out after 300ms/,
    );
    assert.ok(Date.now() - started < 2_000, 'settles at the timeout, not at exit');

    pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(pid > 0);
    assert.equal(isAlive(pid), true, 'still inside the SIGTERM grace');
    const deadline = Date.now() + 3_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(isAlive(pid), false, 'SIGKILL reaped the child that ignored SIGTERM');
  } finally {
    // Reap by the recorded pid only.
    if (pid && isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing executable rejects instead of throwing', async () => {
  await assert.rejects(
    runRegistryChild('vibespace-definitely-missing-binary', [], { timeoutMs: 1_000, label: 'missing' }),
    /Failed to spawn missing/,
  );
});
