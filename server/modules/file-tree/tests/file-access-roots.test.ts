import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { buildFileAccessRoots } from '@/modules/file-tree/index.js';

test('buildFileAccessRoots includes configured and registered project roots', () => {
  assert.deepEqual(
    buildFileAccessRoots(['/workspace'], ['/Volumes/notes', '/workspace']),
    [path.resolve('/workspace'), path.resolve('/Volumes/notes')],
  );
});

test('buildFileAccessRoots drops blank roots', () => {
  assert.deepEqual(buildFileAccessRoots(['', '  '], ['/workspace/project']), [
    path.resolve('/workspace/project'),
  ]);
});
