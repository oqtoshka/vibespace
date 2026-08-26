/**
 * Cursor runtime adapter — the registry-facing surface over `server/cursor-cli.js`.
 * See the Claude adapter for the `run` id conventions.
 */
import {
  spawnCursor,
  abortCursorSession,
  isCursorSessionActive,
  getActiveCursorSessions,
} from '../../../../cursor-cli.js';

/*
 * Declared as a function, not a `const`, on purpose. The registry constructs
 * every provider at module load, and this module sits on an import cycle with
 * it (registry -> cursor.provider -> here -> the impl -> services -> registry).
 * Whichever side is entered first, the other reads this binding while this
 * module is still mid-evaluation: a `const` would be in its TDZ and throw,
 * while a function declaration is initialized before evaluation starts. The
 * members are attached below and only ever read at call time.
 */
export function cursorRuntime() {
  throw new Error('cursorRuntime is a runtime adapter object, not a function.');
}
cursorRuntime.run = (command, options, writer, context) => spawnCursor(command, options, writer, context);
cursorRuntime.abort = (sessionId) => abortCursorSession(sessionId);

export {
  spawnCursor,
  abortCursorSession,
  isCursorSessionActive,
  getActiveCursorSessions,
};
