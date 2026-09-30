import { createFdObservationRouter } from './fd-observation.routes.js';
import { fdObserver } from './fd-observation.service.js';

export {
  FdObserver,
  fdObserver,
  parseLsofFieldOutput,
  classifyProcFdTarget,
} from './fd-observation.service.js';
export type { FdSample, FdProbeExec, FdChildrenObservation, FdObserverOptions } from './fd-observation.service.js';

/** Mounted by `server/index.js` at `/api/diagnostics`, behind authenticateToken. */
export const fdObservationRoutes = createFdObservationRouter(fdObserver);
