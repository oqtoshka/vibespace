import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import Database from 'better-sqlite3';

type Route = { id: string; hostname: string; address: string; port: number; version: number; status: string };
type Grant = { app: string; version: number; kind: 'private' | 'share' | 'session'; exp: number; nonce: string };
const cookieName = '__Host-vs-access';
const sensitiveCookie = (name: string) => name === cookieName || /^(?:vibespace|__Host-vibespace|auth-token)/i.test(name);

/** Dedicated app gateway composition uses this server. It never mounts manager
 * routes, worker credentials, a Docker socket or workspace files.
 */
export class AppGateway {
  readonly server: http.Server;
  private readonly nonces: Database.Database;
  private readonly streams = new Map<Duplex | ServerResponse, { host: string; app: string; version: number; expires: number }>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: { registry: string; signingKey: string; nonceDatabase: string; request?: typeof http.request }) {
    if (options.signingKey.length < 32) throw new Error('Gateway signing key is required');
    this.nonces = new Database(options.nonceDatabase);
    this.nonces.pragma('max_page_count = 2048');
    this.nonces.exec('CREATE TABLE IF NOT EXISTS used_grants(nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    this.server = http.createServer((req, res) => this.request(req, res));
    this.server.maxHeadersCount = 100;
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 60_000;
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.timer = setInterval(() => this.revokeStreams(), 1000); this.timer.unref();
    this.server.once('close', () => { clearInterval(this.timer); this.nonces.close(); });
  }
  private route(host: string): Route {
    const registry = JSON.parse(fs.readFileSync(this.options.registry, 'utf8')) as { expiresAt: number; apps: Route[] };
    if (!Number.isFinite(registry.expiresAt) || registry.expiresAt <= Date.now() || !Array.isArray(registry.apps)) throw new Error('Routing unavailable');
    const route = registry.apps.find(item => item.hostname === host);
    if (!route || route.status !== 'running' || !/^[a-f0-9]{32}$/.test(route.id)
      || !Number.isInteger(route.version) || route.port !== 8080
      || !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}(?:\.\d{1,3}){1,2}$/.test(route.address)
      || route.address.split('.').length !== 4 || route.address.split('.').some(part => Number(part) > 255)) throw new Error('Application unavailable');
    return route;
  }
  private decode(token: string): Grant {
    if (token.length > 2048) throw new Error('Invalid grant');
    const pieces = token.split('.'); if (pieces.length !== 2) throw new Error('Invalid grant');
    const expected = crypto.createHmac('sha256', this.options.signingKey).update(pieces[0]).digest();
    const supplied = Buffer.from(pieces[1], 'base64url');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw new Error('Invalid grant');
    const value = JSON.parse(Buffer.from(pieces[0], 'base64url').toString()) as Grant;
    if (!Number.isInteger(value.exp) || value.exp <= Date.now()/1000 || !/^[a-f0-9]{32}$/.test(value.nonce)
      || !['private', 'share', 'session'].includes(value.kind)) throw new Error('Expired or invalid grant');
    return value;
  }
  private encode(grant: Grant): string {
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return payload+'.'+crypto.createHmac('sha256', this.options.signingKey).update(payload).digest('base64url');
  }
  private host(req: IncomingMessage): string {
    const host = (req.headers.host || '').toLowerCase();
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) throw new Error('Unknown host');
    return host;
  }
  private authorize(req: IncomingMessage, route: Route): Grant {
    const values = (req.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(cookieName+'='));
    if (values.length !== 1) throw new Error('Authentication required');
    const grant = this.decode(values[0].slice(cookieName.length+1));
    if (grant.kind !== 'session' || grant.app !== route.id || grant.version !== route.version) throw new Error('Access revoked');
    return grant;
  }
  private headers(req: IncomingMessage): http.OutgoingHttpHeaders {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (/^(?:x-vibespace|x-forwarded|proxy-)/i.test(name) || ['forwarded', 'connection', 'keep-alive'].includes(name)) delete headers[name];
    }
    if (headers.cookie) headers.cookie = headers.cookie.split(';').filter(item => !sensitiveCookie(item.trim().split('=')[0])).join(';');
    return headers;
  }
  private responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const output = { ...headers };
    delete output['connection']; delete output['keep-alive'];
    output['referrer-policy'] = 'no-referrer';
    if (output['set-cookie']) output['set-cookie'] = output['set-cookie']
      .filter(value => !sensitiveCookie(value.split('=')[0].trim()))
      .map(value => value.replace(/;\s*Domain=[^;]*/gi, ''));
    return output;
  }
  private track(socket: Duplex | ServerResponse, host: string, route: Route, grant: Grant) {
    this.streams.set(socket, { host, app: route.id, version: route.version, expires: grant.exp });
    socket.once('close', () => this.streams.delete(socket));
  }
  private revokeStreams() {
    for (const [socket, access] of this.streams) {
      try {
        const route = this.route(access.host);
        if (route.id !== access.app || route.version !== access.version || access.expires <= Date.now()/1000) socket.destroy();
      } catch { socket.destroy(); } // Lease/read failure closes access; never invents a running route.
    }
  }
  private request(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = this.host(req); const route = this.route(host);
      if (!req.url?.startsWith('/')) throw new Error('Invalid request target');
      if (!['GET', 'HEAD'].includes(req.method || '') && req.headers.origin && req.headers.origin !== 'https://'+host) throw new Error('Origin not allowed');
      const url = new URL(req.url, 'https://'+host);
      if (url.pathname === '/_vs/auth') {
        if (req.method !== 'GET') throw new Error('Invalid authentication request');
        const grant = this.decode(url.searchParams.get('grant') || '');
        if (grant.app !== route.id || grant.version !== route.version || grant.kind === 'session') throw new Error('Invalid grant');
        if (grant.kind === 'private') {
          this.nonces.prepare('DELETE FROM used_grants WHERE expires<?').run(Math.floor(Date.now()/1000));
          const count = this.nonces.prepare('SELECT count(*) AS n FROM used_grants').get() as { n: number };
          if (count.n >= 10_000) throw new Error('Grant exchange capacity reached');
          this.nonces.prepare('INSERT INTO used_grants(nonce,expires) VALUES(?,?)').run(grant.nonce, grant.exp);
        }
        const exp = grant.kind === 'share' ? grant.exp : Math.floor(Date.now()/1000)+12*3600;
        const session = this.encode({ ...grant, kind: 'session', exp });
        res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store',
          'Set-Cookie': `${cookieName}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0,exp-Math.floor(Date.now()/1000))}` });
        res.end(); return;
      }
      if (url.searchParams.has('grant') || url.pathname.startsWith('/_vs/')) throw new Error('Reserved route');
      const grant = this.authorize(req, route);
      if (this.streams.size >= 256) { res.writeHead(503).end('Gateway busy'); return; }
      const upstream = (this.options.request || http.request)({ host: route.address, port: route.port, method: req.method,
        path: req.url, headers: this.headers(req) }, response => {
        res.writeHead(response.statusCode || 502, this.responseHeaders(response.headers)); response.pipe(res);
      });
      const connect = setTimeout(() => upstream.destroy(new Error('Connection timed out')), 10_000);
      upstream.on('socket', socket => { if (socket.connecting) socket.once('connect', () => clearTimeout(connect)); else clearTimeout(connect); });
      upstream.on('error', () => { clearTimeout(connect); if (!res.headersSent) res.writeHead(502); res.end('Application unavailable'); });
      res.once('close', () => { clearTimeout(connect); upstream.destroy(); this.streams.delete(res); });
      // Responses, including SSE streams, are revoked without waiting for a new request.
      this.track(res, host, route, grant);
      req.pipe(upstream);
    } catch {
      res.writeHead(403, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Open this application from VibeSpace or use an active sharing link.');
    }
  }
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const host = this.host(req); const route = this.route(host); const grant = this.authorize(req, route);
      if (req.headers.origin && req.headers.origin !== 'https://'+host) throw new Error('Origin not allowed');
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || this.streams.size >= 256 || !req.url?.startsWith('/') || req.url.startsWith('/_vs/')) throw new Error('Unavailable');
      const headers = this.headers(req); headers.connection = 'Upgrade'; headers.upgrade = req.headers.upgrade;
      const upstream = (this.options.request || http.request)({ host: route.address, port: route.port, path: req.url, headers });
      const timer = setTimeout(() => upstream.destroy(), 10_000);
      upstream.on('upgrade', (response, target, received) => {
        clearTimeout(timer);
        const responseHeaders = this.responseHeaders(response.headers); responseHeaders.connection = 'Upgrade'; responseHeaders.upgrade = response.headers.upgrade;
        socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(responseHeaders).flatMap(([key,value]) => (Array.isArray(value)?value:[value]).map(item => `${key}: ${item}`)).join('\r\n')+'\r\n\r\n');
        if (received.length) socket.write(received); if (head.length) target.write(head);
        socket.pipe(target); target.pipe(socket);
        socket.once('close', () => target.destroy()); target.once('close', () => socket.destroy());
        target.on('error', () => socket.destroy());
        this.track(socket, host, route, grant);
      });
      upstream.on('response', response => { clearTimeout(timer); response.destroy(); socket.destroy(); });
      upstream.on('error', () => { clearTimeout(timer); socket.destroy(); });
      socket.on('error', () => upstream.destroy()); socket.once('close', () => { clearTimeout(timer); upstream.destroy(); });
      upstream.end();
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  }
  close() { for (const socket of this.streams.keys()) socket.destroy(); this.server.closeAllConnections(); this.server.close(); }
}
