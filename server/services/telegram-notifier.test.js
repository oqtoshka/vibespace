import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTelegramText, sendTelegramMessage } from './telegram-notifier.js';

test('buildTelegramText formats a finished run with session name', () => {
  const text = buildTelegramText(
    { provider: 'claude', kind: 'stop', code: 'run.stopped', meta: { stopReason: 'completed' } },
    { sessionName: 'Fix login bug' },
  );
  assert.match(text, /^✅ <b>Claude<\/b> finished/);
  assert.match(text, /<i>Fix login bug<\/i>/);
});

test('buildTelegramText distinguishes aborted runs', () => {
  const text = buildTelegramText(
    { provider: 'claude', kind: 'stop', code: 'run.stopped', meta: { stopReason: 'aborted' } },
    {},
  );
  assert.match(text, /run was stopped/);
});

test('buildTelegramText surfaces the tool name for permission prompts', () => {
  const text = buildTelegramText(
    { provider: 'opencode', kind: 'action_required', code: 'permission.required', meta: { toolName: 'Bash' } },
    {},
  );
  assert.match(text, /⏳ <b>OpenCode<\/b> needs approval for "Bash"/);
});

test('buildTelegramText escapes HTML in error messages', () => {
  const text = buildTelegramText(
    { provider: 'claude', kind: 'error', code: 'run.failed', meta: { error: 'boom <x> & y' } },
    {},
  );
  assert.match(text, /failed: boom &lt;x&gt; &amp; y/);
  assert.doesNotMatch(text, /<x>/);
});

test('sendTelegramMessage refuses to send without credentials', async () => {
  assert.deepEqual(await sendTelegramMessage({ botToken: '', chatId: '123' }), {
    ok: false,
    error: 'Missing bot token or chat id',
  });
  assert.deepEqual(await sendTelegramMessage({ botToken: 'abc', chatId: '' }), {
    ok: false,
    error: 'Missing bot token or chat id',
  });
});
