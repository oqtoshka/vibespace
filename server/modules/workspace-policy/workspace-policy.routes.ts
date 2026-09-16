import { Router } from 'express';

import { workspacePolicy } from './workspace-policy.service.js';

/** Authenticated worker clients read presentation rules; configuration writes stay with deployment administration. */
export const workspacePolicyRoutes = Router();
workspacePolicyRoutes.get('/', async (_request, response) => {
  response.set('Cache-Control', 'no-store');
  try { response.json(await workspacePolicy.read()); }
  catch { response.status(503).json({ error: 'Workspace policy is unavailable.' }); }
});
