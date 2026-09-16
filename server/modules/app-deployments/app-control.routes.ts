import { Router, type Request, type Response, type NextFunction } from 'express';

import type { AppControl } from './app-control.service.js';

/** Manager supplies verified owner identity; an app or worker cannot choose it in a body. */
export function createAppControlRouter(control: AppControl, publicOrigin?: string): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && (!req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site'
      || (req.get('Origin') && publicOrigin && req.get('Origin') !== publicOrigin))) {
      res.status(403).json({ error: 'Same-origin JSON request required.' }); return;
    }
    if (typeof res.locals.workspaceUser !== 'string' || !res.locals.workspaceUser) {
      res.status(401).json({ error: 'Authentication required.' }); return;
    }
    next();
  });
  router.get('/', (_req, res) => res.json(control.list(res.locals.workspaceUser)));
  router.post('/', (req, res) => {
    const { name, source, runtime, entrypoint } = req.body || {};
    if (![name, source, runtime, entrypoint].every(value => typeof value === 'string')) {
      res.status(400).json({ error: 'name, source, runtime and entrypoint are required strings.' }); return;
    }
    res.status(202).json(control.create(res.locals.workspaceUser, { name, source, runtime, entrypoint }));
  });
  router.get('/:id/logs', (req, res) => res.json(control.logs(res.locals.workspaceUser, String(req.params.id))));
  router.post('/:id/open', (req, res) => res.json(control.grant(res.locals.workspaceUser, String(req.params.id), false)));
  router.post('/:id/share', (req, res) => res.json(control.grant(res.locals.workspaceUser, String(req.params.id), true)));
  router.post('/:id/revoke', (req, res) => res.json(control.revoke(res.locals.workspaceUser, String(req.params.id))));
  router.post('/:id/:action', (req, res) => res.status(202).json(control.command(res.locals.workspaceUser, String(req.params.id), String(req.params.action))));
  router.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.status || 400).json({ error: error.message });
  });
  return router;
}
