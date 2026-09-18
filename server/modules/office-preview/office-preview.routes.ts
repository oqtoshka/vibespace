import { Router } from 'express';

import { AppError } from '@/shared/index.js';

import type { OfficePreviewService } from './office-preview.service.js';

/** Mounted by server composition with authentication; exercised by route tests. */
export function createOfficePreviewRouter(service: OfficePreviewService): Router {
  const router = Router();
  router.get('/:projectId', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof req.query.path !== 'string' || !req.query.path || req.query.path.includes('\0')) {
      res.status(400).json({ error: 'A file path is required.', code: 'OFFICE_PATH' }); return;
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const pdf = await service.preview(String(req.params.projectId), req.query.path, controller.signal);
      res.set({ 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="preview.pdf"' }).send(pdf);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code }); return;
      }
      res.status(500).json({ error: 'Office preview failed.', code: 'OFFICE_UNAVAILABLE' });
    }
  });
  return router;
}
