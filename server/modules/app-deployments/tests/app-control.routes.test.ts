import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import express from 'express';

import { AppControl } from '../app-control.service.js';
import { createAppControlRouter } from '../app-control.routes.js';

test('app HTTP rejects cross-origin writes, validates inputs and derives the owner from trusted middleware', async () => {
  const control = new AppControl(':memory:', new Map([['alice', { enabled: true, workspace_id: 'a' }]]), 'apps.example.com', 'test-key'.repeat(8));
  const app = express(); app.use(express.json());
  app.use('/anonymous', createAppControlRouter(control));
  app.use('/apps', (_req, res, next) => { res.locals.workspaceUser = 'alice'; next(); }, createAppControlRouter(control, 'https://workspace.example.com'));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const input = { owner: 'bob', name: 'Demo', source: 'projects/demo', runtime: 'node', entrypoint: 'server.mjs' };
  try {
    assert.equal((await fetch(base+'/anonymous')).status, 401);
    const post = (body: unknown, headers = {}) => fetch(base+'/apps', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post(input, { Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await post(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post({ ...input, source: 123 })).status, 400);
    const response = await post(input); assert.equal(response.status, 202);
    const created = await response.json() as { owner: string; id: string }; assert.equal(created.owner, 'alice');
    const conflict = await fetch(base+`/apps/${created.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(conflict.status, 409);
    const list = await fetch(base+'/apps'); assert.equal(list.headers.get('cache-control'), 'no-store');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); control.close(); }
});
