import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProcFdTarget,
  FdObserver,
  parseLsofFieldOutput,
  type FdProbeExec,
} from '@/modules/fd-observation/index.js';

const LSOF_OUTPUT = [
  'p4242',
  'fcwd', 'tDIR',
  'ftxt', 'tREG',
  'f0', 'tCHR',
  'f1', 'tunix',
  'f2', 'tunix',
  'f7', 'tPIPE',
  'f8', 'tPIPE',
  'f9', 'tREG',
  'f10', 'tIPv4',
  '',
].join('\n');

function execWith(handlers: Record<string, (args: string[]) => Promise<{ stdout: string }>>): FdProbeExec & { calls: string[] } {
  const calls: string[] = [];
  const exec = (async (file: string, args: string[]) => {
    calls.push(file);
    const handler = handlers[file];
    if (!handler) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    return handler(args);
  }) as unknown as FdProbeExec & { calls: string[] };
  exec.calls = calls;
  return exec;
}

const pgrepNone = async () => { throw Object.assign(new Error('Command failed: pgrep'), { code: 1 }); };

test('lsof field output is counted by type, numeric descriptors only', () => {
  assert.deepEqual(parseLsofFieldOutput(LSOF_OUTPUT), {
    total: 7,
    byType: { CHR: 1, unix: 2, PIPE: 2, REG: 1, IPv4: 1 },
  });
});

test('procfs targets are classified without keeping the path', () => {
  assert.equal(classifyProcFdTarget('pipe:[123]'), 'pipe');
  assert.equal(classifyProcFdTarget('socket:[9]'), 'socket');
  assert.equal(classifyProcFdTarget('anon_inode:[eventpoll]'), 'anon_inode');
  assert.equal(classifyProcFdTarget('/dev/null'), 'dev');
  assert.equal(classifyProcFdTarget('/home/u/secret.txt'), 'file');
});

test('a macOS probe returns counts and children, and asks lsof for no names', async () => {
  let lsofArgs: string[] = [];
  const exec = execWith({
    lsof: async (args) => { lsofArgs = args; return { stdout: LSOF_OUTPUT }; },
    pgrep: async () => ({ stdout: '101\n102\n' }),
  });
  const observer = new FdObserver({ pid: 4242, platform: 'darwin', exec });
  const sample = await observer.probe();
  assert.equal(sample.ok, true);
  if (!sample.ok) return;
  assert.equal(sample.source, 'lsof');
  assert.equal(sample.total, 7);
  assert.equal(sample.byType.PIPE, 2);
  assert.deepEqual(sample.children, { ok: true, count: 2, pids: [101, 102], truncated: false });
  assert.deepEqual(lsofArgs.slice(-2), ['-F', 'ft'], 'only fd and type fields');
  assert.ok(lsofArgs.includes('4242'));
  assert.deepEqual(exec.calls, ['lsof', 'pgrep'], 'sequential: lsof is gone before children are listed');
});

test('missing lsof is an error sample, never zero', async () => {
  const observer = new FdObserver({ platform: 'darwin', exec: execWith({ pgrep: pgrepNone }) });
  const sample = await observer.probe();
  assert.equal(sample.ok, false);
  if (sample.ok) return;
  assert.match(sample.error, /lsof is not installed/);
  assert.equal('total' in sample, false);
});

test('a failing lsof is an error sample', async () => {
  const exec = execWith({
    lsof: async () => { throw Object.assign(new Error('Command failed: lsof'), { code: 1 }); },
    pgrep: pgrepNone,
  });
  const sample = await new FdObserver({ platform: 'darwin', exec }).probe();
  assert.equal(sample.ok, false);
  if (!sample.ok) assert.match(sample.error, /lsof failed: Command failed: lsof/);
});

test('an lsof that exits 0 with nothing parseable is an error, not zero descriptors', async () => {
  const exec = execWith({ lsof: async () => ({ stdout: '' }), pgrep: pgrepNone });
  const sample = await new FdObserver({ platform: 'darwin', exec }).probe();
  assert.equal(sample.ok, false);
  if (!sample.ok) assert.match(sample.error, /no descriptors/);
});

test('a hanging lsof is cut off by the Node-side deadline', async () => {
  const exec = execWith({ lsof: () => new Promise(() => {}), pgrep: pgrepNone });
  const observer = new FdObserver({ platform: 'darwin', exec, probeTimeoutMs: 150 });
  const startedAt = Date.now();
  const sample = await observer.probe();
  const elapsed = Date.now() - startedAt;
  assert.equal(sample.ok, false);
  if (!sample.ok) assert.match(sample.error, /lsof probe timed out after 150ms/);
  assert.ok(elapsed < 2_000, `settled in ${elapsed}ms`);
});

test('pgrep exit 1 means no children; a missing pgrep is reported, not zero', async () => {
  const none = await new FdObserver({ platform: 'darwin', exec: execWith({ lsof: async () => ({ stdout: LSOF_OUTPUT }), pgrep: pgrepNone }) }).probe();
  assert.ok(none.ok && none.children.ok && none.children.count === 0);

  const missing = await new FdObserver({ platform: 'darwin', exec: execWith({ lsof: async () => ({ stdout: LSOF_OUTPUT }) }) }).probe();
  assert.ok(missing.ok);
  if (missing.ok) assert.deepEqual(missing.children, { ok: false, error: 'pgrep is not installed' });
});

test('child PIDs are capped while the count stays exact', async () => {
  const pids = Array.from({ length: 100 }, (_, index) => 1000 + index).join('\n');
  const exec = execWith({ lsof: async () => ({ stdout: LSOF_OUTPUT }), pgrep: async () => ({ stdout: pids }) });
  const sample = await new FdObserver({ platform: 'darwin', exec }).probe();
  assert.ok(sample.ok && sample.children.ok);
  if (sample.ok && sample.children.ok) {
    assert.equal(sample.children.count, 100);
    assert.equal(sample.children.pids.length, 64);
    assert.equal(sample.children.truncated, true);
  }
});

test('the Linux probe reads /proc/<pid>/fd and skips descriptors that vanished', async () => {
  const links: Record<string, string> = {
    '/proc/7/fd/0': '/dev/null',
    '/proc/7/fd/1': 'pipe:[1]',
    '/proc/7/fd/2': 'pipe:[2]',
    '/proc/7/fd/3': 'socket:[3]',
  };
  const observer = new FdObserver({
    pid: 7,
    platform: 'linux',
    exec: execWith({ pgrep: pgrepNone }),
    procfs: {
      readdir: async () => ['0', '1', '2', '3', '4'],
      readlink: async (link) => {
        if (!(link in links)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return links[link];
      },
    },
  });
  const sample = await observer.probe();
  assert.ok(sample.ok);
  if (sample.ok) {
    assert.equal(sample.source, 'procfs');
    assert.equal(sample.total, 4);
    assert.deepEqual(sample.byType, { dev: 1, pipe: 2, socket: 1 });
  }
});

test('an unreadable /proc is an error sample', async () => {
  const observer = new FdObserver({
    platform: 'linux',
    exec: execWith({ pgrep: pgrepNone }),
    procfs: { readdir: async () => { throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); }, readlink: async () => '' },
  });
  const sample = await observer.probe();
  assert.equal(sample.ok, false);
});

test('the ring keeps the newest N samples and settings are clamped', async () => {
  let n = 0;
  const exec = execWith({
    lsof: async () => { n += 1; return { stdout: `f${n}\ntPIPE\n` }; },
    pgrep: pgrepNone,
  });
  const observer = new FdObserver({ platform: 'darwin', exec, ringSize: 3 });
  for (let index = 0; index < 5; index += 1) await observer.sample();
  const samples = observer.samples();
  assert.equal(samples.length, 3);
  assert.deepEqual(samples.map((sample) => sample.ok), [true, true, true]);

  const clamped = new FdObserver({ intervalMs: 1, ringSize: 1e9, probeTimeoutMs: 1e9 });
  assert.equal(clamped.intervalMs, 5_000);
  assert.equal(clamped.ringSize, 1_000);
  assert.equal(clamped.probeTimeoutMs, 30_000);
  const defaults = new FdObserver({ intervalMs: Number.NaN });
  assert.equal(defaults.intervalMs, 60_000);
});

test('concurrent sample() calls share one probe', async () => {
  let release: () => void = () => {};
  const exec = execWith({
    lsof: () => new Promise((resolve) => { release = () => resolve({ stdout: LSOF_OUTPUT }); }),
    pgrep: pgrepNone,
  });
  const observer = new FdObserver({ platform: 'darwin', exec });
  const first = observer.sample();
  const second = observer.sample();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await first, await second);
  assert.equal(exec.calls.filter((call) => call === 'lsof').length, 1);
  assert.equal(observer.samples().length, 1);
});

test('the real probe on this host returns counts for this process', async () => {
  const sample = await new FdObserver({ probeTimeoutMs: 10_000 }).probe();
  assert.equal(sample.ok, true, sample.ok ? '' : sample.error);
  if (sample.ok) assert.ok(sample.total > 0);
});

test('the real lsof failing (no such pid) is an error sample', { skip: process.platform !== 'darwin' }, async () => {
  // PIDs on macOS stay below 100000; this one cannot exist.
  const sample = await new FdObserver({ pid: 99_999_999, platform: 'darwin', probeTimeoutMs: 10_000 }).probe();
  assert.equal(sample.ok, false);
});
