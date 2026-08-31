import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFileTreeReference } from './fileTreeReference';

const entries = [
  { name: 'desktop-browser', path: '/workspace/media/desktop-browser', type: 'directory' as const },
  { name: 'README.md', path: '/workspace/media/desktop-browser/README.md', type: 'file' as const },
];

test('resolveFileTreeReference preserves the matched entry type', () => {
  assert.deepEqual(resolveFileTreeReference(entries, 'desktop-browser'), entries[0]);
  assert.deepEqual(resolveFileTreeReference(entries, 'desktop-browser/README.md'), entries[1]);
});

test('resolveFileTreeReference leaves external paths unmatched', () => {
  assert.equal(resolveFileTreeReference(entries, '/Volumes/notes/Project.md'), null);
});
