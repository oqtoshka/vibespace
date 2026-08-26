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
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_FALLBACK_MODELS, normalizeClaudeModelToCatalogValue } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { buildClaudeUserContent, getGlobalImageAssetsDir, normalizeImageDescriptors } from './shared/image-attachments.js';
import { buildAgentEnv, collectAgentEnv } from './shared/agent-env.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { describeTool } from './services/notification-content.js';
import { describeAssistantActivity } from './services/activity-status.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage, resolveConfiguredContextWindow } from './shared/utils.js';
import { rememberContextUsage } from './shared/context-usage-cache.js';
import { readOpenClaudeTasks } from './shared/claude-task-ledger.js';
import { scheduleSessionRecap } from './services/session-recap.service.js';
import { recordSessionActivity, recordSessionEnd, recordPendingInteraction } from './services/session-restore.service.js';
import { scheduleRateLimitWake, cancelRateLimitWake, isRateLimitWakePending } from './services/rate-limit-wake.service.js';
import { broadcastSessionUpdate } from './modules/providers/index.js';
import { chatRunRegistry } from './modules/websocket/services/chat-run-registry.service.js';
import { sessionsDb } from './modules/database/index.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

// 0 = a permission prompt waits indefinitely for a human. It used to expire
// after 55s and return deny, which the CLI reports to the model as "The user
// doesn't want to proceed with this tool use" — so a user who was simply not
// looking at the tab came back to a transcript claiming they had declined
// something they never saw. Nothing about the wait leaks: both reapers extend
// the session while an approval is pending, teardown/abort settle the prompt
// explicitly, and chat attach replays outstanding prompts to a returning
// client. Set the env var to restore a bound.
const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 0;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Indirection so tests can substitute a scripted SDK query / rewind step.
// Defaults to the real implementations.
let queryImpl = query;
function __setClaudeQueryImpl(fn) {
  queryImpl = fn || query;
}
let rewindHistoryImpl = (sessionId, messageUuid) => sessionsService.rewindHistory(sessionId, messageUuid);
function __setRewindHistoryImpl(fn) {
  rewindHistoryImpl = fn || ((sessionId, messageUuid) => sessionsService.rewindHistory(sessionId, messageUuid));
}

// A persistent session with no active turn and no running background jobs is
// torn down after this idle window. While a background job is running the
// session is kept alive regardless (the job's completion auto-resumes it).
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.CLAUDE_SESSION_IDLE_TIMEOUT_MS, 10) || 5 * 60 * 1000;
// There is deliberately NO wall-clock lifetime cap on sessions. One existed
// (SESSION_MAX_LIFETIME_MS, 2h) and killed an actively working overnight
// session mid-turn — its fire-time checks knew about background jobs, prompts,
// and ledgers, but not about an in-flight turn. Long sessions are the product
// here; the idle reaper above is the leak bound: a genuinely dead session goes
// idle and gets torn down, an active one keeps earning its keep.

// A session that goes idle while its own task ledger (~/.claude/tasks/<id>/)
// still holds open items is nudged to continue instead of being reaped: the
// model declared that work and hasn't closed it, so an idle turn boundary is
// not the end of the session. Bounded so a confused model can't run all night:
// at most TASK_NUDGE_MAX nudges per session, and two consecutive nudges that
// produce no tool calls and no ledger change give up early with a notification.
// The model exits the loop by editing the ledger — completing, deleting, or
// re-scoping its tasks — or, when a task is genuinely parked on the user (an
// unanswered question, a decision, a review), by marking it with TaskUpdate
// metadata `{ waitingOnUser: true }`: the supervisor then stands down and the
// task stays open, so a supervisor board keeps showing the outstanding work
// instead of a falsely "complete" session. The marker is trusted only while
// no newer user turn exists — a reply after the mark makes the task
// actionable again. VIBESPACE_TASK_NUDGE=0 disables the mechanism.
const TASK_NUDGE_MAX = parseInt(process.env.VIBESPACE_TASK_NUDGE_MAX, 10) || 5;
const TASK_NUDGE_ENABLED = !['0', 'false', 'off'].includes((process.env.VIBESPACE_TASK_NUDGE || '').trim().toLowerCase());

// Auto-compact window for Claude sessions, in tokens. The CLI's "auto" choice
// is tuned per model (~300k on current large-window models); we compact
// earlier so long sessions summarize before the context gets that expensive.
// Applied through the SDK's flag-settings layer, so it scopes to vibespace
// sessions without touching ~/.claude/settings.json; a host-level
// CLAUDE_CODE_AUTO_COMPACT_WINDOW env var still outranks it. Set
// VIBESPACE_CLAUDE_AUTO_COMPACT_WINDOW=auto to fall back to the CLI default.
const AUTO_COMPACT_WINDOW = (() => {
  const raw = (process.env.VIBESPACE_CLAUDE_AUTO_COMPACT_WINDOW || '').trim().toLowerCase();
  if (raw === 'auto' || raw === '0' || raw === 'off') return null;
  return parseInt(raw, 10) || 256000;
})();

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
 * Cancels every pending tool-approval prompt for a session, settling each
 * awaiting `canUseTool` call with a cancelled decision (which returns deny).
 * Used before interrupting/ending a session so a query parked inside the
 * approval callback can actually unwind.
 * @param {string} sessionId
 * @returns {number} count of approvals cancelled
 */
function cancelPendingApprovalsForSession(sessionId) {
  let cancelled = 0;
  for (const [, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      resolver({ cancelled: true });
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Whether the session is parked on a permission prompt the user has not
 * answered yet. Such a session looks idle from the outside — no output, no
 * running job — but the thing it is waiting for is the user, so the reapers
 * must not treat the quiet as abandonment.
 * @param {string} sessionId
 * @returns {boolean}
 */
function hasPendingApprovalsForSession(sessionId) {
  for (const [, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) return true;
  }
  return false;
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

/**
 * Validates a requested reasoning-effort value against the efforts the selected
 * model actually advertises; returns undefined for "default" or anything the
 * model doesn't support so the SDK falls back to its own default.
 */
function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Applies a pending per-session model override to a LIVE session.
 *
 * The override is the user's explicit pick from the model picker; it is stored
 * per session and stays in force until they pick something else. Enforcing it
 * only where a *user-typed* message enters the runtime was not enough: a
 * session also starts turns on its own (background-job auto-resume, the
 * open-tasks nudge, a message folded into a running turn), and those turns kept
 * running on whatever model the CLI already had. A session resumed on Fable
 * therefore stayed on Fable no matter how many times the user picked Opus — the
 * pick only "took" if the very next turn happened to be a hand-typed one.
 *
 * Safe to call before every turn: it is a no-op when the session already runs
 * the wanted model, and `session.model` is kept honest from the runtime's own
 * `init` (see the message loop), so a model the CLI reset behind our back —
 * across a compaction, say — is simply re-applied on the next turn.
 */
async function applyPendingModelSwitch(session) {
  if (!session?.sessionId || session.ended) return;
  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      session.sessionId,
      undefined,
      { resuming: true },
    );
    if (!resolvedModel || resolvedModel === session.model || !session.instance?.setModel) return;
    // "default" is the catalog's *absence* of a pick, and the SDK spells that
    // `undefined` — passing the literal string would ask for a model that
    // doesn't exist. It also never matches the concrete model `init` reports
    // back, so it is applied once rather than on every turn.
    if (resolvedModel === 'default' && session.appliedModelOverride === 'default') return;
    await session.instance.setModel(resolvedModel === 'default' ? undefined : resolvedModel);
    session.model = resolvedModel;
    session.appliedModelOverride = resolvedModel;
    console.log(`[claude] session ${session.sessionId}: switched model to ${resolvedModel}`);
  } catch (err) {
    console.warn(`setModel for ${session?.sessionId} failed:`, err?.message || err);
  }
}

/**
 * Host-specific preamble appended to the claude_code system prompt.
 *
 * The agent has no way to know it is answering into VibeSpace rather than a
 * terminal, and the difference matters for one thing: the chat renderer turns
 * any non-external markdown link into a click that opens that file in the
 * editor pane (see `Markdown.tsx`). That only works for paths relative to the
 * project root — the renderer deliberately refuses `/…` and `~/…`, which it
 * cannot resolve through the project file API. Absolute paths, the terminal's
 * natural habit, render as dead links.
 *
 * So this states the one convention the host needs and nothing else. Kept
 * short on purpose: it rides on every request, and a long preamble here is a
 * standing tax on every session's context.
 *
 * @param {string} [cwd] - Project root the session runs in.
 * @returns {string} Text to append, or '' when there is no project root.
 */
function buildVibespaceSystemPrompt(cwd) {
  if (!cwd) return '';

  return [
    '# VibeSpace',
    '',
    `You are running inside VibeSpace, a web UI. The project root is \`${cwd}\`.`,
    '',
    'When you finish a turn in which you created, edited, or deleted files, end',
    'your reply with a short list of those files as markdown links whose target',
    'is the path relative to the project root:',
    '',
    '    - [src/components/Foo.tsx](src/components/Foo.tsx) — what changed',
    '',
    'VibeSpace turns those links into clicks that open the file in the editor',
    'pane. This only works for project-root-relative paths: absolute paths and',
    '`~/…` cannot be resolved and render as dead links. A `:line` suffix is',
    'understood and jumps to that line.',
    '',
    'Skip the list entirely when a turn changed no files — do not pad a reply',
    'with an empty or irrelevant one.',
  ].join('\n');
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode } = options;

  const sdkOptions = {};

  // Forward host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess, minus
  // VibeSpace's own server configuration — see shared/agent-env.js.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = buildAgentEnv();

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Non-image attachments reach the agent as "read this file" path references
  // into the global assets store (~/.vibespace/assets), which lives outside
  // every project cwd — without this grant the Read tool trips an
  // out-of-directory permission prompt on each attachment.
  sdkOptions.additionalDirectories = [getGlobalImageAssetsDir()];

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Add plan mode default tools
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

  // Map model. Valid values: sonnet, opus, haiku, opusplan, opus[1m], fable.
  //
  // "default" is deliberately NOT forwarded: the SDK turns any model value into
  // an explicit `--model` flag, and that flag outranks the CLI's own settings.
  // Passing it pinned every session to the CLI's built-in default (Sonnet) and
  // silently overrode `model` in ~/.claude/settings.json, so a deployment could
  // not choose its own default. Omitting the flag is what makes the picker's
  // "Default (recommended)" mean "whatever this Claude Code is configured to
  // use". The selected value still drives effort validation below.
  const selectedModel = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;
  if (selectedModel !== CLAUDE_FALLBACK_MODELS.DEFAULT) {
    sdkOptions.model = selectedModel;
  }
  // Model logged at query start below

  const resolvedEffort = resolveClaudeEffort(
    selectedModel,
    options.effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  // Map system prompt configuration
  const vibespacePreamble = buildVibespaceSystemPrompt(cwd);
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code',  // Required to use CLAUDE.md
    ...(vibespacePreamble ? { append: vibespacePreamble } : {}),
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Compact earlier than the model-tuned "auto" window (see AUTO_COMPACT_WINDOW).
  if (AUTO_COMPACT_WINDOW) {
    sdkOptions.settings = { autoCompactWindow: AUTO_COMPACT_WINDOW };
  }

  // Helper calls (commit messages, agent REST one-shots, the title/recap
  // generator) are conversations only in the mechanical sense: nothing resumes
  // them and nobody reads them back. Left persisted, the SDK writes each one
  // into ~/.claude/projects/<cwd>/ exactly like a real chat, the transcript
  // watcher indexes it, and the sidebar fills with sessions named after our own
  // prompts ("Below is the tail of a coding session…"). Not writing them at all
  // is cheaper than teaching the watcher to recognise and skip them.
  if (options.ephemeral) {
    sdkOptions.persistSession = false;
  }

  // Let host plugins tag the subprocess for what it is. An ephemeral helper
  // turn fires the same agent hooks a real one does, and a private session is
  // the user's choice to stay off external channels; which variables express
  // that (e.g. a presence reporter's opt-out) is the plugin's business, not
  // the runtime's. Merged over the filtered host env: contributors add, never
  // remove — dropping the rest would strip ANTHROPIC_BASE_URL and friends.
  Object.assign(sdkOptions.env, collectAgentEnv({
    provider: 'claude',
    scope: 'session',
    private: Boolean(options.private),
    ephemeral: Boolean(options.ephemeral),
    sessionId: options.sessionId ?? null,
  }));

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
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
  // A removed session ended (or is about to be respawned, which re-records it)
  // — either way it must not be a restore-on-boot candidate anymore.
  recordSessionEnd(sessionId).catch(() => {});
}

/**
 * Mirrors the session's liveness to the restore-on-boot registry (see
 * session-restore.service). Ephemeral helpers never come back, so they are
 * never recorded.
 */
function recordRestoreState(session, turnActive) {
  if (!session.sessionId || session.ephemeral) return;
  recordSessionActivity({
    sessionId: session.sessionId,
    cwd: session.options?.cwd,
    permissionMode: session.options?.permissionMode,
    userId: session.userId,
    // Carried so a detached restore after a restart spawns the resumed turn
    // with the same gate the session was started with.
    private: Boolean(session.options?.private),
    turnActive,
  }).catch(() => {});
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
    const contextWindow = resolveConfiguredContextWindow() ?? 0;

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
  const contextWindow = resolveConfiguredContextWindow() ?? 0;

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
 * Asks the live runtime how full the context window actually is and pushes the
 * answer to the client as a `context_usage` status.
 *
 * This is the authoritative source for the composer's gauge: `tokenBudget` is
 * inferred from a single message's `usage`, whereas this is the CLI's own
 * accounting — the real window for the model in use, plus the auto-compact
 * threshold and whether it is even on, which is what makes the reading
 * actionable ("will this compact itself, or am I about to hit the wall?").
 *
 * Deliberately NOT awaited by the stream loop: it is a control round-trip to
 * the CLI, and awaiting it inside `for await` would stall message consumption
 * (and so the visible stream) for its duration.
 *
 * Overlapping requests collapse into one trailing re-read rather than being
 * dropped: a compaction emits its boundary and its turn `result` moments
 * apart, and simply ignoring the second would leave the gauge showing the
 * pre-compaction number — exactly the reading the user is watching for.
 *
 * @param {Object} session
 * @param {string} reason - Why we are refreshing; logged on failure only.
 */
function refreshContextUsage(session, reason) {
  if (!session || session.ended) return;
  // One-shot internal flows (commit messages, agent helpers) have no chat UI
  // behind them and tear down immediately — probing them only races teardown.
  if (session.ephemeral) return;
  if (session.contextUsageInFlight) {
    session.contextUsageRerunReason = reason;
    return;
  }
  const instance = session.instance;
  if (!instance || typeof instance.getContextUsage !== 'function') return;

  session.contextUsageInFlight = true;
  Promise.resolve()
    .then(() => instance.getContextUsage())
    .then((usage) => {
      if (!usage || session.ended) return;
      const maxTokens = readNumber(usage.maxTokens);
      const totalTokens = readNumber(usage.totalTokens);
      if (maxTokens <= 0) return;

      const contextUsage = {
        totalTokens,
        maxTokens,
        // The runtime already computes this; recompute only if it is absent
        // so the gauge can never disagree with the CLI's own number.
        percentage: Number.isFinite(usage.percentage)
          ? usage.percentage
          : (totalTokens / maxTokens) * 100,
        model: typeof usage.model === 'string' ? usage.model : undefined,
        autoCompactThreshold: Number.isFinite(usage.autoCompactThreshold)
          ? usage.autoCompactThreshold
          : undefined,
        isAutoCompactEnabled: usage.isAutoCompactEnabled === true,
      };

      // Survives a page reload / session switch, which would otherwise drop the
      // gauge back to a bare token count until the user sends something.
      rememberContextUsage(session.sessionId || session.options.sessionId, contextUsage);

      session.writer.send(createNormalizedMessage({
        kind: 'status',
        text: 'context_usage',
        contextUsage,
        sessionId: session.sessionId || session.options.sessionId || null,
        provider: 'claude',
      }));
    })
    .catch((error) => {
      // Never surfaced to the user: an unavailable gauge is a missing nicety,
      // not a failed turn. Older CLIs simply don't answer this control request.
      console.warn(`[claude context] ${reason} usage probe failed:`, error?.message || error);
    })
    .finally(() => {
      session.contextUsageInFlight = false;
      const rerunReason = session.contextUsageRerunReason;
      if (rerunReason) {
        session.contextUsageRerunReason = null;
        refreshContextUsage(session, rerunReason);
      }
    });
}

/**
 * Surfaces compaction as it happens.
 *
 * Compaction takes tens of seconds to minutes, during which the model emits
 * nothing at all, so without this the UI is indistinguishable from a hung
 * turn.
 * The runtime announces the phase with a `status` system event and the seam
 * itself with `compact_boundary` (normalized into the transcript elsewhere).
 *
 * @returns {boolean} True when the message was a compaction status.
 */
function handleCompactionStatus(session, message) {
  if (!message || message.type !== 'system' || message.subtype !== 'status') {
    return false;
  }

  const sid = session.sessionId || session.options.sessionId || null;

  if (message.status === 'compacting') {
    session.writer.send(createNormalizedMessage({
      kind: 'status',
      text: 'Compacting conversation',
      canInterrupt: true,
      sessionId: sid,
      provider: 'claude',
    }));
    return true;
  }

  if (message.compact_result === 'failed') {
    // A failed compaction leaves the context exactly as full as it was, so the
    // next turn will very likely hit the input limit. Say so in the transcript
    // rather than letting it fail later with no explanation.
    session.writer.send(createNormalizedMessage({
      kind: 'error',
      content: `Compaction failed${message.compact_error ? `: ${message.compact_error}` : ''}. The conversation was left uncompacted — start a fresh session if the next turn hits the context limit.`,
      sessionId: sid,
      provider: 'claude',
    }));
    return true;
  }

  return message.compact_result === 'success';
}

/**
 * Builds the user-turn content for the streaming input: the plain prompt when
 * there are no attachments, or a text block plus one base64 `image` block per
 * attachment. Descriptors are `{ path, name?, mimeType? }` records pointing at
 * the global `~/.vibespace/assets` store; paths outside the allowed roots are
 * refused inside buildClaudeUserContent.
 */
async function buildTurnContent(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }
  return await buildClaudeUserContent(command, images, cwd);
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
// streaming-input mode: user turns are fed into an async-iterable prompt that
// stays open across turns. This lets `run_in_background` jobs outlive the turn
// that launched them (the SDK subprocess stays alive) and lets us auto-resume
// the agent when a job finishes (mirroring the Claude Code CLI harness).
//
// New-runtime adaptation: each turn streams to `session.writer`, the CURRENT
// chat-run's writer. A user turn uses the run the gateway opened; a background
// auto-resume opens its OWN run via `session.acquireResumeRun()` (so its output
// is sequenced/replayed under a fresh run, and the session is "processing"
// again). `settleTurn` sends the terminal `complete`, ending that run.
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
 * Also resets the per-turn recap capture.
 */
function beginTurn(session) {
  if (session.currentTurn) {
    session.currentTurn.resolve();
  }
  session.awaitingResult = true;
  session.lastAssistantText = '';
  session.turnToolNames = [];
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

/**
 * Records the latest assistant text + tool names for the in-flight turn, so the
 * "run stopped" notification can carry a recap and detect background work. Only
 * overwrites the text when this message actually has text blocks, so a trailing
 * tool-only message doesn't blank out the real answer.
 */
function captureAssistantSummary(session, message) {
  const blocks = message?.message?.content;
  if (!Array.isArray(blocks)) return;
  const textParts = [];
  for (const b of blocks) {
    if (b?.type === 'text' && b.text) textParts.push(b.text);
    else if (b?.type === 'tool_use' && b.name) {
      session.turnToolNames.push(b.name);
      // Session-lifetime counter, never reset per turn: the task-nudge stall
      // detector compares it across nudges to tell "worked but didn't update
      // the ledger yet" from "did nothing at all".
      session.toolUseCount += 1;
    }
  }
  if (textParts.length) session.lastAssistantText = textParts.join('\n').trim();
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
  recordRestoreState(session, session.turnActive);
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
  // Settle any outstanding prompt BEFORE closing the stream it arrived on.
  // Closing first strands the CLI's permission request mid-flight, and it
  // reports the opaque "Tool permission stream closed before response
  // received"; resolving first turns the same teardown into an ordinary
  // "Permission request cancelled" and lets the client clear the prompt.
  if (session.sessionId) {
    const cancelled = cancelPendingApprovalsForSession(session.sessionId);
    if (cancelled > 0) {
      console.log(`[claude bg] session ${session.sessionId}: cancelled ${cancelled} pending approval(s) during ${reason}`);
    }
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

    // Last line of defence against a stale arm. The timer is armed when a turn
    // settles and cleared when the next one starts, but those two events race:
    // a background job's auto-resume opens the next turn from the message
    // stream, while the previous turn's `result` — which arms the timer — can
    // arrive after it. Assistant output then re-arms `awaitingResult` without
    // clearing the timer, so the session ends up mid-turn with a live reaper
    // pointed at it, and five minutes later gets torn down under a running
    // turn. The visible damage was an unanswered AskUserQuestion: closing the
    // input stream drops the CLI's permission request, which surfaces in the
    // transcript as "Tool permission stream closed before response received"
    // and reads, on reopening the session, as though the user had declined.
    //
    // Re-arm rather than return so a session that really is finished still
    // gets reaped on the next tick.
    if (session.awaitingResult || session.turnActive || hasPendingApprovalsForSession(session.sessionId)) {
      armIdleTimer(session);
      return;
    }

    // Last gate before teardown: the model's own task ledger. The read is
    // async, so the session can change state underneath it — every outcome
    // re-checks before acting.
    maybeContinueOpenTasks(session)
      .catch((err) => {
        console.warn(`[claude tasks] ledger check failed for ${session.sessionId}:`, err?.message || err);
        return false;
      })
      .then((handled) => {
        if (handled || session.ended) return;
        if (session.pendingTasks.size > 0 || session.awaitingResult || session.turnActive
          || hasPendingApprovalsForSession(session.sessionId)) {
          armIdleTimer(session);
          return;
        }
        endSession(session, 'idle-timeout');
      });
  }, SESSION_IDLE_TIMEOUT_MS);
  // Don't let an idle session keep the process alive / block shutdown.
  session.idleTimer.unref?.();
}

/**
 * The idle reaper's last gate: a session whose task ledger still holds open
 * items is not finished, whatever the turn boundary says — the model declared
 * that work and hasn't closed it. Injects a continuation turn the same way a
 * background-job auto-resume does, so the model either keeps working or
 * explicitly closes/re-scopes its tasks; the ledger edit is the exit from the
 * loop.
 *
 * Returns true when the reaper should stand down (a nudge was injected, or the
 * session grew a live turn under the ledger read). Returns false when the
 * session is genuinely done, the mechanism is off, or nudging has demonstrably
 * stopped helping — the bail-out paths notify the user before handing the
 * session back to the reaper.
 */
async function maybeContinueOpenTasks(session) {
  if (!TASK_NUDGE_ENABLED || session.ephemeral || session.ended || !session.sessionId) return false;
  if (session.input.closed) return false;
  // Waiting on a usage-limit reset: a nudge now would only hit the limit
  // again and burn the nudge budget. The wake service owns this session —
  // let the reaper tear the idle process down; the wake resumes it.
  if (isRateLimitWakePending(session.sessionId)) {
    console.log(`[claude tasks] session ${session.sessionId}: usage-limit wake pending — not nudging`);
    return false;
  }

  const open = await readOpenClaudeTasks(session.sessionId);
  if (open.length === 0) return false;

  // A task marked waitingOnUser is parked on input only the user can give —
  // nudging cannot advance it, and pressing the model to "close" it is how
  // sessions used to fake-complete work the user never signed off on. The
  // marker is honored only if set at or after the last real user turn; a
  // reply that arrived later makes the task actionable again. An unreadable
  // mtime honors the marker (standing down is the safe direction).
  const actionable = open.filter(
    (t) => !t.waitingOnUser || (t.updatedAt !== null && t.updatedAt < session.lastUserTurnAt),
  );
  if (actionable.length === 0) {
    console.log(`[claude tasks] session ${session.sessionId}: all ${open.length} open task(s) are waiting on the user — standing down, ledger stays open`);
    return false;
  }

  // State may have moved while we were on disk; a live turn owns the session.
  if (session.ended || session.input.closed) return false;
  if (session.turnActive || session.awaitingResult || session.pendingTasks.size > 0) return true;

  // Stall detection: a nudge that produced no tool calls AND left the ledger
  // untouched did nothing. Two of those in a row mean nudging isn't helping.
  const nudges = session.taskNudges;
  const fingerprint = actionable.map((t) => `${t.id}:${t.status}`).join(',');
  if (nudges.count > 0 && fingerprint === nudges.fingerprint && session.toolUseCount === nudges.toolCount) {
    nudges.stalls += 1;
  } else {
    nudges.stalls = 0;
  }

  if (nudges.count >= TASK_NUDGE_MAX || nudges.stalls >= 2) {
    const subjects = actionable.map((t) => t.subject).join('; ');
    const why = nudges.stalls >= 2 ? 'no progress across two nudges' : `nudge budget (${TASK_NUDGE_MAX}) exhausted`;
    console.log(`[claude tasks] session ${session.sessionId}: giving up (${why}) with ${actionable.length} open task(s): ${subjects}`);
    notifyRunFailed({
      userId: session.userId,
      provider: 'claude',
      sessionId: session.sessionId,
      sessionName: session.sessionSummary,
      error: `Went idle with ${actionable.length} open task(s) — ${why}: ${subjects}`,
    });
    return false;
  }

  nudges.count += 1;
  nudges.fingerprint = fingerprint;
  nudges.toolCount = session.toolUseCount;

  ensureRunForServerStartedTurn(session, 'Resuming — open tasks remain');
  console.log(`[claude tasks] session ${session.sessionId}: idle with ${actionable.length} open task(s) — nudging (${nudges.count}/${TASK_NUDGE_MAX})`);
  await applyPendingModelSwitch(session);
  session.input.push(makeUserMessage(buildOpenTasksNudge(actionable)));
  return true;
}

/**
 * Records usage-limit signals from the message stream on the session.
 *
 * The trigger is the synthetic assistant message the runtime writes for a
 * rejected request (`error: 'rate_limit'`, text like "You've hit your session
 * limit · resets 7:30pm (Europe/Moscow)"); the transcript line carries the
 * machine-readable `quotaLimits` alongside it, and the SDK's `rate_limit_event`
 * reports the same `resetsAt` independently. A `rate_limit_event` alone is
 * only data — its status can lag or lead the turn — so it never marks a hit.
 */
function readClaudeApiErrorText(message) {
  const content = message?.message?.content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
  }
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(message?.errors)) return message.errors.filter(Boolean).join(' ').trim();
  return typeof message?.result === 'string' ? message.result.trim() : '';
}

function readClaudeApiStatus(message) {
  const value = message?.apiErrorStatus
    ?? message?.api_error_status
    ?? message?.status
    ?? message?.statusCode
    ?? message?.status_code
    ?? message?.response?.status;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function isClaude529Error(value) {
  if (readClaudeApiStatus(value) === 529) return true;
  const text = value instanceof Error
    ? value.message
    : (readClaudeApiErrorText(value) || value?.message || '');
  return /(?:\b529\b.*(?:overload|service)|(?:overload|service overloaded).*\b529\b)/i.test(String(text));
}

function trackRateLimit(session, message) {
  if (!message) return;
  if (message.type === 'rate_limit_event' && message.rate_limit_info && typeof message.rate_limit_info === 'object') {
    session.lastRateLimitInfo = { ...message.rate_limit_info, seenAt: Date.now() };
    return;
  }
  if (message.type === 'assistant' && message.error === 'rate_limit') {
    const text = readClaudeApiErrorText(message);
    const quota = message.quotaLimits && typeof message.quotaLimits === 'object' ? message.quotaLimits : null;
    session.rateLimitHit = {
      text: text || 'usage limit reached',
      resetsAt: quota?.resetsAt ?? null,
      limitType: quota?.rateLimitType ?? null,
      recoveryKind: 'usage-limit',
      seenAt: Date.now(),
    };
    return;
  }
  // Claude Code may surface an exhausted overload retry either as the
  // synthetic assistant API-error row or only on the terminal result.
  if (isClaude529Error(message)) {
    session.rateLimitHit = {
      text: readClaudeApiErrorText(message) || 'Claude API returned HTTP 529 (service overloaded)',
      resetsAt: null,
      limitType: 'http_529',
      recoveryKind: 'claude-529',
      seenAt: Date.now(),
    };
  }
}

/**
 * If the turn that just settled died on the usage limit, hands the session
 * to the wake service and returns true. Consumes the hit either way.
 */
function scheduleWakeForRateLimitedTurn(session) {
  const hit = session.rateLimitHit;
  session.rateLimitHit = null;
  // Ephemeral helpers (recaps, commit messages) are one-shot: nothing to
  // resume, and no session row for a wake to land on.
  if (!hit || !session.sessionId || session.ephemeral) return false;
  // The event is account-wide and may have arrived before or after the
  // assistant message; trust it only when it describes a rejection.
  const info = session.lastRateLimitInfo;
  const infoResetsAt = info && info.status === 'rejected' ? info.resetsAt ?? null : null;
  scheduleRateLimitWake({
    provider: 'claude',
    providerSessionId: session.sessionId,
    userId: session.userId,
    sessionName: session.sessionSummary,
    resetsAt: hit.resetsAt ?? infoResetsAt,
    limitType: hit.limitType ?? (infoResetsAt !== null ? info.rateLimitType ?? null : null),
    limitText: hit.text,
    permissionMode: session.options?.permissionMode ?? null,
    recoveryKind: hit.recoveryKind || 'usage-limit',
    messageId: session.currentRateLimitWakeMessageId ?? null,
    priorAttempts: session.currentRateLimitWakeAttempts ?? 0,
  }).catch((error) => {
    console.warn(`[claude] session ${session.sessionId}: scheduling the retry wake failed:`, error?.message || error);
  });
  return true;
}

function buildOpenTasksNudge(open) {
  return [
    '[session supervisor] Automated check: this session went idle, but its task list still has open items:',
    ...open.map((t) => `- #${t.id} [${t.status}] ${t.subject}`),
    '',
    'Continue working through them now. If an item is finished, mark it completed. '
      + 'If it is no longer relevant, delete it or replace it with a re-scoped task, and say why.',
    '',
    'If an item cannot proceed because it needs the user\'s answer, decision, or review, it is NOT '
      + 'finished — never mark it completed to satisfy this check. Instead keep its status open and '
      + 'flag it via TaskUpdate metadata: {"waitingOnUser": true}, then end the turn. The '
      + 'supervisor stops nudging tasks flagged this way, and each stays visible as outstanding '
      + 'work until the user responds. (Set the metadata now even if you believe it is already '
      + 'set — the flag must postdate this message. It expires automatically when the user '
      + 'replies.)',
  ].join('\n');
}

/**
 * Handles the task-lifecycle system messages that drive background-job
 * persistence and auto-resume.
 */
async function handleTaskMessage(session, message) {
  if (!message || message.type !== 'system') return;

  if (message.subtype === 'task_started' && message.task_id) {
    // `background` is set true once the task survives a turn boundary (see
    // settleTurn). Foreground subagents complete before their parent turn ends,
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
      // No active turn → open a fresh run for the auto-resumed turn so its
      // output streams under its own sequence and the session shows as
      // processing again (a server-initiated resume has no client `chat.send`
      // behind it, so without the status the composer would still show "send"
      // while messages stream in — and a user send would race into a
      // RUN_IN_PROGRESS rejection). A resume turn also has to settle even if it
      // produces only a result, which the helper's `awaitingResult` covers.
      ensureRunForServerStartedTurn(session, 'Resuming — background task finished');
      console.log(`[claude bg] session ${session.sessionId}: background task ${message.task_id} ${message.status || 'completed'} — auto-resuming agent`);
      await applyPendingModelSwitch(session);
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

// ---------------------------------------------------------------------------
// Mid-turn user messages ("async commands")
//
// The Claude runtime accepts a user message while a turn is still running: it
// parks it in its own command queue and folds it into the RUNNING turn at the
// next tool boundary — the model sees it after finishing the current action
// instead of after the whole task, which is what the Claude Code CLI does.
// The runtime narrates that with `command_lifecycle` events carrying the uuid
// we stamped on the message: queued → started → completed (or cancelled).
//
// Turn accounting: a folded message produces NO extra `result`, so it must not
// open a chat-run of its own. Only when the runtime's own drain loop starts a
// *fresh* turn for it (the message landed just as the previous turn ended) do
// we open one, the same way a background-job auto-resume does.
// ---------------------------------------------------------------------------

/**
 * Opens a chat-run for a turn the runtime started on its own, so its output is
 * sequenced under a run and every client sees the session as processing again.
 * No-op when a turn is already in flight (the output belongs to that run).
 */
function ensureRunForServerStartedTurn(session, statusText) {
  if (!session.turnActive) {
    // Without a seam (tests, one-shot callers) keep the current writer.
    const resumeWriter = session.acquireResumeRun?.();
    if (resumeWriter) {
      session.writer = resumeWriter;
      resumeWriter.send(createNormalizedMessage({
        kind: 'status',
        text: statusText,
        canInterrupt: true,
        sessionId: session.sessionId,
        provider: 'claude',
      }));
    }
    session.turnActive = true;
    session.turnStartTime = Date.now();
    recordRestoreState(session, true);
  }

  // Make sure the turn settles even if it produces only a result (the loop
  // re-arms this on assistant output too), with a fresh recap capture.
  session.awaitingResult = true;
  session.lastAssistantText = '';
  session.turnToolNames = [];
  clearIdleTimer(session);
}

/**
 * Feeds a user message into a live session's running turn.
 *
 * Returns the uuid the runtime will refer to it by in `command_lifecycle`
 * events (and which `cancelInjectedClaudeMessage` cancels it with), or null
 * when the session isn't live — the caller then falls back to the app-level
 * queue, which sends it as its own turn once the run finishes.
 */
async function injectClaudeMessage(sessionId, command, options = {}) {
  const session = getSession(sessionId);
  if (!session || session.ended || session.input.closed) {
    return null;
  }

  // Without the lifecycle events there is no signal that the runtime picked the
  // message up, so the queue card would hang around forever and the prompt
  // would never appear in the transcript. Fall back to the app-level queue.
  if (!session.capabilities?.includes('msg_lifecycle_v1')) {
    console.warn(`[claude] session ${sessionId}: runtime has no msg_lifecycle_v1 — queueing instead of delivering mid-turn`);
    return null;
  }

  const content = await buildTurnContent(command, options.images, options.cwd);
  const uuid = crypto.randomUUID();
  // A message folded into a running turn is still a user turn: honour a model
  // pick made while that turn was in flight.
  await applyPendingModelSwitch(session);
  session.lastUserTurnAt = Date.now();
  const pushed = session.input.push({ ...makeUserMessage(content), uuid });
  if (!pushed) {
    return null;
  }

  session.injectedCommands.set(uuid, {
    content: command,
    onDelivered: typeof options.onDelivered === 'function' ? options.onDelivered : null,
    onCancelled: typeof options.onCancelled === 'function' ? options.onCancelled : null,
  });
  if (options.sessionSummary) session.sessionSummary = options.sessionSummary;
  console.log(`[claude] session ${sessionId}: injected mid-turn message ${uuid}`);
  return uuid;
}

/**
 * Drops a still-queued injected message from the runtime's command queue.
 * Resolves false when the runtime had already folded it into a turn — its
 * content is running and the caller must not treat it as recallable.
 */
async function cancelInjectedClaudeMessage(sessionId, uuid) {
  const session = getSession(sessionId);
  if (!session || !session.injectedCommands.has(uuid) || !session.instance?.cancelAsyncMessage) {
    return false;
  }

  try {
    const cancelled = Boolean(await session.instance.cancelAsyncMessage(uuid));
    if (cancelled) {
      session.injectedCommands.delete(uuid);
    }
    return cancelled;
  } catch (error) {
    console.warn(`cancelAsyncMessage(${uuid}) for ${sessionId} rejected:`, error?.message || error);
    return false;
  }
}

/** Reports one injected message as recalled and forgets it. */
function settleCancelledInjection(session, uuid) {
  const entry = session.injectedCommands.get(uuid);
  if (!entry) return;
  session.injectedCommands.delete(uuid);
  entry.onCancelled?.();
}

/**
 * Interrupts the in-flight turn, taking anything the user queued during it
 * along with it.
 *
 * A plain `interrupt()` deliberately leaves queued messages alone — they would
 * then start a brand-new turn moments after the abort, the opposite of what
 * pressing Stop means. `cancel_queued` sweeps them in the same round-trip and
 * reaches even a message already being folded into the turn (the one case
 * `cancelAsyncMessage` refuses). Advertised as `interrupt_cancel_queued_v1`;
 * older runtimes ignore the field, which the per-uuid sweep afterwards covers.
 */
async function interruptTurn(session) {
  try {
    const response = typeof session.instance.request === 'function'
      ? (await session.instance.request({ subtype: 'interrupt', cancel_queued: true }))?.response
      : await session.instance.interrupt();

    for (const uuid of Array.isArray(response?.cancelled) ? response.cancelled : []) {
      settleCancelledInjection(session, uuid);
    }
  } catch (error) {
    console.warn(`interrupt() for ${session.sessionId} rejected:`, error?.message || error);
  }
}

/**
 * Cancels every injected message still parked in the runtime's queue, one by
 * one. Backstop for whatever `interruptTurn` did not sweep: an older runtime
 * without `interrupt_cancel_queued_v1`, or a message queued while no turn was
 * running. Each cancelled message is handed back through its `onCancelled`
 * callback so the gateway can return the text to the composer.
 */
async function cancelInjectedMessagesForSession(session) {
  if (!session?.injectedCommands?.size) return;

  for (const uuid of [...session.injectedCommands.keys()]) {
    if (await cancelInjectedClaudeMessage(session.sessionId, uuid)) {
      settleCancelledInjection(session, uuid);
    }
  }
}

/**
 * Handles the runtime's `command_lifecycle` narration for injected messages.
 * @returns {boolean} true when the message was a lifecycle event (consumed).
 */
function handleCommandLifecycle(session, message) {
  if (!message || message.type !== 'command_lifecycle' || !message.command_uuid) {
    return false;
  }

  // Uuids we never stamped (cron triggers, internal continuations) are none of
  // our business, but they're still lifecycle events — swallow them.
  const entry = session.injectedCommands.get(message.command_uuid);
  if (!entry) {
    return true;
  }

  if (message.state === 'started') {
    // The runtime picked the message up. If it folded it into the running turn
    // there is nothing to open; if it started a fresh turn for it, this opens
    // the run that turn streams into.
    ensureRunForServerStartedTurn(session, 'Sending your queued message');

    // Show the prompt in the transcript at the point it actually landed. The
    // durable copy is the runtime's own `queued_command` attachment row, which
    // replaces this on the next history load — keyed by the same uuid we
    // stamped the injection with (the runtime echoes it as `source_uuid`), so
    // the merge drops this live row by id instead of stacking a second bubble
    // once the transcript sync lands.
    if (entry.content.trim()) {
      session.writer.send(createNormalizedMessage({
        id: message.command_uuid,
        kind: 'text',
        role: 'user',
        content: entry.content,
        sessionId: session.sessionId,
        provider: 'claude',
      }));
    }
    entry.onDelivered?.();
    entry.onDelivered = null;
    return true;
  }

  if (message.state === 'completed' || message.state === 'cancelled') {
    session.injectedCommands.delete(message.command_uuid);
    if (message.state === 'cancelled') {
      entry.onCancelled?.();
    }
  }

  return true;
}

/**
 * Settles the current assistant turn — once. Driven by a `result` message
 * (onTurnEnd) and also by abort (which interrupts the turn). `awaitingResult` is
 * the idempotency guard: it is set when a turn starts (a user turn, an injected
 * resume, or any assistant output) and cleared here, so whichever path settles
 * first wins and the other is a no-op. Background jobs are kept running either
 * way — only the model's turn stops. The terminal `complete` ends the current
 * chat-run (so the next turn can open a new one); when aborted the gateway emits
 * the (aborted) completion, so we don't send our own.
 * @param {Object} session
 * @param {{aborted?: boolean}} opts
 */
function settleTurn(session, { aborted = false } = {}) {
  if (!session.awaitingResult) return;
  session.awaitingResult = false;
  session.turnActive = false;
  session.turnStartTime = null;
  recordRestoreState(session, false);

  // Any task still pending after a turn boundary is genuinely backgrounded —
  // mark it so its completion later triggers an auto-resume.
  for (const task of session.pendingTasks.values()) {
    task.background = true;
  }

  if (!aborted) {
    const isNewSession = session.startedNew && !session.firstTurnCompleted;
    session.firstTurnCompleted = true;
    session.writer.send(createNormalizedMessage({
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

  // A turn the usage limit cut off is unfinished work waiting on the clock:
  // schedule its wake (the service notifies the user in place of the ordinary
  // stop ping) and leave the session to the idle reaper, which stands down
  // from nudging while the wake is pending.
  if (!aborted && scheduleWakeForRateLimitedTurn(session)) {
    armIdleTimer(session);
    completeTurn(session);
    return;
  }
  session.rateLimitHit = null;

  // Truly idle now: notify (once per idle transition, matching the old
  // per-query behaviour), carrying the turn's recap + tools used.
  notifyRunStopped({
    userId: session.userId,
    provider: 'claude',
    sessionId: session.sessionId,
    sessionName: session.sessionSummary,
    stopReason: aborted ? 'aborted' : 'completed',
    recap: aborted ? '' : session.lastAssistantText,
    toolNames: aborted ? [] : session.turnToolNames,
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
function onTurnEnd(session) {
  settleTurn(session, { aborted: false });
  queueRecapForSession(session);
}

/**
 * Queues the background title/recap refresh for a finished turn.
 *
 * Skipped for ephemeral sessions — those ARE the helper calls (commit messages,
 * and the recap generation itself), so summarising them would have each recap
 * schedule another one.
 */
function queueRecapForSession(session) {
  if (session.ephemeral) return;

  const sessionId = session.sessionId || session.options?.sessionId;
  const cwd = session.options?.cwd;
  if (!sessionId || !cwd) return;

  scheduleSessionRecap({
    sessionId,
    cwd,
    // Injected rather than imported by the service, which would close a cycle
    // back into this module.
    runQuery: queryClaudeSDK,
    onRecap: (result) => {
      // The turn is long over by now, so this rides the session's writer only
      // if it is still attached; a closed one is not an error.
      try {
        session.writer?.send?.(createNormalizedMessage({
          kind: 'status',
          text: 'session_recap',
          sessionRecap: result,
          sessionId: result.sessionId,
          provider: 'claude',
        }));
      } catch {
        // Client gone — the recap is in the database either way, and the next
        // projects refresh carries it.
      }
      // Everyone else — the sidebar in this tab and every other client — hears
      // about it through the same per-session delta the transcript watcher
      // uses. The recap is a database write with no file change behind it, so
      // without this nothing would ever be told.
      broadcastSessionUpdate(result.sessionId);
    },
  });
}

/**
 * Builds the `canUseTool` permission callback bound to a persistent session.
 * Reads the session's live id, the (mutable) allow/deny lists carried on its
 * sdkOptions, and streams prompts to the session's current writer.
 */
function makeCanUseTool(session, sdkOptions, emitNotification) {
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
    session.writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: sid(), provider: 'claude' }));
    emitNotification(createNotificationEvent({
      provider: 'claude',
      sessionId: sid(),
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName, toolDetail: describeTool(toolName, input), sessionName: session.sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `claude:permission:${sid() || 'none'}:${requestId}`
    }));

    // Persist the parked interactive prompt so a hard kill (deploy restart,
    // crash) doesn't silently destroy an unanswered question: the restore boot
    // pass reads it and instructs the resumed agent to re-ask. Cleared below
    // on every in-process settle (answer, deny, cancel, abort).
    if (requiresInteraction && !session.ephemeral) {
      recordPendingInteraction(sid(), { toolName, input }).catch(() => {});
    }

    const decision = await waitForToolApproval(requestId, {
      // Interactive prompts wait indefinitely even if the env var reinstates a
      // bound for ordinary tools: there is no sane way to answer a question on
      // the user's behalf.
      timeoutMs: requiresInteraction ? 0 : undefined,
      signal: context?.signal,
      metadata: {
        _sessionId: sid(),
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
      },
      onCancel: (reason) => {
        session.writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: sid(), provider: 'claude' }));
      }
    });
    if (requiresInteraction && !session.ephemeral) {
      recordPendingInteraction(sid(), null).catch(() => {});
    }
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

      // Approving ExitPlanMode ends plan mode, and the runtime picks `default`
      // on its own unless told otherwise — so a bypassPermissions the user
      // selected while reading the plan was dropped the moment they hit Build,
      // and the build phase prompted for every tool. The client sends the mode
      // to continue in with that approval; apply it before allowing, so the
      // very first tool of the build phase already sees it.
      //
      // Both gates matter, as in the mid-session switch in resumePersistentSession:
      // this callback reads sdkOptions.permissionMode, and setPermissionMode
      // moves the SDK's own permission step.
      if (requiresInteraction && typeof decision.permissionMode === 'string' && decision.permissionMode) {
        try {
          if (sdkOptions.permissionMode !== decision.permissionMode) {
            sdkOptions.permissionMode = decision.permissionMode;
            if (session.instance?.setPermissionMode) {
              await session.instance.setPermissionMode(decision.permissionMode);
            }
          }
        } catch (error) {
          // A failed switch must not turn an approved plan into a denied tool.
          console.warn(`setPermissionMode after ${toolName} approval failed:`, error?.message || error);
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
 * closes. Final cleanup happens in `finally`. All output goes to the session's
 * CURRENT writer, which is swapped per turn (user turn / auto-resume run).
 */
async function runSessionLoop(session) {
  try {
    for await (const message of session.instance) {
      // Capture the session id from the first message of a brand-new session.
      if (message.session_id && !session.sessionId) {
        registerSession(message.session_id, session);
        if (session.writer.setSessionId && typeof session.writer.setSessionId === 'function') {
          session.writer.setSessionId(message.session_id);
        }
        if (session.startedNew && !session.sessionCreatedSent) {
          session.sessionCreatedSent = true;
          session.writer.send(createNormalizedMessage({ kind: 'session_created', newSessionId: message.session_id, sessionId: message.session_id, provider: 'claude' }));
        }
      }

      const sid = session.sessionId || session.options.sessionId || null;

      // Any assistant output means a turn is in flight — (re)arm the settle
      // guard so this turn's `result` is honored, including queued resume turns
      // that begin after a previous turn already settled.
      if (message.type === 'assistant') {
        // A fresh turn: reset the recap capture so a stale prior answer isn't
        // reused in this turn's "stopped" notification.
        if (!session.awaitingResult) {
          session.lastAssistantText = '';
          session.turnToolNames = [];
          session.lastActivityText = undefined;
          session.rateLimitHit = null;
        }
        session.awaitingResult = true;
        captureAssistantSummary(session, message);

        // Narrate the turn in the activity indicator. Without this the UI only
        // ever cycles generic words ("Thinking", "Working"), so a long tool run
        // looks identical to a stalled one. A prose-only message clears the
        // label back to those words, which is what the model is actually doing.
        const activityText = describeAssistantActivity(message);
        if (activityText !== session.lastActivityText) {
          session.lastActivityText = activityText;
          session.writer.send(createNormalizedMessage({
            kind: 'status',
            text: activityText,
            canInterrupt: true,
            sessionId: sid,
            provider: 'claude',
          }));
        }
      }

      // Usage limits: the runtime narrates a rejected request as a synthetic
      // assistant message flagged `error: 'rate_limit'`, and separately emits
      // `rate_limit_event`s carrying the reset time. Both feed settleTurn's
      // wake scheduling (see noteRateLimitHit).
      trackRateLimit(session, message);

      // Drive background-job tracking / auto-resume off the task system messages.
      await handleTaskMessage(session, message);

      // Mid-turn user messages the runtime parked in its own command queue.
      // Not a provider message — it narrates delivery, so it never reaches the
      // normalizer.
      if (handleCommandLifecycle(session, message)) {
        continue;
      }

      // Compaction: narrate the phase, and re-read the gauge once the seam
      // lands so the user sees the window actually drop.
      if (handleCompactionStatus(session, message) && message.compact_result) {
        refreshContextUsage(session, 'post-compact');
      }
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        refreshContextUsage(session, 'compact-boundary');
      }

      // Seed the gauge from the runtime at the start of the session instead of
      // leaving it on the offline estimate until the first turn finishes —
      // turns can run for minutes. Only the first init: the runtime re-inits
      // every turn (and after a compaction), and those readings are already
      // covered by the turn-end probe.
      // Protocol capabilities are feature-detected, not version-sniffed — the
      // mid-turn delivery path needs `msg_lifecycle_v1` to know when the
      // runtime picks a message up.
      if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.capabilities)) {
        session.capabilities = message.capabilities;
      }

      // Keep `session.model` honest. It is seeded from the *requested* model,
      // but a resume deliberately sends no `--model` so the conversation keeps
      // the one it already ran on — which means the seed can name a model the
      // CLI is not running. That lie made the mid-session switch skip itself
      // ("already on Opus") while the runtime happily carried on with Fable,
      // and the user's pick could never take. The runtime re-inits every turn
      // and after every compaction, so this is also what re-asserts the pick
      // if a compaction resets the model underneath us.
      if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string' && message.model.trim()) {
        session.model = normalizeClaudeModelToCatalogValue(message.model);
      }

      if (message.type === 'system' && message.subtype === 'init' && !session.contextUsageSeeded) {
        session.contextUsageSeeded = true;
        refreshContextUsage(session, 'init');
      }

      // Transform and normalize the message, then fan out to the current writer.
      const transformedMessage = transformMessage(message);
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        // Subagent-internal (sidechain) messages don't belong in the main
        // thread — the subagent's prompt would otherwise render as if the user
        // typed it. They stay available via the subagent thread viewer, which
        // reads the subagent transcript directly. Keep the parent Task card
        // (no parentToolUseId) so the subagent is still represented inline.
        if (msg.parentToolUseId) continue;
        session.writer.send(msg);
      }

      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        session.writer.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: sid, provider: 'claude' }));
      }

      // A `result` marks the end of one assistant turn.
      if (message.type === 'result') {
        // Read the gauge at the turn boundary — the point where the context has
        // just grown by a whole turn and the user decides what to do next.
        refreshContextUsage(session, 'turn-end');
        onTurnEnd(session);
      }
    }
  } catch (error) {
    if (!session.ended) {
      await handleSessionError(session, error);
    }
  } finally {
    finalizeSession(session);
  }
}

/** Loop teardown: drop tracking, clear timers, remove temp files. */
function finalizeSession(session) {
  if (session.finalized) return;
  session.finalized = true;

  // Any message still parked in the runtime's queue died with it — hand each
  // back so its text returns to the composer instead of sitting in the queue
  // card forever, waiting for a runtime that will never pick it up.
  for (const uuid of [...session.injectedCommands?.keys() ?? []]) {
    settleCancelledInjection(session, uuid);
  }

  // NOTE: a queued recap is deliberately NOT cancelled here. It reads the
  // transcript from disk and makes its own one-shot call, so it needs nothing
  // from this session — and sessions are torn down on idle, which is exactly
  // the quiet the debounce is waiting for. Cancelling here would mean the
  // recap almost never ran.

  // A turn that dies before its `result` — the SDK stream throws, or the
  // session is torn down mid-turn — never reaches settleTurn, so the run it
  // was streaming into stays `running` in the registry forever: every client
  // shows the session as processing, the next send bounces off
  // RUN_IN_PROGRESS, and /health's activeSessions never falls back to zero.
  // `chat.send` and the queue drain each have this safety net in their own
  // `finally` (completeRunIfCurrent / completeRun); a background auto-resume
  // opens its run from down here — via `acquireResumeRun` — and had none, so
  // two oqto sessions whose CLI died under an auto-resume left the count
  // pinned at 2 for days.
  //
  // The registry drops a duplicate terminal `complete`, so emitting one here
  // is a no-op on every path that already settled.
  if ((session.awaitingResult || session.turnActive) && !session.handedOffToRetry) {
    session.awaitingResult = false;
    session.turnActive = false;
    try {
      session.writer.send(createCompleteMessage({
        provider: 'claude',
        sessionId: session.sessionId || session.options.sessionId || null,
        exitCode: 1,
      }));
    } catch (error) {
      console.warn(`[claude] session ${session.sessionId}: terminal complete on teardown failed:`, error?.message || error);
    }
  }

  completeTurn(session);
  session.finalizeDeferred?.resolve();
  clearIdleTimer(session);
  if (session.sessionId && getSession(session.sessionId) === session) {
    removeSession(session.sessionId);
  }
}

/**
 * Surfaces a fatal session error to the client, with the same recovery paths as
 * the original per-query implementation (resume fallback, prompt-too-long, etc).
 */
async function handleSessionError(session, error) {
  console.error('SDK query error:', error);
  const sessionId = session.options.sessionId;
  const sid = session.sessionId || sessionId || null;

  // Some SDK/CLI versions throw after exhausting their short internal 529
  // retry instead of emitting a synthetic assistant row + result. Hand that
  // shape to the same durable five-minute loop and suppress the ordinary
  // terminal failure notification; this is a pause, not a final failure.
  if (isClaude529Error(error) && sid && !session.ephemeral) {
    try {
      await scheduleRateLimitWake({
        provider: 'claude',
        providerSessionId: sid,
        userId: session.userId,
        sessionName: session.sessionSummary,
        limitType: 'http_529',
        limitText: error?.message || String(error),
        permissionMode: session.options?.permissionMode ?? null,
        recoveryKind: 'claude-529',
        messageId: session.currentRateLimitWakeMessageId ?? null,
        priorAttempts: session.currentRateLimitWakeAttempts ?? 0,
      });
      session.writer.send(createNormalizedMessage({
        kind: 'error',
        content: 'Claude is temporarily overloaded (HTTP 529). VibeSpace will retry this session in five minutes and keep retrying until it succeeds.',
        sessionId: sid,
        provider: 'claude',
      }));
      return;
    } catch (scheduleError) {
      console.warn(`[claude] session ${sid}: scheduling the HTTP 529 retry failed:`, scheduleError?.message || scheduleError);
    }
  }

  // A session jsonl that holds only bridge/system metadata has no conversation
  // Claude can resume — the SDK fails with "No conversation found". Retry once
  // as a brand-new session in the same cwd so the message isn't silently dropped.
  const notResumable = /No conversation found with session ID/i.test(String(error?.message || ''));
  if (notResumable && sessionId && !session.options._resumeFallback) {
    console.warn(`Session ${sessionId} is not resumable, starting a new session instead`);
    // The retry below streams into THIS session's writer — the same chat-run.
    // Its teardown must therefore not emit the run's terminal `complete`, or
    // the run ends (and gets evicted) while the replacement query is still
    // streaming into it.
    session.handedOffToRetry = true;
    session.writer.send(createNormalizedMessage({
      kind: 'error',
      content: 'This session has no resumable conversation — sending your message to a new session instead.',
      sessionId,
      provider: 'claude'
    }));
    // finalizeSession (the loop's finally) will untrack this dead session.
    await queryClaudeSDK(session.command, { ...session.options, sessionId: undefined, resume: false, _resumeFallback: true }, session.writer);
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

  session.writer.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: sid, provider: 'claude' }));
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
 * alive while the conversation continues. The session's writer is swapped to
 * this turn's run writer so its output streams under the new run.
 */
async function reuseSession(session, command, options, ws) {
  // Stream this turn's output (and any background-job resume that begins during
  // it) to the run the gateway just opened.
  session.writer = ws;
  if (options.acquireResumeRun) {
    session.acquireResumeRun = options.acquireResumeRun;
  }
  session.currentRateLimitWakeMessageId = options.rateLimitWakeMessageId ?? null;
  session.currentRateLimitWakeAttempts = options.rateLimitWakeAttempts ?? 0;

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

  // Apply a mid-session model switch if the user changed it — and *only* then.
  // This session is warm, so it already has a model; `options.model` is just
  // the composer's per-provider default riding along on every message, and
  // honouring it here is what switched sessions the user never touched, so the
  // helper deliberately ignores it and looks only at the stored pick.
  await applyPendingModelSwitch(session);

  // Apply a mid-session reasoning-effort switch. Like the permission mode, the
  // effort rides on every user message but the live session keeps whatever it
  // was spawned with, so picking a new level from the composer would otherwise
  // only change the label. Validated against the (possibly just switched) model
  // so an unsupported level falls back to the model's own default.
  try {
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch {
      // Static catalog is a fine fallback for validation.
    }
    const wantedEffort = resolveClaudeEffort(session.model, options.effort, effortModels);
    if (session.sdkOptions && wantedEffort !== session.sdkOptions.effort) {
      session.sdkOptions.effort = wantedEffort;
      if (session.instance?.applyFlagSettings) {
        // null clears the flag layer so the model's default effort applies again.
        await session.instance.applyFlagSettings({ effortLevel: wantedEffort ?? null });
      }
    }
  } catch (err) {
    console.warn(`effort switch during reuse for ${session.sessionId} failed:`, err?.message || err);
  }

  // Apply a mid-session permission mode switch. The mode rides on every user
  // message, but the live SDK session keeps whatever it was spawned with, so a
  // later default→bypassPermissions change would otherwise be silently ignored
  // and tools would still prompt.
  try {
    const settings = options.toolsSettings || {};
    let wantedMode = options.permissionMode || 'default';
    if (settings.skipPermissions && wantedMode !== 'plan') wantedMode = 'bypassPermissions';
    const currentMode = session.sdkOptions?.permissionMode || 'default';
    if (session.sdkOptions && wantedMode !== currentMode) {
      // Both gates: canUseTool reads sdkOptions.permissionMode, and
      // setPermissionMode moves the SDK's own permission step.
      session.sdkOptions.permissionMode = wantedMode;
      if (session.instance?.setPermissionMode) {
        await session.instance.setPermissionMode(wantedMode);
      }
    }
  } catch (err) {
    console.warn(`setPermissionMode during reuse for ${session.sessionId} failed:`, err?.message || err);
  }

  // Attachments ride along as content blocks read from the assets store.
  const turnContent = await buildTurnContent(command, options.images, options.cwd);

  clearIdleTimer(session);
  session.turnActive = true;
  session.turnStartTime = Date.now();
  session.lastUserTurnAt = Date.now();
  recordRestoreState(session, true);
  if (options.sessionSummary) session.sessionSummary = options.sessionSummary;

  const turnPromise = beginTurn(session);
  const pushed = session.input.push(makeUserMessage(turnContent));
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

  // A resumed conversation keeps the model it already ran on unless an
  // override says otherwise; only a genuinely new one starts on the composer's
  // per-provider default. `undefined` means "send no --model", which is what
  // makes the resume inherit the transcript's own model.
  const resolvedModel = await providerModelsService.resolveResumeModel(
    'claude',
    sessionId,
    options.model,
    { resuming: options.resume === true },
  );
  // Validate any requested reasoning effort against the live model catalog
  // (falls back to the static definition when the catalog can't be loaded).
  let effortModels = CLAUDE_FALLBACK_MODELS;
  try {
    effortModels = (await providerModelsService.getProviderModels('claude')).models;
  } catch (error) {
    console.warn('[Claude SDK] Unable to load provider models for effort validation:', error?.message || error);
  }
  const sdkOptions = mapCliOptionsToSDK({ ...options, model: resolvedModel, effortModels });

  const mcpServers = await loadMcpConfig(options.cwd);
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  const firstTurnContent = await buildTurnContent(command, options.images, options.cwd);

  const input = createInputController();
  const session = {
    sessionId: sessionId || null,
    instance: null,
    input,
    writer: ws,
    // Opens a fresh chat-run for a background auto-resume turn (null in tests /
    // one-shot callers, where the current writer is reused instead).
    acquireResumeRun: typeof options.acquireResumeRun === 'function' ? options.acquireResumeRun : null,
    // The selected catalog value, not sdkOptions.model — the latter is absent
    // for "default" (see mapCliOptionsToSDK), and effort validation plus the
    // mid-session switch in reuseSession both need something to compare against.
    // Only a seed: a resume sends no `--model` at all, so what the conversation
    // actually runs on is whatever its transcript says — the runtime's first
    // `init` corrects this (see runSessionLoop).
    model: resolvedModel || options.model || CLAUDE_FALLBACK_MODELS.DEFAULT,
    // Kept on the session so reuseSession can apply mid-session permission mode
    // switches (canUseTool reads permissionMode from this same object).
    sdkOptions,
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
    // When the user last spoke (first turn, reuse, mid-turn injection — not
    // supervisor nudges or background-task resumes). A waitingOnUser task
    // marker older than this is stale: the user has since replied.
    lastUserTurnAt: Date.now(),
    lastAssistantText: '',
    turnToolNames: [],
    toolUseCount: 0,
    // Task-nudge bookkeeping (see maybeContinueOpenTasks).
    taskNudges: { count: 0, stalls: 0, fingerprint: null, toolCount: 0 },
    // Usage-limit bookkeeping (see noteRateLimitHit / settleTurn): the hit
    // recorded for the turn in flight, and the latest rate_limit_event.
    rateLimitHit: null,
    lastRateLimitInfo: null,
    // Identifies a server-owned retry incident for the current turn. A manual
    // user turn clears both values in reuseSession.
    currentRateLimitWakeMessageId: options.rateLimitWakeMessageId ?? null,
    currentRateLimitWakeAttempts: options.rateLimitWakeAttempts ?? 0,
    // Last label pushed to the activity indicator, so repeat tool calls of the
    // same shape don't spam identical status messages down the socket.
    lastActivityText: undefined,
    firstTurnCompleted: false,
    sessionCreatedSent: false,
    currentTurn: null,
    pendingTasks: new Map(),
    // uuid -> { content, onDelivered, onCancelled } for messages fed into a
    // running turn (see "Mid-turn user messages" above).
    injectedCommands: new Map(),
    // Protocol capabilities the runtime advertised on system/init.
    capabilities: null,
    idleTimer: null,
    ended: false,
    finalized: false,
    finalizeDeferred: createDeferred(),
  };

  const emitNotification = (event) => {
    notifyUserIfEnabled({ userId: session.userId, writer: session.writer, event });
  };

  sdkOptions.hooks = {
    Notification: [{
      matcher: '',
      hooks: [async (hookInput) => {
        const message = typeof hookInput?.message === 'string' ? hookInput.message : 'Claude requires your attention.';
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
  sdkOptions.canUseTool = makeCanUseTool(session, sdkOptions, emitNotification);

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

  // Feed the first user turn, then run the loop for the session's whole life.
  // The returned promise resolves when this first turn completes; the loop keeps
  // running in the background for later turns and background-job resumes.
  console.log('Starting persistent streaming session for:', sessionId || 'NEW');
  const turnPromise = beginTurn(session);
  input.push(makeUserMessage(firstTurnContent));
  void runSessionLoop(session);
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

  // A new turn supersedes a pending usage-limit wake: whoever sent it (the
  // user, or the wake itself, which consumes its entry before enqueueing) is
  // driving now. If this turn hits the limit too, settleTurn re-records.
  if (sessionId && !options.ephemeral) {
    cancelRateLimitWake(sessionId).catch(() => {});
  }

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
      if (result.startFresh) {
        // First-turn edit — nothing resumable precedes the edited message, so
        // start a brand-new session.
        return await startPersistentSession(command, { ...baseOptions, sessionId: undefined, resume: false }, ws);
      }
      if (!result.ok) {
        // The truncation failed (anchor not found / transcript unreadable).
        // Degrade to resuming with the history INTACT — the edited message is
        // appended instead of replacing its original. Never fall back to a
        // blank session here: that silently discards the whole conversation
        // and orphans the old transcript once the new provider id is mapped.
        console.warn(`Rewind for session ${sessionId} did not truncate; resuming with full history.`);
        return await startPersistentSession(command, { ...baseOptions, resume: true }, ws);
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

    // Interrupt the in-flight turn, sweeping anything the user queued during
    // it. The streaming query stays alive for future turns and for background
    // jobs launched this turn.
    if (session.turnActive && session.instance) {
      await interruptTurn(session);
    }

    // Backstop for messages the interrupt didn't sweep (or an abort with no
    // turn running): stop means stop, so nothing the user queued may start a
    // new turn seconds later.
    await cancelInjectedMessagesForSession(session);

    // Settle the turn now (keeps the session alive; reconciles background jobs).
    // The gateway emits the aborted terminal `complete`, so settleTurn skips it.
    settleTurn(session, { aborted: true });
    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    cancelPendingApprovalsForSession(sessionId);
    return false;
  }
}

/**
 * Returns the authoritative set of background jobs currently running for a
 * session — the ground truth the client can't reliably derive from the message
 * stream (some task completions are delivered as internal transcript entries the
 * UI never sees, leaving derived tasks stuck "running"). Empty when the session
 * isn't live in memory (e.g. after a server restart the jobs are gone).
 * @param {string} sessionId - App/provider session identifier
 * @returns {Array<{taskId: string, description: string}>}
 */
function getClaudeSDKBackgroundTasks(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.pendingTasks) return [];
  const out = [];
  for (const [taskId, task] of session.pendingTasks.entries()) {
    out.push({ taskId, description: (task && task.description) || '' });
  }
  return out;
}

/**
 * Cancels a single background bash job by its task id, without touching the
 * model's turn or the session. Uses the SDK's `stopTask` control request
 * (`{subtype:"stop_task"}`) — the same mechanism Claude Code's KillShell uses —
 * so only the targeted job dies; other jobs and the agent keep running.
 * @param {string} sessionId - App/provider session identifier
 * @param {string} taskId - Background task id (as announced at launch)
 * @returns {Promise<boolean>} True if the request was dispatched to a live session
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session) {
    console.log(`stopTask: session ${sessionId} not found`);
    return false;
  }
  if (!taskId || typeof session.instance?.stopTask !== 'function') {
    console.warn(`stopTask: session ${sessionId} cannot stop task ${taskId} (no stopTask support)`);
    return false;
  }
  try {
    console.log(`[claude bg] session ${sessionId}: stopping background task ${taskId}`);
    await session.instance.stopTask(taskId);
    // Reconcile local bookkeeping; the SDK also emits a task_updated/killed the
    // stream loop already handles, but dropping it here avoids a spurious
    // auto-resume if that event races.
    session.pendingTasks?.delete(taskId);
    return true;
  } catch (error) {
    console.error(`stopTask for ${sessionId}/${taskId} failed:`, error?.message || error);
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
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
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
  __setRewindHistoryImpl
};
