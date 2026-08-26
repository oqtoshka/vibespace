/**
 * Codex runtime adapter — the registry-facing surface over `server/openai-codex.js`
 * (the app-server transport with turn steering, usage-limit wake and task
 * continuation). See the Claude adapter for the `run` id conventions.
 */
import {
  queryCodex,
  injectCodexMessage,
  abortCodexSession,
  isCodexSessionActive,
  getActiveCodexSessions,
  isCodexUsageLimitError,
  pickCodexLimitReset,
  __resetCodexRateLimits,
} from '../../../../openai-codex.js';

/*
 * Declared as a function, not a `const`, on purpose. The registry constructs
 * every provider at module load, and this module sits on an import cycle with
 * it (registry -> codex.provider -> here -> the impl -> services -> registry).
 * Whichever side is entered first, the other reads this binding while this
 * module is still mid-evaluation: a `const` would be in its TDZ and throw,
 * while a function declaration is initialized before evaluation starts. The
 * members are attached below and only ever read at call time.
 */
export function codexRuntime() {
  throw new Error('codexRuntime is a runtime adapter object, not a function.');
}
codexRuntime.run = (command, options, writer, context) => queryCodex(command, options, writer, context);
codexRuntime.abort = (sessionId) => abortCodexSession(sessionId);

export {
  queryCodex,
  injectCodexMessage,
  abortCodexSession,
  isCodexSessionActive,
  getActiveCodexSessions,
  isCodexUsageLimitError,
  pickCodexLimitReset,
  __resetCodexRateLimits,
};
