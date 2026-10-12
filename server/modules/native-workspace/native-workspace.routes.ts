import express from 'express';
import { authenticateNativeControl } from '@/modules/native-control/index.js';
import { NativeWorkspaceService } from './native-workspace.service.js';

/** Server entrypoint mounts this private federation route. Browser callers are rejected. */
export const nativeWorkspaceRoutes = express.Router();
const service = new NativeWorkspaceService();
nativeWorkspaceRoutes.post('/sessions/:id', async (req, res) => {
  if (req.headers.origin || !authenticateNativeControl(req.headers['x-mc-federation-token'])) {
    res.status(403).json({ error: 'Workspace authentication failed' }); return;
  }
  try { res.json(await service.request(String(req.params.id), req.body)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    res.status(code === 'ENOENT' ? 404 : 400).json({ error: code === 'ENOENT' ? 'File was moved or deleted' : error instanceof Error ? error.message.slice(0, 300) : 'Workspace unavailable' });
  }
});

/** Raw bytes for media playback and downloads (video/audio have no 32 MiB cap here).
 * `sendFile` answers Range with 206/416 and sets Accept-Ranges, ETag and Last-Modified.
 * The marker header lets Mission Control tell this route from an older server's fallback. */
nativeWorkspaceRoutes.get('/sessions/:id/raw', async (req, res) => {
  if (req.headers.origin || !authenticateNativeControl(req.headers['x-mc-federation-token'])) {
    res.status(403).json({ error: 'Workspace authentication failed' }); return;
  }
  let file: Awaited<ReturnType<NativeWorkspaceService['rawFile']>>;
  try { file = await service.rawFile(String(req.params.id), req.query.path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    res.setHeader('X-Native-Workspace-Raw', '1');
    res.status(code === 'ENOENT' ? 404 : 400).json({ error: code === 'ENOENT' ? 'File was moved or deleted' : error instanceof Error ? error.message.slice(0, 300) : 'Workspace unavailable' });
    return;
  }
  res.setHeader('X-Native-Workspace-Raw', '1');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.sendFile(file.file, { dotfiles: 'allow', acceptRanges: true, lastModified: true, etag: true }, error => {
    if (!error || res.headersSent) return;
    // send() reports an unsatisfiable Range as an error with status 416.
    const status = (error as { status?: number }).status ?? 500;
    if (status === 416) res.setHeader('Content-Range', `bytes */${file.size}`);
    res.status(status).end();
  });
});
