import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Registry lives under getDataDir() → DATABASE_PATH's parent. Set before import.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rate-limit-wake-'));
process.env.DATABASE_PATH = path.join(tmp, 'data', 'auth.db');
process.env.VIBESPACE_RATE_LIMIT_WAKE_GRACE_MS = '1000';
process.env.VIBESPACE_RATE_LIMIT_WAKE_RETRY_MS = '60000';
process.env.VIBESPACE_RATE_LIMIT_WAKE_MAX_ATTEMPTS = '3';
process.env.VIBESPACE_CLAUDE_529_RETRY_MS = '300000';

const {
  normalizeResetsAt,
  parseResetFromText,
  resolveResetsAt,
  buildRateLimitWakePrompt,
  scheduleRateLimitWake,
  cancelRateLimitWake,
  forgetRateLimitWake,
  isRateLimitWakePending,
  getRateLimitWake,
  runRateLimitWakeTick,
  startRateLimitWakeLoop,
  loadRateLimitWakes,
  __resetRateLimitWakeState,
} = await import('../rate-limit-wake.service.js');

const stateFile = path.join(tmp, 'data', 'rate-limited-sessions.json');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  __resetRateLimitWakeState();
  await fs.rm(path.join(tmp, 'data'), { recursive: true, force: true });
});

test('normalizeResetsAt accepts epoch seconds and milliseconds, rejects junk', () => {
  const now = 1_787_243_000_000;
  assert.equal(normalizeResetsAt(1787243400, now), 1_787_243_400_000);
  assert.equal(normalizeResetsAt(1_787_243_400_000, now), 1_787_243_400_000);
  assert.equal(normalizeResetsAt('1787243400', now), 1_787_243_400_000);
  assert.equal(normalizeResetsAt(null, now), null);
  assert.equal(normalizeResetsAt('soon', now), null);
  assert.equal(normalizeResetsAt(0, now), null);
  // A month out is not a real reset window.
  assert.equal(normalizeResetsAt(now + 30 * 24 * 3600 * 1000, now), null);
});

test('parseResetFromText reads the Claude "resets 7:30pm (Zone)" shape as the next such wall-clock time', () => {
  // 15:00 UTC == 18:00 in Europe/Moscow (UTC+3, no DST) → 7:30pm is 90 min away.
  const now = Date.UTC(2026, 7, 20, 15, 0, 0);
  const at = parseResetFromText("You've hit your session limit · resets 7:30pm (Europe/Moscow)", now);
  assert.equal(at, now + 90 * 60 * 1000);
});

test('parseResetFromText rolls a wall-clock time already past today over to tomorrow', () => {
  const now = Date.UTC(2026, 7, 20, 17, 0, 0); // 20:00 Moscow
  const at = parseResetFromText('resets 7:30pm (Europe/Moscow)', now);
  assert.equal(at, now + (23 * 60 + 30) * 60 * 1000);
});

test('parseResetFromText reads relative "try again in …" phrasing', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseResetFromText("You've hit your usage limit. Try again in 2 hours 15 minutes.", now), now + (2 * 60 + 15) * 60 * 1000);
  assert.equal(parseResetFromText('resets in 45 minutes', now), now + 45 * 60 * 1000);
  assert.equal(parseResetFromText('back in 1h 20m', now), now + 80 * 60 * 1000);
});

test('parseResetFromText returns null when nothing time-like is present', () => {
  assert.equal(parseResetFromText('Rate limit exceeded', Date.now()), null);
  assert.equal(parseResetFromText('', Date.now()), null);
  assert.equal(parseResetFromText(null, Date.now()), null);
});

test('resolveResetsAt prefers the machine timestamp over the text', () => {
  const now = Date.UTC(2026, 7, 20, 15, 0, 0);
  assert.equal(resolveResetsAt({ resetsAt: 1787243400, text: 'resets 11:00pm (Europe/Moscow)' }, now), 1_787_243_400_000);
  assert.equal(resolveResetsAt({ resetsAt: null, text: 'resets 7:30pm (Europe/Moscow)' }, now), now + 90 * 60 * 1000);
  assert.equal(resolveResetsAt({}, now), null);
});

test('a limit hit is scheduled at reset + grace, persisted, and visible to the other supervisors', async () => {
  const now = Date.now();
  const entry = await scheduleRateLimitWake({
    provider: 'claude',
    providerSessionId: 'c-1',
    userId: 7,
    sessionName: 'Deploy thing',
    resetsAt: Math.floor((now + 60_000) / 1000),
    limitType: 'five_hour',
    limitText: "You've hit your session limit · resets 7:30pm (Europe/Moscow)",
    permissionMode: 'bypassPermissions',
    now,
  });
  assert.ok(entry);
  assert.equal(entry.attempts, 1);
  // Seconds → ms, plus the 1s grace from the env above (rounded by the seconds cast).
  assert.ok(Math.abs(entry.resumeAt - (now + 60_000 + 1000)) < 1000, `resumeAt ${entry.resumeAt} vs ${now + 61_000}`);
  assert.equal(isRateLimitWakePending('c-1'), true);
  assert.equal(isRateLimitWakePending('other'), false);

  await delay(700); // debounced mirror
  const onDisk = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].providerSessionId, 'c-1');
  assert.equal(onDisk[0].permissionMode, 'bypassPermissions');

  // A fresh process sees the same entry.
  __resetRateLimitWakeState();
  await loadRateLimitWakes();
  assert.equal(isRateLimitWakePending('c-1'), true);
  assert.equal(getRateLimitWake('c-1').userId, 7);
});

test('an unknown reset time falls back to an escalating retry delay', async () => {
  const now = Date.now();
  const first = await scheduleRateLimitWake({ provider: 'codex', providerSessionId: 'x-1', limitText: 'Rate limit exceeded', now });
  assert.equal(first.resumeAt, now + 60_000);
  assert.equal(first.resetsAt, null);
  const second = await scheduleRateLimitWake({ provider: 'codex', providerSessionId: 'x-1', limitText: 'Rate limit exceeded', now });
  assert.equal(second.attempts, 2);
  assert.equal(second.resumeAt, now + 120_000);
});

test('Claude HTTP 529 retries every five minutes forever with one stable supervisor message', async () => {
  const now = Date.now();
  let entry = await scheduleRateLimitWake({
    provider: 'claude',
    providerSessionId: 'claude-overloaded',
    recoveryKind: 'claude-529',
    limitType: 'http_529',
    limitText: 'API Error: 529 service overloaded',
    now,
  });
  assert.ok(entry);
  assert.equal(entry.resumeAt, now + 300_000);
  assert.equal(entry.attempts, 1);
  assert.ok(entry.messageId);
  const firstMessageId = entry.messageId;
  const firstPrompt = buildRateLimitWakePrompt(entry, now);

  // The ordinary usage-limit budget is 3 in this test process. A 529 incident
  // deliberately continues past it, carrying its attempt/message identity as
  // it would through the server-owned queue after each consumed wake.
  for (let attempt = 2; attempt <= 6; attempt += 1) {
    entry = await scheduleRateLimitWake({
      provider: 'claude',
      providerSessionId: 'claude-overloaded',
      recoveryKind: 'claude-529',
      limitType: 'http_529',
      messageId: firstMessageId,
      priorAttempts: attempt - 1,
      now,
    });
    assert.ok(entry, `attempt ${attempt} should remain scheduled`);
    assert.equal(entry.attempts, attempt);
    assert.equal(entry.resumeAt, now + 300_000);
    assert.equal(entry.messageId, firstMessageId);
    assert.equal(buildRateLimitWakePrompt(entry, now + attempt), firstPrompt);
  }
});

test('the tick starts due wakes through the injected starter, consuming the entry', async () => {
  const now = Date.now();
  const started = [];
  await startRateLimitWakeLoop({
    startTurn: async (entry, prompt) => { started.push({ entry, prompt }); return true; },
  });
  await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'due', resetsAt: (now - 5000) / 1000, limitText: 'resets 1:00am', now });
  await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'later', resetsAt: (now + 3_600_000) / 1000, now });

  const woken = await runRateLimitWakeTick(now + 2000);
  assert.deepEqual(woken, ['due']);
  assert.equal(started.length, 1);
  assert.equal(started[0].entry.providerSessionId, 'due');
  assert.match(started[0].prompt, /\[session supervisor\]/);
  assert.match(started[0].prompt, /usage limit/);
  assert.match(started[0].prompt, /resets 1:00am/);
  assert.equal(isRateLimitWakePending('due'), false, 'a fired wake is consumed');
  assert.equal(isRateLimitWakePending('later'), true, 'a future wake stays');
});

test('a wake whose session no longer exists is dropped; a starter that throws is retried then dropped', async () => {
  const now = Date.now();
  let calls = 0;
  await startRateLimitWakeLoop({
    startTurn: async (entry) => {
      calls += 1;
      if (entry.providerSessionId === 'gone') return false;
      throw new Error('db locked');
    },
  });
  await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'gone', resetsAt: (now - 1000) / 1000, now });
  await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'flaky', resetsAt: (now - 1000) / 1000, now });

  assert.deepEqual(await runRateLimitWakeTick(now + 2000), []);
  assert.equal(isRateLimitWakePending('gone'), false);
  assert.equal(isRateLimitWakePending('flaky'), true, 'first failure keeps the entry for a retry');
  const retryAt = getRateLimitWake('flaky').resumeAt;
  assert.deepEqual(await runRateLimitWakeTick(retryAt), []);
  assert.deepEqual(await runRateLimitWakeTick(getRateLimitWake('flaky').resumeAt), []);
  assert.equal(isRateLimitWakePending('flaky'), false, 'third failure drops it');
  assert.equal(calls, 4);
});

test('the attempt budget ends the loop for a session whose limit never clears', async () => {
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    assert.ok(await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'stuck', resetsAt: (now + 1000) / 1000, now }));
  }
  const fourth = await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'stuck', resetsAt: (now + 1000) / 1000, now });
  assert.equal(fourth, null);
  assert.equal(isRateLimitWakePending('stuck'), false);
});

test('cancel and forget both remove the entry; forget flushes the file immediately', async () => {
  const now = Date.now();
  await scheduleRateLimitWake({ provider: 'claude', providerSessionId: 'a', resetsAt: (now + 1000) / 1000, now });
  await scheduleRateLimitWake({ provider: 'codex', providerSessionId: 'b', resetsAt: (now + 1000) / 1000, now });
  assert.equal(await cancelRateLimitWake('a'), true);
  assert.equal(await cancelRateLimitWake('a'), false);
  assert.equal(isRateLimitWakePending('a'), false);
  assert.equal(await forgetRateLimitWake('b'), true);
  const onDisk = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.deepEqual(onDisk, []);
});

test('the wake prompt names the provider, quotes the limit message, and counts repeat attempts', () => {
  const prompt = buildRateLimitWakePrompt({
    provider: 'codex', attempts: 2, limitText: "You've hit your usage limit. Try again in 1 hour.",
  });
  assert.match(prompt, /Codex usage limit/);
  assert.match(prompt, /Try again in 1 hour/);
  assert.match(prompt, /attempt 2/);
  assert.match(prompt, /task ledger/);
});
