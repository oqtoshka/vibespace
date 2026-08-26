/**
 * Claude runtime adapter — the registry-facing surface over `server/claude-sdk.js`.
 *
 * The implementation stays in `server/claude-sdk.js` (persistent streaming
 * sessions, idle reaper, task-ledger nudge, usage-limit wake, compaction,
 * mid-turn injection); this module only adapts it to `IProviderRuntime`:
 *
 *   run(command, options, writer, context)
 *     `options.sessionId` is the app session id when `context` is supplied
 *     (the chat gateway); direct callers pass the provider-native id and no
 *     context. `options.providerSessionId` / `options.appSessionId` are
 *     accepted as already-resolved hints.
 *   abort(sessionId)          — app or provider-native id.
 *   permissions.resolve(requestId, decision) — decision may carry
 *     `permissionMode` (the mode to continue in after ExitPlanMode).
 *   permissions.listPending(sessionId) — app or provider-native id.
 */
import {
  queryClaudeSDK,
  injectClaudeMessage,
  cancelInjectedClaudeMessage,
  abortClaudeSDKSession,
  stopClaudeSDKTask,
  getClaudeSDKBackgroundTasks,
  isClaudeSDKSessionActive,
  isClaudeSDKSessionAlive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  TOOL_APPROVAL_TIMEOUT_MS,
  __setClaudeQueryImpl,
  __setRewindHistoryImpl,
} from '../../../../claude-sdk.js';

/*
 * Declared as a function, not a `const`, on purpose. The registry constructs
 * every provider at module load, and this module sits on an import cycle with
 * it (registry -> claude.provider -> here -> the impl -> services -> registry).
 * Whichever side is entered first, the other reads this binding while this
 * module is still mid-evaluation: a `const` would be in its TDZ and throw,
 * while a function declaration is initialized before evaluation starts. The
 * members are attached below and only ever read at call time.
 */
export function claudeRuntime() {
  throw new Error('claudeRuntime is a runtime adapter object, not a function.');
}
claudeRuntime.run = (command, options, writer, context) => queryClaudeSDK(command, options, writer, context);
claudeRuntime.abort = (sessionId) => abortClaudeSDKSession(sessionId);
claudeRuntime.permissions = {
  resolve: (requestId, decision) => resolveToolApproval(requestId, decision),
  listPending: (sessionId) => getPendingApprovalsForSession(sessionId),
};

export {
  queryClaudeSDK,
  injectClaudeMessage,
  cancelInjectedClaudeMessage,
  abortClaudeSDKSession,
  stopClaudeSDKTask,
  getClaudeSDKBackgroundTasks,
  isClaudeSDKSessionActive,
  isClaudeSDKSessionAlive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  TOOL_APPROVAL_TIMEOUT_MS,
  __setClaudeQueryImpl,
  __setRewindHistoryImpl,
};
