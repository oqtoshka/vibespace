import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarizeRecap, classifyAssistantState, describeTool } from './notification-content.js';

test('summarizeRecap strips markdown and keeps the closing paragraph', () => {
  const recap = summarizeRecap('# Heading\n\nDid some setup.\n\n```\ncode block\n```\n\n**All done** now.');
  assert.equal(recap, 'All done now.');
});

test('summarizeRecap truncates very long text', () => {
  const recap = summarizeRecap('x'.repeat(500));
  assert.ok(recap.length <= 320);
  assert.match(recap, /…$/);
});

test('classifyAssistantState detects a question', () => {
  assert.equal(classifyAssistantState({ recap: 'Which option do you want?' }).state, 'question');
  assert.equal(classifyAssistantState({ recap: 'Let me know how to proceed.' }).state, 'question');
});

test('classifyAssistantState detects background work by tool or text', () => {
  assert.equal(classifyAssistantState({ recap: 'done', toolNames: ['Monitor'] }).state, 'background');
  assert.equal(
    classifyAssistantState({ recap: "Kicked off CI; I'll let you know when the build finishes." }).state,
    'background',
  );
});

test('classifyAssistantState defaults to finished', () => {
  const r = classifyAssistantState({ recap: 'Shipped it. Everything is green.' });
  assert.equal(r.state, 'finished');
  assert.equal(r.emoji, '✅');
});

test('describeTool renders per tool type', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), '$ npm test');
  assert.equal(describeTool('Edit', { file_path: '/a/b.ts' }), 'edit /a/b.ts');
  assert.equal(describeTool('WebFetch', { url: 'https://x.dev' }), 'fetch https://x.dev');
  assert.equal(describeTool('Glob', {}), 'Glob');
});
