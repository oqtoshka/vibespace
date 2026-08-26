/**
 * OpenAI Codex App Server Integration
 * ====================================
 *
 * Codex's TypeScript SDK shells out to a one-shot `codex exec` process. The
 * app-server transport keeps turns loaded, which lets VibeSpace use the native
 * `turn/steer` method for messages sent while Codex is still working.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - injectCodexMessage(sessionId, command, options) - Steer the active turn
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { buildCodexInputItems, normalizeImageDescriptors } from './shared/image-attachments.js';
import { getCodexAppServer } from './services/codex-app-server.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { cancelRateLimitWake, scheduleRateLimitWake } from './services/rate-limit-wake.service.js';
import { scheduleSessionRecap } from './services/session-recap.service.js';
import { recordSessionActivity, recordSessionEnd } from './services/session-restore.service.js';
import { planTaskContinuation } from './services/task-continuation.js';
import { broadcastSessionUpdate } from './modules/providers/index.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { buildCodexTokenBudget, readLatestCodexTokenBudget } from './shared/codex-token-usage.js';
import { toCodexAppServerSandboxPolicy } from './shared/codex-sandbox-policy.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeCodexSessions = new Map();

// Latest account-wide rate-limit snapshot from the app-server
// (`account/rateLimits/updated` is sparse: merge, never replace). Consulted
// when a turn fails on `usageLimitExceeded` to find out when to resume.
let codexRateLimits = null;

function mergeCodexRateLimits(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  codexRateLimits = { ...(codexRateLimits || {}) };
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== null && value !== undefined) codexRateLimits[key] = value;
  }
}

/** Test seam: forget the account-wide snapshot between cases. */
export function __resetCodexRateLimits() {
  codexRateLimits = null;
}

/** Whether a failed turn's error is the usage/rate limit (vs. any other failure). */
export function isCodexUsageLimitError(error) {
  if (!error) return false;
  const info = error.codexErrorInfo;
  if (info === 'usageLimitExceeded') return true;
  if (info && typeof info === 'object' && 'usageLimitExceeded' in info) return true;
  const message = String(error.message || '');
  return /usage limit|rate limit|hit your limit/i.test(message);
}

/**
 * Picks the reset time (epoch seconds, as the app-server reports it) out of a
 * rate-limit snapshot: the latest reset among exhausted windows — when both
 * the 5-hour and weekly windows are spent, the later one gates the resume.
 * Falls back to the window with the highest utilization, or null.
 */
export function pickCodexLimitReset(snapshot) {
  const windows = [snapshot?.primary, snapshot?.secondary]
    .filter((w) => w && typeof w === 'object' && Number.isFinite(Number(w.resetsAt)));
  if (windows.length === 0) return null;
  const exhausted = windows.filter((w) => Number(w.usedPercent) >= 100);
  if (exhausted.length > 0) {
    return Math.max(...exhausted.map((w) => Number(w.resetsAt)));
  }
  const busiest = windows.reduce((a, b) => (Number(b.usedPercent) > Number(a.usedPercent) ? b : a));
  return Number(busiest.resetsAt);
}

function describeCodexLimitType(snapshot) {
  const windows = [['primary', snapshot?.primary], ['secondary', snapshot?.secondary]]
    .filter(([, w]) => w && Number(w.usedPercent) >= 100);
  if (windows.length === 0) return null;
  return windows.map(([name, w]) => (w.windowDurationMins ? `${Math.round(w.windowDurationMins / 60)}h window` : name)).join(' + ');
}

/**
 * Resolves when a usage-limited Codex session may resume. Prefers the live
 * snapshot, then a fresh `account/rateLimits/read` (the failing turn may have
 * been the first signal), then the human message.
 */
async function resolveCodexLimitReset(appServer, error) {
  let resetsAt = pickCodexLimitReset(codexRateLimits);
  if (resetsAt === null && appServer) {
    try {
      const fresh = await appServer.request('account/rateLimits/read', {}, 10_000);
      mergeCodexRateLimits(fresh?.rateLimits);
      resetsAt = pickCodexLimitReset(codexRateLimits);
    } catch (readError) {
      console.warn('[Codex] account/rateLimits/read failed:', readError?.message || readError);
    }
  }
  return {
    resetsAt,
    limitType: describeCodexLimitType(codexRateLimits),
    limitText: String(error?.message || 'usage limit reached'),
  };
}

function readUsageNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCodexTokenBudget(event) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const persistedBudget = buildCodexTokenBudget(info);
  if (persistedBudget) {
    return persistedBudget;
  }

  const usage = event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    // The SDK aggregates every model call made during a tool-using turn. It is
    // spend, not context occupancy, so it must never drive a percentage.
    total: 0,
    sessionTotalTokens: used,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Transform an app-server item into the live-event shape already understood by
 * the Codex session adapter.
 * @param {object} item - app-server ThreadItem
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexItem(item) {
  switch (item?.type) {
    case 'agentMessage':
      return {
        type: 'item',
        itemType: 'agent_message',
        uuid: item.id,
        message: { role: 'assistant', content: item.text },
      };
    case 'reasoning':
      return {
        type: 'item',
        itemType: 'reasoning',
        uuid: item.id,
        message: {
          role: 'assistant',
          content: [...(item.summary || []), ...(item.content || [])].join('\n'),
          isReasoning: true,
        },
      };
    case 'commandExecution':
      return {
        type: 'item',
        itemType: 'command_execution',
        uuid: item.id,
        command: item.command,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        status: item.status,
      };
    case 'fileChange':
      return {
        type: 'item',
        itemType: 'file_change',
        uuid: item.id,
        changes: item.changes,
        status: item.status,
      };
    case 'mcpToolCall':
      return {
        type: 'item',
        itemType: 'mcp_tool_call',
        uuid: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      };
    case 'webSearch':
      return { type: 'item', itemType: 'web_search', uuid: item.id, query: item.query };
    default:
      return null;
  }
}

const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never'];

/**
 * Read a deployment-wide override for one of the Codex thread options.
 * An unrecognised value is ignored rather than passed on — the SDK would reject
 * it and take the whole session down with it.
 * @param {string} name - environment variable to read
 * @param {string[]} allowed - values the Codex SDK accepts
 * @returns {string|null}
 */
function readCodexOptionOverride(name, allowed) {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }

  if (!allowed.includes(value)) {
    console.warn(`[Codex] Ignoring ${name}="${value}" — expected one of: ${allowed.join(', ')}`);
    return null;
  }

  return value;
}

/**
 * Map permission mode to Codex SDK options
 *
 * VS_CODEX_SANDBOX / VS_CODEX_APPROVAL pin the result regardless of the mode the
 * user picked. That exists for containerised deployments, where codex's own
 * sandbox cannot run at all: bubblewrap needs an unprivileged user namespace, and
 * Docker's default seccomp profile denies CLONE_NEWUSER, so every command under
 * `workspace-write` dies with "bwrap: No permissions to create a new namespace"
 * and only `danger-full-access` gets any work done. The container is already the
 * isolation boundary there, so the sandbox being lost is a sandbox nested inside
 * a sandbox. Unset — the default — nothing changes.
 *
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  const options = (() => {
    switch (permissionMode) {
      case 'acceptEdits':
        return {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'never'
        };
      case 'bypassPermissions':
        return {
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never'
        };
      case 'default':
      default:
        return {
          sandboxMode: 'workspace-write',
          approvalPolicy: 'untrusted'
        };
    }
  })();

  return {
    sandboxMode: readCodexOptionOverride('VS_CODEX_SANDBOX', CODEX_SANDBOX_MODES) ?? options.sandboxMode,
    approvalPolicy: readCodexOptionOverride('VS_CODEX_APPROVAL', CODEX_APPROVAL_POLICIES) ?? options.approvalPolicy
  };
}

function toAppServerInput(command, images, workingDirectory) {
  if (normalizeImageDescriptors(images).length === 0) {
    return [{ type: 'text', text: command }];
  }

  return buildCodexInputItems(command, images, workingDirectory).map((item) => (
    item.type === 'local_image'
      ? { type: 'localImage', path: item.path }
      : item
  ));
}

function toAppServerTokenBudget(tokenUsage) {
  const latest = tokenUsage?.last;
  const cumulative = tokenUsage?.total;
  if (!latest || !cumulative) {
    return null;
  }

  const used = readUsageNumber(latest.totalTokens);
  const inputTokens = readUsageNumber(latest.inputTokens);
  const outputTokens = readUsageNumber(latest.outputTokens);
  return {
    used,
    total: readUsageNumber(tokenUsage.modelContextWindow),
    sessionTotalTokens: readUsageNumber(cumulative.totalTokens),
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/** Keep the same final-answer/tool capture Claude uses for stop notifications. */
function captureCodexTurnSummary(session, item) {
  if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
    session.lastAssistantText = item.text.trim();
    return;
  }

  const toolName = (() => {
    switch (item?.type) {
      case 'commandExecution': return 'Bash';
      case 'fileChange': return 'Edit';
      case 'mcpToolCall': return item.tool || 'MCP';
      case 'webSearch': return 'WebSearch';
      default: return null;
    }
  })();
  if (toolName && !session.turnToolNames.includes(toolName)) {
    session.turnToolNames.push(toolName);
  }
}

/**
 * Run the shared title/recap generator after a successful Codex turn.
 *
 * Codex JSONL is not Claude JSONL, so the generator reads the same normalized
 * history the UI renders. Its helper turn is ephemeral at the app-server level
 * and therefore never creates a rollout file or a junk sidebar session.
 */
function queueCodexRecap({ sessionId, cwd, model, ws }) {
  if (!sessionId || !cwd) {
    return;
  }

  scheduleSessionRecap({
    sessionId,
    cwd,
    model,
    useIndexedHistory: true,
    runQuery: (prompt, helperOptions, writer) => queryCodex(prompt, {
      ...helperOptions,
      permissionMode: 'default',
      ephemeral: true,
    }, writer),
    onRecap: (result) => {
      sendMessage(ws, createNormalizedMessage({
        kind: 'status',
        text: 'session_recap',
        sessionRecap: result,
        sessionId: result.sessionId,
        provider: 'codex',
      }));
      broadcastSessionUpdate(result.sessionId);
    },
  });
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    permissionMode = 'default',
    ephemeral = false,
    private: isPrivate = false,
  } = options;

  const resolvedModel = await providerModelsService.resolveResumeModel(
    'codex',
    sessionId,
    model,
  );

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  // app-server removed the legacy `on-failure` spelling from its wire schema;
  // `on-request` is the closest supported interactive policy.
  const appServerApprovalPolicy = approvalPolicy === 'on-failure' ? 'on-request' : approvalPolicy;
  const catalog = (await providerModelsService.getProviderModels('codex')).models;
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;

  let capturedSessionId = sessionId;
  let terminalFailure = null;
  let unsubscribe = null;

  // A new turn supersedes a pending usage-limit wake (the wake consumes its
  // own entry before enqueueing; a re-hit below re-records).
  if (sessionId && !ephemeral) {
    cancelRateLimitWake(sessionId).catch(() => {});
  }

  try {
    // A private session is hosted by the app-server spawned with the private-variant env (see collectAgentEnv),
    // so the presence reporter's hooks exit before reading anything about it.
    // Ephemeral title/recap helpers have no user, rollout, or viewer and must
    // never appear as empty presence-board sessions. Host them on the same
    // private-variant app-server variant private sessions use.
    const appServer = await getCodexAppServer({ private: isPrivate || ephemeral });
    const threadOptions = {
      cwd: workingDirectory,
      model: resolvedModel,
      sandbox: sandboxMode,
      approvalPolicy: appServerApprovalPolicy,
    };
    const threadResponse = sessionId
      ? await appServer.request('thread/resume', { threadId: sessionId, ...threadOptions })
      : await appServer.request('thread/start', { ...threadOptions, ephemeral });
    capturedSessionId = threadResponse?.thread?.id || sessionId || null;
    if (!capturedSessionId) {
      throw new Error('Codex app-server did not return a thread id');
    }

    ws.setSessionId?.(capturedSessionId);
    if (!sessionId && !ephemeral) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'codex',
      }));
    }

    let resolveTurnReady;
    const turnReady = new Promise((resolve) => { resolveTurnReady = resolve; });
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const activeSession = {
      appServer,
      writer: ws,
      status: 'running',
      turnId: null,
      turnReady,
      resolveTurnReady,
      pendingSteers: new Map(),
      deliverSteer(messageId) {
        const pending = this.pendingSteers.get(messageId);
        if (!pending) {
          return;
        }
        this.pendingSteers.delete(messageId);
        sendMessage(this.writer, createNormalizedMessage({
          id: messageId,
          kind: 'text',
          role: 'user',
          content: pending.command,
          images: normalizeImageDescriptors(pending.images).length > 0 ? pending.images : undefined,
          sessionId: capturedSessionId,
          provider: 'codex',
        }));
        pending.onDelivered?.();
      },
      tokenBudget: null,
      lastAssistantText: '',
      turnToolNames: [],
      startedAt: new Date().toISOString(),
    };
    activeCodexSessions.set(capturedSessionId, activeSession);
    if (!ephemeral) {
      recordSessionActivity({
        provider: 'codex',
        sessionId: capturedSessionId,
        cwd: workingDirectory,
        permissionMode,
        userId: ws?.userId || null,
        private: Boolean(isPrivate),
        turnActive: true,
      }).catch(() => {});
    }

    unsubscribe = appServer.subscribe((method, params) => {
      if (method === 'transport/closed') {
        rejectCompletion(params.error || new Error('Codex app-server closed'));
        return;
      }
      // Account-wide, not thread-scoped — keep it ahead of the thread filter.
      if (method === 'account/rateLimits/updated') {
        mergeCodexRateLimits(params.rateLimits);
        return;
      }
      if (params.threadId !== capturedSessionId) {
        return;
      }

      const eventTurnId = params.turnId || params.turn?.id || null;
      if (method === 'turn/started' && eventTurnId) {
        activeSession.turnId = eventTurnId;
        activeSession.resolveTurnReady(eventTurnId);
        return;
      }
      if (activeSession.turnId && eventTurnId && eventTurnId !== activeSession.turnId) {
        return;
      }

      if ((method === 'item/started' || method === 'item/completed') && params.item?.type === 'userMessage') {
        activeSession.deliverSteer(params.item.clientId);
        return;
      }

      if (method === 'item/completed') {
        captureCodexTurnSummary(activeSession, params.item);
        const transformed = transformCodexItem(params.item);
        if (!transformed) {
          return;
        }
        const normalized = sessionsService.normalizeMessage('codex', transformed, capturedSessionId);
        for (const message of normalized) {
          sendMessage(ws, message);
        }
        return;
      }

      if (method === 'thread/tokenUsage/updated') {
        activeSession.tokenBudget = toAppServerTokenBudget(params.tokenUsage);
        return;
      }

      if (method === 'turn/completed') {
        resolveCompletion(params.turn || { id: eventTurnId, status: 'completed' });
      }
    });

    const turnResponse = await appServer.request('turn/start', {
      threadId: capturedSessionId,
      input: toAppServerInput(command, images, workingDirectory),
      cwd: workingDirectory,
      model: resolvedModel,
      effort: resolvedEffort,
      approvalPolicy: appServerApprovalPolicy,
      // turn/start is the authoritative per-turn override. thread/resume's
      // legacy `sandbox` string does not carry through here, so omitting this
      // silently turned Bypass Permissions into workspace-write after restart.
      sandboxPolicy: toCodexAppServerSandboxPolicy(sandboxMode),
    });
    activeSession.turnId = turnResponse?.turn?.id || activeSession.turnId;
    activeSession.resolveTurnReady(activeSession.turnId);

    const completedTurn = await completion;
    if (completedTurn?.status !== 'completed' && activeSession.status !== 'aborted') {
      terminalFailure = completedTurn.error || new Error('Codex turn failed');
      if (!ephemeral && isCodexUsageLimitError(terminalFailure)) {
        // Not a failure the user can act on — the work resumes by itself once
        // the limit resets. The wake service sends the "paused" ping.
        const { resetsAt, limitType, limitText } = await resolveCodexLimitReset(appServer, terminalFailure);
        await scheduleRateLimitWake({
          provider: 'codex',
          providerSessionId: capturedSessionId,
          userId: ws?.userId || null,
          sessionName: sessionSummary,
          resetsAt,
          limitType,
          limitText,
          permissionMode,
        });
      } else {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId,
          sessionName: sessionSummary,
          error: terminalFailure,
        });
      }
    }

    const tokenBudget = activeSession.tokenBudget
      || (!ephemeral ? await readLatestCodexTokenBudget(capturedSessionId) : null)
      || extractCodexTokenBudget({ usage: completedTurn?.usage });
    if (tokenBudget) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'status',
        text: 'token_budget',
        tokenBudget,
        sessionId: capturedSessionId,
        provider: 'codex',
      }));
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runSession = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const runAborted = runSession?.status === 'aborted';
    if (!terminalFailure && !runAborted && !ephemeral) {
      const continuation = planTaskContinuation({
        provider: 'codex',
        sessionId: capturedSessionId,
        userId: ws?.userId || null,
        sessionName: sessionSummary,
      });
      if (continuation) {
        // This turn is over, so stop its listener before the resumed turn
        // installs its own. Withhold the terminal `complete` and recap until
        // the plan closes or the continuation service reaches its bound.
        unsubscribe?.();
        unsubscribe = null;
        activeSession.status = 'completed';
        sendMessage(ws, createNormalizedMessage({
          kind: 'status',
          text: 'Resuming — open tasks remain',
          sessionId: capturedSessionId,
          provider: 'codex',
        }));
        await queryCodex(continuation, {
          ...options,
          sessionId: capturedSessionId,
          images: undefined,
        }, ws);
        return;
      }
    }
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure && !ephemeral) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed',
          recap: activeSession.lastAssistantText,
          toolNames: activeSession.turnToolNames,
        });
        queueCodexRecap({
          sessionId: capturedSessionId || sessionId || null,
          cwd: workingDirectory,
          model: resolvedModel,
          ws,
        });
      }
    }

  } catch (error) {
    const session = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      String(error?.message || '').toLowerCase().includes('interrupted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // Check if Codex SDK is available for a clearer error message
      const installed = await providerAuthService.isProviderInstalled('codex');
      const errorContent = !installed
        ? 'Codex CLI is not configured. Please set up authentication first.'
        : error.message;

      sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure && !ephemeral) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    unsubscribe?.();
    // Update session status
    if (capturedSessionId) {
      const session = activeCodexSessions.get(capturedSessionId);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
    if (capturedSessionId && !ephemeral) {
      const session = activeCodexSessions.get(capturedSessionId);
      if (session?.status === 'aborted') {
        recordSessionEnd(capturedSessionId).catch(() => {});
      } else {
        recordSessionActivity({
          provider: 'codex',
          sessionId: capturedSessionId,
          cwd: workingDirectory,
          permissionMode,
          userId: ws?.userId || null,
          private: Boolean(isPrivate),
          turnActive: false,
        }).catch(() => {});
      }
    }
  }
}

/**
 * Adds a user message to Codex's currently running turn.
 *
 * `turn/steer` accepts the message atomically. Once accepted it is no longer a
 * separately cancellable queue entry, so the shared queue card is removed and
 * replaced with a normal live user bubble immediately.
 */
export async function injectCodexMessage(sessionId, command, options = {}) {
  const session = activeCodexSessions.get(sessionId);
  if (!session || session.status !== 'running') {
    return null;
  }

  const turnId = session.turnId || await session.turnReady;
  if (!turnId || session.status !== 'running') {
    return null;
  }

  const messageId = options.clientUserMessageId
    || `codex_steer_${Date.now()}_${Math.round(Math.random() * 1e9).toString(36)}`;
  const workingDirectory = options.cwd || options.projectPath || process.cwd();
  session.pendingSteers.set(messageId, {
    command,
    images: options.images,
    onDelivered: options.onDelivered,
  });
  try {
    await session.appServer.request('turn/steer', {
      threadId: sessionId,
      expectedTurnId: turnId,
      clientUserMessageId: messageId,
      input: toAppServerInput(command, options.images, workingDirectory),
    });
    // Current app-server emits a userMessage item before subsequent agent
    // output. Keep this fallback for older compatible runtimes that accept the
    // steer but omit that lifecycle event.
    session.deliverSteer(messageId);
  } catch (error) {
    session.pendingSteers.delete(messageId);
    throw error;
  }
  return messageId;
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export async function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session || session.status !== 'running' || !session.turnId) {
    return false;
  }

  session.status = 'aborted';
  recordSessionEnd(sessionId).catch(() => {});
  try {
    await session.appServer.request('turn/interrupt', {
      threadId: sessionId,
      turnId: session.turnId,
    });
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
const completedSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
completedSessionCleanupTimer.unref?.();
