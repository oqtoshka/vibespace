import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { terminateChild } from '@/shared/utils.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test('terminateChild escalates to SIGKILL for a child that ignores SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pid = child.pid as number;
  try {
    await new Promise((resolve) => child.stdout.once('data', resolve));
    terminateChild(child, 150);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(isAlive(pid), true, 'SIGTERM alone is ignored');
    assert.equal(await waitFor(() => child.signalCode === 'SIGKILL', 3_000), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('terminateChild sends no SIGKILL to a child that exits on SIGTERM, and nothing to one already gone', async () => {
  const signals: string[] = [];
  const fake = {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals) {
      signals.push(signal ?? 'SIGTERM');
      this.signalCode = 'SIGTERM';
      return true;
    },
  };
  terminateChild(fake, 30);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(signals, ['SIGTERM']);

  terminateChild(fake, 30);
  assert.deepEqual(signals, ['SIGTERM'], 'an exited child is not signalled again');
});
