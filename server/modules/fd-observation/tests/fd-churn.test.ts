import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FdObserver, type FdSample } from '@/modules/fd-observation/index.js';
import { runRegistryChild } from '@/modules/plugins/index.js';
// eslint-disable-next-line boundaries/no-unknown -- Churn through the legacy Codex runtime outside modules.
import { CodexAppServerClient } from '@/services/codex-app-server.service.js';
import { terminateChild } from '@/shared/utils.js';

/**
 * Churn through the real child-process paths fixed for the 2026-09-29 pipe
 * exhaustion (P6): Codex app-server clients (clean exits, stops mid-request,
 * SIGTERM-ignoring children), plugin-registry children (bursts and timeouts)
 * and the OpenCode/Cursor abort helper. Afterwards this process's descriptors
 * and children must be back near baseline. Meanwhile a "compiler probe" pushes
 * 256 KiB through a real kernel pipe and must finish on time — the write that
 * stalled clang.
 */

const ROUNDS = Number(process.env.FD_CHURN_ROUNDS) || 20;
const PROBE_BYTES = 256 * 1024;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function streamCount(sample: FdSample): number {
  if (!sample.ok) throw new Error(`fd probe failed: ${sample.error}`);
  // lsof: PIPE + unix (libuv stdio is socketpairs on macOS); procfs: pipe + socket.
  const counts = sample.byType;
  return (counts.PIPE ?? 0) + (counts.unix ?? 0) + (counts.pipe ?? 0) + (counts.socket ?? 0);
}

/** Fake app-server: records its pid; FAKE_MODE picks how it behaves. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(process.env.VIBESPACE_CODEX_CAPTURE, process.pid + '\\n');
const mode = process.env.FAKE_MODE;
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
setInterval(() => {}, 1_000);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n');
  } else if (message.method === 'thread/start' && mode === 'exit') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n', () => process.exit(0));
  }
  // Anything else is left unanswered: an in-flight request to cancel.
});
`;

/** The clang stand-in: 256 KiB through sh's own pipe, then out through ours. */
function compilerProbe(timeoutMs: number): Promise<{ bytes: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('sh', ['-c', `head -c ${PROBE_BYTES} /dev/zero | cat`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = 0;
    const timer = setTimeout(() => {
      terminateChild(child, 500);
      reject(new Error(`compiler probe stalled after ${bytes} bytes`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); resolve({ bytes, ms: Date.now() - startedAt }); });
  });
}

test('descriptors and children return to baseline after child churn; a 256 KiB pipe write finishes', { timeout: 120_000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fd-churn-'));
  const fakeCodex = path.join(tempRoot, 'fake-codex');
  const capture = path.join(tempRoot, 'pids');
  const sleeperPids = path.join(tempRoot, 'sleepers');
  await writeFile(capture, '');
  await writeFile(sleeperPids, '');
  await writeFile(fakeCodex, FAKE_CODEX, 'utf8');
  await chmod(fakeCodex, 0o755);

  const saved = { path: process.env.VIBESPACE_CODEX_PATH, capture: process.env.VIBESPACE_CODEX_CAPTURE, grace: process.env.VIBESPACE_CODEX_STOP_GRACE_MS };
  process.env.VIBESPACE_CODEX_PATH = fakeCodex;
  process.env.VIBESPACE_CODEX_CAPTURE = capture;
  process.env.VIBESPACE_CODEX_STOP_GRACE_MS = '200';
  const codexEnv = (mode: string) => ({ ...process.env, FAKE_MODE: mode });
  const recorded = async (file: string) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(Number);

  const observer = new FdObserver({ probeTimeoutMs: 10_000 });
  const stats = { codexExit: 0, codexCancelled: 0, codexKilled: 0, registryOk: 0, registryTimedOut: 0, aborted: 0 };

  try {
    // Warm-up: the first spawn allocates descriptors libuv keeps for good.
    await runRegistryChild(process.execPath, ['-e', ''], { timeoutMs: 10_000, label: 'warmup' });
    const warm = new CodexAppServerClient({ env: codexEnv('exit') });
    await warm.ready;
    await warm.request('thread/start', {}).catch(() => {});
    warm.stop();
    await waitFor(() => warm.exited, 5_000);

    const baseline = await observer.probe();
    assert.ok(baseline.ok, baseline.ok ? '' : baseline.error);
    assert.ok(baseline.children.ok, 'children probe works');
    const baselineStreams = streamCount(baseline);
    // Children that predate the churn (tsx's esbuild service) stay; nothing new may.
    const baselineChildren = new Set(baseline.children.ok ? baseline.children.pids : []);
    const onlyBaselineChildren = (sample: FdSample) =>
      sample.ok && sample.children.ok && sample.children.pids.every((pid) => baselineChildren.has(pid));

    const probe = compilerProbe(15_000);

    const round = async (index: number) => {
      // Codex: a clean exit, a request cancelled mid-flight, a child that ignores SIGTERM.
      const exiting = new CodexAppServerClient({ env: codexEnv('exit') });
      await exiting.ready;
      await exiting.request('thread/start', {});
      await waitFor(() => exiting.closed, 5_000);
      exiting.stop();
      stats.codexExit += 1;

      const cancelled = new CodexAppServerClient({ env: codexEnv('hang') });
      await cancelled.ready;
      const inFlight = cancelled.request('turn/start', {}).catch((error: Error) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      cancelled.stop();
      assert.match(String(await inFlight), /stopped|exited/);
      stats.codexCancelled += 1;

      if (index % 3 === 0) {
        const stubborn = new CodexAppServerClient({ env: codexEnv('ignore-term') });
        await stubborn.ready;
        stubborn.stop();
        stats.codexKilled += 1;
      }

      // Plugin registry: a burst larger than any pipe buffer, and a timeout.
      const burst = await runRegistryChild(process.execPath, ['-e', "process.stdout.write('x'.repeat(200_000))"], { timeoutMs: 10_000, label: 'burst' });
      assert.ok(burst !== undefined);
      stats.registryOk += 1;
      if (index % 2 === 0) {
        await assert.rejects(
          runRegistryChild(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { timeoutMs: 150, killGraceMs: 100, label: 'hung' }),
          /timed out/,
        );
        stats.registryTimedOut += 1;
      }

      // OpenCode/Cursor abort helper on a CLI that ignores SIGTERM.
      const cli = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], { stdio: ['pipe', 'pipe', 'pipe'] });
      await writeFile(sleeperPids, `${cli.pid}\n`, { flag: 'a' });
      await new Promise((resolve) => cli.stdout.once('data', resolve));
      const closed = new Promise((resolve) => cli.once('close', resolve));
      terminateChild(cli, 100);
      await closed;
      stats.aborted += 1;
    };

    // Four lanes in parallel, like concurrent sessions.
    const lanes = 4;
    await Promise.all(Array.from({ length: lanes }, async (_lane, lane) => {
      for (let index = lane; index < ROUNDS; index += lanes) await round(index);
    }));

    const probeResult = await probe;
    assert.equal(probeResult.bytes, PROBE_BYTES, 'the whole 256 KiB arrived');

    const codexPids = await recorded(capture);
    assert.ok(await waitFor(() => codexPids.every((pid) => !isAlive(pid)), 5_000), `codex children alive: ${codexPids.filter(isAlive).join(',')}`);

    let after: FdSample = await observer.probe();
    const settled = await waitFor(async () => {
      after = await observer.probe();
      return onlyBaselineChildren(after) && streamCount(after) <= baselineStreams + 2;
    }, 10_000);
    assert.ok(after.ok);
    if (after.ok && baseline.ok) {
      console.log('[fd-churn]', JSON.stringify({
        stats,
        probe: probeResult,
        baseline: { total: baseline.total, streams: baselineStreams, byType: baseline.byType },
        after: { total: after.total, streams: streamCount(after), byType: after.byType, children: after.children },
      }));
      assert.ok(settled, `not back to baseline: streams ${baselineStreams} -> ${streamCount(after)}, children ${JSON.stringify(after.children)} vs baseline ${[...baselineChildren].join(',')}`);
      assert.ok(after.total <= baseline.total + 4, `descriptor total ${baseline.total} -> ${after.total}`);
    }
    assert.ok(stats.codexExit === ROUNDS && stats.codexCancelled === ROUNDS && stats.aborted === ROUNDS);
  } finally {
    // Reap anything this test started, by recorded PID only.
    for (const file of [capture, sleeperPids]) {
      for (const pid of await recorded(file).catch(() => [] as number[])) {
        if (isAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        }
      }
    }
    for (const [key, env] of [['path', 'VIBESPACE_CODEX_PATH'], ['capture', 'VIBESPACE_CODEX_CAPTURE'], ['grace', 'VIBESPACE_CODEX_STOP_GRACE_MS']] as const) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
