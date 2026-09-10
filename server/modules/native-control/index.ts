// Composition root mounts this authenticated, operator-only federation surface.
export { default as nativeControlRoutes } from './native-control.routes.js';
// WebSocket chat consumes catalog selection and session-bound attachment resolution.
export { nativeModelOptions, nativePermissionOptions, setNativePermissionSelection, setNativeSelection, resolveNativeAttachments } from './native-control.service.js';
