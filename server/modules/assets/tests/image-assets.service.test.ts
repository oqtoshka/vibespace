import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  isAllowedImageMimeType,
  openGeneratedImageArtifact,
  resolveAttachmentAssetFile,
  resolveImageAssetFile,
} from '@/modules/assets/services/image-assets.service.js';

const ASSETS_DIR = path.join(os.homedir(), '.vibespace', 'assets');

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  assert.equal(isAllowedImageMimeType('image/svg+xml'), true);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('buildStoredImageRecords returns absolute posix paths in the assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('buildStoredAttachmentRecords preserves metadata for non-image files', () => {
  const records = buildStoredAttachmentRecords([
    {
      originalname: 'requirements.pdf',
      filename: '123-456-requirements.pdf',
      size: 2048,
      mimetype: 'application/pdf',
    },
  ]);

  assert.deepEqual(records[0], {
    name: 'requirements.pdf',
    path: `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-requirements.pdf`,
    size: 2048,
    mimeType: 'application/pdf',
  });
});

test('resolveImageAssetFile resolves plain filenames inside the assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png');
  assert.equal(resolved, path.join(path.resolve(ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile(''), null);
  assert.equal(resolveImageAssetFile('   '), null);
  assert.equal(resolveImageAssetFile('../auth.db'), null);
  assert.equal(resolveImageAssetFile('..'), null);
  assert.equal(resolveImageAssetFile('sub/dir.png'), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png'), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png'), null);
});

test('resolveAttachmentAssetFile uses the same direct-child boundary', () => {
  assert.equal(
    resolveAttachmentAssetFile('123-notes.txt'),
    path.join(path.resolve(ASSETS_DIR), '123-notes.txt'),
  );
  assert.equal(resolveAttachmentAssetFile('../notes.txt'), null);
});

test('openGeneratedImageArtifact serves nested raster files inside its root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'generated-images-'));
  try {
    const nested = path.join(root, 'run-id');
    await mkdir(nested);
    await writeFile(path.join(nested, 'sheet.png'), Buffer.from('png'));

    const result = await openGeneratedImageArtifact('run-id/sheet.png', root);
    assert.equal(result.status, 'found');
    if (result.status === 'found') {
      assert.equal(result.contentType, 'image/png');
      result.stream.destroy();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openGeneratedImageArtifact rejects traversal, absolute paths, and unsupported files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'generated-images-'));
  try {
    await writeFile(path.join(root, 'drawing.svg'), '<svg/>');
    assert.equal((await openGeneratedImageArtifact('../outside.png', root)).status, 'invalid');
    assert.equal((await openGeneratedImageArtifact(path.join(root, 'drawing.svg'), root)).status, 'invalid');
    assert.equal((await openGeneratedImageArtifact('drawing.svg', root)).status, 'unsupported');
    assert.equal((await openGeneratedImageArtifact('missing.png', root)).status, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openGeneratedImageArtifact rejects symlink escapes', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'generated-images-parent-'));
  const root = path.join(parent, 'generated_images');
  try {
    await mkdir(root);
    const outside = path.join(parent, 'outside.png');
    await writeFile(outside, Buffer.from('png'));
    await symlink(outside, path.join(root, 'linked.png'));
    assert.equal((await openGeneratedImageArtifact('linked.png', root)).status, 'invalid');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
