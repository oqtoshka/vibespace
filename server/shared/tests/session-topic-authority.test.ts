import assert from 'node:assert/strict';
import test from 'node:test';

import { readSessionTopicAuthority, registerSessionTopicAuthoritySource } from '../session-topic-authority.js';

const context = { sessionId: 'app', providerSessionId: 'native', provider: 'codex', private: false,
  sessionRole: 'main' as const, launchOptions: { 'example.briefing': true } };

test('topic authority requires an explicit current source; teardown restores the helper fallback', async () => {
  assert.equal(await readSessionTopicAuthority(context), null);
  const remove = registerSessionTopicAuthoritySource(async received => {
    assert.deepEqual(received, context);
    return 'primary-agent' as const;
  });
  try { assert.equal(await readSessionTopicAuthority(context), 'primary-agent'); }
  finally { remove(); }
  assert.equal(await readSessionTopicAuthority(context), null);
});

test('private/side sessions never ask an integration for topics', async () => {
  let calls = 0;
  const remove = registerSessionTopicAuthoritySource(() => { calls++; return 'primary-agent'; });
  try {
    assert.equal(await readSessionTopicAuthority({ ...context, private: true }), null);
    assert.equal(await readSessionTopicAuthority({ ...context, sessionRole: 'side' }), null);
    assert.equal(calls, 0);
  } finally { remove(); }
});

test('reader errors and malformed results cannot silently suppress the helper', async () => {
  const removeError = registerSessionTopicAuthoritySource(() => { throw new Error('unavailable'); });
  const removeMalformed = registerSessionTopicAuthoritySource(() => 'other' as 'primary-agent');
  try { assert.equal(await readSessionTopicAuthority(context), null); }
  finally { removeError(); removeMalformed(); }
});

test('an unresponsive external reader cannot stall title/recap generation indefinitely', async () => {
  const remove = registerSessionTopicAuthoritySource(() => new Promise(() => {}));
  const start = Date.now();
  try {
    assert.equal(await readSessionTopicAuthority(context), null);
    assert.ok(Date.now() - start < 7000, 'read is bounded at five seconds');
  } finally { remove(); }
});
