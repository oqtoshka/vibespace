/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 * - Persistent, cross-turn sessions so background jobs (run_in_background) survive
 *   past the turn that launched them and auto-resume the agent on completion
 *   (mirrors the Claude Code CLI harness).
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

// Indirection so tests can substitute a scripted SDK query. Defaults to the
// real `query` from @anthropic-ai/claude-agent-sdk.
let queryImpl = query;
function __setClaudeQueryImpl(fn) {
  queryImpl = fn || query;
}

// Indirection so tests can substitute the transcript-truncation step without a
// real session database. Defaults to the provider-backed implementation.
let rewindHistoryImpl = (sessionId, messageUuid) => sessionsService.rewindHistory(sessionId, messageUuid);
function __setRewindHistoryImpl(fn) {
  rewindHistoryImpl = fn || ((sessionId, messageUuid) => sessionsService.rewindHistory(sessionId, messageUuid));
}

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}
// A persistent session with no active turn and no running background jobs is
// torn down after this idle window. While a background job is running the
// session is kept alive regardless (the job's completion auto-resumes it).
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MS, 10) || 5 * 60 * 1000;
// Hard cap so a wedged background job (or a never-completing monitor) can't leak
// a Claude subprocess forever.
const SESSION_MAX_LIFETIME_MS = parseInt(process.env.CLAUDE_SESSION_MAX_LIFETIME_MS, 10) || 2 * 60 * 60 * 1000;

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

/**
 * Cancels every pending tool-approval prompt belonging to a session.
 *
 * When a turn is parked awaiting an interactive permission decision (e.g. the
 * ExitPlanMode prompt at the end of plan mode), `interrupt()` alone does not
 * unblock it — the `canUseTool` callback is awaiting our own promise, not the
 * subprocess. Resolving those promises as cancelled lets the callback return
 * and the query unwind, so the child process can actually exit instead of
 * lingering as an orphan editing the working tree.
 * @param {string} sessionId
 * @returns {number} count of approvals cancelled
 */
function cancelPendingApprovalsForSession(sessionId) {
  let cancelled = 0;
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      // finalize() deletes the entry from the map and settles the awaiting
      // promise with a cancelled decision (canUseTool then returns deny).
      resolver({ cancelled: true });
      cancelled += 1;
    }
  }
  return cancelled;
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const content = await buildClaudeUserContent(command, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    };
  })();
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistent streaming sessions
//
// A Claude session is driven by a single long-lived `query()` running in
// streaming-input mode: we feed user turns into an async-iterable prompt and
// keep it open across turns. This is what lets `run_in_background` jobs outlive
// the turn that launched them — the SDK runtime subprocess stays alive — and
// lets us auto-resume the agent when a job finishes (mirroring the CLI harness).
// ---------------------------------------------------------------------------

/**
 * Creates a pushable async-iterable used as the streaming `prompt`. Each pushed
 * SDKUserMessage starts (or is queued behind) an assistant turn; `close()` ends
 * the stream, after which the SDK finishes the current turn and the query ends.
 */
function createInputController() {
  const queue = [];
  let resolveNext = null;
  let closed = false;

  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const iterator = (async function* () {
    while (true) {
      if (queue.length === 0) {
        if (closed) return;
        await new Promise((resolve) => { resolveNext = resolve; });
        if (queue.length === 0 && closed) return;
      }
      yield queue.shift();
    }
  })();

  return {
    iterator,
    push(message) {
      if (closed) return false;
      queue.push(message);
      wake();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      wake();
    },
    get closed() { return closed; }
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Marks the start of an awaitable turn. Callers of queryClaudeSDK await the
 * returned promise, which resolves when this turn produces its `result` (or the
 * session ends) — so one-shot callers (commit-message/agent flows) still block
 * until the agent's response is complete, even though the session lives on.
 */
function beginTurn(session) {
  if (session.currentTurn) {
    session.currentTurn.resolve();
  }
  session.awaitingResult = true;
  session.currentTurn = createDeferred();
  return session.currentTurn.promise;
}

function completeTurn(session) {
  if (session.currentTurn) {
    const deferred = session.currentTurn;
    session.currentTurn = null;
    deferred.resolve();
  }
}

/** Build an SDKUserMessage for the streaming input. */
function makeUserMessage(content) {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

/**
 * Renders a background-task completion as the synthetic user turn we inject to
 * wake the agent — byte-for-byte the shape the Claude Code harness uses, so the
 * model treats it as a system event and not a user instruction.
 */
function buildTaskNotificationMessage(notification) {
  const lines = [
    '[SYSTEM NOTIFICATION - NOT USER INPUT]',
    'This is an automated background-task event, NOT a message from the user.',
    'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.',
    '',
    '<task-notification>',
    `<task-id>${notification.task_id}</task-id>`,
  ];
  if (notification.tool_use_id) {
    lines.push(`<tool-use-id>${notification.tool_use_id}</tool-use-id>`);
  }
  if (notification.output_file) {
    lines.push(`<output-file>${notification.output_file}</output-file>`);
  }
  lines.push(`<status>${notification.status || 'completed'}</status>`);
  if (notification.summary) {
    lines.push(`<summary>${notification.summary}</summary>`);
  }
  lines.push('</task-notification>');
  return lines.join('\n');
}

function clearIdleTimer(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

/** Register/replace a session under its (now known) session id. */
function registerSession(sessionId, session) {
  session.sessionId = sessionId;
  activeSessions.set(sessionId, session);
}

/**
 * Tears a session down: stop timers, interrupt any active turn, and close the
 * input stream so the query ends and the loop's `finally` cleans up.
 */
function endSession(session, reason = 'ended') {
  if (session.ended) return;
  session.ended = true;
  console.log(`[claude bg] ending session ${session.sessionId || '(pending)'} (${reason})`);
  clearIdleTimer(session);
  if (session.maxLifetimeTimer) {
    clearTimeout(session.maxLifetimeTimer);
    session.maxLifetimeTimer = null;
  }
  try { session.input.close(); } catch { /* noop */ }
  if (session.turnActive && session.instance?.interrupt) {
    session.instance.interrupt().catch((err) => {
      console.warn(`interrupt() during endSession for ${session.sessionId} rejected:`, err?.message || err);
    });
  }
  completeTurn(session);
}

/**
 * Arms the idle teardown timer. Called whenever a turn ends with no background
 * jobs outstanding; cleared as soon as new work (a user turn or a job) arrives.
 */
function armIdleTimer(session) {
  clearIdleTimer(session);
  session.idleTimer = setTimeout(() => {
    if (session.pendingTasks.size > 0) {
      // A job slipped in between the result and this firing — keep alive.
      return;
    }
    endSession(session, 'idle-timeout');
  }, SESSION_IDLE_TIMEOUT_MS);
  // Don't let an idle session keep the process alive / block shutdown.
  session.idleTimer.unref?.();
}

/**
 * Handles the task-lifecycle system messages that drive background-job
 * persistence and auto-resume.
 */
function handleTaskMessage(session, message) {
  if (!message || message.type !== 'system') return;

  if (message.subtype === 'task_started' && message.task_id) {
    // `background` is set true once the task survives a turn boundary (see
    // onTurnEnd). Foreground subagents complete before their parent turn ends,
    // so they never get marked and never trigger a (spurious) auto-resume.
    session.pendingTasks.set(message.task_id, {
      description: message.description || '',
      background: false,
    });
    clearIdleTimer(session);
    return;
  }

  if (message.subtype === 'task_notification' && message.task_id) {
    const task = session.pendingTasks.get(message.task_id);
    session.pendingTasks.delete(message.task_id);

    // Inject (auto-resume) only for genuine background jobs: either the task
    // outlived a turn (marked background), or it completed while no turn was
    // running (which a foreground subagent never does).
    const isBackground = (task && task.background) || session.turnActive === false;
    if (isBackground && !session.ended && !session.input.closed) {
      const text = buildTaskNotificationMessage(message);
      if (!session.turnActive) {
        session.turnActive = true;
        session.turnStartTime = Date.now();
      }
      // A resume turn will run for this injection — make sure it settles even if
      // it produces only a result (the loop also re-arms this on assistant output).
      session.awaitingResult = true;
      clearIdleTimer(session);
      console.log(`[claude bg] session ${session.sessionId}: background task ${message.task_id} ${message.status || 'completed'} — auto-resuming agent`);
      session.input.push(makeUserMessage(text));
    }
    return;
  }

  if (message.subtype === 'task_updated' && message.task_id && message.patch?.status) {
    const terminal = ['completed', 'failed', 'killed'].includes(message.patch.status);
    if (terminal && !session.pendingTasks.has(message.task_id)) {
      // Already reconciled by a task_notification; nothing to do.
      return;
    }
  }
}

/**
 * Settles the current assistant turn — once. Driven by a `result` message
 * (onTurnEnd) and also by abort (which interrupts the turn). `awaitingResult` is
 * the idempotency guard: it is set when a turn starts (a user turn, an injected
 * resume, or any assistant output) and cleared here, so whichever path settles
 * first wins and the other is a no-op. Background jobs are kept running either
 * way — only the model's turn stops.
 * @param {Object} session
 * @param {Object} ws
 * @param {{aborted?: boolean}} opts - when aborted, the ws handler emits the
 *   (aborted) completion, so we don't send our own.
 */
function settleTurn(session, ws, { aborted = false } = {}) {
  if (!session.awaitingResult) return;
  session.awaitingResult = false;
  session.turnActive = false;
  session.turnStartTime = null;

  // Any task still pending after a turn boundary is genuinely backgrounded —
  // mark it so its completion later triggers an auto-resume.
  for (const task of session.pendingTasks.values()) {
    task.background = true;
  }

  if (!aborted) {
    const isNewSession = session.startedNew && !session.firstTurnCompleted;
    session.firstTurnCompleted = true;
    ws.send(createNormalizedMessage({
      kind: 'complete',
      exitCode: 0,
      isNewSession,
      sessionId: session.sessionId,
      provider: 'claude',
    }));
  } else {
    session.firstTurnCompleted = true;
  }

  if (session.pendingTasks.size > 0) {
    // Jobs still running — keep the session alive (even across an abort); their
    // completion resumes the agent.
    clearIdleTimer(session);
    console.log(`[claude bg] session ${session.sessionId}: ${session.pendingTasks.size} background task(s) running — keeping session alive`);
    completeTurn(session);
    return;
  }

  // Truly idle now: notify (once per idle transition, matching the old
  // per-query behaviour).
  notifyRunStopped({
    userId: session.userId,
    provider: 'claude',
    sessionId: session.sessionId,
    sessionName: session.sessionSummary,
    stopReason: aborted ? 'aborted' : 'completed',
  });

  // One-shot callers (commit-message / agent flows) don't want a lingering
  // subprocess: close as soon as their single turn finishes.
  if (session.ephemeral) {
    completeTurn(session);
    endSession(session, 'ephemeral-complete');
    return;
  }

  armIdleTimer(session);
  completeTurn(session);
}

/** Called when a `result` message marks the end of an assistant turn. */
function onTurnEnd(session, ws) {
  settleTurn(session, ws, { aborted: false });
}

/**
 * Builds the `canUseTool` permission callback bound to a persistent session.
 * Mirrors the original per-query callback but reads the session's live id and
 * the (mutable) allow/deny lists carried on its sdkOptions.
 */
function makeCanUseTool(session, sdkOptions, ws, emitNotification) {
  return async (toolName, input, context) => {
    const sid = () => session.sessionId || session.options.sessionId || null;
    const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

    if (!requiresInteraction) {
      if (sdkOptions.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }

      const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isDisallowed) {
        return { behavior: 'deny', message: 'Tool disallowed by settings' };
      }

      const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isAllowed) {
        return { behavior: 'allow', updatedInput: input };
      }
    }

    const requestId = createRequestId();
    ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: sid(), provider: 'claude' }));
    emitNotification(createNotificationEvent({
      provider: 'claude',
      sessionId: sid(),
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName, sessionName: session.sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `claude:permission:${sid() || 'none'}:${requestId}`
    }));

    const decision = await waitForToolApproval(requestId, {
      timeoutMs: requiresInteraction ? 0 : undefined,
      signal: context?.signal,
      metadata: {
        _sessionId: sid(),
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
      },
      onCancel: (reason) => {
        ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: sid(), provider: 'claude' }));
      }
    });
    if (!decision) {
      return { behavior: 'deny', message: 'Permission request timed out' };
    }

    if (decision.cancelled) {
      return { behavior: 'deny', message: 'Permission request cancelled' };
    }

    if (decision.allow) {
      if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
        if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
          sdkOptions.allowedTools.push(decision.rememberEntry);
        }
        if (Array.isArray(sdkOptions.disallowedTools)) {
          sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
        }
      }
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }

    return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
  };
}

/**
 * Consumes the SDK message stream for the whole life of a persistent session
 * (across every turn and every background-job resume) until the input stream
 * closes. Final cleanup happens in `finally`.
 */
async function runSessionLoop(session, ws) {
  try {
    for await (const message of session.instance) {
      // Capture the session id from the first message of a brand-new session.
      if (message.session_id && !session.sessionId) {
        registerSession(message.session_id, session);
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(message.session_id);
        }
        if (session.startedNew && !session.sessionCreatedSent) {
          session.sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: message.session_id, sessionId: message.session_id, provider: 'claude' }));
        }
      }

      const sid = session.sessionId || session.options.sessionId || null;

      // Any assistant output means a turn is in flight — (re)arm the settle
      // guard so this turn's `result` is honored, including queued resume turns
      // that begin after a previous turn already settled.
      if (message.type === 'assistant') {
        session.awaitingResult = true;
      }

      // Drive background-job tracking / auto-resume off the task system messages.
      handleTaskMessage(session, message);

      // Transform and normalize the message, then fan out to attached sockets.
      const transformedMessage = transformMessage(message);
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: sid, provider: 'claude' }));
      }

      // A `result` marks the end of one assistant turn.
      if (message.type === 'result') {
        onTurnEnd(session, ws);
      }
    }
  } catch (error) {
    if (!session.ended) {
      await handleSessionError(session, ws, error);
    }
  } finally {
    finalizeSession(session);
  }
}

/** Loop teardown: drop tracking, clear timers, remove temp files. */
function finalizeSession(session) {
  if (session.finalized) return;
  session.finalized = true;
  completeTurn(session);
  session.finalizeDeferred?.resolve();
  clearIdleTimer(session);
  if (session.maxLifetimeTimer) {
    clearTimeout(session.maxLifetimeTimer);
    session.maxLifetimeTimer = null;
  }
  if (session.sessionId && getSession(session.sessionId) === session) {
    removeSession(session.sessionId);
  }
  void cleanupTempFiles(session.tempImagePaths, session.tempDirs);
}

/**
 * Surfaces a fatal session error to the client, with the same recovery paths as
 * the original per-query implementation (resume fallback, prompt-too-long, etc).
 */
async function handleSessionError(session, ws, error) {
  console.error('SDK query error:', error);
  const sessionId = session.options.sessionId;
  const sid = session.sessionId || sessionId || null;

  // A session jsonl that holds only bridge/system metadata (e.g. /remote-control
  // reconnect droppings) has no conversation Claude can resume — the SDK fails
  // with "No conversation found". Retry once as a brand-new session in the same
  // cwd so the user's message isn't silently dropped.
  const notResumable = /No conversation found with session ID/i.test(String(error?.message || ''));
  if (notResumable && sessionId && !session.options._resumeFallback) {
    console.warn(`Session ${sessionId} is not resumable, starting a new session instead`);
    ws.send(createNormalizedMessage({
      kind: 'error',
      content: 'This session has no resumable conversation — sending your message to a new session instead.',
      sessionId,
      provider: 'claude'
    }));
    // finalizeSession (the loop's finally) will untrack this dead session.
    await queryClaudeSDK(session.command, { ...session.options, sessionId: undefined, resume: false, _resumeFallback: true }, ws);
    return;
  }

  const installed = await providerAuthService.isProviderInstalled('claude');
  let errorContent;
  if (!installed) {
    errorContent = 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code';
  } else if (/Prompt is too long/i.test(String(error?.message || ''))) {
    errorContent = [
      '**Context too large**: this session\'s history exceeds the model\'s input limit.',
      '',
      'Resending the same prompt will keep hitting this error. Choose one:',
      '- Run `/compact` to summarize the conversation in place.',
      '- Start a fresh session in the same project to continue work.',
      '',
      '_(original error: ' + error.message + ')_',
    ].join('\n');
  } else {
    errorContent = error.message;
  }

  ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: sid, provider: 'claude' }));
  notifyRunFailed({
    userId: session.userId,
    provider: 'claude',
    sessionId: sid,
    sessionName: session.sessionSummary,
    error
  });
}

/**
 * Pushes a new user turn into an already-running persistent session instead of
 * spawning a fresh query — this is what keeps background jobs from a prior turn
 * alive while the conversation continues.
 */
async function reuseSession(session, command, options, ws) {
  // Attach this connection's socket to the session's writer so its output (and
  // any background-job resume) streams here too.
  try {
    const rawSocket = ws?.ws;
    if (rawSocket && session.writer?.updateWebSocket) {
      session.writer.updateWebSocket(rawSocket);
    }
  } catch (err) {
    console.warn('Failed to attach socket to persistent session writer:', err?.message || err);
  }

  // If a turn is mid-flight, interrupt it so the new message starts promptly
  // (the streaming query stays alive for the next turn).
  if (session.turnActive) {
    cancelPendingApprovalsForSession(session.sessionId);
    try {
      await session.instance.interrupt();
    } catch (err) {
      console.warn(`interrupt() before reuse for ${session.sessionId} rejected:`, err?.message || err);
    }
    session.turnActive = false;
  }

  // Apply a mid-session model switch if the user changed it.
  try {
    const resolvedModel = await providerModelsService.resolveResumeModel('claude', session.sessionId, options.model);
    const wanted = resolvedModel || options.model;
    if (wanted && wanted !== session.model && session.instance?.setModel) {
      await session.instance.setModel(wanted);
      session.model = wanted;
    }
  } catch (err) {
    console.warn(`setModel during reuse for ${session.sessionId} failed:`, err?.message || err);
  }

  // Persist any attached images and append their paths to the prompt.
  const imageResult = await handleImages(command, options.images, options.cwd);
  if (imageResult.tempImagePaths.length > 0) {
    session.tempImagePaths.push(...imageResult.tempImagePaths);
    if (imageResult.tempDir) session.tempDirs.push(imageResult.tempDir);
  }

  clearIdleTimer(session);
  session.turnActive = true;
  session.turnStartTime = Date.now();
  if (options.sessionSummary) session.sessionSummary = options.sessionSummary;

  const turnPromise = beginTurn(session);
  const pushed = session.input.push(makeUserMessage(imageResult.modifiedCommand));
  if (!pushed) {
    // Stream closed out from under us (raced teardown) — fall back to a fresh
    // session so the message isn't dropped.
    console.warn(`Persistent session ${session.sessionId} input closed during reuse — starting fresh`);
    completeTurn(session);
    removeSession(session.sessionId);
    return startPersistentSession(command, options, ws);
  }
  return turnPromise;
}

/**
 * Spins up a fresh persistent streaming session and kicks off its message loop.
 */
async function startPersistentSession(command, options, ws) {
  const { sessionId, sessionSummary } = options;

  const resolvedModel = await providerModelsService.resolveResumeModel('claude', sessionId, options.model);
  const sdkOptions = mapCliOptionsToSDK({ ...options, model: resolvedModel || options.model });

  const mcpServers = await loadMcpConfig(options.cwd);
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  const imageResult = await handleImages(command, options.images, options.cwd);
  const finalCommand = imageResult.modifiedCommand;

  const input = createInputController();
  const session = {
    sessionId: sessionId || null,
    instance: null,
    input,
    writer: ws,
    model: sdkOptions.model,
    options,
    command,
    sessionSummary,
    userId: ws?.userId || null,
    startedNew: !sessionId,
    ephemeral: Boolean(options.ephemeral),
    startTime: Date.now(),
    turnActive: true,
    turnStartTime: Date.now(),
    awaitingResult: true,
    firstTurnCompleted: false,
    sessionCreatedSent: false,
    currentTurn: null,
    pendingTasks: new Map(),
    tempImagePaths: [...imageResult.tempImagePaths],
    tempDirs: imageResult.tempDir ? [imageResult.tempDir] : [],
    idleTimer: null,
    maxLifetimeTimer: null,
    ended: false,
    finalized: false,
    finalizeDeferred: createDeferred(),
  };

  const emitNotification = (event) => {
    notifyUserIfEnabled({ userId: ws?.userId || null, writer: ws, event });
  };

  sdkOptions.hooks = {
    Notification: [{
      matcher: '',
      hooks: [async (input) => {
        const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
        emitNotification(createNotificationEvent({
          provider: 'claude',
          sessionId: session.sessionId || sessionId || null,
          kind: 'action_required',
          code: 'agent.notification',
          meta: { message, sessionName: session.sessionSummary },
          severity: 'warning',
          requiresUserAction: true,
          dedupeKey: `claude:hook:notification:${session.sessionId || sessionId || 'none'}:${message}`
        }));
        return {};
      }]
    }]
  };

  // Caveat: in 'auto'/'bypassPermissions' modes the SDK resolves approval at the
  // permission-mode step and skips this callback, so interactive tools won't
  // reach the UI in those modes (unchanged from the per-query implementation).
  sdkOptions.canUseTool = makeCanUseTool(session, sdkOptions, ws, emitNotification);

  // Set stream-close timeout for interactive tools (Query constructor reads it synchronously).
  const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
  process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';
  try {
    session.instance = queryImpl({ prompt: input.iterator, options: sdkOptions });
  } catch (hookError) {
    console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
    delete sdkOptions.hooks;
    session.instance = queryImpl({ prompt: input.iterator, options: sdkOptions });
  }
  if (prevStreamTimeout !== undefined) {
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
  } else {
    delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
  }

  if (sessionId) {
    registerSession(sessionId, session);
  }
  session.maxLifetimeTimer = setTimeout(() => endSession(session, 'max-lifetime'), SESSION_MAX_LIFETIME_MS);
  session.maxLifetimeTimer.unref?.();

  // Feed the first user turn, then run the loop for the session's whole life.
  // The returned promise resolves when this first turn completes; the loop keeps
  // running in the background for later turns and background-job resumes.
  console.log('Starting persistent streaming session for:', sessionId || 'NEW');
  const turnPromise = beginTurn(session);
  input.push(makeUserMessage(finalCommand));
  void runSessionLoop(session, ws);
  return turnPromise;
}

/** Waits for a session's message loop to fully tear down, with a hard cap. */
function waitForFinalize(session, timeoutMs = 10000) {
  if (!session || session.finalized || !session.finalizeDeferred) {
    return Promise.resolve();
  }
  return Promise.race([
    session.finalizeDeferred.promise,
    new Promise((resolve) => { setTimeout(resolve, timeoutMs).unref?.(); }),
  ]);
}

/**
 * Rewinds a session in-place: tears down any live session so the SDK releases
 * the transcript, then truncates the transcript at (and including) the edited
 * message so a subsequent resume continues from that point.
 * @returns {Promise<import('./shared/types.js').RewindResult>}
 */
async function performClaudeRewind(sessionId, rewindUuid) {
  const live = getSession(sessionId);
  if (live && !live.ended) {
    cancelPendingApprovalsForSession(sessionId);
    endSession(live, 'rewind');
    await waitForFinalize(live);
    if (getSession(sessionId) === live) {
      removeSession(sessionId);
    }
  }

  try {
    return await rewindHistoryImpl(sessionId, rewindUuid);
  } catch (error) {
    console.error(`Rewind for session ${sessionId} failed:`, error?.message || error);
    return { ok: false, startFresh: false, removed: 0 };
  }
}

/**
 * Executes (or continues) a Claude query using the SDK. A brand-new session
 * spins up a persistent streaming query; a message for an already-running
 * session is fed into it so background jobs from earlier turns stay alive.
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection/writer
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, rewind } = options;

  try {
    // Fail fast on a missing working directory (e.g. a project on an unmounted
    // volume). Otherwise the SDK spawn hangs silently: no error, no session
    // file, and the chat spinner runs forever.
    if (options.cwd) {
      try {
        await fs.access(options.cwd);
      } catch {
        const message = `Project directory does not exist: ${options.cwd} — is the volume mounted?`;
        console.error(`Claude query rejected: ${message}`);
        ws.send(createNormalizedMessage({ kind: 'error', content: message, sessionId: sessionId || null, provider: 'claude' }));
        return;
      }
    }

    // Rewind / edit-and-resend: truncate the transcript at the edited message,
    // then resume in-place from that point (a fresh persistent session loads the
    // truncated history). Never reuse the live session — its in-memory context
    // still holds the discarded tail.
    if (rewind && sessionId) {
      const result = await performClaudeRewind(sessionId, rewind);
      const baseOptions = { ...options, rewind: undefined };
      if (result.startFresh || !result.ok) {
        // First-turn edit (nothing to resume) or the anchor was not found — start
        // a brand-new session so the edited message is never dropped.
        return await startPersistentSession(command, { ...baseOptions, sessionId: undefined, resume: false }, ws);
      }
      return await startPersistentSession(command, { ...baseOptions, resume: true }, ws);
    }

    // Continue a live persistent session by feeding the new turn into it.
    if (sessionId) {
      const existing = getSession(sessionId);
      if (existing && !existing.ended && existing.input && !existing.input.closed) {
        return await reuseSession(existing, command, options, ws);
      }
      if (existing) {
        // A dead/closing session still lingering in the map — drop it.
        removeSession(sessionId);
      }
    }

    return await startPersistentSession(command, options, ws);
  } catch (error) {
    console.error('Claude session setup error:', error);
    ws.send(createNormalizedMessage({
      kind: 'error',
      content: error?.message || String(error),
      sessionId: sessionId || null,
      provider: 'claude',
    }));
  }
}

/**
 * Aborts the current turn of an SDK session. Like Claude Code's stop/Esc, this
 * interrupts the model's in-flight turn but KEEPS the session — and any running
 * background jobs — alive: the jobs keep running and still auto-resume the agent
 * when they finish. The session winds down on its own via the idle timeout (or
 * stays alive while jobs run).
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if the session was found and its turn interrupted
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  // Phantom-abort guard. Racy clients (e.g. a send-tap whose compatibility
  // mousedown lands on the swapped-in STOP button) fire abort within ~300ms of
  // a turn starting; a human pressing stop needs time to see output first, so an
  // abort this soon after a turn began is never intentional — ignore it.
  const parsedMinTurnAge = parseInt(process.env.CLAUDE_ABORT_MIN_TURN_AGE_MS, 10);
  const minTurnAgeMs = Number.isFinite(parsedMinTurnAge) ? parsedMinTurnAge : 1000;
  if (session.turnActive && session.turnStartTime) {
    const turnAgeMs = Date.now() - session.turnStartTime;
    if (turnAgeMs < minTurnAgeMs) {
      console.log(`Ignoring abort for session ${sessionId} — turn started ${turnAgeMs}ms ago`);
      return false;
    }
  }

  try {
    console.log(`Stopping current turn for SDK session: ${sessionId}`);
    // Release any interactive permission prompt this turn is parked on FIRST.
    // interrupt() can't unblock a query waiting inside the canUseTool callback
    // (it's awaiting our promise, not generating), so without this the turn
    // can't actually unwind.
    const cancelledApprovals = cancelPendingApprovalsForSession(sessionId);
    if (cancelledApprovals > 0) {
      console.log(`Cancelled ${cancelledApprovals} pending approval(s) for ${sessionId} before interrupt`);
    }

    // Interrupt the in-flight turn. The streaming query stays alive for future
    // turns and for background jobs launched this turn.
    if (session.turnActive && session.instance?.interrupt) {
      try {
        await session.instance.interrupt();
      } catch (interruptError) {
        console.warn(`interrupt() for ${sessionId} rejected:`, interruptError?.message || interruptError);
      }
    }

    // Settle the turn now (keeps the session alive; reconciles background jobs).
    // If the interrupt also yields a `result`, onTurnEnd's settleTurn is a
    // no-op thanks to the awaitingResult guard.
    settleTurn(session, session.writer, { aborted: true });
    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    cancelPendingApprovalsForSession(sessionId);
    return false;
  }
}

/**
 * Checks if an SDK session has a turn actively processing (drives the UI
 * "processing" indicator). A persistent session that is alive but idle between
 * turns reports false.
 * @param {string} sessionId - Session identifier
 * @returns {boolean}
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && !session.ended && session.turnActive);
}

/**
 * Whether a persistent session exists at all (processing or idle-between-turns).
 * @param {string} sessionId
 * @returns {boolean}
 */
function isClaudeSDKSessionAlive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && !session.ended);
}

/**
 * Gets the session IDs with a turn currently processing.
 * @returns {Array<string>} Array of processing session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions().filter((id) => {
    const session = activeSessions.get(id);
    return session && !session.ended && session.turnActive;
  });
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Attach a (re)connecting client's raw WebSocket to a session's writer.
 * Called when a client opens the session (e.g. page refresh, second tab/device)
 * while the SDK session is still alive — including while idle between turns, so
 * a later background-job resume still streams to this client. The writer fans
 * out to every attached socket, so concurrent viewers all receive the stream.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if the socket was attached to the writer
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Client attached to session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  isClaudeSDKSessionAlive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  __setClaudeQueryImpl,
  __setRewindHistoryImpl
};
