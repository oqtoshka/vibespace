import express from 'express';
import { permissionPreferencesService } from '@/modules/providers/index.js';

import type { createSettingsService } from './settings.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function userId(req: express.Request): number {
  return Number((req as AuthenticatedRequest).user?.id);
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Creates thin Settings transport handlers around the application service. */
export function createSettingsRouter(
  service: ReturnType<typeof createSettingsService>,
): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/chat-permissions', respond((req) => permissionPreferencesService.get(userId(req), queryString(req.query.provider) ?? '', queryString(req.query.sessionId) ?? undefined)));
  router.put('/chat-permissions', respond((req) => permissionPreferencesService.update(userId(req), typeof req.body?.provider === 'string' ? req.body.provider : '', typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined, req.body ?? {})));

  router.get('/api-keys', respond((req) => service.listApiKeys(userId(req))));
  router.post('/api-keys', respond((req) => service.createApiKey(userId(req), req.body?.keyName)));
  router.delete('/api-keys/:keyId', respond((req) => service.deleteApiKey(userId(req), Number(req.params.keyId))));
  router.patch('/api-keys/:keyId/toggle', respond((req) => service.toggleApiKey(
    userId(req), Number(req.params.keyId), req.body?.isActive,
  )));
  router.get('/credentials', respond((req) => service.listCredentials(
    userId(req), queryString(req.query.type),
  )));
  router.post('/credentials', respond((req) => service.createCredential(userId(req), req.body ?? {})));
  router.delete('/credentials/:credentialId', respond((req) => service.deleteCredential(
    userId(req), Number(req.params.credentialId),
  )));
  router.patch('/credentials/:credentialId/toggle', respond((req) => service.toggleCredential(
    userId(req), Number(req.params.credentialId), req.body?.isActive,
  )));
  router.get('/notification-preferences', respond((req) => service.getNotificationPreferences(userId(req))));
  router.put('/notification-preferences', respond((req) => service.updateNotificationPreferences(
    userId(req), req.body ?? {},
  )));
  router.get('/push/vapid-public-key', respond(() => service.getVapidPublicKey()));
  router.post('/push/subscribe', respond((req) => service.subscribeToPush(userId(req), req.body ?? {})));
  router.post('/push/unsubscribe', respond((req) => service.unsubscribeFromPush(
    userId(req), req.body?.endpoint,
  )));
  return router;
}
