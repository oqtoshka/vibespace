import express from 'express';

import type { LLMProvider } from '@/shared/index.js';

import { authenticateNativeControl, nativeControlService, nativeModelOptions, nativePermissionOptions } from './native-control.service.js';

const router = express.Router();
router.use((req, res, next) => {
  if (req.headers.origin || !authenticateNativeControl(req.headers['x-mc-federation-token'])) {
    res.status(403).json({ error: 'Native control authentication failed' }); return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const route = (fn: express.RequestHandler): express.RequestHandler => async (req, res, next) => {
  try { await fn(req, res, next); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Native control failed' }); }
};
const one = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
router.get('/catalog', route((_req, res) => { res.json(nativeControlService.catalog()); }));
router.post('/projects', route(async (req, res) => { res.json(await nativeControlService.createProject(req.body)); }));
router.get('/models/:provider', route(async (req, res) => {
  if (!['claude', 'codex', 'opencode'].includes(String(req.params.provider))) throw new Error('Unknown provider');
  const provider = req.params.provider as LLMProvider;
  res.json({ ...await nativeModelOptions(provider), ...nativePermissionOptions(provider) });
}));
/**
 * Mission Control relays the operator's transcription glossary as a
 * percent-encoded `x-mc-stt-prompt` header. A malformed encoding is dropped
 * rather than failing the recording: the hint is optional, the audio is not.
 */
const sttPrompt = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  try { return decodeURIComponent(value).trim() || undefined; } catch { return undefined; }
};
router.post('/transcribe', express.raw({ type: 'audio/mp4', limit: '8mb' }), route(async (req, res) => {
  res.json(await nativeControlService.transcribe(req.body, sttPrompt(req.headers['x-mc-stt-prompt'])));
}));
router.post('/sessions', route(async (req, res) => { res.json(await nativeControlService.create(req.body)); }));
router.get('/search/sessions', route(async (req, res) => {
  const rawLimit = one(req.query.limit);
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  res.json(await nativeControlService.search({
    query: one(req.query.q) ?? '',
    projectId: one(req.query.projectId),
    provider: one(req.query.provider),
    archived: one(req.query.archived) as 'all' | 'active' | 'archived' | undefined,
    from: one(req.query.from),
    to: one(req.query.to),
    matchType: one(req.query.matchType) as 'all' | 'phrase' | 'prefix' | 'title' | 'content' | undefined,
    limit,
    cursor: one(req.query.cursor),
  }));
}));
router.get('/sessions/:id', route((req, res) => { res.json(nativeControlService.describe(String(req.params.id))); }));
router.get('/sessions/:id/owner-capability', route((req, res) => {
  res.json(nativeControlService.ownerCapability(String(req.params.id)));
}));
router.post('/sessions/:id/attachments', express.raw({ type: 'application/octet-stream', limit: '10mb' }), route(async (req, res) => {
  res.json(await nativeControlService.upload(String(req.params.id), decodeURIComponent(String(req.headers['x-file-name'] || 'file')),
    String(req.headers['x-file-type'] || 'application/octet-stream'), req.body));
}));
router.get('/sessions/:id/attachments/:asset', route(async (req, res) => {
  const asset = await nativeControlService.asset(String(req.params.id), String(req.params.asset));
  res.setHeader('Content-Type', asset.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'attachment'); res.send(asset.bytes);
}));
router.get('/sessions/:id/stored-assets/:filename', route(async (req, res) => {
  const asset = await nativeControlService.storedAsset(String(req.params.id), String(req.params.filename));
  if (asset.status === 'invalid') { res.status(400).json({ error: 'Invalid asset filename' }); return; }
  if (asset.status === 'missing') { res.status(404).json({ error: 'Asset not found' }); return; }
  res.setHeader('Content-Type', asset.contentType); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'attachment'); asset.stream.pipe(res);
}));
export default router;
