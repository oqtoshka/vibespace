import assert from 'node:assert/strict';
import test from 'node:test';

import { describeAssistantActivity, describeToolActivity } from '../activity-status.js';

test('tool activity reads as work in progress, not as a pending request', () => {
  assert.equal(describeToolActivity('Bash', { command: 'npm test' }), 'Running npm test');
  assert.equal(describeToolActivity('Read', { file_path: '/a/b/c/claude-sdk.js' }), 'Reading c/claude-sdk.js');
  assert.equal(describeToolActivity('Edit', { file_path: '/a/b/c/claude-sdk.js' }), 'Editing c/claude-sdk.js');
  assert.equal(describeToolActivity('Grep', { pattern: 'effortLevel' }), 'Searching for effortLevel');
  assert.equal(describeToolActivity('Task', { description: 'map session naming' }), 'Running agent: map session naming');
  assert.equal(describeToolActivity('TodoWrite', {}), 'Updating the plan');
});

test('missing inputs and unknown tools still produce a usable label', () => {
  assert.equal(describeToolActivity('Bash', {}), 'Running a command');
  assert.equal(describeToolActivity('mcp__playwright__browser_click', {}), 'Running browser_click');
  assert.equal(describeToolActivity(''), null);
});

test('long values are clipped so the label stays one line', () => {
  const label = describeToolActivity('Bash', { command: 'x'.repeat(500) });
  assert.ok(label.length < 80, `expected a clipped label, got ${label.length} chars`);
  assert.ok(label.endsWith('…'));
});

test('assistant activity reports the last tool call, or nothing for prose', () => {
  const withTools = {
    message: {
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/x/y/z.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  };
  assert.equal(describeAssistantActivity(withTools), 'Running ls');

  const proseOnly = { message: { content: [{ type: 'text', text: 'here is the answer' }] } };
  assert.equal(describeAssistantActivity(proseOnly), null, 'prose clears the label');
  assert.equal(describeAssistantActivity({}), null);
});
