#!/usr/bin/env node
// Cut a launchd-managed VibeSpace over to an installed release, verify it, and roll back on
// failure — from a process that survives the restart it causes.
//
// Why a separate program: an agent running inside VibeSpace that restarts VibeSpace kills
// itself, and with it every child it started. A cutover script launched with `nohup … &`
// from such a session still sits in the service's process tree, so the kickstart takes it
// down between the restart and the probe: the release goes live (or doesn't) and nothing
// writes down which. `--detach` hands the run to launchd as a one-shot job of its own, so it
// outlives the service restart and always writes its RESULT line.
//
// Nothing machine-specific lives here — this repository is public. The launchd label and the
// probe URL are arguments or environment (VIBESPACE_LAUNCH_LABEL, VIBESPACE_PROBE_URL).
//
//   node scripts/release/cutover.mjs --release <dir> --link <symlink> --service <label> --probe-url <url> [--detach]
//   node scripts/release/cutover.mjs --status [--run-id <id>]
//
// Options:
//   --release <dir>        release directory to point the link at (required)
//   --link <path>          the symlink the service runs from, e.g. ~/.vibespace/current (required)
//   --also <link>=<target> flip one more symlink with it, e.g. a plugin release; repeatable
//   --service <label>      launchd label to kickstart (gui/<uid>/<label>)
//   --probe-url <url>      health URL; must answer JSON with `version`
//   --expect-version <v>   version the probe must report (default: read from the release)
//   --probe-timeout <s>    seconds to wait for the probe after a restart (default 150)
//   --state-dir <dir>      lock, pid, log and last-run.json (default ~/.vibespace/cutover)
//   --detach               run as a one-shot launchd job and return its run id at once
//
// Every run appends to <state-dir>/cutover.log under a `=== run <id>` header and ends with
// exactly one `RESULT <id> LIVE|ROLLED_BACK|FAILED …` line; `--status` reads the RESULT of
// the latest run (or of --run-id) only after that run's own header, never an older one.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@vibespace-ai/vibespace';
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.vibespace', 'cutover');
const JOB_LABEL_PREFIX = 'vibespace.cutover';

export function parseArgs(argv, env = process.env) {
  const options = {
    release: null,
    link: null,
    also: [],
    service: env.VIBESPACE_LAUNCH_LABEL || null,
    probeUrl: env.VIBESPACE_PROBE_URL || null,
    expectVersion: null,
    probeTimeoutS: 150,
    stateDir: DEFAULT_STATE_DIR,
    detach: false,
    status: false,
    runId: null,
    jobLabel: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--release') options.release = path.resolve(next());
    else if (arg === '--link') options.link = path.resolve(next());
    else if (arg === '--also') {
      const [link, target] = next().split('=');
      if (!link || !target) throw new Error('--also needs <link>=<target>');
      options.also.push({ link: path.resolve(link), target: path.resolve(target) });
    } else if (arg === '--service') options.service = next();
    else if (arg === '--probe-url') options.probeUrl = next();
    else if (arg === '--expect-version') options.expectVersion = next();
    else if (arg === '--probe-timeout') options.probeTimeoutS = Number(next());
    else if (arg === '--state-dir') options.stateDir = path.resolve(next());
    else if (arg === '--detach') options.detach = true;
    else if (arg === '--status') options.status = true;
    else if (arg === '--run-id') options.runId = next();
    else if (arg === '--job-label') options.jobLabel = next(); // internal: set by --detach
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.status) return options;
  if (!options.release) throw new Error('--release is required');
  // No default on purpose: a defaulted link once pointed a smoke test at the live install.
  if (!options.link) throw new Error('--link is required (the symlink the service runs from)');
  if (!options.service) throw new Error('--service (or VIBESPACE_LAUNCH_LABEL) is required');
  if (!options.probeUrl) throw new Error('--probe-url (or VIBESPACE_PROBE_URL) is required');
  if (!Number.isFinite(options.probeTimeoutS) || options.probeTimeoutS <= 0) {
    throw new Error('--probe-timeout needs a positive number of seconds');
  }
  return options;
}

export function statePaths(stateDir) {
  return {
    lock: path.join(stateDir, 'cutover.lock'),
    pid: path.join(stateDir, 'cutover.pid'),
    log: path.join(stateDir, 'cutover.log'),
    lastRun: path.join(stateDir, 'last-run.json'),
  };
}

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/** The version a release will report: its installed package, else its own package.json. */
export function releaseVersion(releaseDir) {
  const candidates = [
    path.join(releaseDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json'),
    path.join(releaseDir, 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const { version } = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (version && version !== '0.0.0') return version;
    } catch { /* try the next one */ }
  }
  return null;
}

// --- the single-run lock ---------------------------------------------------------------
//
// mkdir is atomic: exactly one run creates the directory. A lock whose owner is gone (its pid
// answers ESRCH) is stale and taken over; any other answer — alive, EPERM, unreadable owner —
// counts as held, because "I could not check" is not "nobody holds it".

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export function acquireLock(lockDir, owner) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify(owner)}\n`);
      return { acquired: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    } catch { /* unreadable: treated as held below */ }
    if (!holder || !Number.isInteger(holder.pid) || pidAlive(holder.pid)) {
      return { acquired: false, holder };
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  return { acquired: false, holder: null };
}

export function releaseLock(lockDir, runId) {
  try {
    const holder = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    if (holder.runId !== runId) return;
  } catch {
    return;
  }
  fs.rmSync(lockDir, { recursive: true, force: true });
}

// --- the run-scoped log ----------------------------------------------------------------

export function createLogger(logFile, runId, echo = false) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return (message) => {
    const line = `${new Date().toISOString()} [${runId}] ${message}\n`;
    fs.appendFileSync(logFile, line);
    if (echo) process.stdout.write(line);
  };
}

/** The RESULT of one run, read only after that run's own header. */
export function readRunResult(logFile, runId = null) {
  let text = '';
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch {
    return { runId, found: false, result: null };
  }
  const lines = text.split('\n');
  let start = -1;
  let id = runId;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/=== run (\S+) start/);
    if (match && (!runId || match[1] === runId)) {
      start = i;
      id = match[1];
      break;
    }
  }
  if (start === -1) return { runId, found: false, result: null };
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].includes(`=== run `) && !lines[i].includes(`=== run ${id} `)) break;
    const match = lines[i].match(new RegExp(`RESULT ${id} (\\S+)(.*)$`));
    if (match) return { runId: id, found: true, result: match[1], detail: match[2].trim() };
  }
  return { runId: id, found: true, result: null };
}

// --- links -----------------------------------------------------------------------------

function readLink(link) {
  try {
    return fs.readlinkSync(link);
  } catch {
    return null;
  }
}

/** Points `link` at `target` atomically: there is no moment without the link. */
export function flipLink(link, target) {
  const staging = `${link}.staging-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.symlinkSync(target, staging);
  fs.renameSync(staging, link);
}

// --- the cutover -----------------------------------------------------------------------

async function probeVersion(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = await response.json();
    return { ok: true, version: typeof body?.version === 'string' ? body.version : null };
  } catch (error) {
    return { ok: false, detail: error?.cause?.code || error?.name || String(error) };
  }
}

async function waitForVersion(url, want, { timeoutS, fetchImpl, sleep, now, log }) {
  const deadline = now() + timeoutS * 1_000;
  let last = 'no answer yet';
  for (let attempt = 1; now() < deadline; attempt += 1) {
    const answer = await probeVersion(url, fetchImpl);
    last = answer.ok ? `version ${answer.version ?? '(none)'}` : answer.detail;
    if (attempt === 1 || attempt % 5 === 0 || (answer.ok && answer.version === want)) {
      log(`probe ${attempt}: ${last}`);
    }
    if (answer.ok && answer.version === want) return { ok: true };
    await sleep(3_000);
  }
  return { ok: false, last };
}

function defaultKickstart(label) {
  const uid = process.getuid();
  const result = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { encoding: 'utf8' });
  return { ok: result.status === 0, detail: (result.stderr || result.stdout || '').trim() || `exit ${result.status}` };
}

/**
 * One cutover. Everything with an outside effect is injectable so the sequencing — lock,
 * flip, restart, verify, roll back, RESULT — can be exercised without a real service.
 * Resolves to the result written to the log; never throws past the lock.
 */
export async function runCutover(options, deps = {}) {
  const {
    kickstart = defaultKickstart,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now = Date.now,
    runId = options.runId || newRunId(),
    echo = false,
  } = deps;
  const paths = statePaths(options.stateDir);
  const log = createLogger(paths.log, runId, echo);
  log(`=== run ${runId} start pid=${process.pid} release=${options.release}`);

  const finish = (result, detail) => {
    log(`RESULT ${runId} ${result} ${detail}`);
    try {
      fs.writeFileSync(paths.lastRun, `${JSON.stringify({ runId, result, detail, at: new Date().toISOString() }, null, 2)}\n`);
    } catch { /* the log line is the record */ }
    return { runId, result, detail };
  };

  const lock = acquireLock(paths.lock, { pid: process.pid, runId, startedAt: new Date().toISOString() });
  if (!lock.acquired) {
    return finish('FAILED', `another cutover holds the lock (${JSON.stringify(lock.holder)}); nothing changed`);
  }
  fs.writeFileSync(paths.pid, `${process.pid}\n`);

  try {
    if (!fs.existsSync(options.release)) {
      return finish('FAILED', `${options.release} does not exist; nothing changed`);
    }
    const want = options.expectVersion || releaseVersion(options.release);
    if (!want) return finish('FAILED', `cannot tell which version ${options.release} holds; pass --expect-version`);
    for (const extra of options.also) {
      if (!fs.existsSync(extra.target)) return finish('FAILED', `${extra.target} does not exist; nothing changed`);
    }

    const flips = [{ link: options.link, target: options.release }, ...options.also];
    const previous = flips.map(({ link }) => ({ link, target: readLink(link) }));
    const previousVersion = previous[0].target ? releaseVersion(path.resolve(path.dirname(options.link), previous[0].target)) : null;
    for (const entry of previous) log(`previous ${entry.link} -> ${entry.target ?? '(none)'}`);

    for (const { link, target } of flips) {
      flipLink(link, target);
      log(`flipped ${link} -> ${readLink(link)}`);
    }

    const restart = kickstart(options.service);
    log(`kickstart ${options.service}: ${restart.ok ? 'ok' : `failed (${restart.detail})`}`);

    const probe = restart.ok
      ? await waitForVersion(options.probeUrl, want, { timeoutS: options.probeTimeoutS, fetchImpl, sleep, now, log })
      : { ok: false, last: 'kickstart failed' };
    const linksHold = flips.every(({ link, target }) => readLink(link) === target);
    if (probe.ok && linksHold) {
      return finish('LIVE', `${want} from ${options.release}`);
    }

    log(`verification failed (${probe.ok ? 'a link moved during the cutover' : probe.last}); rolling back`);
    for (const entry of previous) {
      if (entry.target) flipLink(entry.link, entry.target);
      else fs.rmSync(entry.link, { force: true });
      log(`restored ${entry.link} -> ${readLink(entry.link) ?? '(none)'}`);
    }
    if (!previous[0].target) return finish('FAILED', 'no previous release to roll back to; the service may be down');
    const again = kickstart(options.service);
    log(`kickstart ${options.service} (rollback): ${again.ok ? 'ok' : `failed (${again.detail})`}`);
    const back = previousVersion
      ? await waitForVersion(options.probeUrl, previousVersion, { timeoutS: options.probeTimeoutS, fetchImpl, sleep, now, log })
      : { ok: false, last: 'previous version unknown' };
    return back.ok
      ? finish('ROLLED_BACK', `to ${previousVersion} at ${previous[0].target}`)
      : finish('FAILED', `rolled the links back but the probe did not confirm ${previousVersion ?? 'the previous version'} (${back.last}); the service may be down`);
  } catch (error) {
    return finish('FAILED', `unexpected error: ${error?.stack || error}`);
  } finally {
    try { fs.rmSync(paths.pid, { force: true }); } catch { /* best effort */ }
    releaseLock(paths.lock, runId);
  }
}

// --- detaching into launchd ------------------------------------------------------------

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A one-shot LaunchAgent: runs once at load, never restarted, its own process group. */
export function oneShotPlist(label, programArguments, logFile) {
  const args = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

/** The arguments that reproduce `options` — absolute paths, since launchd starts jobs in `/`. */
export function cutoverArgs(options) {
  const args = [
    '--release', options.release,
    '--link', options.link,
    '--service', options.service,
    '--probe-url', options.probeUrl,
    '--probe-timeout', String(options.probeTimeoutS),
    '--state-dir', options.stateDir,
  ];
  for (const { link, target } of options.also) args.push('--also', `${link}=${target}`);
  if (options.expectVersion) args.push('--expect-version', options.expectVersion);
  return args;
}

export function jobPlistPath(stateDir, label) {
  return path.join(stateDir, `${label}.plist`);
}

function detach(options) {
  const runId = newRunId();
  const paths = statePaths(options.stateDir);
  fs.mkdirSync(options.stateDir, { recursive: true });
  const label = `${JOB_LABEL_PREFIX}.${runId}`;
  const plist = jobPlistPath(options.stateDir, label);
  const programArguments = [
    process.execPath, fileURLToPath(import.meta.url), ...cutoverArgs(options),
    '--run-id', runId, '--job-label', label,
  ];
  fs.writeFileSync(plist, oneShotPlist(label, programArguments, paths.log));
  const result = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { encoding: 'utf8' });
  if (result.status !== 0) {
    fs.rmSync(plist, { force: true });
    throw new Error(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return { runId, label, log: paths.log };
}

/**
 * A finished one-shot job removes its plist and has launchd forget it. The bootout runs a
 * moment after this process has exited, from its own process group: booting out a job
 * from inside it would wait on the SIGTERM it sends to the very process waiting.
 */
function retireJob(stateDir, label) {
  fs.rmSync(jobPlistPath(stateDir, label), { force: true });
  const target = `gui/${process.getuid()}/${label}`;
  spawn('/bin/sh', ['-c', `sleep 2; launchctl bootout ${target}`], { detached: true, stdio: 'ignore' }).unref();
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.status) {
    const status = readRunResult(statePaths(options.stateDir).log, options.runId);
    process.stdout.write(`${JSON.stringify(status)}\n`);
    process.exitCode = status.result === 'LIVE' ? 0 : 1;
    return;
  }
  if (options.detach) {
    const { runId, label, log } = detach(options);
    process.stdout.write(`started cutover run ${runId} as launchd job ${label}\nlog: ${log}\n`
      + `status: node ${fileURLToPath(import.meta.url)} --status --state-dir ${options.stateDir} --run-id ${runId}\n`);
    return;
  }
  const outcome = await runCutover(options, { echo: !options.jobLabel });
  process.exitCode = outcome.result === 'LIVE' ? 0 : 1;
  if (options.jobLabel) retireJob(options.stateDir, options.jobLabel);
}
function invokedDirectly() {
  try {
    return !!process.argv[1]
      && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`cutover: ${error.message}\n`);
    process.exit(2);
  });
}
