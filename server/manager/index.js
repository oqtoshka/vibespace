#!/usr/bin/env node
import '../load-env.js';

import cors from 'cors';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';
import { loadManagerConfig } from './config.js';
import { createResolver } from './resolvers/index.js';
import { createBackend } from './backends/index.js';
import { buildProxyHeaders, proxyHttpRequest, proxyUpgrade } from './proxy.js';
import { installStaticHandlers } from './static-files.js';

/**
 * VibeSpace manager — authenticates users and proxies them to their own worker.
 *
 * The manager owns the public port and the login flow; each worker runs the
 * ordinary single-user server with its own database and workspace, and trusts
 * the identity this process stamps on every forwarded request.
 */

const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const RUNNING_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

/**
 * Paths the worker itself serves without a bearer token: public share links,
 * preview-iframe subresources, telemetry, and the API-key surfaces. They still
 * need routing to *a* worker, so they fall back to the session cookie.
 *
 * Known limitation: a share link opened by someone who isn't logged in as its
 * creator cannot be routed and will 401. Cross-tenant sharing needs the creator
 * id in the URL, which is a separate change.
 */
const PUBLIC_WORKER_PATHS = [
  '/api/share/',
  '/api/debug-log',
  '/api/browser-use-mcp/',
  '/api/agent/',
];

const isPublicWorkerPath = (pathname) =>
  PUBLIC_WORKER_PATHS.some((prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix)) ||
  /^\/api\/projects\/[^/]+\/preview-fs\//.test(pathname);

const ERROR_STATUS = {
  unauthenticated: 401,
  unmapped: 403,
  disabled: 403,
  unavailable: 503,
};

function requestUrl(req) {
  return new URL(req.url, 'http://manager.local');
}

function requestProto(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.encrypted ? 'https' : 'http';
}

export async function startManager(env = process.env) {
  const config = loadManagerConfig(env);
  const resolver = createResolver(config.authKind, config);
  const backend = createBackend(config.backendKind, config);

  const app = express();
  const server = http.createServer(app);

  app.use(cors({ exposedHeaders: ['X-Refreshed-Token'], credentials: true }));

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      role: 'manager',
      version: RUNNING_VERSION,
      workers: backend.listWorkers?.() ?? [],
    });
  });

  /**
   * Extension point: handlers mounted here run before authentication, for
   * deployments that expose manager-side endpoints to their workers (for
   * example credential-stamping egress proxies under a reserved prefix).
   */
  const preAuthHandlers = [];
  for (const handler of preAuthHandlers) app.use(handler);

  if (resolver.router) app.use('/api/auth', resolver.router);

  // Everything else that isn't a static asset belongs to a worker.
  app.use(async (req, res, next) => {
    const url = requestUrl(req);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/plugin-ws/')) {
      return next();
    }

    let identity;
    if (isPublicWorkerPath(url.pathname)) {
      const session = resolver.resolveSessionCookie(req);
      identity = session || { error: 'unauthenticated' };
    } else {
      identity = resolver.resolveUser(req, url);
    }

    if (identity.error) {
      return res.status(ERROR_STATUS[identity.error] ?? 403).json({ error: identity.error });
    }

    let entry;
    try {
      backend.touch(identity.userId);
      entry = await backend.getOrStartWorker(identity.link);
    } catch (error) {
      console.error(`[manager] ${error.message}`);
      return res.status(503).json({ error: 'Worker unavailable' });
    }

    if (identity.refreshedToken) {
      res.setHeader('X-Refreshed-Token', identity.refreshedToken);
      resolver.applySession?.(req, res, identity.refreshedToken);
    }

    const headers = buildProxyHeaders(req.headers, {
      username: identity.userId,
      workerToken: entry.workerToken,
      remoteAddress: req.socket.remoteAddress || '',
      proto: requestProto(req),
      upstreamHost: `${entry.host}:${entry.port}`,
    });

    proxyHttpRequest(req, res, { entry, headers, backend });
  });

  installStaticHandlers(app, APP_ROOT);

  server.on('upgrade', async (req, socket, head) => {
    const url = requestUrl(req);
    const identity = resolver.resolveUser(req, url);

    if (identity.error) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let entry;
    try {
      backend.touch(identity.userId);
      entry = await backend.getOrStartWorker(identity.link);
    } catch (error) {
      console.error(`[manager] ${error.message}`);
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const headers = buildProxyHeaders(req.headers, {
      username: identity.userId,
      workerToken: entry.workerToken,
      remoteAddress: req.socket.remoteAddress || '',
      proto: requestProto(req),
      upstreamHost: `${entry.host}:${entry.port}`,
      upgrade: true,
    });

    proxyUpgrade(req, socket, head, { entry, headers, backend });
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));

  console.log(`VibeSpace manager v${RUNNING_VERSION} listening on ${config.host}:${config.port}`);
  console.log(`  auth backend: ${config.authKind}   worker backend: ${backend.kind}`);
  for (const [username, link] of config.links) {
    console.log(`  ${username} -> ${link.upstream}${link.enabled ? '' : ' (disabled)'}`);
  }

  const shutdown = async () => {
    console.log('\nShutting down manager...');
    server.close();
    await backend.stopAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return { server, config, backend, resolver };
}

// Running this file directly starts the manager; importing it (from the CLI, or
// from tests) just exposes startManager.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(getModuleDir(import.meta.url), 'index.js');

if (invokedDirectly) {
  startManager().catch((error) => {
    console.error(`[manager] failed to start: ${error.message}`);
    process.exit(1);
  });
}
