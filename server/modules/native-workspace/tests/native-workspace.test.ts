import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NativeWorkspaceService } from '../native-workspace.service.js';

test('session workspace bounds, assets, ignored files, missing files and real content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-workspace-'));
  const workspace = path.join(root, 'project');
  const approved = path.join(root, 'approved');
  await mkdir(path.join(workspace, 'build'), { recursive: true });
  await mkdir(approved, { recursive: true });
  await writeFile(path.join(root, 'outside.txt'), 'must stay outside');
  await writeFile(path.join(approved, 'review.png'), 'approved review artifact');
  await writeFile(path.join(workspace, 'build', 'index.html'), '<html>fixture</html>');
  await writeFile(path.join(workspace, 'build', 'main.css'), 'body{color:red}');
  await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'escape.txt'));
  const service = new NativeWorkspaceService(id => id === 'ours' ? workspace : null, () => [approved]);
  try {
    const read = await service.request('ours', { op: 'read', path: 'build/index.html' });
    assert.equal(Buffer.from(String(read.base64), 'base64').toString(), '<html>fixture</html>');
    const external = await service.request('ours', { op: 'read', path: path.join(approved, 'review.png') });
    assert.equal(Buffer.from(String(external.base64), 'base64').toString(), 'approved review artifact');
    await assert.rejects(service.request('other', { op: 'read', path: 'build/index.html' }), /no available workspace/);
    for (const target of ['../outside.txt', path.join(root, 'outside.txt'), 'escape.txt']) {
      await assert.rejects(service.request('ours', { op: 'read', path: target }), /outside/);
    }
    await assert.rejects(service.request('ours', { op: 'write', path: 'build/index.html' }), /Unsupported/);
    await assert.rejects(service.request('ours', { op: 'read', path: 'missing' }), { code: 'ENOENT' });
    const html = await service.request('ours', { op: 'html', path: 'build/index.html' });
    assert.equal(html.entryRel, 'index.html');
    const asset = await service.request('ours', { op: 'asset', entry: 'build/index.html', path: '/main.css' });
    assert.equal(Buffer.from(String(asset.base64), 'base64').toString(), 'body{color:red}');
    await assert.rejects(service.request('ours', { op: 'asset', entry: 'build/index.html', path: '/../../outside.txt' }));
    const before = await service.request('ours', { op: 'stat', paths: ['build/index.html'] });
    await writeFile(path.join(workspace, 'build', 'index.html'), '<html>changed fixture</html>');
    const after = await service.request('ours', { op: 'stat', paths: ['build/index.html'] });
    assert.notDeepEqual(after, before);
    assert(!JSON.stringify(await service.request('ours', { op: 'list', path: '.' })).includes('escape.txt'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native review links may read real files from /tmp but not symlink escapes', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp('/tmp/mc-native-review-');
  const workspace = path.join(root, 'project');
  await mkdir(workspace);
  await writeFile(path.join(root, 'marketing.png'), 'rendered review');
  await symlink('/etc/hosts', path.join(root, 'escape.txt'));
  const service = new NativeWorkspaceService(id => id === 'ours' ? workspace : null);
  try {
    const review = await service.request('ours', { op: 'read', path: path.join(root, 'marketing.png') });
    assert.equal(Buffer.from(String(review.base64), 'base64').toString(), 'rendered review');
    await assert.rejects(service.request('ours', { op: 'read', path: path.join(root, 'escape.txt') }), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
