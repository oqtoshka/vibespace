// The orchestrator implementation lives in server/services/notification-orchestrator.js
// (VibeSpace's version: Telegram channel, private-session gating, recap-aware
// messages, rate-limit pauses). This module path is kept so the notifications
// barrel and its tests keep resolving; move the implementation here when
// server/services is folded into modules.
export {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunPaused,
  notifyRunFailed,
  notifyBackgroundWorkCompleted
// eslint-disable-next-line boundaries/no-unknown -- temporary until server/services moves into modules
} from '../../../services/notification-orchestrator.js';
