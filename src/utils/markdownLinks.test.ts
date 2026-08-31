import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMarkdownLinkPath } from './markdownLinks';

test('preserves absolute file links when requested by the chat renderer', () => {
  assert.equal(
    resolveMarkdownLinkPath(
      '/Users/dudin/projects/anthill/worktrees/risk-map/spec/system/domains/risk/README.md',
      null,
      true,
    ),
    '/Users/dudin/projects/anthill/worktrees/risk-map/spec/system/domains/risk/README.md',
  );
});

test('keeps root-relative Markdown preview links project-relative', () => {
  assert.equal(
    resolveMarkdownLinkPath('/docs/guide.md', '/Users/dudin/projects/vibespace/README.md'),
    'docs/guide.md',
  );
});

test('resolves relative links from an absolute Markdown document path', () => {
  assert.equal(
    resolveMarkdownLinkPath('../guide.md', '/Users/dudin/projects/vibespace/docs/reference.md'),
    '/Users/dudin/projects/vibespace/guide.md',
  );
});

test('rejects external and fragment-only links in either mode', () => {
  assert.equal(resolveMarkdownLinkPath('https://example.com/file.md', null, true), null);
  assert.equal(resolveMarkdownLinkPath('#section', null, true), null);
});
