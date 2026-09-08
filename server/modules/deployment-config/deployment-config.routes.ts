import { Router } from 'express';

import { deploymentConfigScript } from './deployment-config.service.js';

/** Manager and worker entrypoints serve deployment branding before SPA startup. */
export const deploymentConfigRouter = Router();
deploymentConfigRouter.get('/deployment-config.js', (_req, res) => {
  res.set('Cache-Control', 'no-store').type('application/javascript').send(deploymentConfigScript());
});
