import { execFile } from 'node:child_process';
import { readdir, readlink } from 'node:fs/promises';

/**
 * Bounded observation of this server's own file descriptors and children.
 *
 * On 2026-09-29 an xcodebuild on the Mac stalled with clang blocked in write()
 * to SWBBuildService: new pipes on the host were being created with 512-byte
 * buffers instead of 65536, the kernel's answer to too much pipe memory in use,
 * and restarting only the VibeSpace server restored 65536. Nothing recorded how
 * many pipes the server held before that restart, so which holder it was stays
 * unproven. This sampler keeps the answer for next time.
 *
 * It records only counts by descriptor type plus the PIDs of live direct
 * children — never paths, socket peers or anything a request carried. Every
 * probe has a Node-side deadline; a failed probe is `{ ok: false, error }` in
 * the ring, never a zero that would read as "no descriptors".
 */

/** Result of running an external probe command. */
export type FdProbeExecResult = { stdout: string };

/**
 * Runs `file args` and resolves its stdout. Rejects on spawn failure or a
 * non-zero exit; the error's `code` carries the exit status when there is one.
 */
export type FdProbeExec = (
  file: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<FdProbeExecResult>;

export type FdChildrenObservation =
  | { ok: true; count: number; pids: number[]; truncated: boolean }
  | { ok: false; error: string };

export type FdSample =
  | {
      ok: true;
      at: string;
      source: 'procfs' | 'lsof';
      durationMs: number;
      /** Numeric descriptors only (lsof's cwd/txt/mem rows are not descriptors). */
      total: number;
      /** Descriptor count per type: PIPE, unix, REG, IPv4, KQUEUE… (procfs: pipe, socket, file, anon_inode…). */
      byType: Record<string, number>;
      children: FdChildrenObservation;
    }
  | { ok: false; at: string; durationMs: number; error: string };

export type FdObserverOptions = {
  pid?: number;
  platform?: NodeJS.Platform;
  exec?: FdProbeExec;
  /** Linux only: lists and resolves `/proc/<pid>/fd`. */
  procfs?: { readdir: (dir: string) => Promise<string[]>; readlink: (link: string) => Promise<string> };
  probeTimeoutMs?: number;
  intervalMs?: number;
  ringSize?: number;
  now?: () => number;
};

export const FD_PROBE_TIMEOUT_MS = 5_000;
export const FD_PROBE_TIMEOUT_MAX_MS = 30_000;
export const FD_SAMPLE_INTERVAL_MS = 60_000;
export const FD_SAMPLE_INTERVAL_MIN_MS = 5_000;
export const FD_SAMPLE_INTERVAL_MAX_MS = 60 * 60_000;
export const FD_RING_SIZE = 60;
export const FD_RING_SIZE_MAX = 1_000;
/** How many child PIDs a sample keeps; the count stays exact. */
export const FD_CHILD_PIDS_MAX = 64;
// lsof -F output is a few bytes per descriptor; this covers ~100k of them.
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined && !error.message.includes(String(code)) ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

/** Default exec: execFile with its own kill timeout, no shell. */
export const defaultFdProbeExec: FdProbeExec = (file, args, { timeoutMs, maxBuffer }) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout) });
    });
  });

/**
 * Settles within `timeoutMs` whatever the probe does. execFile's own timeout
 * kills lsof, but its callback still waits for the pipes to close; this is the
 * deadline the caller can rely on.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Counts `lsof -F ft` records by type; the input names no files. */
export function parseLsofFieldOutput(stdout: string): { total: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {};
  let total = 0;
  let numericFd = false;
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'f') {
      numericFd = /^\d+$/.test(value);
    } else if (tag === 't' && numericFd) {
      const type = value || 'unknown';
      byType[type] = (byType[type] ?? 0) + 1;
      total += 1;
      numericFd = false;
    }
  }
  return { total, byType };
}

/** Classifies a `/proc/<pid>/fd/<n>` link target without keeping it. */
export function classifyProcFdTarget(target: string): string {
  if (target.startsWith('pipe:')) return 'pipe';
  if (target.startsWith('socket:')) return 'socket';
  if (target.startsWith('anon_inode:')) return 'anon_inode';
  if (target.startsWith('/dev/')) return 'dev';
  if (target.startsWith('/')) return 'file';
  return 'other';
}

export class FdObserver {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly probeTimeoutMs: number;
  readonly intervalMs: number;
  readonly ringSize: number;
  private readonly exec: FdProbeExec;
  private readonly procfs: NonNullable<FdObserverOptions['procfs']>;
  private readonly now: () => number;
  private readonly ring: FdSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<FdSample> | null = null;

  constructor(options: FdObserverOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.platform = options.platform ?? process.platform;
    this.exec = options.exec ?? defaultFdProbeExec;
    this.procfs = options.procfs ?? { readdir: (dir) => readdir(dir), readlink: (link) => readlink(link) };
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = clamp(options.probeTimeoutMs, FD_PROBE_TIMEOUT_MS, 100, FD_PROBE_TIMEOUT_MAX_MS);
    this.intervalMs = clamp(options.intervalMs, FD_SAMPLE_INTERVAL_MS, FD_SAMPLE_INTERVAL_MIN_MS, FD_SAMPLE_INTERVAL_MAX_MS);
    this.ringSize = clamp(options.ringSize, FD_RING_SIZE, 1, FD_RING_SIZE_MAX);
  }

  /** Takes one sample without recording it. Never rejects. */
  async probe(): Promise<FdSample> {
    const startedAt = this.now();
    const at = new Date(startedAt).toISOString();
    try {
      const descriptors = this.platform === 'linux'
        ? { source: 'procfs' as const, ...(await withDeadline(this.probeProcfs(), this.probeTimeoutMs, 'procfs probe')) }
        : { source: 'lsof' as const, ...(await this.probeLsof()) };
      // Sequential, so the lsof run is gone before children are listed.
      const children = await this.probeChildren();
      return { ok: true, at, durationMs: this.now() - startedAt, ...descriptors, children };
    } catch (error) {
      return { ok: false, at, durationMs: this.now() - startedAt, error: errorMessage(error) };
    }
  }

  /** Takes a sample and appends it to the ring. Concurrent calls share one probe. */
  sample(): Promise<FdSample> {
    if (!this.inFlight) {
      this.inFlight = this.probe().then((sample) => {
        this.ring.push(sample);
        if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
        return sample;
      }).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Starts periodic sampling. Idempotent; the timer never keeps the process alive. */
  start(): () => void {
    if (!this.timer) {
      void this.sample();
      this.timer = setInterval(() => { void this.sample(); }, this.intervalMs);
      this.timer.unref?.();
    }
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Oldest first; a copy. */
  samples(): FdSample[] {
    return this.ring.slice();
  }

  snapshot() {
    return {
      pid: this.pid,
      platform: this.platform,
      intervalMs: this.intervalMs,
      probeTimeoutMs: this.probeTimeoutMs,
      ringSize: this.ringSize,
      running: this.timer !== null,
      samples: this.samples(),
    };
  }

  private async probeProcfs(): Promise<{ total: number; byType: Record<string, number> }> {
    const dir = `/proc/${this.pid}/fd`;
    const entries = await this.procfs.readdir(dir);
    const byType: Record<string, number> = {};
    let total = 0;
    for (const entry of entries) {
      let target: string;
      try {
        target = await this.procfs.readlink(`${dir}/${entry}`);
      } catch {
        // Closed between readdir and readlink (readdir's own descriptor is one).
        continue;
      }
      const type = classifyProcFdTarget(target);
      byType[type] = (byType[type] ?? 0) + 1;
      total += 1;
    }
    return { total, byType };
  }

  private async probeLsof(): Promise<{ total: number; byType: Record<string, number> }> {
    // -F ft: only descriptor and type fields — no names, no peers.
    const args = ['-n', '-P', '-w', '-p', String(this.pid), '-F', 'ft'];
    let stdout: string;
    try {
      ({ stdout } = await withDeadline(
        this.exec('lsof', args, { timeoutMs: this.probeTimeoutMs, maxBuffer: PROBE_MAX_BUFFER }),
        this.probeTimeoutMs,
        'lsof probe',
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('lsof is not installed');
      }
      throw new Error(`lsof failed: ${errorMessage(error)}`);
    }
    const parsed = parseLsofFieldOutput(stdout);
    if (parsed.total === 0) {
      // A live process always has descriptors; an empty parse is a failed probe.
      throw new Error('lsof returned no descriptors');
    }
    return parsed;
  }

  private async probeChildren(): Promise<FdChildrenObservation> {
    try {
      const { stdout } = await withDeadline(
        this.exec('pgrep', ['-P', String(this.pid)], { timeoutMs: this.probeTimeoutMs, maxBuffer: PROBE_MAX_BUFFER }),
        this.probeTimeoutMs,
        'pgrep probe',
      );
      return this.childrenFrom(stdout);
    } catch (error) {
      // pgrep exits 1 when nothing matched: zero children, not a failure.
      if ((error as { code?: unknown }).code === 1) {
        return { ok: true, count: 0, pids: [], truncated: false };
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, error: 'pgrep is not installed' };
      }
      return { ok: false, error: `pgrep failed: ${errorMessage(error)}` };
    }
  }

  private childrenFrom(stdout: string): FdChildrenObservation {
    const pids = stdout.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
    return {
      ok: true,
      count: pids.length,
      pids: pids.slice(0, FD_CHILD_PIDS_MAX),
      truncated: pids.length > FD_CHILD_PIDS_MAX,
    };
  }
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : Number(raw);
}

/**
 * The server's observer. Consumed by `server/index.js` (started next to the
 * event-loop health monitor, served at `GET /api/diagnostics/fd`).
 * `VIBESPACE_FD_SAMPLE_INTERVAL_MS` / `VIBESPACE_FD_RING_SIZE` /
 * `VIBESPACE_FD_PROBE_TIMEOUT_MS` tune it within the clamps above.
 */
export const fdObserver = new FdObserver({
  intervalMs: envNumber('VIBESPACE_FD_SAMPLE_INTERVAL_MS'),
  ringSize: envNumber('VIBESPACE_FD_RING_SIZE'),
  probeTimeoutMs: envNumber('VIBESPACE_FD_PROBE_TIMEOUT_MS'),
});
