import express from 'express';
import { permissionPreferencesService } from '@/modules/providers/index.js';

/** Mounted alongside legacy settings by the HTTP entrypoint. Only permission
 * preferences are owned here; existing settings keep their current routes. */
export const permissionPreferencesRoutes = express.Router();
permissionPreferencesRoutes.get('/chat-permissions', (req, res, next) => {
  try {
    const userId = Number((req as express.Request & { user?: { id?: number } }).user?.id);
    res.json(permissionPreferencesService.get(userId, String(req.query.provider ?? ''), typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined));
  } catch (error) { next(error); }
});
permissionPreferencesRoutes.put('/chat-permissions', (req, res, next) => {
  try {
    const userId = Number((req as express.Request & { user?: { id?: number } }).user?.id);
    res.json(permissionPreferencesService.update(userId, typeof req.body?.provider === 'string' ? req.body.provider : '', typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined, req.body ?? {}));
  } catch (error) { next(error); }
});
