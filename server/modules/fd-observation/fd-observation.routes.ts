import express from 'express';

import type { FdObserver } from './fd-observation.service.js';

/**
 * Read-only diagnostics routes. `GET /fd` returns the sample ring;
 * `?fresh=1` takes (and records) one sample first. Counts and child PIDs only.
 */
export function createFdObservationRouter(observer: FdObserver): express.Router {
  const router = express.Router();

  router.get('/fd', async (request, response, next) => {
    try {
      if (request.query.fresh === '1') {
        await observer.sample();
      }
      response.json(observer.snapshot());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
