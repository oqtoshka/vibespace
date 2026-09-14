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
