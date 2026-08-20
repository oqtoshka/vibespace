import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { appendImagesInputTag, normalizeImageDescriptors } from './shared/image-attachments.js';
import { readOpenCodeTokenUsage } from './shared/opencode-token-usage.js';
import { buildAgentEnv } from './shared/agent-env.js';
import { sendOpenCodeContextUsage } from './shared/opencode-context.js';
import { runOpenCodeHttpTurn } from './services/opencode-http-runner.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { planTaskContinuation } from './services/task-continuation.js';
import { scheduleSessionRecap } from './services/session-recap.service.js';
import { broadcastSessionUpdate } from './modules/providers/index.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell, getOpenCodeHelperWorkspace, isDatabaseLockedError, stripAnsi } from './shared/utils.js';

// Every `opencode` process on this machine writes to one WAL database, so a
// second run — or a terminal opencode, or this server's own catalog probe —
// can hold the lock past opencode's 5 s busy_timeout and the run dies at init
// with nothing sent. The message alone reads like corruption; it is not.
const OPEN_CODE_DATABASE_LOCKED_HINT = 'Another opencode process was writing to opencode.db and did not let go in time. '
  + 'Nothing was lost and nothing is corrupt — send the message again.';
// One retry. The lock is held by a writer that is finishing something short (a
// prune, a WAL checkpoint); if a second attempt a second later still loses, the
// holder is wedged and retrying harder only delays telling the user.
const OPEN_CODE_DATABASE_LOCKED_RETRIES = 1;
const OPEN_CODE_DATABASE_LOCKED_RETRY_DELAY_MS = 1_000;

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

const activeOpenCodeProcesses = new Map();

/**
 * Maps the UI permission mode onto OpenCode's non-interactive controls.
 *
 * OpenCode has no single "permission mode" flag; each mode uses a different
 * lever of the `opencode run` CLI (verified against v1.17.13):
 * - plan              → the built-in read-only `plan` agent (`--agent plan`).
 * - bypassPermissions → `--auto`, which auto-approves every permission that
 *                       is not explicitly denied in the user's config.
 * - acceptEdits       → the OPENCODE_PERMISSION env var, whose JSON body the
 *                       CLI merges into its permission config. Forcing
 *                       `edit: allow` guarantees file edits go through while
 *                       every other rule stays under the user's own config.
 * - default           → nothing; the user's opencode.json governs. In
 *                       non-interactive `run` mode any `ask` rule is denied.
 *
 * Exported for tests only.
 */
export function resolveOpenCodePermissionOptions(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return { args: ['--agent', 'plan'], env: {} };
    case 'bypassPermissions':
      return { args: ['--auto'], env: {} };
    case 'acceptEdits':
      return { args: [], env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow' }) } };
    default:
      return { args: [], env: {} };
  }
}

function resolveOpenCodeEffort(model, effort, modelsDefinition) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function readOpenCodeSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.sessionID || event.sessionId || null;
}

/**
 * Runs one throwaway OpenCode turn on behalf of the background title/recap
 * summariser.
 *
 * OpenCode has no stateless completion mode — `run` always writes a session to
 * opencode.db — and that whole store is imported into the sidebar, so a recap
 * left to its own devices would add one junk session per generation. The
 * helper's session is therefore deleted again as soon as the answer is in.
 *
 * `--agent plan` is the read-only agent, which is all a summariser needs; it
 * takes the place of the tool deny-list the Claude path passes.
 *
 * It deliberately does NOT run in the conversation's own directory: the store
 * importer binds an unrecognised provider id to the newest unmapped app row of
 * the same project, so a helper started while a brand-new chat was still
 * waiting for its own id would be adopted by that chat — and the cleanup below
 * would then delete the user's session along with the helper's.
 */
async function runOpenCodeRecapQuery(prompt, options, writer) {
  const workspace = getOpenCodeHelperWorkspace();
  await mkdir(workspace, { recursive: true });

  let helperSessionId = null;
  const capturingWriter = {
    userId: null,
    send: (message) => {
      if (message?.kind === 'session_created' && message.newSessionId) {
        helperSessionId = message.newSessionId;
      }
      writer.send(message);
    },
    setSessionId: (sessionId) => {
      helperSessionId = sessionId;
    },
  };

  try {
    await spawnOpenCode(prompt, {
      cwd: workspace,
      model: options.model,
      permissionMode: 'plan',
      ephemeral: true,
    }, capturingWriter);
  } finally {
    if (helperSessionId) {
      await sessionsService.discardProviderSession('opencode', helperSessionId).catch((error) => {
        console.warn('[OpenCode] Could not discard the recap helper session:', error?.message || error);
      });
    }
  }
}

/**
 * Queues the background title/recap refresh for a finished OpenCode turn.
 *
 * The model is the session's own current one, resolved here rather than inside
 * the service: OpenCode has no cheap tier to fall back on the way Claude has
 * haiku, so the only model known to be reachable is the one the conversation
 * is already running on.
 */
async function queueOpenCodeRecap({ sessionId, cwd, ws }) {
  if (!sessionId || !cwd) {
    return;
  }

  let model;
  try {
    ({ model } = await providerModelsService.resolveSessionActiveModel('opencode', sessionId));
  } catch (error) {
    console.warn('[OpenCode] Could not resolve the recap model:', error?.message || error);
    return;
  }

  scheduleSessionRecap({
    sessionId,
    cwd,
    model,
    runQuery: runOpenCodeRecapQuery,
    onRecap: (result) => {
      // The turn is long over by now, so this rides the run's writer only if it
      // is still attached; a closed one is not an error.
      try {
        ws?.send?.(createNormalizedMessage({
          kind: 'status',
          text: 'session_recap',
          sessionRecap: result,
          sessionId: result.sessionId,
          provider: 'opencode',
        }));
      } catch {
        // Client gone — the recap is in the database either way.
      }
      // Everyone else hears about it through the same per-session delta the
      // transcript watcher uses; a recap is a database write with no file
      // change behind it, so without this nothing would ever be told.
      broadcastSessionUpdate(result.sessionId);
    },
  });
}

async function spawnOpenCode(command, options = {}, ws) {
  // Rewind / edit-and-resend: truncate this session's history at the edited
  // message before resuming, so `opencode run --session <id>` continues in-place
  // from that point. If nothing resumable precedes the edit, run as a new session.
  if (options.rewind && options.sessionId) {
    try {
      abortOpenCodeSession(options.sessionId);
      const result = await sessionsService.rewindHistory(options.sessionId, options.rewind);
      if (result.startFresh || !result.ok) {
        options = { ...options, sessionId: undefined, resume: false };
      }
    } catch (error) {
      console.error('[OpenCode] rewind failed:', error?.message || error);
    }
    options = { ...options, rewind: undefined };
  }

  // Images are the one thing `opencode run` cannot carry: its read tool returns
  // them inside a tool *result*, which an OpenAI-compatible transport flattens
  // to text, and `--file` labels every attachment text/plain (upstream
  // anomalyco/opencode#16723). The HTTP server takes an image as a part of the
  // user message, which is the shape vision models actually read — so a turn
  // with an image goes that way and every other turn stays on the CLI.
  if (normalizeImageDescriptors(options.images).length > 0) {
    return runOpenCodeHttpTurn(command, options, ws, {
      registerHandle: (sessionId, handle) => activeOpenCodeProcesses.set(sessionId, handle),
      releaseHandle: (sessionId) => activeOpenCodeProcesses.delete(sessionId),
      onCompleted: ({ sessionId, cwd }) => queueOpenCodeRecap({ sessionId, cwd, ws }),
    });
  }

  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, permissionMode } = options;
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = sessionId || null;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let opencodeProcess = null;
    // Unified lifecycle contract: exactly one terminal `complete` per run
    // (close and error handlers can both fire for spawn failures).
    let completeSent = false;
    // Set as soon as the CLI writes anything at all. A run that dies before
    // this is a run that never reached the model, so re-running it repeats
    // nothing — no tool ran, no tokens were spent, no history was appended.
    let producedOutput = false;
    // opencode reports a failure in several writes — the red `Error: ` header,
    // then a blank line, then the detail — and a busy reader gets them as
    // separate `data` events. Judged one at a time, the header alone does not
    // look like the lock error it belongs to, so it reached the browser as a
    // bare "Error: Unexpected error" while the detail was held and the retry
    // quietly succeeded. The attempt's stderr is classified once, whole, when
    // the process has finished writing it. The lock error is withheld while a
    // retry is still possible; showing it and then succeeding is worse than
    // showing nothing.
    let stderrBuffer = '';
    let lockRetriesLeft = OPEN_CODE_DATABASE_LOCKED_RETRIES;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'opencode',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `OpenCode CLI exited with code ${code}`,
      });
    };

    // Everything the CLI writes to stderr becomes an error bubble. A lock
    // error carries the hint: on its own the message reads like a corrupt
    // database, which is the one thing it never means.
    const sendStderr = (text, forSessionId) => {
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: isDatabaseLockedError(text)
          ? `${text.trim()}\n\n${OPEN_CODE_DATABASE_LOCKED_HINT}`
          : text,
        sessionId: forSessionId,
        provider: 'opencode',
      }));
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      if (processKey !== capturedSessionId && opencodeProcess) {
        activeOpenCodeProcesses.delete(processKey);
        activeOpenCodeProcesses.set(capturedSessionId, opencodeProcess);
      }
      if (opencodeProcess) {
        opencodeProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'opencode',
        }));
      }
    };

    const processOpenCodeOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        return;
      }

      try {
        registerSession(readOpenCodeSessionId(response));
        const normalized = sessionsService.normalizeMessage(
          'opencode',
          response,
          capturedSessionId || sessionId || null,
        );
        for (const msg of normalized) {
          ws.send(msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[OpenCode] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      }
    };

    void providerModelsService.resolveResumeModel('opencode', sessionId, model).then(async (resolvedModel) => {
      let effortModels = null;
      try {
        effortModels = (await providerModelsService.getProviderModels('opencode')).models;
      } catch (error) {
        console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
      }

      const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, effortModels);
      const args = ['run', '--format', 'json'];
      // OpenCode's `run` command owns workspace selection through `--dir`.
      // Relying on the child-process cwd alone is not enough on Linux, where
      // the CLI can still resolve the session under the server install dir.
      args.push('--dir', workingDir);
      if (sessionId) {
        args.push('--session', sessionId);
      }
      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }
      if (resolvedEffort) {
        args.push('--variant', resolvedEffort);
      }
      const permissionOptions = resolveOpenCodePermissionOptions(permissionMode);
      args.push(...permissionOptions.args);
      if (command && command.trim()) {
        // Image attachments ride along as an <images_input> path list appended
        // to the prompt; the session history reader strips the tag back out.
        // opencode is a .cmd shim on Windows, so the whole argument must be
        // newline-free or cmd.exe silently truncates it at the first newline.
        args.push(flattenPromptForWindowsShell(appendImagesInputTag(command.trim(), images)));
      }

      const startAttempt = () => {
        opencodeProcess = spawnFunction('opencode', args, {
          cwd: workingDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildAgentEnv(permissionOptions.env),
        });

        activeOpenCodeProcesses.set(processKey, opencodeProcess);
        opencodeProcess.sessionId = processKey;
        opencodeProcess.stdin.end();

        opencodeProcess.stdout.on('data', (data) => {
          producedOutput = true;
          stdoutLineBuffer += data.toString();
          const completeLines = stdoutLineBuffer.split(/\r?\n/);
          stdoutLineBuffer = completeLines.pop() || '';

          completeLines.forEach((line) => {
            processOpenCodeOutputLine(line.trim());
          });
        });

        opencodeProcess.stderr.on('data', (data) => {
          // OpenCode colours stderr whether or not it is talking to a terminal,
          // so the raw bytes would otherwise reach the browser as escape codes.
          stderrBuffer += stripAnsi(data.toString());
        });

        opencodeProcess.on('close', async (code) => {
          const finalSessionId = capturedSessionId || sessionId || processKey;
          activeOpenCodeProcesses.delete(finalSessionId);
          activeOpenCodeProcesses.delete(processKey);

          const stderrText = stderrBuffer.trim();
          stderrBuffer = '';

          // Lost the race for opencode.db before the run began. Retry it
          // rather than making the user re-send: the failure is another
          // process's write lock, not anything about this request.
          if (
            stderrText
            && lockRetriesLeft > 0
            && isDatabaseLockedError(stderrText)
            && code !== 0
            && !producedOutput
            && !opencodeProcess.aborted
          ) {
            lockRetriesLeft -= 1;
            stdoutLineBuffer = '';
            console.warn('[OpenCode] opencode.db was locked before the run started; retrying once.');
            setTimeout(startAttempt, OPEN_CODE_DATABASE_LOCKED_RETRY_DELAY_MS);
            return;
          }

          if (stderrText) {
            sendStderr(stderrText, finalSessionId);
          }

          if (stdoutLineBuffer.trim()) {
            processOpenCodeOutputLine(stdoutLineBuffer.trim());
            stdoutLineBuffer = '';
          }

          const tokenBudget = readOpenCodeTokenUsage(finalSessionId);
          if (tokenBudget) {
            ws.send(createNormalizedMessage({
              kind: 'status',
              text: 'token_budget',
              tokenBudget,
              sessionId: finalSessionId,
              provider: 'opencode',
            }));
          }

          // What the session has spent, above; how full the window is, here.
          // The turn's own counts are gone with the process, so this reads them
          // back out of the messages `run` just wrote.
          void sendOpenCodeContextUsage({
            ws,
            sessionId: finalSessionId,
            modelId: resolvedModel,
          });

          // Task-ledger continuation: a turn that ended while the session's
          // own todo list still has open items rolls straight into a
          // continuation turn. The `complete` is withheld so the client keeps
          // seeing one running turn; the nested run emits its own terminal
          // messages (and queues the recap) when the chain actually ends.
          // Bounds and bail-outs live in planTaskContinuation.
          if (code === 0 && !completeSent && !opencodeProcess.aborted && !options.ephemeral) {
            const continuation = planTaskContinuation({
              provider: 'opencode',
              sessionId: finalSessionId,
              userId: ws?.userId || null,
              sessionName: sessionSummary,
            });
            if (continuation) {
              ws.send(createNormalizedMessage({
                kind: 'status',
                text: 'Resuming — open tasks remain',
                sessionId: finalSessionId,
                provider: 'opencode',
              }));
              spawnOpenCode(continuation, {
                ...options,
                sessionId: finalSessionId,
                images: undefined,
                rewind: undefined,
              }, ws).then(resolve, reject);
              return;
            }
          }

          // Terminal complete — skipped for aborted runs (abort-session
          // already sent the aborted complete on this run's behalf).
          if (!completeSent && !opencodeProcess.aborted) {
            completeSent = true;
            ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: code }));
          }

          if (code === 0) {
            notifyTerminalState({ code });
            // Skipped for the summariser's own turns, or each recap would
            // schedule another one.
            if (!options.ephemeral) {
              void queueOpenCodeRecap({ sessionId: finalSessionId, cwd: workingDir, ws });
            }
            resolve();
            return;
          }

          if (code === 127 || code === null) {
            const installed = await providerAuthService.isProviderInstalled('opencode');
            if (!installed) {
              ws.send(createNormalizedMessage({
                kind: 'error',
                content: 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/',
                sessionId: finalSessionId,
                provider: 'opencode',
              }));
            }
          }

          notifyTerminalState({ code });
          reject(new Error(code === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${code}`));
        });

        opencodeProcess.on('error', async (error) => {
          const finalSessionId = capturedSessionId || sessionId || processKey;
          activeOpenCodeProcesses.delete(finalSessionId);
          activeOpenCodeProcesses.delete(processKey);

          const installed = await providerAuthService.isProviderInstalled('opencode');
          const errorContent = !installed
            ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
            : error.message;

          ws.send(createNormalizedMessage({
            kind: 'error',
            content: errorContent,
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
          if (!completeSent && !opencodeProcess.aborted) {
            completeSent = true;
            ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: 1 }));
          }
          notifyTerminalState({ error });
          reject(error);
        });
      };

      startAttempt();
    }).catch(reject);
  });
}

function abortOpenCodeSession(sessionId) {
  const process = activeOpenCodeProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  // The abort handler sends the terminal complete (aborted: true); flag the
  // process so its close handler does not emit a second one.
  process.aborted = true;
  process.kill('SIGTERM');
  activeOpenCodeProcesses.delete(sessionId);
  return true;
}

function isOpenCodeSessionActive(sessionId) {
  return activeOpenCodeProcesses.has(sessionId);
}

function getActiveOpenCodeSessions() {
  return Array.from(activeOpenCodeProcesses.keys());
}

export {
  spawnOpenCode,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
};
