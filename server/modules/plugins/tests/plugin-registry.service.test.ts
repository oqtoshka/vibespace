import assert from 'node:assert/strict';
import test from 'node:test';

import { validateManifest } from '@/modules/plugins/index.js';

const baseManifest = {
  name: 'example',
  displayName: 'Example',
  hostModule: 'host/index.js',
};

test('accepts a same-origin plugin session action with a session placeholder', () => {
  assert.deepEqual(validateManifest({
    ...baseManifest,
    sessionActions: [{
      id: 'open-board',
      label: 'Open on board',
      endpoint: '/api/example/sessions/{sessionId}/card',
    }],
  }), { valid: true });
});

test('rejects session actions that could fetch another origin or cannot identify a session', () => {
  for (const endpoint of [
    'https://example.test/session/{sessionId}',
    '//example.test/session/{sessionId}',
    '/api/example/session',
  ]) {
    const result = validateManifest({
      ...baseManifest,
      sessionActions: [{ id: 'open-board', label: 'Open on board', endpoint }],
    });
    assert.equal(result.valid, false);
    assert.match(String(result.error), /same-origin path/);
  }
});

test('accepts legacy launch-preamble headings that are single Markdown heading lines', () => {
  assert.deepEqual(validateManifest({
    ...baseManifest,
    legacyLaunchPreambleHeadings: ['# Briefing mode (Example board)', '## Older mode  '],
  }), { valid: true });
});

test('rejects legacy launch-preamble headings that could swallow ordinary messages', () => {
  for (const legacyLaunchPreambleHeadings of [
    '# Briefing mode (Example board)',
    [''],
    ['Briefing mode'],
    ['#no-space'],
    ['# Two\nlines'],
    [`# ${'x'.repeat(200)}`],
    [42],
    Array.from({ length: 21 }, (_, i) => `# Mode ${i}`),
  ]) {
    const result = validateManifest({ ...baseManifest, legacyLaunchPreambleHeadings });
    assert.equal(result.valid, false, JSON.stringify(legacyLaunchPreambleHeadings).slice(0, 80));
    assert.match(String(result.error), /legacyLaunchPreambleHeadings/);
  }
});
