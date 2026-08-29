/**
 * OpenCode runtime adapter — the registry-facing surface over `server/opencode-cli.js`
 * (interactive server turns with mid-turn steering, CLI helpers, lock retries,
 * recap and task continuation). See the Claude adapter for the `run` id conventions.
 */
import {
  spawnOpenCode,
  injectOpenCodeMessage,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
  resolveOpenCodePermissionOptions,
} from '../../../../opencode-cli.js';

/*
 * Declared as a function, not a `const`, on purpose. The registry constructs
 * every provider at module load, and this module sits on an import cycle with
 * it (registry -> opencode.provider -> here -> the impl -> services -> registry).
 * Whichever side is entered first, the other reads this binding while this
 * module is still mid-evaluation: a `const` would be in its TDZ and throw,
 * while a function declaration is initialized before evaluation starts. The
 * members are attached below and only ever read at call time.
 */
export function opencodeRuntime() {
  throw new Error('opencodeRuntime is a runtime adapter object, not a function.');
}
opencodeRuntime.run = (command, options, writer, context) => spawnOpenCode(command, options, writer, context);
opencodeRuntime.abort = (sessionId) => abortOpenCodeSession(sessionId);

export {
  spawnOpenCode,
  injectOpenCodeMessage,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
  resolveOpenCodePermissionOptions,
};
