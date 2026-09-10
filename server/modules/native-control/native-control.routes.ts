import express from 'express';
import { authenticateNativeControl, nativeControlService, nativeModelOptions, nativePermissionOptions } from './native-control.service.js';
import type { LLMProvider } from '@/shared/index.js';

const router = express.Router();
router.use((req, res, next) => {
  if (req.headers.origin || !authenticateNativeControl(req.headers['x-mc-federation-token'])) {
    res.status(403).json({ error: 'Native control authentication failed' }); return;
  }
  next();
});
const route = (fn: express.RequestHandler): express.RequestHandler => async (req, res, next) => {
  try { await fn(req, res, next); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Native control failed' }); }
};
router.get('/catalog', route((_req, res) => { res.json(nativeControlService.catalog()); }));
router.get('/models/:provider', route(async (req, res) => {
  if (!['claude', 'codex', 'opencode'].includes(String(req.params.provider))) throw new Error('Unknown provider');
  const provider = req.params.provider as LLMProvider;
  res.json({ ...await nativeModelOptions(provider), ...nativePermissionOptions(provider) });
}));
router.post('/sessions', route(async (req, res) => { res.json(await nativeControlService.create(req.body)); }));
router.get('/sessions/:id', route((req, res) => { res.json(nativeControlService.describe(String(req.params.id))); }));
router.post('/sessions/:id/attachments', express.raw({ type: 'application/octet-stream', limit: '10mb' }), route(async (req, res) => {
  res.json(await nativeControlService.upload(String(req.params.id), decodeURIComponent(String(req.headers['x-file-name'] || 'file')),
    String(req.headers['x-file-type'] || 'application/octet-stream'), req.body));
}));
router.get('/sessions/:id/attachments/:asset', route(async (req, res) => {
  const asset = await nativeControlService.asset(String(req.params.id), String(req.params.asset));
  res.setHeader('Content-Type', asset.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'attachment'); res.send(asset.bytes);
}));
export default router;
