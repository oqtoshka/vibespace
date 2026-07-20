import http from 'http';
import net from 'net';

import { WORKER_USER_HEADER, WORKER_TOKEN_HEADER } from '../constants/config.js';

/**
 * HTTP and WebSocket forwarding from the manager to a user's worker.
 */

// Per-hop headers that must not be forwarded verbatim.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Builds the header set for the worker hop.
 *
 * The identity headers are stripped from client input before being re-stamped:
 * without that, anyone who can reach the manager could name themselves another
 * tenant and the worker — which trusts these headers by design — would believe
 * it. Header names arrive lowercased from Node, so one delete covers all casings.
 *
 * @param {object} options.upgrade  keep the WebSocket handshake headers, which
 *   are hop-by-hop for a normal request but are the point of an upgrade.
 */
export function buildProxyHeaders(headers, { username, workerToken, remoteAddress, proto, upstreamHost, upgrade = false }) {
  const out = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === WORKER_USER_HEADER || lower === WORKER_TOKEN_HEADER) continue;
    if (lower === 'host') continue;
    if (HOP_BY_HOP.has(lower) && !(upgrade && (lower === 'connection' || lower === 'upgrade'))) continue;
    out[name] = value;
  }

  out[WORKER_USER_HEADER] = username;
  if (workerToken) out[WORKER_TOKEN_HEADER] = workerToken;
  out.host = upstreamHost;

  const forwardedFor = headers['x-forwarded-for'];
  out['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${remoteAddress}` : remoteAddress;
  out['x-forwarded-proto'] = headers['x-forwarded-proto'] || proto;
  if (headers.host) out['x-forwarded-host'] = headers.host;

  return out;
}

/** Forwards a normal HTTP request and pipes the response back. */
export function proxyHttpRequest(req, res, { entry, headers, backend }) {
  const upstream = http.request({
    host: entry.host,
    port: entry.port,
    method: req.method,
    path: req.url,
    headers,
  });

  upstream.on('error', (error) => {
    console.error(`[manager] upstream error for ${entry.userId}: ${error.message}`);
    backend.invalidateWorker(entry.userId, entry);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Worker unavailable' }));
    } else {
      res.destroy();
    }
  });

  upstream.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  req.pipe(upstream);
}

/**
 * Forwards a WebSocket upgrade by re-serializing the request onto a raw socket
 * and splicing the two connections. Express never sees these — they arrive on
 * the HTTP server's 'upgrade' event, before any middleware.
 */
export function proxyUpgrade(req, socket, head, { entry, headers, backend }) {
  const upstream = net.connect(entry.port, entry.host);
  let opened = false;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    // Only balance the counter if the open was ever recorded — a connection
    // that fails before it is established never incremented it.
    if (opened) backend.noteWebSocketClosed(entry.userId);
    upstream.destroy();
    socket.destroy();
  };

  upstream.on('connect', () => {
    opened = true;
    backend.noteWebSocketOpened(entry.userId);

    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    }

    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);

    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    // No idle timeout: chat and shell sessions are legitimately quiet for a long time.
    upstream.setTimeout(0);
    socket.setTimeout(0);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', (error) => {
    console.error(`[manager] websocket upstream error for ${entry.userId}: ${error.message}`);
    backend.invalidateWorker(entry.userId, entry);
    cleanup();
  });

  upstream.on('close', cleanup);
  upstream.on('end', cleanup);
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  socket.on('end', cleanup);
}
