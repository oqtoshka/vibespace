/**
 * Wake-after-retryable-provider-interruption for agent sessions.
 *
 * A turn that dies on the provider's usage limit (Claude's "You've hit your
 * session limit · resets 7:30pm", Codex's `usageLimitExceeded`) is not a turn
 * the model chose to end: the work is unfinished, and the only thing standing
 * between it and continuing is the clock. This service remembers such
 * sessions — mirrored to <dataDir>/rate-limited-sessions.json so the promise
 * survives a server restart — and, once the limit has reset (plus a small
 * grace), starts a `[session supervisor]` continuation turn, the same shape the
 * restore-on-boot and task-nudge mechanisms inject.
 *
 * While a wake is pending the other supervisors stand down for that session:
 * the Claude idle reaper must not nudge it (every nudge would just hit the
 * limit again and burn the nudge budget, which is exactly what happened before
 * this existed), and the boot restore pass must not resume it early. A
 * user-sent turn cancels the pending wake — the user has taken over; if that
 * turn hits the limit too, the provider re-schedules.
 *
 * Reset time comes from the provider (Claude `rate_limit_event` /
 * `quotaLimits.resetsAt`, Codex `account/rateLimits`), falling back to parsing
 * the human message, and finally to an escalating retry delay. Attempts are
 * bounded so a session whose limit never clears does not retry forever.
 * Claude HTTP 529 is different: it is a transient overload with no reset
 * timestamp, so it retries every five minutes without an attempt ceiling until
 * a turn gets through (or the user sends a new turn and takes over).
 *
 * VIBESPACE_RATE_LIMIT_WAKE=0 disables scheduling (recording nothing).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { getDataDir } from '../utils/worktrees.js';

import { notifyRunFailed, notifyRunPaused } from './notification-orchestrator.js';

const WAKE_ENABLED = !['0', 'false', 'off'].includes((process.env.VIBESPACE_RATE_LIMIT_WAKE || '').trim().toLowerCase());
// Wait this long past the reported reset before resuming: the reset timestamp
// is the provider's clock, and resuming a few seconds early just re-hits.
const WAKE_GRACE_MS = parseInt(process.env.VIBESPACE_RATE_LIMIT_WAKE_GRACE_MS, 10) || 90 * 1000;
// When the provider gave no usable reset time: first retry after this long,
// doubling per attempt up to WAKE_RETRY_MAX_MS.
const WAKE_RETRY_MS = parseInt(process.env.VIBESPACE_RATE_LIMIT_WAKE_RETRY_MS, 10) || 30 * 60 * 1000;
const WAKE_RETRY_MAX_MS = 4 * 60 * 60 * 1000;
// Anthropic overloads are normally brief but can recur for hours. Retrying at
// a fixed, deliberately quiet cadence avoids both a hot loop and a backoff that
// eventually leaves unfinished work parked for half a day.
const CLAUDE_529_RETRY_MS = parseInt(process.env.VIBESPACE_CLAUDE_529_RETRY_MS, 10) || 5 * 60 * 1000;
// A wake that hits the limit again is re-scheduled; stop after this many.
const WAKE_MAX_ATTEMPTS = parseInt(process.env.VIBESPACE_RATE_LIMIT_WAKE_MAX_ATTEMPTS, 10) || 12;
// Sanity bound on how far out a reset may be (weekly limits are the longest
// real window); anything further is a parse error, not a plan.
const WAKE_MAX_WAIT_MS = 14 * 24 * 60 * 60 * 1000;
// How often the scheduler looks for due entries. Resolution, not latency
// budget: the grace above already absorbs it.
const WAKE_POLL_MS = parseInt(process.env.VIBESPACE_RATE_LIMIT_WAKE_POLL_MS, 10) || 30 * 1000;
// A wake whose start keeps throwing (provider down, DB unreadable) is retried
// on later ticks this many times before it is dropped with a notification.
const WAKE_MAX_START_FAILURES = 3;

const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' };

const stateFile = () => path.join(getDataDir(), 'rate-limited-sessions.json');

// The ping is a courtesy; the schedule is the contract. A notification-side
// failure (preferences DB, push transport) must never lose the wake.
function safeNotify(send) {
  try {
    send();
  } catch (error) {
    console.warn('[rate-limit wake] notification failed:', error?.message || error);
  }
}

// providerSessionId -> entry. Mirrors the file.
const entries = new Map();
let loaded = false;
let loading = null;
let writeTimer = null;
let pollTimer = null;
let startTurnHook = null;
let tickInFlight = false;

async function loadOnce() {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(stateFile(), 'utf8'));
        for (const e of Array.isArray(raw) ? raw : []) {
          if (e && typeof e.providerSessionId === 'string' && typeof e.resumeAt === 'number') {
            entries.set(e.providerSessionId, e);
          }
        }
      } catch { /* first run or unreadable — start empty */ }
      loaded = true;
    })();
  }
  await loading;
}

/** Debounced atomic mirror of the registry to disk. */
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    const file = stateFile();
    const tmp = `${file}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify([...entries.values()], null, 2));
      await fs.rename(tmp, file);
    } catch (error) {
      console.warn('[rate-limit wake] failed to persist registry:', error?.message || error);
    }
  }, 500);
  writeTimer.unref?.();
}

/** Exported so the boot restore pass can consult the registry before acting. */
export async function loadRateLimitWakes() {
  await loadOnce();
}

/**
 * Normalizes a provider reset timestamp to epoch milliseconds. Providers
 * report epoch seconds (Claude `resetsAt`, Codex `resetsAt`); a millisecond
 * value is accepted too. Anything unparseable or absurdly far out yields
 * null (the caller falls back); a time already in the past is returned as-is
 * and means "resume now".
 */
export function normalizeResetsAt(value, now = Date.now()) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  if (ms - now > WAKE_MAX_WAIT_MS) return null;
  return ms;
}

function wallClockIn(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl renders midnight as "24" in some engines with hour12:false.
  return { hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort parse of a human limit message into a reset time (epoch ms).
 * Understands the shapes the CLIs actually print:
 *   "resets 7:30pm (Europe/Moscow)", "resets at 19:30", "try again at 3:15pm"
 *   "try again in 2 hours 15 minutes", "resets in 45 minutes", "in 1h 20m"
 * A wall-clock time is taken as the next occurrence of that time in the named
 * zone (or this process's zone when none is given). Returns null when nothing
 * matches.
 */
export function parseResetFromText(text, now = Date.now()) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = text.replace(/\s+/g, ' ');

  const rel = s.match(/\b(?:in|after)\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*(?:and\s*)?)+)/i);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (unit.startsWith('h')) ms += n * 3600_000;
      else if (unit.startsWith('m')) ms += n * 60_000;
      else ms += n * 1000;
    }
    if (ms > 0) return normalizeResetsAt(now + ms, now);
  }

  const abs = s.match(/\b(?:resets?|try again|available|back)\s*(?:at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([A-Za-z_]+\/[A-Za-z_/+-]+)\))?/i);
  if (!abs) return null;
  let hour = Number(abs[1]);
  const minute = abs[2] ? Number(abs[2]) : 0;
  const meridiem = abs[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!meridiem && !abs[2]) return null; // a bare "resets 7" is not a time
  if (hour > 23 || minute > 59) return null;

  const zone = abs[4] && isValidTimeZone(abs[4]) ? abs[4] : undefined;
  const here = wallClockIn(zone, now);
  const nowSec = here.hour * 3600 + here.minute * 60 + here.second;
  let diffSec = hour * 3600 + minute * 60 - nowSec;
  // Already past today (or right now): it means tomorrow. A reset printed a
  // minute or two "ago" is clock skew, and tomorrow would be wrong — treat the
  // last few minutes as "now".
  if (diffSec < -5 * 60) diffSec += 24 * 3600;
  if (diffSec < 0) diffSec = 0;
  return normalizeResetsAt(now + diffSec * 1000, now);
}

/**
 * Resolves the reset time from whatever the provider offered, in order of
 * trust: an explicit timestamp, then the human message. Null means unknown.
 */
export function resolveResetsAt({ resetsAt, text } = {}, now = Date.now()) {
  return normalizeResetsAt(resetsAt, now) ?? parseResetFromText(text, now);
}

function formatWhen(ms) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short', timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The supervisor prompt for one wake. Exported for tests and providers. */
export function buildRateLimitWakePrompt(entry, now = Date.now()) {
  const label = PROVIDER_LABELS[entry.provider] || 'provider';
  if (entry.recoveryKind === 'claude-529') {
    return [
      '[session supervisor] Claude returned HTTP 529 (service overloaded) before completing the previous turn.',
      'This is the automatic retry for that same unfinished work, not a new request from the user.',
      'Review the tail of the transcript and the task ledger, then continue exactly where the interrupted turn stopped.',
      'If Claude is still overloaded, VibeSpace will resend this same retry in five minutes; do not create a separate task or message for another retry.',
      `<!-- vibespace-retry:${entry.messageId || entry.providerSessionId} -->`,
    ].join(' ');
  }
  const quoted = entry.limitText ? ` ("${String(entry.limitText).replace(/\s+/g, ' ').trim().slice(0, 200)}" at the end of this transcript)` : '';
  const attempt = entry.attempts > 1 ? ` This is automatic resume attempt ${entry.attempts}.` : '';
  return [
    `[session supervisor] Your previous turn did not fail and the user did not stop you: it was cut off by the ${label} usage limit${quoted}.`,
    `That limit has reset now (${formatWhen(now)}), so this is an automatic resume.${attempt}`,
    'Re-read the tail of your own transcript and your task ledger first, re-verify anything you had only half-confirmed when the limit hit (do not trust an unverified claim from before the cut), then continue where you left off.',
    'Update task statuses as you go and finish or explicitly re-scope every open item — do not stop while items remain open.',
  ].join(' ');
}

/**
 * Records a session whose turn just died on the usage limit and schedules its
 * wake. Idempotent per session: a second hit (the wake itself re-hitting)
 * replaces the entry and counts an attempt. Returns the entry, or null when
 * the mechanism is off / the attempt budget is spent (that path notifies the
 * user through the ordinary run-failed channel, since nothing will retry).
 */
export async function scheduleRateLimitWake({
  provider,
  providerSessionId,
  userId = null,
  sessionName = null,
  resetsAt = null,
  limitType = null,
  limitText = null,
  permissionMode = null,
  recoveryKind = 'usage-limit',
  messageId = null,
  priorAttempts = 0,
  now = Date.now(),
}) {
  if (!WAKE_ENABLED || !provider || !providerSessionId) return null;
  await loadOnce();

  const prev = entries.get(providerSessionId);
  const attempts = Math.max(prev?.attempts || 0, priorAttempts || 0) + 1;
  const retryForever = recoveryKind === 'claude-529';
  if (!retryForever && attempts > WAKE_MAX_ATTEMPTS) {
    console.log(`[rate-limit wake] ${provider} session ${providerSessionId}: giving up after ${prev.attempts} resume attempt(s)`);
    entries.delete(providerSessionId);
    scheduleWrite();
    safeNotify(() => notifyRunFailed({
      userId,
      provider,
      sessionId: providerSessionId,
      sessionName,
      error: `Usage limit still in force after ${prev.attempts} automatic resume attempt(s) — giving up`,
    }));
    return null;
  }

  const known = retryForever ? null : resolveResetsAt({ resetsAt, text: limitText }, now);
  let resumeAt;
  let source;
  if (retryForever) {
    resumeAt = now + CLAUDE_529_RETRY_MS;
    source = 'fixed-529-retry';
  } else if (known !== null) {
    resumeAt = Math.max(known, now) + WAKE_GRACE_MS;
    source = 'provider';
  } else {
    const delay = Math.min(WAKE_RETRY_MS * 2 ** (attempts - 1), WAKE_RETRY_MAX_MS);
    resumeAt = now + delay;
    source = 'retry-backoff';
  }

  const entry = {
    provider,
    providerSessionId,
    userId: userId ?? prev?.userId ?? null,
    sessionName: sessionName ?? prev?.sessionName ?? null,
    permissionMode: permissionMode ?? prev?.permissionMode ?? null,
    recoveryKind,
    // Stable across every 529 attempt. The websocket/history layers use this
    // identity to render one supervisor bubble even though the provider must
    // receive the prompt again for every retry.
    messageId: messageId ?? prev?.messageId ?? randomUUID(),
    resetsAt: known,
    resumeAt,
    limitType: limitType ?? null,
    limitText: limitText ? String(limitText).slice(0, 500) : null,
    attempts,
    startFailures: 0,
    recordedAt: now,
  };
  entries.set(providerSessionId, entry);
  scheduleWrite();
  const attemptBudget = retryForever ? '∞' : WAKE_MAX_ATTEMPTS;
  console.log(`[rate-limit wake] ${provider} session ${providerSessionId}: interrupted (${limitType || recoveryKind}), resuming at ${new Date(resumeAt).toISOString()} (${source}, attempt ${attempts}/${attemptBudget})`);
  // A recurring 529 is one incident, not a fresh pause every five minutes.
  // Notify once when it starts; subsequent attempts only move the durable wake.
  if (!retryForever || attempts === 1) {
    safeNotify(() => notifyRunPaused({
      userId: entry.userId,
      provider,
      sessionId: providerSessionId,
      sessionName: entry.sessionName,
      resumeAt,
      limitType,
    }));
  }
  return entry;
}

/** Drops a pending wake — the user (or a wake) has taken the session over. */
export async function cancelRateLimitWake(providerSessionId) {
  if (!providerSessionId) return false;
  await loadOnce();
  if (!entries.delete(providerSessionId)) return false;
  scheduleWrite();
  return true;
}

/**
 * Removes a session's wake for good and flushes the file now — the shred
 * path, which must leave no trace on disk. Returns whether one was there.
 */
export async function forgetRateLimitWake(providerSessionId) {
  if (!providerSessionId) return false;
  await loadOnce();
  if (!entries.delete(providerSessionId)) return false;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const file = stateFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify([...entries.values()], null, 2));
  await fs.rename(tmp, file);
  return true;
}

/**
 * Whether a wake is pending for the session. Synchronous on the in-memory
 * registry — callers that run before the boot load (the restore pass) await
 * `loadRateLimitWakes()` first.
 */
export function isRateLimitWakePending(providerSessionId) {
  return Boolean(providerSessionId) && entries.has(providerSessionId);
}

export function getRateLimitWake(providerSessionId) {
  return entries.get(providerSessionId) || null;
}

/**
 * One scheduler pass: starts every due wake. `startTurn(entry, prompt)` is the
 * injected starter (index.js routes it through the server-owned message
 * queue so the turn is a real, client-visible run); it returns true when the
 * turn was started, false when the session no longer exists. Exported for
 * tests; the boot loop calls it on a timer.
 */
export async function runRateLimitWakeTick(now = Date.now()) {
  if (!startTurnHook || tickInFlight) return [];
  tickInFlight = true;
  const woken = [];
  try {
    await loadOnce();
    const due = [...entries.values()].filter((e) => e.resumeAt <= now);
    for (const entry of due) {
      // Consumed before the turn starts: the turn's own limit hit (if any)
      // re-records it, and a user send in the meantime has nothing to cancel.
      entries.delete(entry.providerSessionId);
      scheduleWrite();
      const prompt = buildRateLimitWakePrompt(entry, now);
      let started = false;
      try {
        started = Boolean(await startTurnHook(entry, prompt));
      } catch (error) {
        entry.startFailures = (entry.startFailures || 0) + 1;
        if (entry.startFailures < WAKE_MAX_START_FAILURES) {
          console.warn(`[rate-limit wake] ${entry.provider} session ${entry.providerSessionId}: resume failed (${entry.startFailures}/${WAKE_MAX_START_FAILURES}), retrying next tick:`, error?.message || error);
          entry.resumeAt = now + WAKE_POLL_MS;
          entries.set(entry.providerSessionId, entry);
          scheduleWrite();
          continue;
        }
        console.error(`[rate-limit wake] ${entry.provider} session ${entry.providerSessionId}: resume keeps failing, dropping:`, error?.message || error);
        safeNotify(() => notifyRunFailed({
          userId: entry.userId,
          provider: entry.provider,
          sessionId: entry.providerSessionId,
          sessionName: entry.sessionName,
          error: `Automatic resume after the usage limit failed: ${error?.message || error}`,
        }));
        continue;
      }
      if (!started) {
        console.log(`[rate-limit wake] ${entry.provider} session ${entry.providerSessionId}: no longer exists, dropping`);
        continue;
      }
      console.log(`[rate-limit wake] ${entry.provider} session ${entry.providerSessionId}: resumed (attempt ${entry.attempts})`);
      woken.push(entry.providerSessionId);
      // Small stagger so several wakes due at once don't spawn CLIs together.
      if (due.length > 1) await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    tickInFlight = false;
  }
  return woken;
}

/**
 * Boot: load the registry and start the scheduler. `startTurn` — see
 * `runRateLimitWakeTick`. Safe to call once per process; a second call just
 * replaces the hook.
 */
export async function startRateLimitWakeLoop({ startTurn }) {
  startTurnHook = typeof startTurn === 'function' ? startTurn : null;
  await loadOnce();
  if (pollTimer) return;
  const pending = entries.size;
  console.log(`[rate-limit wake] scheduler armed (poll ${Math.round(WAKE_POLL_MS / 1000)}s, ${pending} session(s) waiting for a usage-limit reset)`);
  pollTimer = setInterval(() => {
    runRateLimitWakeTick().catch((error) => {
      console.error('[rate-limit wake] scheduler tick failed:', error?.message || error);
    });
  }, WAKE_POLL_MS);
  pollTimer.unref?.();
}

/** Test seam: reset module state between cases. */
export function __resetRateLimitWakeState() {
  entries.clear();
  loaded = false;
  loading = null;
  startTurnHook = null;
  tickInFlight = false;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
