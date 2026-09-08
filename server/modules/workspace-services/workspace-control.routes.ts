import { Router, type Request, type Response, type NextFunction } from 'express';

import type { WorkspaceControl } from './workspace-control.service.js';

/** Manager entrypoint mounts this after its verified session middleware. */
export function createWorkspaceControlRouter(control: WorkspaceControl): Router {
  const router = Router();
  router.use((req, res, next) => {
    // Mutations require a same-origin JSON request as well as manager auth.
    if (req.method !== 'GET' && (!req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site')) {
      res.status(403).json({ error: 'Same-origin JSON request required.' }); return;
    }
    const origin = req.get('Origin');
    const publicUrl = process.env.VS_OIDC_REDIRECT_URI;
    if (req.method !== 'GET' && origin && publicUrl && origin !== new URL(publicUrl).origin) {
      res.status(403).json({ error: 'Origin not allowed.' }); return;
    }
    next();
  });
  const user = (res: { locals: Record<string, unknown> }) => String(res.locals.workspaceUser);
  router.get('/', (_req, res) => res.json(control.list(user(res))));
  router.get('/users', (_req, res) => res.json({ users: control.users(user(res)) }));
  router.post('/shares', (req, res) => {
    const { recipient, path, kind = 'folder', access = 'read' } = req.body || {};
    if (![recipient, path, kind, access].every(value => typeof value === 'string')) throw new Error('recipient, path and kind must be strings.');
    res.status(201).json(control.share(user(res), { recipient, path, kind, access }));
  });
  router.post('/accept', (req, res) => {
    if (typeof req.body?.token !== 'string') throw new Error('Invitation token required.');
    res.json(control.accept(user(res), req.body.token));
  });
  router.post('/shares/:id/revoke', (req, res) => res.json(control.revoke(user(res), String(req.params.id))));
  router.post('/backups', (req, res) => {
    if (req.body?.snapshot != null && typeof req.body.snapshot !== 'string') throw new Error('Invalid snapshot.');
    res.status(202).json(control.backup(user(res), req.body?.snapshot || null));
  });
  router.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => res.status(error.status || 400).json({ error: error.message }));
  return router;
}
