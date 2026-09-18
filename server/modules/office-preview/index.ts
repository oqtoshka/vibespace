import { projectsDb } from '@/modules/database/index.js';

import { OfficePreviewService } from './office-preview.service.js';
import { createOfficePreviewRouter } from './office-preview.routes.js';

/** Authenticated read-only Office preview API used by the server entrypoint. */
export const officePreviewRoutes = createOfficePreviewRouter(new OfficePreviewService({
  projectPath: id => projectsDb.getProjectPathById(id),
  converterUrl: process.env.VS_OFFICE_CONVERTER_URL,
}));
