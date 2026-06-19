import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTelegramText, sendTelegramMessage } from './telegram-notifier.js';

const stopEvent = (meta) => ({ provider: 'claude', kind: 'stop', code: 'run.stopped', meta });

test('finished run shows state + recap + session name', () => {
  const text = buildTelegramText(
    stopEvent({ stopReason: 'completed', recap: 'Deployed the feature; daemon healthy.' }),
    { sessionName: 'Fix login bug' },
  );
  assert.match(text, /^✅ <b>Claude<\/b> — Finished/);
  assert.match(text, /<i>Deployed the feature; daemon healthy.<\/i>/);
  assert.match(text, /📁 Fix login bug/);
});

test('a trailing question is classified as Needs your answer', () => {
  const text = buildTelegramText(
    stopEvent({ stopReason: 'completed', recap: 'I can do it two ways. Which would you prefer?' }),
    {},
  );
  assert.match(text, /❓ <b>Claude<\/b> — Needs your answer/);
});

test('background work is classified from tool names', () => {
  const text = buildTelegramText(
    stopEvent({ stopReason: 'completed', recap: 'Started it.', toolNames: ['Bash', 'ScheduleWakeup'] }),
    {},
  );
  assert.match(text, /🛰️ <b>Claude<\/b> — Working in background/);
});

test('aborted run reads as Stopped', () => {
  const text = buildTelegramText(stopEvent({ stopReason: 'aborted' }), {});
  assert.match(text, /⏹️ <b>Claude<\/b> — Stopped/);
});

test('permission prompt surfaces the exact pending action', () => {
  const text = buildTelegramText(
    {
      provider: 'claude',
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName: 'Bash', toolDetail: '$ npm run build' },
    },
    {},
  );
  assert.match(text, /🔐 <b>Claude<\/b> — Approval needed/);
  assert.match(text, /<code>\$ npm run build<\/code>/);
});

test('failed run escapes HTML in the error', () => {
  const text = buildTelegramText(
    { provider: 'claude', kind: 'error', code: 'run.failed', meta: { error: 'boom <x> & y' } },
    {},
  );
  assert.match(text, /❌ <b>Claude<\/b> — Failed: boom &lt;x&gt; &amp; y/);
  assert.doesNotMatch(text, /<x>/);
});

test('sendTelegramMessage refuses to send without credentials', async () => {
  assert.deepEqual(await sendTelegramMessage({ botToken: '', chatId: '123' }), {
    ok: false,
    error: 'Missing bot token or chat id',
  });
});
