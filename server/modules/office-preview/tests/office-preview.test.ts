import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, symlink, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { OfficePreviewService } from '../office-preview.service.js';
import { createOfficePreviewRouter } from '../office-preview.routes.js';
import { isOfficeFile } from '../../../../shared/office-formats.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'project'));
  const project = path.join(root, 'project');
  const source = Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.from('fixture')]);
  await writeFile(path.join(project, 'deck.pptx'), source);
  return { root, project, source };
}

test('supported presentation, document and spreadsheet formats only', () => {
  for (const name of ['a.PPTX', 'a.ppt', 'a.docx', 'a.doc', 'a.xlsx', 'a.xls', 'a.odp', 'a.odt', 'a.ods']) assert.ok(isOfficeFile(name));
  for (const name of ['a.pdf', 'a.exe', 'a.pptx.html', 'a.pptm']) assert.equal(isOfficeFile(name), false);
});

test('conversion sends bytes, caches content, and invalidates on edits', async t => {
  const f = await fixture(t); let calls = 0;
  const service = new OfficePreviewService({ projectPath: () => f.project, converterUrl: 'http://converter/forms/libreoffice/convert', fetch: async (_url, request) => {
    calls++; assert.equal(request?.redirect, 'error');
    const form = request?.body as FormData;
    assert.equal((form.get('files') as File).name, 'document.pptx');
    assert.equal((form.get('files') as File).size, f.source.length + (calls === 2 ? 1 : 0));
    return new Response('%PDF-1.7\nfixture');
  } });
  assert.match((await service.preview('p', 'deck.pptx')).toString(), /^%PDF/);
  await service.preview('p', path.join(f.project, 'deck.pptx')); assert.equal(calls, 1);
  await writeFile(path.join(f.project, 'deck.pptx'), Buffer.concat([f.source, Buffer.from('2')]));
  await service.preview('p', 'deck.pptx'); assert.equal(calls, 2);
});

test('rejects escape paths, symlinks, large and invalid inputs before conversion', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'secret.pptx'), f.source);
  await symlink(path.join(f.root, 'secret.pptx'), path.join(f.project, 'link.pptx'));
  await writeFile(path.join(f.project, 'fake.docx'), '<html>not Office</html>');
  await writeFile(path.join(f.project, 'large.xlsx'), ''); await truncate(path.join(f.project, 'large.xlsx'), 26 * 1024 * 1024);
  const service = new OfficePreviewService({ projectPath: id => id === 'missing' ? null : f.project, converterUrl: 'http://converter', fetch: async () => { throw Error('must not fetch'); } });
  for (const file of ['../secret.pptx', 'link.pptx']) await assert.rejects(service.preview('p', file), { statusCode: 403 });
  await assert.rejects(service.preview('p', 'large.xlsx'), { statusCode: 413 });
  await assert.rejects(service.preview('p', 'fake.docx'), { statusCode: 422 });
  await assert.rejects(service.preview('missing', 'deck.pptx'), { statusCode: 404 });
  await assert.rejects(service.preview('p', 'deck.exe'), { statusCode: 415 });
});

test('unconfigured service, corrupt output and converter errors have safe errors', async t => {
  const f = await fixture(t);
  await assert.rejects(new OfficePreviewService({ projectPath: () => f.project }).preview('p', 'deck.pptx'), { statusCode: 503 });
  for (const [response, code] of [[new Response('<script>bad</script>'), 502], [new Response('secret details', { status: 400 }), 422], [new Response('internal failure', { status: 500 }), 503]] as const) {
    const service = new OfficePreviewService({ projectPath: () => f.project, converterUrl: 'http://converter', fetch: async () => response });
    await assert.rejects(service.preview('p', 'deck.pptx'), error => (error as {statusCode:number}).statusCode === code && !String(error).includes('secret details'));
  }
});

test('bounded concurrent work and cancelled requests release slots', async t => {
  const f = await fixture(t);
  const service = new OfficePreviewService({ projectPath: () => f.project, converterUrl: 'http://converter', timeoutMs: 40, fetch: async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true });
  }) });
  const first = assert.rejects(service.preview('p', 'deck.pptx'), { statusCode: 503 });
  const second = assert.rejects(service.preview('p', 'deck.pptx'), { statusCode: 503 });
  await assert.rejects(service.preview('p', 'deck.pptx'), { statusCode: 429 });
  const keepAlive = setTimeout(() => {}, 200);
  await Promise.all([first, second]); clearTimeout(keepAlive);
});

test('HTTP route validates query and returns a non-cacheable PDF', async t => {
  const f = await fixture(t);
  const app = express();
  app.use('/office', createOfficePreviewRouter(new OfficePreviewService({ projectPath: () => f.project, converterUrl: 'http://converter', fetch: async () => new Response('%PDF-1.7\nfixture') })));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/office/p`;
  assert.equal((await fetch(base)).status, 400);
  assert.equal((await fetch(base + '?path=a&path=b')).status, 400);
  const response = await fetch(base + '?path=deck.pptx');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type')!, /^application\/pdf/);
  assert.equal(await response.text(), '%PDF-1.7\nfixture');
});
