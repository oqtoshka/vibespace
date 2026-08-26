#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { execFile } from 'child_process';

// cross-spawn is a drop-in for child_process.spawn that resolves .cmd
// shims/PATHEXT on Windows and delegates to the native spawn elsewhere.
import spawn from 'cross-spawn';
import express from 'express';
import cors from 'cors';
import mime from 'mime-types';
import Database from 'better-sqlite3';

import { AppError, WORKSPACES_ROOT, getOpenCodeDatabasePath, resolveConfiguredContextWindow, validateWorkspacePath } from '@/shared/utils.js';
import { recallContextUsage } from '@/shared/context-usage-cache.js';
import { buildCodexTokenBudget } from '@/shared/codex-token-usage.js';
import { validateAccessiblePath, validatePathInProject } from './utils/allowedPaths.js';
import { closeSessionsWatcher, initializeSessionsWatcher, registerPendingCliSession, registerSessionShredDependencies } from '@/modules/providers/index.js';
import { getSubagentConversation } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { registerChatDependenciesAtBoot, serverEnqueueMessage } from '@/modules/websocket/index.js';
import { forgetRateLimitWake, startRateLimitWakeLoop } from '@/services/rate-limit-wake.service.js';
import { cancelSessionRecap } from '@/services/session-recap.service.js';
import { forgetSession as forgetRestoreEntry, restoreInterruptedSessions } from '@/services/session-restore.service.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import {
    queryClaudeSDK,
    injectClaudeMessage,
    cancelInjectedClaudeMessage,
    abortClaudeSDKSession,
    stopClaudeSDKTask,
    getClaudeSDKBackgroundTasks,
    isClaudeSDKSessionAlive,
    resolveToolApproval,
    getPendingApprovalsForSession,
} from './claude-sdk.js';
import {
    spawnCursor,
    abortCursorSession,
} from './cursor-cli.js';
import {
    queryCodex,
    injectCodexMessage,
    abortCodexSession,
} from './openai-codex.js';
import {
    spawnOpenCode,
    abortOpenCodeSession,
} from './opencode-cli.js';
import { encodePlantUmlSource, inlinePlantUmlIncludes } from './utils/plantuml.js';
import { renderDbmlToSvg } from './utils/dbml.js';
import {
    stripAnsiSequences,
    normalizeDetectedUrl,
    extractUrlsFromText,
    shouldAutoOpenUrlFromOutput,
} from './utils/url-detection.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import cursorRoutes from './routes/cursor.js';
import taskmasterRoutes from './routes/taskmaster.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import userRoutes from './routes/user.js';
import pluginsRoutes from './routes/plugins.js';
import providerRoutes from './modules/providers/provider.routes.js';
import voiceRoutes from './voice-proxy.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { startEnabledPluginServers, stopAllPlugins, getPluginPort } from './utils/plugin-process-manager.js';
import { scanPlugins, getPluginsDir } from './utils/plugin-loader.js';
import { initializeDatabase, projectsDb, sessionsDb, fileSharesDb, appConfigDb } from './modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
    activateHostExtensions,
    deactivateHostExtensions,
    getHostExtensionRouter,
} from '@/modules/plugins/index.js';
import crypto from 'crypto';
import { configureWebPush } from './services/vapid-keys.js';
import { validateApiKey, authenticateToken, authenticateWebSocket, readWorkerIdentity, JWT_SECRET } from './middleware/auth.js';
import jwt from 'jsonwebtoken';
import {
    resolvePreviewModel,
    resolvePreviewAssetPath,
    isTextAsset,
    rewriteAssetReferences,
    resolveCustomRenderer,
    wireFlowCrossLinks,
} from './utils/htmlPreview.js';
import { IS_PLATFORM, IS_WORKER_MODE } from './constants/config.js';
import { c } from './utils/colors.js';

const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const MAX_FILE_UPLOAD_SIZE_MB = 200;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_COUNT = 20;

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

function readUsageNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

const app = express();
const server = http.createServer(app);

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
const webSocketDependencies = {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
        isWorkerMode: IS_WORKER_MODE,
        resolveWorkerUser: (request) => {
            const user = readWorkerIdentity(request);
            return user ? { id: user.id, userId: user.id, username: user.username } : null;
        },
    },
    chat: {
        spawnFns: {
            claude: queryClaudeSDK,
            cursor: spawnCursor,
            codex: queryCodex,
            opencode: spawnOpenCode,
        },
        abortFns: {
            claude: abortClaudeSDKSession,
            cursor: abortCursorSession,
            codex: abortCodexSession,
            opencode: abortOpenCodeSession,
        },
        // Per-background-job cancel. Only Claude's SDK exposes a task-level stop
        // (`stopTask`); other providers have no equivalent, so they're omitted
        // and the handler no-ops for them.
        stopTaskFns: {
            claude: stopClaudeSDKTask,
        },
        // Mid-turn message delivery. Claude and Codex can fold a user message
        // into the currently running turn; other providers fall back to the
        // server-drained queue.
        injectFns: {
            claude: injectClaudeMessage,
            codex: injectCodexMessage,
        },
        cancelInjectedFns: {
            claude: cancelInjectedClaudeMessage,
        },
        resolveToolApproval,
        getPendingApprovalsForSession,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
        registerPendingCliSession,
        stripAnsiSequences,
        normalizeDetectedUrl,
        extractUrlsFromText,
        shouldAutoOpenUrlFromOutput,
    },
    getPluginPort,
};

const wss = createWebSocketServer(server, webSocketDependencies);

// Server-initiated runs (a plugin host module driving a queue, the boot
// restore below) need the provider spawn functions before any browser has
// connected: per-connection registration alone would leave a boot-spawned
// session's first message enqueued forever.
registerChatDependenciesAtBoot(webSocketDependencies.chat);
// Shred reaches the legacy runtime registries through hooks, same reason as
// the chat dependencies above: the module graph does not import server/services.
registerSessionShredDependencies({ forgetRestoreEntry, forgetRateLimitWake, cancelSessionRecap });

// Restore every provider through the ordinary server-owned queue. The session
// row chooses Claude/Codex/OpenCode and supplies cwd/privacy exactly as a live
// send does; keeping this at the entrypoint avoids the old Claude-only boot
// hook and makes restored turns visible/replayable to clients from the start.
if (!process.env.NODE_TEST_CONTEXT) {
    const bootRestoreTimer = setTimeout(() => {
        restoreInterruptedSessions(null, {
            startTurn: (entry, prompt) => {
                const row = sessionsDb.getSessionByProviderSessionId(entry.sessionId);
                if (!row) return false;
                const options = {
                    ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
                    ...(entry.cwd ? { cwd: entry.cwd } : {}),
                };
                return serverEnqueueMessage(row.session_id, prompt, options, { userId: entry.userId ?? null });
            },
        }).catch((error) => {
            console.error('[session restore] boot pass failed:', error?.message || error);
        });
    }, 8000);
    bootRestoreTimer.unref?.();
}

// Sessions parked on a provider usage limit resume through the same
// server-owned queue once the limit resets (see rate-limit-wake.service): the
// session row supplies provider/cwd/privacy, the entry supplies the rest.
startRateLimitWakeLoop({
    startTurn: (entry, prompt) => {
        const row = sessionsDb.getSessionByProviderSessionId(entry.providerSessionId);
        if (!row) return false;
        const options = {
            ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
            // Carried through the provider turn so a recurring Claude 529 can
            // re-arm the same durable incident and reuse one UI message.
            rateLimitWakeMessageId: entry.messageId,
            rateLimitWakeAttempts: entry.attempts,
        };
        return serverEnqueueMessage(row.session_id, prompt, options, { userId: entry.userId ?? null });
    },
}).catch((error) => {
    console.error('[rate-limit wake] failed to start scheduler:', error?.message || error);
});

// Make WebSocket server available to routes
app.locals.wss = wss;

app.use(cors({ exposedHeaders: ['X-Refreshed-Token'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    // Active = a turn currently processing (safe-to-restart signal for deploys).
    // Post-unification, all provider runs are tracked in the chat run registry.
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        activeSessions: chatRunRegistry.listRunningRuns().length,
        version: RUNNING_VERSION
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Read a background task's output file (Claude Code `run_in_background` writes to
// <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output). Scoped hard to that
// shape so it can't read arbitrary files: parent dir must be `tasks`, basename
// must be `<id>.output`, and the path must sit under a `claude-` tmp namespace.
app.get('/api/tasks/output', authenticateToken, async (req, res) => {
    try {
        const file = typeof req.query.path === 'string' ? req.query.path : '';
        if (!file || file.includes('\0')) {
            return res.status(400).json({ error: 'path is required' });
        }
        const resolved = path.resolve(file);
        const base = path.basename(resolved);
        const parent = path.basename(path.dirname(resolved));
        if (parent !== 'tasks' || !/^[A-Za-z0-9_-]+\.output$/.test(base) || !/[\\/]claude-[^\\/]+[\\/]/.test(resolved)) {
            return res.status(403).json({ error: 'Not a task output file' });
        }
        const content = await fsPromises.readFile(resolved, 'utf8');
        // Cap the payload; tail is what matters for a running command.
        const MAX = 200_000;
        res.json({
            content: content.length > MAX ? content.slice(-MAX) : content,
            truncated: content.length > MAX,
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'Output not found' });
        }
        console.error('Error reading task output:', error);
        res.status(500).json({ error: error.message });
    }
});

// Authoritative running-background-job set for a session. The client can't
// reliably tell from the message stream which jobs are still running (some task
// completions arrive as internal transcript entries it never sees), so it polls
// this to reconcile — a "running" task absent here has actually finished.
app.get('/api/sessions/:sessionId/background-tasks', authenticateToken, (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessionsDb.getSessionById(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        // Only Claude's SDK tracks background jobs; other providers report none.
        if (session.provider !== 'claude') {
            return res.json({ running: [], live: false });
        }
        const providerSessionId = session.provider_session_id || sessionId;
        const running = getClaudeSDKBackgroundTasks(providerSessionId);
        // `live` distinguishes "session in memory, 0 jobs" from "session not
        // loaded" — the client only reconciles (marks stuck tasks done) when the
        // session is live, so a cold session doesn't wrongly clear everything.
        res.json({ running, live: isClaudeSDKSessionAlive(providerSessionId) });
    } catch (error) {
        console.error('Error listing background tasks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Full transcript of one subagent (Task) for the thread viewer — the prompt,
// the subagent's replies/thinking, and its tool calls. Subagent conversations
// are suppressed from the main thread, so this is how they're inspected.
app.get('/api/sessions/:sessionId/subagents/:agentId', authenticateToken, async (req, res) => {
    try {
        const { sessionId, agentId } = req.params;
        if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
            return res.status(400).json({ error: 'Invalid agent id' });
        }
        const session = sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const { found, messages } = await getSubagentConversation(sessionId, agentId);
        if (!found) {
            return res.status(404).json({ error: 'Subagent transcript not found' });
        }
        res.json({ messages });
    } catch (error) {
        console.error('Error reading subagent conversation:', error);
        res.status(500).json({ error: error.message });
    }
});

// HTML-preview asset route — MUST be registered before the /api/projects Bearer
// guard below, because iframe subresource requests (`<script src="/kit/...">`)
// can't send the app's Authorization header. It authenticates instead via a
// path-scoped cookie issued by POST /api/projects/:id/html-preview, whose signed
// payload carries the resolved web root + alias map.
const PREVIEW_COOKIE = 'vibespace_preview';

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}

app.get('/api/projects/:projectId/preview-fs/*', async (req, res) => {
    try {
        const { projectId } = req.params;
        const cookieToken = readCookie(req, PREVIEW_COOKIE) || req.query.token;
        if (!cookieToken) {
            return res.status(401).send('Preview session required');
        }
        let claims;
        try {
            claims = jwt.verify(cookieToken, JWT_SECRET);
        } catch {
            return res.status(401).send('Invalid preview session');
        }
        if (claims.projectId !== projectId || !claims.webRoot) {
            return res.status(403).send('Preview session mismatch');
        }

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).send('Project not found');
        }

        const reqPath = `/${req.params[0] || ''}`;
        const target = resolvePreviewAssetPath(reqPath, claims.webRoot, claims.aliases || {}, projectRoot);
        if (!target) {
            return res.status(403).send('Path outside project');
        }

        let stat;
        try {
            stat = await fsPromises.stat(target);
        } catch {
            return res.status(404).send('Not found');
        }
        if (stat.isDirectory()) {
            return res.status(404).send('Not found');
        }

        const assetBase = `/api/projects/${projectId}/preview-fs`;
        if (isTextAsset(target)) {
            const text = await fsPromises.readFile(target, 'utf8');
            const rewritten = rewriteAssetReferences(text, claims.aliases || {}, assetBase);
            res.type(mime.lookup(target) || 'text/plain');
            return res.send(rewritten);
        }
        res.type(mime.lookup(target) || 'application/octet-stream');
        return res.send(await fsPromises.readFile(target));
    } catch (error) {
        console.error('Error serving preview asset:', error);
        res.status(500).send('Preview error');
    }
});

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat image asset upload/serving (global ~/.vibespace/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// MCP utilities
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// Routes contributed by plugin host modules (manifest `hostModule`). Mounted
// here, ahead of the SPA catch-all, so a plugin can own a path like
// /api/<integration>/... exactly as a core route would; each plugin applies
// its own authentication.
app.use(getHostExtensionRouter());

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

app.use('/api/voice', authenticateToken, voiceRoutes);

// Debug log sink — unauthenticated, fire-and-forget client telemetry for
// reproducing iOS bugs without Web Inspector. Body is `{ events: [...] }`.
// Also tee client debug events to a stable JSONL file so they can be read
// back after the fact (the daemon's stdout isn't always easy to reach).
const CLIENT_DEBUG_LOG_PATH = path.join(os.tmpdir(), 'vibespace-client-debug.log');
app.post('/api/debug-log', express.json({ limit: '256kb' }), (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    const lines = [];
    for (const ev of events) {
        try {
            const line = JSON.stringify(ev);
            console.log('[DBG]', line);
            lines.push(line);
        } catch {
            console.log('[DBG] <unserializable>');
        }
    }
    if (lines.length > 0) {
        // Fire-and-forget append; never block or fail the response on IO.
        fs.appendFile(CLIENT_DEBUG_LOG_PATH, lines.join('\n') + '\n', () => {});
    }
    res.status(204).end();
});

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // `no-cache` (revalidate every request) avoids stale HTML after a
            // build. We avoid `no-store` because that hard-disqualifies iOS
            // Safari's bfcache, which is the main lever we have against the
            // multi-second white screen on background→foreground.
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// System update endpoint
app.post('/api/system/update', authenticateToken, async (req, res) => {
    try {
        // Get the project root directory (parent of server directory)
        const projectRoot = APP_ROOT;

        console.log('Starting system update from directory:', projectRoot);

        // Platform deployments use their own update workflow from the project root.
        const updateCommand = IS_PLATFORM
        // In platform, husky and dev dependencies are not needed
            ? 'npm run update:platform'
            : installMode === 'git'
                ? 'git checkout main && git pull && npm install'
                : 'npm install -g @vibespace-ai/vibespace@latest';

        const updateCwd = IS_PLATFORM || installMode === 'git'
            ? projectRoot
            : os.homedir();

        const child = spawn('sh', ['-c', updateCommand], {
            cwd: updateCwd,
            env: process.env
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            console.log('Update output:', text);
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            console.error('Update error:', text);
        });

        child.on('close', (code) => {
            if (code === 0) {
                res.json({
                    success: true,
                    output: output || 'Update completed successfully',
                    message: 'Update completed. Please restart the server to apply changes.'
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Update command failed',
                    output: output,
                    errorOutput: errorOutput
                });
            }
        });

        child.on('error', (error) => {
            console.error('Update process error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        });

    } catch (error) {
        console.error('System update error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Open a session in the host machine's desktop Terminal (macOS only).
// The vibespace server runs on the user's Mac; this launches Terminal.app on
// that host and resumes the given provider session via its CLI. The client
// only shows the button when it detects it is itself running on macOS, but we
// re-check `process.platform` here since the host is the source of truth.
app.post('/api/open-in-terminal', authenticateToken, async (req, res) => {
    if (process.platform !== 'darwin') {
        return res.status(400).json({
            success: false,
            error: 'Opening a desktop terminal is only supported on macOS hosts',
        });
    }

    const { projectPath, sessionId, provider = 'claude' } = req.body || {};

    if (typeof projectPath !== 'string' || !projectPath.trim()) {
        return res.status(400).json({ success: false, error: 'projectPath is required' });
    }

    const resolvedProjectPath = path.resolve(projectPath);
    try {
        if (!fs.statSync(resolvedProjectPath).isDirectory()) {
            throw new Error('Not a directory');
        }
    } catch {
        return res.status(400).json({ success: false, error: 'Invalid project path' });
    }

    // Same constraint the shell websocket enforces on session ids.
    const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
    if (sessionId != null && (typeof sessionId !== 'string' || !safeSessionIdPattern.test(sessionId))) {
        return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    const hasSession = typeof sessionId === 'string' && sessionId.length > 0;

    // Mirror the resume commands used by the in-app shell (unix variants).
    let resumeCommand;
    if (provider === 'cursor') {
        resumeCommand = hasSession ? `cursor-agent --resume="${sessionId}"` : 'cursor-agent';
    } else if (provider === 'codex') {
        resumeCommand = hasSession ? `codex resume "${sessionId}" || codex` : 'codex';
    } else if (provider === 'gemini') {
        resumeCommand = hasSession ? `gemini --resume "${sessionId}"` : 'gemini';
    } else {
        resumeCommand = hasSession ? `claude --resume "${sessionId}" || claude` : 'claude';
    }

    // Command Terminal.app will run. Single-quote the cwd so spaces are safe;
    // escape any embedded single quotes.
    const safeCwd = resolvedProjectPath.replace(/'/g, `'\\''`);
    const shellCommand = `cd '${safeCwd}' && ${resumeCommand}`;

    // Embed inside an AppleScript string literal — escape backslashes and
    // double quotes for AppleScript. execFile passes each -e arg verbatim
    // (no shell), so there is no second shell-escaping layer to worry about.
    const appleScriptArg = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    execFile(
        'osascript',
        [
            '-e', 'tell application "Terminal" to activate',
            '-e', `tell application "Terminal" to do script "${appleScriptArg}"`,
        ],
        (error, _stdout, stderr) => {
            if (error) {
                console.error('open-in-terminal osascript error:', error, stderr);
                return res.status(500).json({ success: false, error: error.message });
            }
            res.json({ success: true });
        }
    );
});

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is within allowed workspace root
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Resolve the absolute project root via the DB-backed helper; the
        // caller passes the DB-assigned `projectId`, not a folder name.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths, and allow the additional
        // roots — the agent's edits are not confined to the project.
        const allowed = await validateAccessiblePath(projectRoot, filePath);
        if (!allowed.valid) {
            return res.status(403).json({ error: allowed.error });
        }
        const { resolved } = allowed;

        const content = await fsPromises.readFile(resolved, 'utf8');
        res.json({ content, path: resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PlantUML preview: resolve a .puml file's local `!include`s (which a remote
// renderer can't reach) against the project tree, then return a render URL for
// the configured PlantUML server. `content` carries the live editor text so
// unsaved edits preview; `path` anchors include resolution to the file's dir.
const PLANTUML_SERVER_URL = (process.env.PLANTUML_SERVER_URL || 'https://www.plantuml.com/plantuml').replace(/\/+$/, '');
app.post('/api/projects/:projectId/plantuml', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
        const content = typeof req.body?.content === 'string' ? req.body.content : null;
        const format = req.body?.format === 'png' ? 'png' : 'svg';

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const validation = validatePathInProject(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        // Prefer live editor content; fall back to the file on disk.
        let source = content;
        if (source === null) {
            source = await fsPromises.readFile(validation.resolved, 'utf8');
        }
        if (!source.trim()) {
            return res.status(400).json({ error: 'Empty diagram' });
        }

        const inlined = await inlinePlantUmlIncludes(source, path.dirname(validation.resolved), projectRoot);
        const code = encodePlantUmlSource(inlined);
        res.json({ url: `${PLANTUML_SERVER_URL}/${format}/${code}` });
    } catch (error) {
        console.error('Error building PlantUML render:', error);
        res.status(500).json({ error: error.message });
    }
});

// Inline PlantUML render (```plantuml fences in markdown previews and chat):
// there's no file anchoring the source, so no `!include` resolution — just
// encode the snippet and return a render URL for the configured server.
app.post('/api/plantuml', authenticateToken, async (req, res) => {
    try {
        const content = typeof req.body?.content === 'string' ? req.body.content : '';
        const format = req.body?.format === 'png' ? 'png' : 'svg';
        if (!content.trim()) {
            return res.status(400).json({ error: 'Empty diagram' });
        }
        const code = encodePlantUmlSource(content);
        res.json({ url: `${PLANTUML_SERVER_URL}/${format}/${code}` });
    } catch (error) {
        console.error('Error building inline PlantUML render:', error);
        res.status(500).json({ error: error.message });
    }
});

// DBML preview: render a `.dbml` file's schema into an ER diagram (SVG) using
// @softwaretechnik/dbml-renderer (the graphviz-via-wasm renderer the VSCode DBML
// extensions use). `content` carries the live editor text so unsaved edits
// preview; a parse error returns 400 with a readable message.
app.post('/api/projects/:projectId/dbml', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
        const content = typeof req.body?.content === 'string' ? req.body.content : null;

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const validation = validatePathInProject(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        // Prefer live editor content; fall back to the file on disk.
        let source = content;
        if (source === null) {
            source = await fsPromises.readFile(validation.resolved, 'utf8');
        }
        if (!source.trim()) {
            return res.status(400).json({ error: 'Empty diagram' });
        }

        try {
            const svg = renderDbmlToSvg(source);
            res.json({ svg });
        } catch (renderError) {
            return res.status(400).json({ error: renderError.message || 'Invalid DBML' });
        }
    } catch (error) {
        console.error('Error building DBML render:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── File share links ──────────────────────────────────────────────────────
// Mint/list/revoke public, no-login links to a project file. Anyone with the
// (unguessable) link reads the live file via the unauthenticated
// /api/share/:shareId/* routes below; the link 404s once revoked/expired and
// 410s once the underlying file is gone.
const SHARE_EXPIRY_SECONDS = { '1h': 3600, '1d': 86400, '7d': 604800 };

app.post('/api/projects/:projectId/share', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
        const expiresIn = req.body?.expiresIn ?? null; // '1h' | '1d' | '7d' | null (permanent)

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }
        const validation = validatePathInProject(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }
        try {
            const stat = await fsPromises.stat(validation.resolved);
            if (!stat.isFile()) {
                return res.status(400).json({ error: 'Only files can be shared' });
            }
        } catch {
            return res.status(404).json({ error: 'File not found' });
        }

        let expiresAt = null;
        if (expiresIn && SHARE_EXPIRY_SECONDS[expiresIn]) {
            expiresAt = new Date(Date.now() + SHARE_EXPIRY_SECONDS[expiresIn] * 1000).toISOString();
        }

        const shareId = crypto.randomBytes(24).toString('base64url');
        fileSharesDb.createShare({
            shareId,
            projectId,
            filePath: validation.resolved,
            userId: req.user.id,
            expiresAt,
        });
        res.json({ shareId, expiresAt });
    } catch (error) {
        console.error('Error creating share:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectId/shares', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const filePath = typeof req.query?.path === 'string' ? req.query.path : '';
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }
        const validation = validatePathInProject(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }
        const shares = fileSharesDb.listSharesForFile(projectId, validation.resolved).map((s) => ({
            shareId: s.share_id,
            createdAt: s.created_at,
            expiresAt: s.expires_at,
            viewCount: s.view_count,
            lastAccessed: s.last_accessed,
        }));
        res.json({ shares });
    } catch (error) {
        console.error('Error listing shares:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/projects/:projectId/shares/:shareId', authenticateToken, async (req, res) => {
    try {
        const deleted = fileSharesDb.deleteShare(req.params.shareId, req.user.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Share not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting share:', error);
        res.status(500).json({ error: error.message });
    }
});

// Resolve an active share to its on-disk file, re-validating against the project
// root and confirming the file still exists. Returns an error shape on any miss
// so a stale/forbidden path never leaks. 410 = link valid but file deleted.
async function resolveShare(shareId) {
    const share = fileSharesDb.getActiveShare(shareId);
    if (!share) return { status: 404, error: 'This link is invalid or has expired' };
    const projectRoot = await projectsDb.getProjectPathById(share.project_id);
    if (!projectRoot) return { status: 404, error: 'This link is invalid or has expired' };
    const validation = validatePathInProject(projectRoot, share.file_path);
    if (!validation.valid) return { status: 404, error: 'This link is invalid or has expired' };
    try {
        const stat = await fsPromises.stat(validation.resolved);
        if (!stat.isFile()) return { status: 410, error: 'The shared file is no longer available' };
        return { share, resolved: validation.resolved, size: stat.size };
    } catch {
        return { status: 410, error: 'The shared file is no longer available' };
    }
}

// Public (no auth): metadata for a shared file. Only the basename is exposed —
// never the absolute server path.
app.get('/api/share/:shareId/meta', async (req, res) => {
    try {
        const result = await resolveShare(req.params.shareId);
        if (result.error) return res.status(result.status).json({ error: result.error });
        fileSharesDb.recordAccess(req.params.shareId);
        res.json({
            name: path.basename(result.resolved),
            size: result.size,
            mime: mime.lookup(result.resolved) || 'application/octet-stream',
            expiresAt: result.share.expires_at,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Public (no auth): stream the shared file's bytes. `?download` forces a save.
app.get('/api/share/:shareId/content', async (req, res) => {
    try {
        const result = await resolveShare(req.params.shareId);
        if (result.error) return res.status(result.status).json({ error: result.error });
        fileSharesDb.recordAccess(req.params.shareId);
        const mimeType = mime.lookup(result.resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);
        if (req.query.download !== undefined) {
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(result.resolved)}"`);
        }
        const fileStream = fs.createReadStream(result.resolved);
        fileStream.pipe(res);
        fileStream.on('error', () => {
            if (!res.headersSent) res.status(500).json({ error: 'Error reading file' });
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

// Public (no auth): rendered artifact for previewable diagram types. Markdown is
// rendered client-side from /content, so only puml/dbml need server rendering.
app.get('/api/share/:shareId/render', async (req, res) => {
    try {
        const result = await resolveShare(req.params.shareId);
        if (result.error) return res.status(result.status).json({ error: result.error });
        const ext = path.extname(result.resolved).slice(1).toLowerCase();
        const source = await fsPromises.readFile(result.resolved, 'utf8');
        if (!source.trim()) return res.status(400).json({ error: 'Empty file' });

        if (ext === 'dbml') {
            try {
                return res.json({ type: 'svg', svg: renderDbmlToSvg(source) });
            } catch (renderError) {
                return res.status(400).json({ error: renderError.message || 'Invalid DBML' });
            }
        }
        if (ext === 'puml' || ext === 'plantuml' || ext === 'iuml' || ext === 'wsd') {
            const projectRoot = await projectsDb.getProjectPathById(result.share.project_id);
            const inlined = await inlinePlantUmlIncludes(source, path.dirname(result.resolved), projectRoot);
            const code = encodePlantUmlSource(inlined);
            return res.json({ type: 'url', url: `${PLANTUML_SERVER_URL}/svg/${code}` });
        }
        if (ext === 'html' || ext === 'htm') {
            // Sketch-style HTML loads resources from root-absolute paths (`/kit/...`);
            // point the iframe at the share preview route, which serves the entry
            // file and those resources with references rewritten. See the route below.
            const projectRoot = await projectsDb.getProjectPathById(result.share.project_id);
            const { entryRel } = await resolvePreviewModel(result.resolved, projectRoot);
            return res.json({ type: 'html', url: `/api/share/${req.params.shareId}/preview/${encodeURI(entryRel)}` });
        }
        return res.status(400).json({ error: 'No renderer for this file type' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Public (no auth): serve a shared HTML entry and its root-absolute resources
// (`/kit/...`) so sketch-style pages render in the share iframe — the public
// analogue of the authenticated /preview-fs route. The shareId is the
// capability; resolvePreviewAssetPath constrains every asset to the project root.
app.get('/api/share/:shareId/preview/*', async (req, res) => {
    try {
        const result = await resolveShare(req.params.shareId);
        if (result.error) return res.status(result.status).send(result.error);
        const projectRoot = await projectsDb.getProjectPathById(result.share.project_id);
        if (!projectRoot) return res.status(404).send('Not found');

        const { webRoot, aliases } = await resolvePreviewModel(result.resolved, projectRoot);
        const reqPath = `/${req.params[0] || ''}`;
        const target = resolvePreviewAssetPath(reqPath, webRoot, aliases, projectRoot);
        if (!target) return res.status(403).send('Path outside project');

        let stat;
        try {
            stat = await fsPromises.stat(target);
        } catch {
            return res.status(404).send('Not found');
        }
        if (stat.isDirectory()) return res.status(404).send('Not found');

        const assetBase = `/api/share/${req.params.shareId}/preview`;
        if (isTextAsset(target)) {
            const text = await fsPromises.readFile(target, 'utf8');
            res.type(mime.lookup(target) || 'text/plain');
            return res.send(rewriteAssetReferences(text, aliases, assetBase));
        }
        res.type(mime.lookup(target) || 'application/octet-stream');
        return res.send(await fsPromises.readFile(target));
    } catch (error) {
        console.error('Error serving share preview asset:', error);
        res.status(500).send('Preview error');
    }
});

// HTML live preview. Sketch-style HTML loads resources from root-absolute paths
// (`/kit/...`) a dev server maps to project dirs; we serve the file and those
// resources ourselves so it renders in an iframe. See server/utils/htmlPreview.js.
//
// Auth note: iframe subresource requests can't carry the app's Bearer token, so
// the resolve step issues a short-lived, path-scoped cookie that the asset route
// (registered above the /api/projects Bearer guard) reads. The cookie also
// carries the resolved web root + alias map, so each asset request is
// self-describing without re-reading config.

// Resolve a preview: validate the entry, set the preview cookie, return its URL.
app.post('/api/projects/:projectId/html-preview', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const filePath = typeof req.body?.path === 'string' ? req.body.path : '';

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }
        const validation = validatePathInProject(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        const { webRoot, aliases, entryRel } = await resolvePreviewModel(validation.resolved, projectRoot);
        // The directories the page's subresources come from, so the client can
        // reload the iframe when one of them changes (the entry file alone is
        // watched separately). Absolute, like the watcher's change paths.
        const resourceRoots = [...new Set([
            webRoot,
            ...Object.values(aliases).map((target) => path.resolve(webRoot, target)),
        ])];

        const previewToken = jwt.sign(
            { userId: req.user.id, projectId, webRoot, aliases },
            JWT_SECRET,
            { expiresIn: '12h' },
        );
        res.cookie(PREVIEW_COOKIE, previewToken, {
            httpOnly: true,
            sameSite: 'lax',
            path: `/api/projects/${projectId}/preview-fs`,
            maxAge: 12 * 60 * 60 * 1000,
        });
        res.json({ entryUrl: `/api/projects/${projectId}/preview-fs/${entryRel}`, resourceRoots });
    } catch (error) {
        console.error('Error resolving HTML preview:', error);
        res.status(500).json({ error: error.message });
    }
});

// Custom-format preview: runs a project-declared (or convention-detected)
// renderer that turns a source file (e.g. a `*.flow.json` flow spec) into
// self-contained HTML, and returns that HTML for a srcDoc iframe. The live
// editor `content` is rendered (written to a temp input) so edits preview.
//
// Trust model: the renderer command comes from the project's own
// `.vibespace/preview.json` (or the `_kit/render.mjs` sibling convention), so
// running it is equivalent to running the project's build — acceptable for this
// single-user instance.
app.post('/api/projects/:projectId/render-custom', authenticateToken, async (req, res) => {
    let tmpInput = null;
    let tmpOutput = null;
    try {
        const { projectId } = req.params;
        const filePath = typeof req.body?.path === 'string' ? req.body.path : '';
        const content = typeof req.body?.content === 'string' ? req.body.content : null;

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }
        const validation = validatePathInProject(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }

        const renderer = await resolveCustomRenderer(validation.resolved, projectRoot, process.execPath);
        if (!renderer) {
            return res.status(400).json({ error: 'No renderer configured for this file type.' });
        }

        // Render the live editor content (fall back to disk) via a temp input so
        // unsaved edits preview. The output is a temp HTML file the renderer writes.
        const source = content === null ? await fsPromises.readFile(validation.resolved, 'utf8') : content;
        const stamp = `${Date.now()}-${process.pid}-${Math.round(Math.random() * 1e9)}`;
        tmpInput = path.join(os.tmpdir(), `vibespace-render-${stamp}-${path.basename(validation.resolved)}`);
        tmpOutput = path.join(os.tmpdir(), `vibespace-render-${stamp}.html`);
        await fsPromises.writeFile(tmpInput, source);

        const args = renderer.args.map((a) => a.replace('{input}', tmpInput).replace('{output}', tmpOutput));
        await new Promise((resolve, reject) => {
            execFile(renderer.bin, args, { cwd: projectRoot, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
                if (error) {
                    error.stderr = stderr;
                    reject(error);
                } else {
                    resolve();
                }
            });
        });

        const html = await fsPromises.readFile(tmpOutput, 'utf8');
        // Wire flow cross-links to open the target .flow.json in vibespace
        // (no-op for non-flow renderers without the docs placeholder).
        const wired = wireFlowCrossLinks(html, validation.resolved, projectRoot);
        res.json({ html: wired });
    } catch (error) {
        console.error('Error rendering custom format:', error.message, error.stderr || '');
        const detail = (error.stderr && String(error.stderr).trim()) || error.message;
        res.status(500).json({ error: `Renderer failed: ${detail}`.slice(0, 600) });
    } finally {
        if (tmpInput) await fsPromises.unlink(tmpInput).catch(() => {});
        if (tmpOutput) await fsPromises.unlink(tmpOutput).catch(() => {});
    }
});

// Serve raw file bytes for previews and downloads.
app.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Match the text reader endpoint so callers can pass either project-relative
        // or absolute paths without changing how the bytes are served.
        const allowed = await validateAccessiblePath(projectRoot, filePath);
        if (!allowed.valid) {
            return res.status(403).json({ error: allowed.error });
        }
        const { resolved } = allowed;

        // Check if file exists
        try {
            await fsPromises.access(resolved);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // Stream the file
        const fileStream = fs.createReadStream(resolved);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Save file content endpoint
app.put('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Same reach as the reader: a file you can open is a file you can save,
        // otherwise opening an out-of-project file leaves a tab that can never
        // be written back.
        const allowed = await validateAccessiblePath(projectRoot, filePath);
        if (!allowed.valid) {
            return res.status(403).json({ error: allowed.error });
        }
        const { resolved } = allowed;

        // Write the new content
        await fsPromises.writeFile(resolved, content, 'utf8');

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // Resolve the project's absolute path through the DB (projectId is the
        // primary key of the `projects` table after the identifier migration).
        const actualPath = await projectsDb.getProjectPathById(req.params.projectId);
        if (!actualPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Optional subtree root for lazy loading. Accepts the additional roots so
        // the breadcrumb of an out-of-project file can still list its folder.
        let rootPath = actualPath;
        if (typeof req.query.dir === 'string' && req.query.dir) {
            const validation = await validateAccessiblePath(actualPath, req.query.dir);
            if (!validation.valid) {
                return res.status(400).json({ error: validation.error });
            }
            rootPath = validation.resolved;
        }

        // Check if path exists
        try {
            await fsPromises.access(rootPath);
        } catch (e) {
            return res.status(404).json({ error: `Path not found: ${rootPath}` });
        }

        // depth=0 lists just the directory, depth=1 prefetches one level below
        // it, etc. Default keeps the historical deep walk for consumers that
        // need the whole tree (palette file search, @-mentions, tree search).
        const parsedDepth = Number.parseInt(req.query.depth, 10);
        const maxDepth = Number.isFinite(parsedDepth) ? Math.max(0, Math.min(parsedDepth, 10)) : 10;
        // meta=0 skips the per-entry lstat (size/mtime/permissions) — names
        // and types alone are enough for path-only consumers and cut both the
        // walk time and the payload roughly in half.
        const includeMeta = req.query.meta !== '0';

        // Stop walking when the client gives up (project switches abort the
        // fetch); without this, orphaned walks keep consuming fs permits and
        // starve the request the user is actually waiting on.
        let clientGone = false;
        res.on('close', () => { clientGone = true; });

        const files = await getFileTree(rootPath, maxDepth, 0, true, {
            includeMeta,
            isCancelled: () => clientGone,
        });
        if (clientGone) {
            return;
        }
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

// Path containment lives in server/utils/allowedPaths.js — see the module
// header for why reads reach further than the mutating routes.

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

// POST /api/projects/:projectId/files/create - Create new file or directory
app.post('/api/projects/:projectId/files/create', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Create file or directory
        if (type === 'directory') {
            await fsPromises.mkdir(resolvedPath, { recursive: false });
        } else {
            // Ensure parent directory exists
            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            await fsPromises.writeFile(resolvedPath, '', 'utf8');
        }

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectId/files/rename - Rename file or directory
app.put('/api/projects/:projectId/files/rename', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate old path
        const oldValidation = validatePathInProject(projectRoot, oldPath);
        if (!oldValidation.valid) {
            return res.status(403).json({ error: oldValidation.error });
        }

        const resolvedOldPath = oldValidation.resolved;

        // Check if old path exists
        try {
            await fsPromises.access(resolvedOldPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = validatePathInProject(projectRoot, resolvedNewPath);
        if (!newValidation.valid) {
            return res.status(403).json({ error: newValidation.error });
        }

        // Check if new path already exists
        try {
            await fsPromises.access(resolvedNewPath);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Rename
        await fsPromises.rename(resolvedOldPath, resolvedNewPath);

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: resolvedNewPath,
            newName,
            message: 'Renamed successfully'
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectId/files/move - Move files/directories into another directory
// (drag-and-drop in the file tree). Accepts several sources at once; each is
// moved independently so one conflict doesn't abort the rest.
app.post('/api/projects/:projectId/files/move', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { sourcePaths, targetDir } = req.body;

        if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || typeof targetDir !== 'string') {
            return res.status(400).json({ error: 'sourcePaths (non-empty array) and targetDir are required' });
        }

        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Empty targetDir means the project root itself (which the
        // path-under-root validator would reject as not strictly inside).
        let resolvedTargetDir;
        if (!targetDir || targetDir === '.' || targetDir === './') {
            resolvedTargetDir = path.resolve(projectRoot);
        } else {
            const targetValidation = validatePathInProject(projectRoot, targetDir);
            if (!targetValidation.valid) {
                return res.status(403).json({ error: targetValidation.error });
            }
            resolvedTargetDir = targetValidation.resolved;
        }

        let targetStats;
        try {
            targetStats = await fsPromises.stat(resolvedTargetDir);
        } catch {
            return res.status(404).json({ error: 'Target directory not found' });
        }
        if (!targetStats.isDirectory()) {
            return res.status(400).json({ error: 'Target is not a directory' });
        }

        const moved = [];
        const failed = [];
        const unchanged = [];
        for (const sourcePath of sourcePaths) {
            const validation = validatePathInProject(projectRoot, String(sourcePath));
            if (!validation.valid) {
                failed.push({ path: sourcePath, error: validation.error });
                continue;
            }
            const resolvedSource = validation.resolved;
            const destination = path.join(resolvedTargetDir, path.basename(resolvedSource));

            if (destination === resolvedSource) {
                // Dropped into its own parent — nothing to do. Reported apart
                // from `moved` so the UI doesn't announce a move that never
                // happened (a near-miss drag reading "Moved 1 item" sends the
                // user hunting for a folder that never left).
                unchanged.push({ path: sourcePath });
                continue;
            }
            if (resolvedTargetDir === resolvedSource || resolvedTargetDir.startsWith(resolvedSource + path.sep)) {
                failed.push({ path: sourcePath, error: 'Cannot move a directory into itself' });
                continue;
            }

            try {
                await fsPromises.access(resolvedSource);
            } catch {
                failed.push({ path: sourcePath, error: 'Source not found' });
                continue;
            }

            try {
                await fsPromises.access(destination);
                failed.push({ path: sourcePath, error: `"${path.basename(destination)}" already exists in the target folder` });
                continue;
            } catch {
                // Destination free — proceed.
            }

            try {
                await fsPromises.rename(resolvedSource, destination);
                moved.push({ from: resolvedSource, to: destination });
            } catch (error) {
                failed.push({
                    path: sourcePath,
                    error: error.code === 'EXDEV' ? 'Cannot move across different filesystems' : error.message,
                });
            }
        }

        res.json({ success: failed.length === 0, moved, failed, unchanged });
    } catch (error) {
        console.error('Error moving files:', error);
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/projects/:projectId/files - Delete file or directory
app.delete('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: targetPath, type } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate path
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if path exists and get stats
        let stats;
        try {
            stats = await fsPromises.stat(resolvedPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Prevent deleting the project root itself
        if (resolvedPath === path.resolve(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        // Delete based on type
        if (stats.isDirectory()) {
            await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(resolvedPath);
        }

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectId/files/upload - Upload files
// Dynamic import of multer for file uploads
const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, os.tmpdir());
            },
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
            files: MAX_FILE_UPLOAD_COUNT
        }
    });

    // Use multer middleware
    uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, async (err) => {
        if (err) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_MB}MB.` });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
            }
            return res.status(500).json({ error: err.message });
        }

        try {
            const { projectId } = req.params;
            const { targetPath, relativePaths, requestedFileCount: requestedFileCountRaw } = req.body;

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                projectId,
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            const parsedRequestedFileCount = Number.parseInt(requestedFileCountRaw, 10);
            const requestedFileCount = Number.isFinite(parsedRequestedFileCount) && parsedRequestedFileCount > 0
                ? parsedRequestedFileCount
                : req.files.length;

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = path.resolve(projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = validatePathInProject(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
                const destPath = path.join(resolvedTargetDir, fileName);

                // Validate destination path
                const destValidation = validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    // Clean up temp file
                    await fsPromises.unlink(file.path).catch(() => {});
                    continue;
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(destPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }

                // Move file (copy + unlink to handle cross-device scenarios)
                await fsPromises.copyFile(file.path, destPath);
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: fileName,
                    path: destPath,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }

            res.json({
                success: true,
                files: uploadedFiles,
                uploadedCount: uploadedFiles.length,
                requestedFileCount,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            // Clean up any remaining temp files
            if (req.files) {
                for (const file of req.files) {
                    await fsPromises.unlink(file.path).catch(() => {});
                }
            }
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });
};

app.post('/api/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

// Chat image uploads moved to POST /api/assets/images (server/modules/assets),
// which stores them in the global ~/.vibespace/assets folder.

// Terminal image paste: unlike upload-images (which inlines base64 and
// deletes the temp file), this persists the file on disk and returns its
// absolute path so it can be typed into a PTY for a CLI to read.
app.post('/api/projects/:projectId/upload-terminal-image', authenticateToken, async (req, res) => {
    try {
        const multer = (await import('multer')).default;
        const path = (await import('path')).default;
        const fs = (await import('fs')).promises;
        const os = (await import('os')).default;

        const uploadDir = path.join(os.tmpdir(), 'vibespace-terminal-images', String(req.user.id));

        const storage = multer.diskStorage({
            destination: async (req, file, cb) => {
                await fs.mkdir(uploadDir, { recursive: true });
                cb(null, uploadDir);
            },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                cb(null, uniqueSuffix + '-' + sanitizedName);
            }
        });

        const fileFilter = (req, file, cb) => {
            const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
            }
        };

        const upload = multer({
            storage,
            fileFilter,
            limits: {
                fileSize: 5 * 1024 * 1024, // 5MB
                files: 1
            }
        });

        upload.single('image')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No image file provided' });
            }

            // Opportunistic cleanup: drop this user's pasted images older than 24h.
            try {
                const entries = await fs.readdir(uploadDir);
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                await Promise.all(entries.map(async (entry) => {
                    const entryPath = path.join(uploadDir, entry);
                    if (entryPath === req.file.path) return;
                    const stat = await fs.stat(entryPath).catch(() => null);
                    if (stat && stat.isFile() && stat.mtimeMs < cutoff) {
                        await fs.unlink(entryPath).catch(() => { });
                    }
                }));
            } catch { /* cleanup is best-effort */ }

            res.json({ path: req.file.path });
        });
    } catch (error) {
        console.error('Error in terminal image upload endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get token usage for a specific session. `projectId` is the DB primary key;
// the Claude branch below resolves it to an absolute path via the DB.
app.get('/api/projects/:projectId/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectId, sessionId } = req.params;
        const homeDir = os.homedir();

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Provider artifacts on disk (JSONL file names, OpenCode sqlite rows)
        // are keyed by the provider-native session id, while the caller sends
        // the app-facing id. Resolve provider and id mapping from the indexed
        // session row so the frontend does not choose provider-specific paths.
        const sessionRow = sessionsDb.getSessionById(safeSessionId);
        if (!sessionRow) {
            return res.status(404).json({ error: 'Session not found', sessionId: safeSessionId });
        }

        const provider = sessionRow.provider || 'claude';
        const providerNativeSessionId = sessionRow?.provider_session_id || safeSessionId;

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                inputTokens: 0,
                outputTokens: 0,
                breakdown: { input: 0, output: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        if (provider === 'opencode') {
            const dbPath = getOpenCodeDatabasePath();
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: 'OpenCode database not found' });
            }

            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const columns = db.prepare('PRAGMA table_info(session)').all();
                const columnNames = new Set(columns.map((column) => column.name));
                const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
                if (!requiredColumns.every((column) => columnNames.has(column))) {
                    return res.json({
                        used: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        breakdown: { input: 0, output: 0 },
                        unsupported: true,
                        message: 'Token usage tracking is not available in this OpenCode database schema'
                    });
                }

                const row = db.prepare(`
                    SELECT
                        tokens_input AS inputTokens,
                        tokens_output AS outputTokens,
                        tokens_reasoning AS reasoningTokens,
                        tokens_cache_read AS cacheReadTokens,
                        tokens_cache_write AS cacheWriteTokens
                    FROM session
                    WHERE id = ?
                `).get(providerNativeSessionId);

                if (!row) {
                    return res.status(404).json({ error: 'OpenCode session not found', sessionId: safeSessionId });
                }

                const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
                const outputTokens = Number(row.outputTokens || 0);
                const totalUsed = Number(row.inputTokens || 0)
                    + outputTokens
                    + Number(row.reasoningTokens || 0)
                    + Number(row.cacheReadTokens || 0)
                    + Number(row.cacheWriteTokens || 0);

                return res.json({
                    used: totalUsed,
                    inputTokens,
                    outputTokens,
                    breakdown: {
                        input: inputTokens,
                        output: outputTokens
                    }
                });
            } finally {
                db.close();
            }
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

            // Find the session file by searching for the session ID
            const findSessionFile = async (dir) => {
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = await findSessionFile(fullPath);
                            if (found) return found;
                        } else if (entry.name.includes(providerNativeSessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                } catch (error) {
                    // Skip directories we can't read
                }
                return null;
            };

            const sessionFilePath = await findSessionFile(codexSessionsDir);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            // Read and parse the Codex JSONL file
            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            const lines = fileContent.trim().split('\n');
            let tokenBudget = null;

            // Find the latest token_count event with info (scan from end)
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Codex stores token info in event_msg with type: "token_count"
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
                        tokenBudget = buildCodexTokenBudget(entry.payload.info);
                        break; // Stop after finding the latest token count
                    }
                } catch (parseError) {
                    // Skip lines that can't be parsed
                    continue;
                }
            }

            return res.json(tokenBudget || {
                used: 0,
                total: 0,
                sessionTotalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                breakdown: { input: 0, output: 0 }
            });
        }

        // Handle Claude sessions (default)
        // Resolve the project path through the DB using the caller-supplied
        // `projectId`. Legacy code here called extractProjectDirectory with a
        // folder-encoded project name; the migration centralizes that lookup
        // in the projects table.
        const projectPath = await projectsDb.getProjectPathById(projectId);
        if (!projectPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        // Prefer the indexed transcript path (already produced by the trusted
        // session synchronizer); fall back to the conventional location
        // derived from the provider-native session id.
        let jsonlPath = sessionRow?.jsonl_path;
        if (!jsonlPath) {
            jsonlPath = path.join(projectDir, `${providerNativeSessionId}.jsonl`);

            // Constrain the constructed path to projectDir (the id is
            // caller-influenced in this fallback branch).
            const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                return res.status(400).json({ error: 'Invalid path' });
            }
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let usageModel = null;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;

                    // Use token counts from latest assistant message only
                    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
                    cacheReadTokens = readUsageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens);
                    cacheCreationTokens = readUsageNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
                    inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
                    outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);
                    usageModel = typeof entry.message?.model === 'string' ? entry.message.model : null;

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        const totalUsed = inputTokens + outputTokens;
        const cacheTokens = cacheReadTokens + cacheCreationTokens;
        // The window is only knowable from a live runtime, so reuse the last
        // reading this server saw for the session — that survives the page
        // reloads and session switches a web UI does constantly. Failing that,
        // only an explicit CONTEXT_WINDOW is trustworthy; with neither,
        // `total: 0` means "unknown" and the client shows a bare token count
        // instead of a percentage of a number we made up.
        const rememberedContextUsage = recallContextUsage(providerNativeSessionId);
        const contextWindow = rememberedContextUsage?.maxTokens ?? resolveConfiguredContextWindow() ?? 0;

        res.json({
            used: totalUsed,
            total: contextWindow,
            model: usageModel,
            estimated: true,
            ...(rememberedContextUsage ? { contextUsage: rememberedContextUsage } : {}),
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            cacheTokens,
            breakdown: {
                input: inputTokens,
                output: outputTokens
            }
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

// Directories that are almost never interesting for a project tree but can
// contain tens of thousands of files. Skipping them before recursion keeps
// traversal time bounded on large monorepos and high-latency filesystems
// (NFS / SMB).
const IGNORED_DIRS = new Set([
    // JS / TS toolchains
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
    // VCS
    '.git', '.svn', '.hg',
    // Python
    '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
    // Rust / Go / Java / Ruby
    'target', 'vendor',
    // Build output / IDE
    '.gradle', '.idea', 'coverage', '.nyc_output'
]);

const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
    ? parsedFsConcurrency
    : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations = [];

async function acquire() {
    if (activeFsOperations < FS_CONCURRENCY) {
        activeFsOperations += 1;
        return;
    }

    await new Promise((resolve) => {
        pendingFsOperations.push(resolve);
    });
}

function release() {
    const next = pendingFsOperations.shift();
    if (next) {
        next();
        return;
    }

    activeFsOperations = Math.max(0, activeFsOperations - 1);
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true, options = {}) {
    const { includeMeta = true, isCancelled = null } = options;
    if (isCancelled?.()) {
        return [];
    }
    // Using fsPromises from import
    let entries;
    try {
        await acquire();
        try {
            entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        } finally {
            release();
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
        return [];
    }

    const filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));

    // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
    // serial stat() was the real bottleneck — issuing them concurrently lets
    // the kernel pipeline the round-trips and the recursive calls overlap too.
    const items = await Promise.all(filteredEntries.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item = {
            name: entry.name,
            path: itemPath,
            type: entry.isDirectory() ? 'directory' : 'file'
        };

        // Get file stats for additional metadata
        if (includeMeta) {
            try {
                await acquire();
                try {
                  const stats = await fsPromises.lstat(itemPath);
                  item.size = stats.size;
                  item.modified = stats.mtime.toISOString();

                  // Mark symlinks so UI can distinguish them
                  if (stats.isSymbolicLink()) {
                    item.isSymlink = true;
                  }

                  // Convert permissions to rwx format
                  const mode = stats.mode;
                  const ownerPerm = (mode >> 6) & 7;
                  const groupPerm = (mode >> 3) & 7;
                  const otherPerm = mode & 7;
                  item.permissions =
                    ((mode >> 6) & 7).toString() +
                    ((mode >> 3) & 7).toString() +
                    (mode & 7).toString();
                  item.permissionsRwx =
                    permToRwx(ownerPerm) +
                    permToRwx(groupPerm) +
                    permToRwx(otherPerm);
                } finally {
                    release();
                }
            } catch (statError) {
                // If stat fails, provide default values
                item.size = 0;
                item.modified = null;
                item.permissions = '000';
                item.permissionsRwx = '---------';
            }
        }

        if (entry.isDirectory() && currentDepth < maxDepth) {
            // Recurse. Let readdir's own EACCES bubble up through the catch in
            // the recursive call rather than doing a separate access() probe
            // (which doubled the round-trip count on SMB without adding info).
            // The recursive call starts with a bounded readdir; holding a permit
            // for the whole subtree can deadlock when sibling directories are
            // waiting on their own children.
            item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden, options);
        }

        return item;
    }));

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

const SERVER_PORT = process.env.SERVER_PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (error.code === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', error.message);
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);            
        }

        console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('VibeSpace Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            console.log(`${c.tip('[TIP]')}  Run "vibespace status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();

            // In-process plugin host modules. After the sessions watcher and the
            // boot-time chat dependencies, because a host module may create and
            // drive sessions from activate().
            activateHostExtensions({
                scanPlugins,
                getPluginsDir,
                authenticateToken,
                getSigningSecret: () => appConfigDb.getOrCreateJwtSecret(),
                sessions: {
                    getById: (sessionId) => sessionsDb.getSessionById(sessionId),
                    createAppSession: (provider, cwd) => sessionsService.createAppSession(provider, cwd),
                    deleteOrArchiveById: (sessionId, options) =>
                        sessionsService.deleteOrArchiveSessionById(sessionId, options),
                },
                enqueueMessage: (sessionId, prompt, options) => serverEnqueueMessage(sessionId, prompt, options),
            }).catch((err) => {
                console.error('[Plugins] host module activation failed:', err?.message || err);
            });

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });
        });

        await closeSessionsWatcher();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            try {
                await deactivateHostExtensions();
            } catch (err) {
                console.error('[Plugins] Error deactivating host modules during shutdown:', err?.message || err);
            }
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', err?.message || err);
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', err?.message || err);
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', err?.message || err);
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
