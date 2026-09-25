// Composition root mounts this authenticated, operator-only federation surface.
export { default as nativeControlRoutes } from './native-control.routes.js';
// WebSocket chat consumes catalog selection and session-bound attachment resolution.
export { nativeModelOptions, nativePermissionOptions, setNativePermissionSelection, setNativeSelection, resolveNativeAttachments } from './native-control.service.js';

// Native workspace reuses the private federation authentication boundary.
export { authenticateNativeControl } from './native-control.service.js';

// Composition root injects run control and starts the sweep; the websocket
// send path reads a side row's parent context.
export { registerSideRunControl, sideSessionContext, startSideQuestionSweeper } from './side-questions.service.js';
