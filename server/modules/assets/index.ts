// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments plus sandboxed generated-image artifacts.
export { default as assetsRoutes } from './assets.routes.js';

// Native-control stores session-bound uploads in the same attachment directory.
export { ensureImageAssetsDir } from "./services/image-assets.service.js";
