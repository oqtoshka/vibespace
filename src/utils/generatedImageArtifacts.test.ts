import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generatedImageArtifactUrl,
  projectImageArtifactUrl,
  resolveGeneratedImageArtifactPath,
  resolveProjectImagePath,
} from './generatedImageArtifacts';

const ORIGIN = 'https://vibespace.example.com';
const RELATIVE_IMAGE = '01a048c5-c925-7581-8cbc-75f7a3675525/exec-84797002-ffd9-42d6-afea-d4639b341709.png';

test('resolves the reported same-origin generated image URL', () => {
  assert.equal(
    resolveGeneratedImageArtifactPath(
      `${ORIGIN}/Users/dev/.codex/generated_images/${RELATIVE_IMAGE}`,
      ORIGIN,
    ),
    RELATIVE_IMAGE,
  );
});

test('resolves root-absolute, file, encoded, and Windows generated image paths', () => {
  assert.equal(
    resolveGeneratedImageArtifactPath(`/Users/dev/.codex/generated_images/${RELATIVE_IMAGE}`, ORIGIN),
    RELATIVE_IMAGE,
  );
  assert.equal(
    resolveGeneratedImageArtifactPath(`file:///Users/dev/.codex/generated_images/${RELATIVE_IMAGE}`, ORIGIN),
    RELATIVE_IMAGE,
  );
  assert.equal(
    resolveGeneratedImageArtifactPath('/Users/dev/.codex/generated_images/folder%20name/image.png', ORIGIN),
    'folder name/image.png',
  );
  assert.equal(
    resolveGeneratedImageArtifactPath('C:\\Users\\dev\\.codex\\generated_images\\run\\image.webp', ORIGIN),
    'run/image.webp',
  );
});

test('rejects remote, traversal, unrelated, and active image URLs', () => {
  assert.equal(
    resolveGeneratedImageArtifactPath(`https://example.com/.codex/generated_images/${RELATIVE_IMAGE}`, ORIGIN),
    null,
  );
  assert.equal(resolveGeneratedImageArtifactPath('/api/logo.png', ORIGIN), null);
  assert.equal(resolveGeneratedImageArtifactPath('/Users/dev/.codex/generated_images/../auth.png', ORIGIN), null);
  assert.equal(resolveGeneratedImageArtifactPath('/Users/dev/.codex/generated_images/run/image.svg', ORIGIN), null);
  assert.equal(resolveGeneratedImageArtifactPath('data:image/png;base64,abc', ORIGIN), null);
});

test('builds the authenticated generated-image endpoint URL', () => {
  assert.equal(
    generatedImageArtifactUrl('run folder/image.png'),
    '/api/assets/generated-images?path=run%20folder%2Fimage.png',
  );
});

test('resolves provider-neutral project image references', () => {
  const projectRoot = '/Users/dev/projects/demo-app';
  assert.equal(resolveProjectImagePath('art/icons.png', projectRoot, ORIGIN), 'art/icons.png');
  assert.equal(resolveProjectImagePath('/art/icons.png', projectRoot, ORIGIN), 'art/icons.png');
  assert.equal(
    resolveProjectImagePath(`${projectRoot}/art/icons.png`, projectRoot, ORIGIN),
    'art/icons.png',
  );
  assert.equal(
    resolveProjectImagePath(`${ORIGIN}${projectRoot}/art/icons.png`, projectRoot, ORIGIN),
    'art/icons.png',
  );
  assert.equal(resolveProjectImagePath('art/vector.svg', projectRoot, ORIGIN), 'art/vector.svg');
});

test('rejects remote and out-of-project absolute image references', () => {
  const projectRoot = '/Users/dev/projects/demo-app';
  assert.equal(resolveProjectImagePath('https://example.com/image.png', projectRoot, ORIGIN), null);
  assert.equal(resolveProjectImagePath('/Users/dev/.ssh/secret.png', projectRoot, ORIGIN), null);
  assert.equal(resolveProjectImagePath('../secret.png', projectRoot, ORIGIN), null);
  assert.equal(resolveProjectImagePath('art/../../secret.png', projectRoot, ORIGIN), null);
  assert.equal(resolveProjectImagePath('notes/readme.md', projectRoot, ORIGIN), null);
});

test('builds an authenticated project image URL', () => {
  assert.equal(
    projectImageArtifactUrl('project id', 'art/icon sheet.png'),
    '/api/file-tree/projects/project%20id/files/content?path=art%2Ficon%20sheet.png',
  );
});
