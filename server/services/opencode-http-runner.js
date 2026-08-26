import { appendImagesInputTag, buildOpenCodePromptAttachments } from '../shared/image-attachments.js';
import { createCompleteMessage, createNormalizedMessage } from '../shared/utils.js';
import { readOpenCodeTokenUsage } from '../shared/opencode-token-usage.js';
import { sendOpenCodeContextUsage } from '../shared/opencode-context.js';
import { providerModelsService } from '../modules/providers/services/provider-models.service.js';
import { sessionsService } from '../modules/providers/services/sessions.service.js';

import { notifyRunFailed, notifyRunStopped } from './notification-orchestrator.js';
import { persistOpenCodeTurn } from './opencode-history-writer.js';
import { ensureOpenCodeServer } from './opencode-server.service.js';

/**
 * Runs one OpenCode turn over the HTTP server instead of `opencode run`.
 *
 * Used only when the message carries an image, because that is the only thing
 * `run` cannot do — see the note on {@link ensureOpenCodeServer}. Everything
 * else still goes down the CLI path, which is the better-worn road.
 *
 * The sessions are the same sessions either way (one opencode.db, one id
 * space), so a conversation can move between the two transports message by
 * message: attach an image and this runs, send plain text next and `run`
 * continues the very same session.
 */

// A turn ends on a `step.ended` that did not stop to call tools — the same
// point at which `opencode run` exits. The server publishes no "and now I am
// done" event after it (`session.idle` exists in the schema but never fires
// for a prompt), so the end is inferred, and inferring it needs a moment of
// quiet: the settle timer is re-armed by every further event and only fires
// once nothing has followed the final step.
const TURN_SETTLE_MS = 1_500;

/**
 * How OpenCode's permission prompts are answered without a human present.
 *
 * `opencode run` has no way to ask, so its behaviour is the contract to match:
 * `--auto` approves anything not explicitly denied, `acceptEdits` allows edits,
 * and plain `run` denies every `ask` rule. `once` rather than `always` because
 * `always` writes a saved permission into the user's own config, which a chat
 * message has no business doing.
 */
function resolvePermissionReply(permissionMode) {
  switch (permissionMode) {
    case 'bypassPermissions':
    case 'acceptEdits':
      return 'once';
    default:
      return 'reject';
  }
}

function resolveAgent(permissionMode) {
  return permissionMode === 'plan' ? 'plan' : undefined;
}

/**
 * Builds the token-budget status out of a `step.ended` payload.
 *
 * The CLI path reads the totals from opencode.db after the process is gone, but
 * a turn that ran over HTTP reaches this point while the row is still being
 * written, so the numbers the event already carries are used instead.
 * Exported for tests only.
 */
export function toTokenBudget(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return null;
  }

  const input = Number(tokens.input || 0);
  const output = Number(tokens.output || 0);
  const reasoning = Number(tokens.reasoning || 0);
  const cacheRead = Number(tokens.cache?.read || 0);
  const cacheWrite = Number(tokens.cache?.write || 0);
  const used = input + output + reasoning + cacheRead + cacheWrite;
  if (used <= 0) {
    return null;
  }

  const inputTokens = input + cacheRead;
  return {
    used,
    inputTokens,
    outputTokens: output,
    breakdown: { input: inputTokens, output },
  };
}

/** Splits `provider/model` into the server's `{providerID, id}` pair. Exported for tests only. */
export function toModelRef(model, variant) {
  if (typeof model !== 'string' || !model.includes('/')) {
    return null;
  }

  const separator = model.indexOf('/');
  const ref = {
    providerID: model.slice(0, separator),
    id: model.slice(separator + 1),
  };
  return variant ? { ...ref, variant } : ref;
}

/** Flattens a tool result's content list into the string the UI renders. */
function flattenToolContent(content, structured) {
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => (entry && typeof entry === 'object' && typeof entry.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text.trim()) {
      return text;
    }
  }
  return structured ?? content ?? '';
}

/**
 * Translates one server event into the `run --format json` shapes the OpenCode
 * normalizer already understands, so both transports render identically.
 *
 * Returns null for everything the CLI path never emitted either — progress
 * chatter, input deltas, model switches — which the UI has no place for.
 *
 * Exported for tests only.
 */
export function translateEvent(type, properties, toolNames) {
  const sessionID = properties.sessionID;
  const timestamp = properties.timestamp;

  switch (type) {
    case 'session.next.text.delta':
      // Deltas only: `text.ended` repeats the whole block, and the client
      // appends every delta it is given, so forwarding both doubles the reply.
      return {
        type: 'text',
        sessionID,
        timestamp,
        id: `${properties.assistantMessageID}:${properties.textID}`,
        part: { text: properties.delta },
      };

    case 'session.next.reasoning.delta':
      return {
        type: 'reasoning',
        sessionID,
        timestamp,
        id: `${properties.assistantMessageID}:${properties.reasoningID}`,
        part: { text: properties.delta },
      };

    case 'session.next.tool.called': {
      // The name arrives with the call and is absent from the result events,
      // so it is kept per callID for the completion to reuse.
      toolNames.set(properties.callID, properties.tool);
      return {
        type: 'tool_use',
        sessionID,
        timestamp,
        id: properties.callID,
        part: {
          tool: properties.tool,
          callID: properties.callID,
          state: { status: 'running', input: properties.input ?? {} },
        },
      };
    }

    case 'session.next.tool.success':
      return {
        type: 'tool_use',
        sessionID,
        timestamp,
        id: properties.callID,
        part: {
          tool: toolNames.get(properties.callID) ?? 'Tool',
          callID: properties.callID,
          state: {
            status: 'completed',
            output: flattenToolContent(properties.content, properties.structured),
          },
        },
      };

    case 'session.next.tool.failed':
      return {
        type: 'tool_use',
        sessionID,
        timestamp,
        id: properties.callID,
        part: {
          tool: toolNames.get(properties.callID) ?? 'Tool',
          callID: properties.callID,
          state: {
            status: 'error',
            error: properties.error ?? flattenToolContent(properties.content, properties.structured),
          },
        },
      };

    case 'session.next.step.ended':
      return { type: 'step_finish', sessionID, timestamp };

    default:
      return null;
  }
}

async function requestJson(server, path, init = {}) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: server.authorization,
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenCode server ${init.method || 'GET'} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }

  if (!text.trim()) {
    return null;
  }

  const parsed = JSON.parse(text);
  // Every payload the server returns is wrapped; unwrapping here keeps the
  // callers reading like the OpenAPI schema they were written against.
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
}

/**
 * Consumes the server's event bus, handing every parsed event to `onEvent`.
 *
 * `/api/event` rather than `/event`: the latter carries only server-level
 * frames (connected, heartbeat) and would wait forever for a turn. The bus is
 * machine-wide, so the caller filters by session.
 */
async function consumeEvents(server, signal, onEvent) {
  const response = await fetch(`${server.baseUrl}/api/event`, {
    headers: { Authorization: server.authorization, Accept: 'text/event-stream' },
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`OpenCode server event stream failed (${response.status})`);
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload) {
          continue;
        }
        try {
          onEvent(JSON.parse(payload));
        } catch {
          // A frame that is not JSON is a keep-alive, not an error.
        }
      }
    }
  }
}

/**
 * Runs an image-bearing OpenCode turn end to end.
 *
 * Matches the CLI runner's contract exactly: one `session_created` for a new
 * session, streamed messages, a token-budget status, exactly one terminal
 * `complete`, one run notification, and a recap unless the turn is the
 * summariser's own.
 */
export async function runOpenCodeHttpTurn(command, options, ws, hooks = {}) {
  const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, permissionMode } = options;
  const workingDir = cwd || projectPath || process.cwd();
  const { registerHandle, releaseHandle, onCompleted } = hooks;

  // A private session runs against the server spawned with the private-variant env (see collectAgentEnv).
  const server = await ensureOpenCodeServer({ private: Boolean(options.private) });
  const { files, passthrough } = await buildOpenCodePromptAttachments(images, workingDir);

  const resolvedModel = await providerModelsService.resolveResumeModel('opencode', sessionId, model);
  const variant = typeof effort === 'string' && effort !== 'default' ? effort : undefined;
  const modelRef = toModelRef(resolvedModel, variant);
  const agent = resolveAgent(permissionMode);

  let activeSessionId = sessionId || null;
  if (activeSessionId) {
    // A session that already exists keeps its own settings until told
    // otherwise, so the picker's current choices are pushed before prompting.
    if (modelRef) {
      await requestJson(server, `/api/session/${activeSessionId}/model`, {
        method: 'POST',
        body: JSON.stringify({ model: modelRef }),
      }).catch((error) => console.warn('[OpenCode] Could not set the session model:', error?.message || error));
    }
    if (agent) {
      await requestJson(server, `/api/session/${activeSessionId}/agent`, {
        method: 'POST',
        body: JSON.stringify({ agent }),
      }).catch((error) => console.warn('[OpenCode] Could not set the session agent:', error?.message || error));
    }
  } else {
    const created = await requestJson(server, '/api/session', {
      method: 'POST',
      body: JSON.stringify({
        ...(modelRef ? { model: modelRef } : {}),
        ...(agent ? { agent } : {}),
        location: { directory: workingDir },
      }),
    });
    activeSessionId = created?.id;
    if (!activeSessionId) {
      throw new Error('OpenCode server did not return a session id');
    }
  }

  ws.setSessionId?.(activeSessionId);
  if (!sessionId) {
    ws.send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: activeSessionId,
      sessionId: activeSessionId,
      provider: 'opencode',
    }));
  }

  const abortController = new AbortController();
  const toolNames = new Map();
  // The turn is transcribed as it streams so it can be written to opencode.db
  // at the end: the server keeps its own copy and shares none of it.
  const transcript = { text: '', tools: [], assistantMessageId: null, startedAt: Date.now() };
  let lastStepTokens = null;
  let settle = null;
  let idleTimer = null;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });

  const finish = (outcome) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    abortController.abort();
    settle?.(outcome);
    settle = null;
  };

  const handle = {
    aborted: false,
    kill: () => {
      handle.aborted = true;
      void requestJson(server, `/api/session/${activeSessionId}/interrupt`, { method: 'POST' })
        .catch((error) => console.warn('[OpenCode] Could not interrupt the session:', error?.message || error));
      // Settled here rather than left to the stream teardown: aborting closes
      // the event stream, so no `session.idle` is ever coming and the turn
      // would otherwise wait on a promise nothing can resolve.
      finish({ ok: false, error: 'OpenCode run was stopped' });
    },
  };
  registerHandle?.(activeSessionId, handle);

  // Set once the turn looks finished, cleared again if the model starts
  // another step. See TURN_SETTLE_MS.
  let turnLooksDone = false;

  const handleEvent = (event) => {
    const type = event?.type;
    // The wire puts the payload under `data`; the OpenAPI document calls the
    // same field `properties`, so both are accepted rather than trusting one.
    const properties = event?.data ?? event?.properties;
    if (!type || !properties || (properties.sessionID && properties.sessionID !== activeSessionId)) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (type === 'permission.v2.asked') {
      const reply = resolvePermissionReply(permissionMode);
      void requestJson(server, `/api/session/${activeSessionId}/permission/${properties.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ reply }),
      }).catch((error) => console.warn('[OpenCode] Could not answer a permission request:', error?.message || error));
      if (reply === 'reject') {
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: `OpenCode asked permission to ${properties.action} and was denied, because this run has no way to ask you. `
            + 'Switch the session to accept edits or bypass permissions to allow it.',
          sessionId: activeSessionId,
          provider: 'opencode',
        }));
      }
      return;
    }

    if (type === 'session.idle') {
      finish({ ok: true });
      return;
    }

    if (type === 'session.error' || type === 'session.next.step.failed') {
      const message = properties.error?.data?.message
        ?? properties.error?.message
        ?? properties.message
        ?? 'OpenCode reported an error';
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: String(message),
        sessionId: activeSessionId,
        provider: 'opencode',
      }));
      finish({ ok: false, error: String(message) });
      return;
    }

    const translated = translateEvent(type, properties, toolNames);
    if (translated) {
      for (const message of sessionsService.normalizeMessage('opencode', translated, activeSessionId)) {
        ws.send(message);
      }
    }

    if (properties.assistantMessageID && !transcript.assistantMessageId) {
      transcript.assistantMessageId = properties.assistantMessageID;
    }
    if (type === 'session.next.text.delta' && typeof properties.delta === 'string') {
      transcript.text += properties.delta;
    }
    if (type === 'session.next.tool.success' || type === 'session.next.tool.failed') {
      transcript.tools.push({
        callId: properties.callID,
        name: toolNames.get(properties.callID) ?? 'Tool',
        input: properties.input,
        output: properties.error ?? flattenToolContent(properties.content, properties.structured),
        isError: type === 'session.next.tool.failed',
      });
    }

    if (type === 'session.next.step.started') {
      // Another step means the previous "ended" was not the end after all.
      turnLooksDone = false;
    } else if (type === 'session.next.step.ended') {
      lastStepTokens = properties.tokens ?? lastStepTokens;
      // `tool-calls` means the model stopped only to run something and will be
      // back; any other reason is the turn coming to rest.
      turnLooksDone = properties.finish !== 'tool-calls';
    }

    if (turnLooksDone) {
      idleTimer = setTimeout(() => finish({ ok: true }), TURN_SETTLE_MS);
      idleTimer.unref?.();
    }
  };

  // Subscribed before the prompt is posted, or the first events would be gone
  // before anybody was listening.
  const streamReady = new Promise((resolve, reject) => {
    void consumeEvents(server, abortController.signal, (event) => {
      resolve();
      handleEvent(event);
    })
      .then(() => resolve())
      .catch((error) => {
        if (abortController.signal.aborted) {
          resolve();
          return;
        }
        reject(error);
        finish({ ok: false, error: error?.message || String(error) });
      });
    // The stream sends nothing until something happens, so waiting for a first
    // event would deadlock; a tick after the request is issued is enough.
    setTimeout(resolve, 250).unref?.();
  });
  await streamReady;

  // Non-image attachments keep the CLI path's arrangement: listed for the agent
  // to open with its own tools, which works for everything but images.
  const text = appendImagesInputTag(command?.trim() || '', passthrough);

  let outcome;
  try {
    await requestJson(server, `/api/session/${activeSessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ prompt: { text, ...(files.length ? { files } : {}) } }),
    });
    outcome = await finished;
  } catch (error) {
    abortController.abort();
    outcome = { ok: false, error: error?.message || String(error) };
    if (!handle.aborted) {
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: outcome.error,
        sessionId: activeSessionId,
        provider: 'opencode',
      }));
    }
  } finally {
    releaseHandle?.(activeSessionId);
  }

  // Written before the budget is read, because reading it from opencode.db is
  // what this write makes possible.
  persistOpenCodeTurn({
    sessionId: activeSessionId,
    cwd: workingDir,
    providerId: modelRef?.providerID,
    modelId: modelRef?.id,
    agent: agent ?? 'build',
    promptText: command?.trim() || '',
    images,
    assistantMessageId: transcript.assistantMessageId,
    text: transcript.text,
    tools: transcript.tools,
    tokens: lastStepTokens,
    finish: outcome.ok ? 'stop' : 'error',
    startedAt: transcript.startedAt,
  });

  const tokenBudget = readOpenCodeTokenUsage(activeSessionId) ?? toTokenBudget(lastStepTokens);
  if (tokenBudget) {
    ws.send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget,
      sessionId: activeSessionId,
      provider: 'opencode',
    }));
  }

  // The budget above is what the session has *spent*; this is how full the
  // window is. They diverge without limit, because every turn resends the
  // conversation — see readContextOccupancy.
  //
  // Deliberately not awaited: sizing an unknown model's window can cost a
  // `opencode models` spawn, and a gauge is never worth holding a finished
  // turn's `complete` behind. It arrives on its own a moment later.
  void sendOpenCodeContextUsage({
    ws,
    sessionId: activeSessionId,
    modelId: resolvedModel,
    tokens: lastStepTokens,
  });

  // An aborted run already had its terminal `complete` sent on its behalf.
  if (!handle.aborted) {
    ws.send(createCompleteMessage({
      provider: 'opencode',
      sessionId: activeSessionId,
      exitCode: outcome.ok ? 0 : 1,
    }));
  }

  if (outcome.ok) {
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'opencode',
      sessionId: activeSessionId,
      sessionName: sessionSummary,
      stopReason: 'completed',
    });
    if (!options.ephemeral) {
      await onCompleted?.({ sessionId: activeSessionId, cwd: workingDir });
    }
    return;
  }

  notifyRunFailed({
    userId: ws?.userId || null,
    provider: 'opencode',
    sessionId: activeSessionId,
    sessionName: sessionSummary,
    error: outcome.error,
  });
  throw new Error(outcome.error);
}
