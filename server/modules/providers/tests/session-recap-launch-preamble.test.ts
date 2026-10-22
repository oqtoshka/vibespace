import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __testing } from '@/modules/providers/services/session-recap.service.js';
import { prependLaunchInstructions } from '@/shared/utils.js';

const BRIEFING = ['# Briefing mode (Mission Control)', '', ...Array.from({ length: 300 }, (_, i) => `- rule ${i}`)].join('\n');

test('recap tails carry the user words, not the launch preamble, of a launched first prompt', async () => {
  const first = prependLaunchInstructions(BRIEFING, 'Why does Authentik keep logging me out?');

  const indexed = await __testing.readIndexedTranscriptTail('s', async () => ({
    messages: [
      { kind: 'text', role: 'user', content: first },
      { kind: 'text', role: 'assistant', content: 'Looking at the session cookie.' },
      { kind: 'text', role: 'user', content: `${BRIEFING}\n\n---\n\nAnd keep MFA` },
    ],
    total: 3,
  }));
  assert.deepEqual(indexed.messages.map(m => m.text), [
    'Why does Authentik keep logging me out?', 'Looking at the session cookie.', 'And keep MFA',
  ]);

  const directory = await mkdtemp(path.join(tmpdir(), 'recap-preamble-'));
  try {
    const jsonl = path.join(directory, 'session.jsonl');
    await writeFile(jsonl, [
      { type: 'user', message: { content: first } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    const tail = await __testing.readTranscriptTail(jsonl);
    assert.deepEqual(tail.messages.map(m => m.text), ['Why does Authentik keep logging me out?', 'Looking.']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
