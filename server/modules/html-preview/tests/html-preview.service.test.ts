import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveHtmlPreviewAsset,
  resolveHtmlPreviewEntry,
} from '@/modules/html-preview/index.js';

test('resolveHtmlPreviewEntry preserves nested paths from an approved sibling worktree root', async (t) => {
  const projectRoot = path.resolve('/workspace/main-project');
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibespace-html-preview-'));
  const entryPath = path.join(worktreeRoot, 'spec', 'sketches', 'domains', 'contract', 'contracts.html');
  const webRoot = path.join(worktreeRoot, 'spec', 'sketches');
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(path.join(worktreeRoot, '.git'), 'gitdir: /tmp/repo/worktrees/task\n');
  t.after(async () => fs.rm(worktreeRoot, { recursive: true, force: true }));

  const result = await resolveHtmlPreviewEntry(projectRoot, entryPath, {
    validatePath: async (_root, targetPath) => ({
      valid: targetPath === entryPath || targetPath.startsWith(worktreeRoot),
      resolved: targetPath,
      outsideProject: targetPath === entryPath,
    }),
    resolveModel: async (resolvedEntry, previewRoot) => {
      assert.equal(resolvedEntry, entryPath);
      assert.equal(previewRoot, worktreeRoot);
      return {
        webRoot,
        aliases: { '/kit': '_kit' },
        entryRel: 'domains/contract/contracts.html',
      };
    },
  });

  assert.deepEqual(result, {
    valid: true,
    webRoot,
    aliases: { '/kit': '_kit' },
    entryRel: 'domains/contract/contracts.html',
    previewRoot: worktreeRoot,
    resourceRoots: [
      webRoot,
      path.join(webRoot, '_kit'),
    ],
  });
});

test('resolveHtmlPreviewEntry preserves the active project root for project files', async () => {
  const projectRoot = path.resolve('/workspace/main-project');
  const entryPath = path.join(projectRoot, 'docs', 'index.html');
  let receivedPreviewRoot = '';

  const result = await resolveHtmlPreviewEntry(projectRoot, entryPath, {
    validatePath: async () => ({ valid: true, resolved: entryPath }),
    resolveModel: async (_resolvedEntry, previewRoot) => {
      receivedPreviewRoot = previewRoot;
      return { webRoot: projectRoot, aliases: {}, entryRel: 'docs/index.html' };
    },
  });

  assert.equal(result.valid, true);
  assert.equal(receivedPreviewRoot, projectRoot);
});

test('resolveHtmlPreviewEntry returns the accessible-path validation error', async () => {
  const result = await resolveHtmlPreviewEntry('/workspace/project', '/private/queue.html', {
    validatePath: async () => ({ valid: false, error: 'Path is outside configured roots' }),
    resolveModel: async () => {
      throw new Error('resolveModel must not run for a rejected entry');
    },
  });

  assert.deepEqual(result, {
    valid: false,
    error: 'Path is outside configured roots',
  });
});

test('resolveHtmlPreviewAsset applies the signed external preview boundary', async () => {
  const projectRoot = path.resolve('/workspace/main-project');
  const previewRoot = path.resolve('/workspace/worktrees/task');
  const expectedAsset = path.join(previewRoot, 'queue.html');
  let receivedBoundary = '';

  const result = await resolveHtmlPreviewAsset(
    '/queue.html',
    { webRoot: previewRoot, aliases: {}, previewRoot },
    projectRoot,
    {
      resolveAssetPath: (_requestPath, _webRoot, _aliases, boundary) => {
        receivedBoundary = boundary;
        return expectedAsset;
      },
      validatePath: async (_root, targetPath) => ({
        valid: targetPath === expectedAsset,
        resolved: targetPath,
      }),
    },
  );

  assert.equal(receivedBoundary, previewRoot);
  assert.equal(result, expectedAsset);
});

test('resolveHtmlPreviewAsset rejects an asset no longer in an accessible root', async () => {
  const result = await resolveHtmlPreviewAsset(
    '/linked/secret.js',
    {
      webRoot: '/workspace/worktrees/task',
      aliases: {},
      previewRoot: '/workspace/worktrees/task',
    },
    '/workspace/main-project',
    {
      resolveAssetPath: () => '/workspace/worktrees/task/linked/secret.js',
      validatePath: async () => ({ valid: false, error: 'Path is outside configured roots' }),
    },
  );

  assert.equal(result, null);
});
