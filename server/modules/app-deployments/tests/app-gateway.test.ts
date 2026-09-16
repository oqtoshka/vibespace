import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';
import WebSocket, { WebSocketServer } from 'ws';

import { AppControl } from '../app-control.service.js';
import { AppGateway } from '../app-gateway.service.js';

test('gateway exchanges grants, strips credentials, rejects replay/wrong hosts and revokes active streams', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'app-gateway-')); const key = 'gateway-test-key'.repeat(4);
  const file = path.join(root, 'apps.db'); const registry = path.join(root, 'routes.json');
  const control = new AppControl(file, new Map([['alice', { enabled: true, workspace_id: 'a' }]]), 'apps.example.com', key);
  const app = control.create('alice', { name: 'Demo', source: 'projects/demo', runtime: 'node', entrypoint: 'server.mjs' });
  const db = new Database(file); db.prepare("UPDATE applications SET status='running',observed_generation=generation WHERE id=?").run(app.id);
  const publish = (version = 1, expiresAt = Date.now()+30_000) => writeFileSync(registry, JSON.stringify({ expiresAt, apps: [{ id: app.id, hostname: app.hostname, address: '10.22.0.2', port: 8080, version, status: 'running' }] }));
  publish();
  const target = http.createServer((req, res) => {
    if (req.url === '/stream') { res.writeHead(200); res.write('alive'); return; }
    res.setHeader('Set-Cookie', ['session=abc; Domain=example.com; Path=/', '__Host-vs-access=forged; Path=/; Secure']);
    res.end(JSON.stringify(req.headers));
  });
  const sockets = new WebSocketServer({ noServer: true });
  target.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, client => { client.on('message', value => client.send(value)); }));
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const targetAddress = target.address(); assert.ok(targetAddress && typeof targetAddress !== 'string');
  const gateway = new AppGateway({ registry, signingKey: key, nonceDatabase: path.join(root, 'nonces.db'),
    request: ((options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => http.request({ ...options, host: '127.0.0.1', port: targetAddress.port }, callback)) as typeof http.request });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
  const request = (route: string, headers: http.OutgoingHttpHeaders = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: address.port, path: route, headers: { Host: app.hostname, ...headers } }, response => {
      let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    }).on('error', reject);
  });
  try {
    assert.equal((await request('/')).status, 403);
    const grant = new URL(control.grant('alice', app.id, false).url);
    assert.equal((await request(grant.pathname+grant.search, { Host: 'wrong.apps.example.com' })).status, 403);
    const opened = await request(grant.pathname+grant.search); assert.equal(opened.status, 303); assert.equal(opened.headers.location, '/');
    const cookie = opened.headers['set-cookie']![0].split(';')[0];
    assert.match(opened.headers['set-cookie']![0], /Secure; HttpOnly; SameSite=Lax/);
    assert.equal((await request(grant.pathname+grant.search)).status, 403);
    // Exchange storage stays bounded even when the edge limiter is bypassed.
    const nonces = new Database(path.join(root, 'nonces.db'));
    const fill = nonces.prepare('INSERT INTO used_grants(nonce,expires) VALUES(?,?)');
    nonces.transaction(() => { for (let n = 0; n < 10_000; n++) fill.run('capacity-'+n, Math.floor(Date.now()/1000)+60); })();
    const cappedGrant = new URL(control.grant('alice', app.id, false).url);
    assert.equal((await request(cappedGrant.pathname+cappedGrant.search)).status, 403);
    nonces.prepare("DELETE FROM used_grants WHERE nonce LIKE 'capacity-%'").run();
    assert.equal((await request(cappedGrant.pathname+cappedGrant.search)).status, 303);
    nonces.close();
    const response = await request('/', { Cookie: cookie+'; vibespace_manager_session=secret; session=own', 'X-Vibespace-Worker-Token': 'secret' });
    assert.equal(response.status, 200); const seen = JSON.parse(response.body);
    assert.equal(seen.cookie.trim(), 'session=own'); assert.equal(seen['x-vibespace-worker-token'], undefined);
    assert.deepEqual(response.headers['set-cookie'], ['session=abc; Path=/']);
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/socket`, { headers: { Host: app.hostname, Cookie: cookie, Origin: 'https://'+app.hostname } });
    await once(websocket, 'open'); websocket.send('test'); const [message] = await once(websocket, 'message'); assert.equal(message.toString(), 'test');
    const websocketClosed = once(websocket, 'close');
    const blocked = new WebSocket(`ws://127.0.0.1:${address.port}/socket`, { headers: { Host: app.hostname, Cookie: cookie, Origin: 'https://other.apps.example.com' } });
    const [denied] = await once(blocked, 'error'); assert.match(denied.message, /403/);
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => http.get({ host: '127.0.0.1', port: address.port, path: '/stream', headers: { Host: app.hostname, Cookie: cookie } }, resolve).on('error', reject));
    stream.resume(); const closed = new Promise<void>(resolve => stream.once('close', () => resolve()));
    publish(2); await Promise.race([Promise.all([closed, websocketClosed]), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stream was not revoked')), 2500).unref())]);
    assert.equal((await request('/', { Cookie: cookie })).status, 403);
    publish(1, Date.now()-1); assert.equal((await request('/', { Cookie: cookie })).status, 403);
    writeFileSync(registry, 'corrupt'); assert.equal((await request('/', { Cookie: cookie })).status, 403);
  } finally {
    gateway.close(); for (const client of sockets.clients) client.terminate(); sockets.close(); target.closeAllConnections(); await new Promise<void>(resolve => target.close(() => resolve()));
    control.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
