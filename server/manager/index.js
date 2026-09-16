#!/usr/bin/env node
import { createWorkspacePolicyAdminRouter } from '../modules/workspace-policy/index.js';
import '../load-env.js';
import { AppControl, createAppControlRouter, resolveAppWorker, isWorkspaceOriginAllowed } from '../modules/app-deployments/index.js';
import { WorkspaceControl, createWorkspaceControlRouter } from '../modules/workspace-services/index.js';
import { deploymentConfigRouter } from '../modules/deployment-config/index.js';

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
import { createShareOwnerIndex, shareIdFromPath } from './share-owners.js';
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
 * `/api/share/` is the exception: it is routed by asking the workers which one
 * owns the shareId (see share-owners.js), so a link works for anyone holding
 * it — logged out, or logged in as a different tenant. The others have no such
 * handle and remain session-routed.
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
  const shareOwners = createShareOwnerIndex({ links: config.links });

  const hostingEnabled = env.VS_APPS_ENABLED === 'true';
  const workspaceOrigin = env.VS_APPS_WORKSPACE_ORIGIN || (env.VS_OIDC_REDIRECT_URI ? new URL(env.VS_OIDC_REDIRECT_URI).origin : undefined);
  if (hostingEnabled && (!workspaceOrigin || new URL(workspaceOrigin).origin !== workspaceOrigin)) {
    throw new Error('App hosting requires the exact public workspace origin');
  }
  const app = express();
  // App subdomains share cookie same-site scope. Guard every workspace mutation,
  // including proxied legacy endpoints, before routing or parsing request bodies.
  if (hostingEnabled) app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && !isWorkspaceOriginAllowed(req.get('Origin'), req.get('Sec-Fetch-Site'), workspaceOrigin)) {
      res.status(403).json({ error: 'Workspace origin required.' }); return;
    }
    next();
  });
  app.use(deploymentConfigRouter);
  const server = http.createServer(app);

  app.use(cors({ exposedHeaders: ['X-Refreshed-Token'], credentials: true }));

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      role: 'manager',
      version: RUNNING_VERSION,
      workers: [...config.links.values()].filter((link) => link.enabled).length,
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

  app.use('/api/workspace-policy/admin', (req, res, next) => {
    const identity = resolver.resolveUser(req, requestUrl(req));
    if (identity.error) return res.status(ERROR_STATUS[identity.error] || 403).json({ error: identity.error });
    res.locals.workspaceUser = identity.userId;
    next();
  }, express.json({ limit: '256kb' }), createWorkspacePolicyAdminRouter(
    env.VS_WORKSPACE_POLICY_FILE,
    (env.VS_WORKSPACE_POLICY_ADMINS || '').split(',').map(value => value.trim()).filter(Boolean),
    env.VS_OIDC_REDIRECT_URI ? new URL(env.VS_OIDC_REDIRECT_URI).origin : undefined,
  ));

  if (env.VS_WORKSPACE_SERVICES === 'true') {
    if (!env.VS_WORKSPACE_CONTROL_DB) throw new Error('VS_WORKSPACE_CONTROL_DB is required');
    const control = new WorkspaceControl(env.VS_WORKSPACE_CONTROL_DB, config.links);
    app.use('/api/workspace-control', (req, res, next) => {
      const identity = resolver.resolveUser(req, requestUrl(req));
      if (identity.error) return res.status(ERROR_STATUS[identity.error] || 403).json({ error: identity.error });
      res.locals.workspaceUser = identity.userId;
      next();
    }, express.json({ limit: '16kb' }), createWorkspaceControlRouter(control));
    server.once('close', () => control.close());
  }

  if (env.VS_APPS_ENABLED === 'true') {
    if (!env.VS_APPS_CONTROL_DB || !env.VS_APPS_DOMAIN || !env.VS_APPS_SIGNING_KEY_FILE) {
      throw new Error('App control database, domain and signing key file are required');
    }
    const apps = new AppControl(env.VS_APPS_CONTROL_DB, config.links, env.VS_APPS_DOMAIN,
      fs.readFileSync(env.VS_APPS_SIGNING_KEY_FILE, 'utf8').trim(),
      { owner: Number(env.VS_APPS_OWNER_LIMIT || 3), total: Number(env.VS_APPS_TOTAL_LIMIT || 24) });
    app.use('/api/apps', (req, res, next) => {
      const workerToken = req.get('X-Vibespace-App-Token');
      if (workerToken) {
        const owner = resolveAppWorker(workerToken, config.links);
        if (!owner) return res.status(403).json({ error: 'Worker access unavailable.' });
        res.locals.workspaceUser = owner;
      } else {
        const identity = resolver.resolveUser(req, requestUrl(req));
        if (identity.error) return res.status(ERROR_STATUS[identity.error] || 403).json({ error: identity.error });
        res.locals.workspaceUser = identity.userId;
      }
      next();
    }, express.json({ limit: '16kb' }), createAppControlRouter(apps,
      env.VS_OIDC_REDIRECT_URI ? new URL(env.VS_OIDC_REDIRECT_URI).origin : undefined));
    server.once('close', () => apps.close());
  } else {
    app.get('/api/apps', (_req, res) => res.json({ enabled: false }));
  }

  // Everything else that isn't a static asset belongs to a worker.
  app.use(async (req, res, next) => {
    const url = requestUrl(req);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/plugin-ws/')) {
      return next();
    }

    let identity;
    const shareId = shareIdFromPath(url.pathname);
    if (shareId) {
      const { userId, conclusive } = await shareOwners.findOwner(shareId);
      if (userId) {
        identity = { userId, link: config.links.get(userId) };
      } else if (!conclusive) {
        // A worker stayed silent, so we cannot tell an unknown share from one
        // whose owner was too busy to answer. Saying "invalid or expired" here
        // would brand a live link dead.
        return res.status(503).json({ error: 'Worker unavailable' });
      } else {
        // Every worker answered and none claims it. Reply exactly as the owning
        // worker would have, so a revoked link and an unknown one look alike.
        return res.status(404).json({ error: 'This link is invalid or has expired' });
      }
    } else if (isPublicWorkerPath(url.pathname)) {
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
    if (hostingEnabled && !isWorkspaceOriginAllowed(req.headers.origin, req.headers['sec-fetch-site'], workspaceOrigin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
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

    // Revoke established sockets too; a previously valid JWT cannot keep a
    // shell alive after unlinking, remapping or expiration of the registry.
    const authorization = setInterval(() => {
      const current = config.links.get(identity.userId);
      if (!current?.enabled || current.upstream !== identity.link.upstream
          || current.workerToken !== identity.link.workerToken) socket.destroy();
    }, 1000);
    authorization.unref();
    socket.once('close', () => clearInterval(authorization));
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
