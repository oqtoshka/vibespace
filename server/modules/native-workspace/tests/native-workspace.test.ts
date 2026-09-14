import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeWorkspaceService } from '../native-workspace.service.js';

test('session workspace bounds, assets, ignored files, missing files and real content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mc-workspace-'));
  const workspace = path.join(root, 'project');
  await mkdir(path.join(workspace, 'build'), { recursive: true });
  await writeFile(path.join(root, 'outside.txt'), 'must stay outside');
  await writeFile(path.join(workspace, 'build', 'index.html'), '<html>fixture</html>');
  await writeFile(path.join(workspace, 'build', 'main.css'), 'body{color:red}');
  await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'escape.txt'));
  const service = new NativeWorkspaceService(id => id === 'ours' ? workspace : null);
  try {
    const read = await service.request('ours', { op: 'read', path: 'build/index.html' });
    assert.equal(Buffer.from(String(read.base64), 'base64').toString(), '<html>fixture</html>');
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
