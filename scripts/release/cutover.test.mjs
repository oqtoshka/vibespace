import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  acquireLock,
  cutoverArgs,
  oneShotPlist,
  parseArgs,
  readRunResult,
  runCutover,
  statePaths,
} from './cutover.mjs';

let root;

function makeRelease(name, version) {
  const dir = path.join(root, 'releases', name);
  const pkg = path.join(dir, 'node_modules', '@vibespace-ai', 'vibespace');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@vibespace-ai/vibespace', version }));
  return dir;
}

/**
 * A pretend service: `kickstart` "restarts" it by reading the version the link points at
 * now, and the probe reports that version — unless the release is marked broken.
 */
function fakeService(link, { broken = new Set(), kickstartOk = true } = {}) {
  const service = { version: null, kickstarts: 0 };
  service.kickstart = () => {
    service.kickstarts += 1;
    const target = fs.readlinkSync(link);
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'node_modules', '@vibespace-ai', 'vibespace', 'package.json'), 'utf8'));
    service.version = broken.has(pkg.version) ? null : pkg.version;
    return { ok: kickstartOk, detail: kickstartOk ? '' : 'Could not find service' };
  };
  service.fetchImpl = async () => {
    if (!service.version) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return { ok: true, status: 200, json: async () => ({ status: 'ok', version: service.version }) };
  };
  return service;
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function options(extra = {}) {
  return {
    release: null,
    link: path.join(root, 'current'),
    also: [],
    service: 'test.label',
    probeUrl: 'http://127.0.0.1:1/health',
    expectVersion: null,
    probeTimeoutS: 30,
    stateDir: path.join(root, 'state'),
    ...extra,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runCutover', () => {
  it('goes live, flips every link and leaves the lock and pid free', async () => {
    const old = makeRelease('1.0.0', '1.0.0');
    const next = makeRelease('1.1.0', '1.1.0');
    const pluginOld = path.join(root, 'plugin-1');
    const pluginNew = path.join(root, 'plugin-2');
    fs.mkdirSync(pluginOld);
    fs.mkdirSync(pluginNew);
    const current = path.join(root, 'current');
    const pluginLink = path.join(root, 'plugin');
    fs.symlinkSync(old, current);
    fs.symlinkSync(pluginOld, pluginLink);
    const service = fakeService(current);
    service.kickstart();

    const outcome = await runCutover(
      options({ release: next, also: [{ link: pluginLink, target: pluginNew }] }),
      { kickstart: service.kickstart, fetchImpl: service.fetchImpl, ...fakeClock(), runId: 'r1' },
    );

    assert.equal(outcome.result, 'LIVE');
    assert.equal(fs.readlinkSync(current), next);
    assert.equal(fs.readlinkSync(pluginLink), pluginNew);
    const paths = statePaths(path.join(root, 'state'));
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(fs.existsSync(paths.pid), false);
    assert.deepEqual(readRunResult(paths.log, 'r1').result, 'LIVE');
    assert.equal(JSON.parse(fs.readFileSync(paths.lastRun, 'utf8')).result, 'LIVE');
  });

  it('rolls every link back and restarts the previous release when the new one never answers', async () => {
    const old = makeRelease('1.0.0', '1.0.0');
    const next = makeRelease('1.1.0', '1.1.0');
    const current = path.join(root, 'current');
    const pluginLink = path.join(root, 'plugin');
    const pluginOld = path.join(root, 'plugin-1');
    const pluginNew = path.join(root, 'plugin-2');
    fs.mkdirSync(pluginOld);
    fs.mkdirSync(pluginNew);
    fs.symlinkSync(old, current);
    fs.symlinkSync(pluginOld, pluginLink);
    const service = fakeService(current, { broken: new Set(['1.1.0']) });

    const outcome = await runCutover(
      options({ release: next, also: [{ link: pluginLink, target: pluginNew }] }),
      { kickstart: service.kickstart, fetchImpl: service.fetchImpl, ...fakeClock(), runId: 'r2' },
    );

    assert.equal(outcome.result, 'ROLLED_BACK');
    assert.equal(fs.readlinkSync(current), old);
    assert.equal(fs.readlinkSync(pluginLink), pluginOld);
    assert.equal(service.kickstarts, 2);
    assert.equal(service.version, '1.0.0');
    assert.match(fs.readFileSync(statePaths(path.join(root, 'state')).log, 'utf8'), /ECONNREFUSED/);
  });

  it('reports FAILED, not ROLLED_BACK, when the previous release does not come back either', async () => {
    const old = makeRelease('1.0.0', '1.0.0');
    const next = makeRelease('1.1.0', '1.1.0');
    const current = path.join(root, 'current');
    fs.symlinkSync(old, current);
    const service = fakeService(current, { broken: new Set(['1.0.0', '1.1.0']) });

    const outcome = await runCutover(options({ release: next }), {
      kickstart: service.kickstart, fetchImpl: service.fetchImpl, ...fakeClock(), runId: 'r3',
    });

    assert.equal(outcome.result, 'FAILED');
    assert.match(outcome.detail, /may be down/);
    assert.equal(fs.readlinkSync(current), old);
  });

  it('refuses to start while another live run holds the lock, and changes nothing', async () => {
    const old = makeRelease('1.0.0', '1.0.0');
    const next = makeRelease('1.1.0', '1.1.0');
    const current = path.join(root, 'current');
    fs.symlinkSync(old, current);
    const state = path.join(root, 'state');
    assert.equal(acquireLock(statePaths(state).lock, { pid: process.pid, runId: 'other' }).acquired, true);
    const service = fakeService(current);

    const outcome = await runCutover(options({ release: next }), {
      kickstart: service.kickstart, fetchImpl: service.fetchImpl, ...fakeClock(), runId: 'r4',
    });

    assert.equal(outcome.result, 'FAILED');
    assert.match(outcome.detail, /holds the lock/);
    assert.equal(fs.readlinkSync(current), old);
    assert.equal(service.kickstarts, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(statePaths(state).lock, 'owner.json'), 'utf8')).runId, 'other');
  });

  it('takes over a lock whose owner process is gone', async () => {
    const old = makeRelease('1.0.0', '1.0.0');
    const next = makeRelease('1.1.0', '1.1.0');
    const current = path.join(root, 'current');
    fs.symlinkSync(old, current);
    const state = path.join(root, 'state');
    // A pid far above any real one answers ESRCH.
    acquireLock(statePaths(state).lock, { pid: 2 ** 30, runId: 'dead' });
    const service = fakeService(current);

    const outcome = await runCutover(options({ release: next }), {
      kickstart: service.kickstart, fetchImpl: service.fetchImpl, ...fakeClock(), runId: 'r5',
    });

    assert.equal(outcome.result, 'LIVE');
  });

  it('rolls back when the restart itself fails', async () => {
    const old = makeRelease('1.0.0', '1.0.0');
    const next = makeRelease('1.1.0', '1.1.0');
    const current = path.join(root, 'current');
    fs.symlinkSync(old, current);
    let calls = 0;
    const service = fakeService(current);
    const kickstart = (label) => {
      calls += 1;
      return calls === 1 ? { ok: false, detail: 'Could not find service' } : service.kickstart(label);
    };

    const outcome = await runCutover(options({ release: next }), {
      kickstart, fetchImpl: service.fetchImpl, ...fakeClock(), runId: 'r6',
    });

    assert.equal(outcome.result, 'ROLLED_BACK');
    assert.equal(fs.readlinkSync(current), old);
  });

  it('changes nothing when the release directory is missing', async () => {
    const old = makeRelease('1.0.0', '1.0.0');
    const current = path.join(root, 'current');
    fs.symlinkSync(old, current);
    const service = fakeService(current);

    const outcome = await runCutover(options({ release: path.join(root, 'nope') }), {
      kickstart: service.kickstart, fetchImpl: service.fetchImpl, ...fakeClock(), runId: 'r7',
    });

    assert.equal(outcome.result, 'FAILED');
    assert.equal(fs.readlinkSync(current), old);
    assert.equal(service.kickstarts, 0);
  });
});

describe('readRunResult', () => {
  it('reads the RESULT of the latest run only, never an older run', () => {
    const log = path.join(root, 'cutover.log');
    fs.writeFileSync(log, [
      't [a] === run a start pid=1',
      't [a] RESULT a LIVE 1.0.0 from /x',
      't [b] === run b start pid=2',
      't [b] probe 1: ECONNREFUSED',
      '',
    ].join('\n'));

    assert.deepEqual(readRunResult(log), { runId: 'b', found: true, result: null });
    assert.equal(readRunResult(log, 'a').result, 'LIVE');
    assert.equal(readRunResult(log, 'zzz').found, false);
  });
});

describe('arguments', () => {
  it('reproduces the options with absolute paths for the launchd job', () => {
    const parsed = parseArgs([
      '--release', 'rel', '--link', 'cur', '--service', 'x.y', '--probe-url', 'http://h/health',
      '--also', 'a=b', '--state-dir', 'st', '--expect-version', '2.0.0',
    ], {});
    const again = parseArgs(cutoverArgs(parsed), {});
    assert.equal(path.isAbsolute(again.release), true);
    assert.deepEqual({ ...again, detach: false }, { ...parsed, detach: false });
  });

  it('takes the label and probe URL from the environment, and requires them', () => {
    const env = { VIBESPACE_LAUNCH_LABEL: 'l', VIBESPACE_PROBE_URL: 'u' };
    const parsed = parseArgs(['--release', '/r', '--link', '/c'], env);
    assert.equal(parsed.service, 'l');
    assert.equal(parsed.probeUrl, 'u');
    assert.throws(() => parseArgs(['--release', '/r', '--link', '/c'], {}), /--service/);
    assert.throws(() => parseArgs(['--release', '/r'], env), /--link is required/);
  });

  it('writes a one-shot job that launchd neither restarts nor reaps with its group', () => {
    const plist = oneShotPlist('vibespace.cutover.x', ['/node', '/c.mjs', '--release', 'a&b'], '/log');
    assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
    assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    assert.match(plist, /a&amp;b/);
  });
});
