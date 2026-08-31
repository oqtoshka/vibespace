// fileTreeRoutes: used by the server entrypoint to mount the complete authenticated File Tree API at `/api/file-tree`.
export { fileTreeRoutes } from '@/modules/file-tree/file-tree.module.js';
// buildFileAccessRoots: used by the legacy server composition root while its file endpoints migrate into this module.
export { buildFileAccessRoots } from '@/modules/file-tree/file-access-roots.js';
