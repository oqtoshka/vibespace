import { Router } from 'express';

import { AppError } from '@/shared/index.js';

import { WorkspacePolicy } from './workspace-policy.service.js';

/** Manager mounts this behind verified identity; workers never receive this write route. */
export function createWorkspacePolicyAdminRouter(filename: string | undefined, administrators: string[], publicOrigin?: string): Router {
  const policy = new WorkspacePolicy(() => filename, administrators);
  const router = Router();
  router.use((_request, response, next) => {
    if (!policy.canEdit(String(response.locals.workspaceUser))) { response.status(403).json({error:'Administrator access required.'}); return; }
    response.set('Cache-Control','no-store');
    next();
  });
  router.get('/', async (_request, response) => {
    try { response.json(await policy.snapshot()); }
    catch { response.status(503).json({error:'Workspace policy is unavailable.'}); }
  });
  router.put('/', async (request, response) => {
    if (!request.is('application/json') || request.get('Sec-Fetch-Site') === 'cross-site'
      || (publicOrigin && request.get('Origin') && request.get('Origin') !== publicOrigin)) {
      response.status(403).json({error:'Same-origin JSON request required.'}); return;
    }
    if (typeof request.body?.revision !== 'string' || !Array.isArray(request.body?.rules)) {
      response.status(400).json({error:'Rules and revision are required.'}); return;
    }
    try { response.json(await policy.save(String(response.locals.workspaceUser),request.body.rules,request.body.revision)); }
    catch (error) {
      response.status(error instanceof AppError ? error.statusCode : 500).json({error:error instanceof AppError ? error.message : 'Unable to save workspace policy.'});
    }
  });
  return router;
}
