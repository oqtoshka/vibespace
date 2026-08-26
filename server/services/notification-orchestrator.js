import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '../modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '../modules/notifications/services/desktop-notification-clients.service.js';

import { sendTelegramMessage, buildTelegramText } from './telegram-notifier.js';
import { summarizeRecap, classifyAssistantState, formatResumeAt } from './notification-content.js';

const KIND_TO_PREF_KEY = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

const PROVIDER_LABELS = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  system: 'System'
};

const recentEventKeys = new Map();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isEventEnabled(preferences, event) {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  return prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;
}

function shouldSendPush(preferences, event) {
  return Boolean(preferences?.channels?.webPush) && isEventEnabled(preferences, event);
}

function shouldSendDesktop(preferences, event) {
  return Boolean(preferences?.channels?.desktop) && isEventEnabled(preferences, event);
}

function shouldSendTelegram(preferences, event) {
  const telegram = preferences?.telegram;
  const configured = Boolean(telegram?.enabled && telegram?.botToken && telegram?.chatId);
  return configured && isEventEnabled(preferences, event);
}

function isDuplicate(event) {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}) {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error.message === 'string') {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName) {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row, provider) {
  return row && (!provider || row.provider === provider);
}

function resolveSessionRow(sessionId, provider) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession(event) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event) {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

function buildPushMessage(event) {
  const meta = event.meta || {};

  if (event.code === 'permission.required') {
    const detail = meta.toolDetail || (meta.toolName ? `Tool "${meta.toolName}"` : 'A tool needs your approval');
    return `🔐 Approval needed — ${detail}`;
  }

  if (event.code === 'run.stopped') {
    if (meta.stopReason === 'aborted') {
      return '⏹️ Stopped';
    }
    const { emoji, label } = classifyAssistantState({ recap: meta.recap, toolNames: meta.toolNames });
    const recap = summarizeRecap(meta.recap);
    return recap ? `${emoji} ${label} — ${recap}` : `${emoji} ${label}`;
  }

  if (event.code === 'run.failed') {
    return meta.error ? `❌ Failed: ${meta.error}` : '❌ Failed';
  }

  if (event.code === 'run.paused') {
    return `⏳ Usage limit hit — auto-resume at ${formatResumeAt(meta.resumeAt)}`;
  }

  if (event.code === 'run.background_completed') {
    return '✅ Background work finished';
  }

  const CODE_MAP = {
    'agent.notification': meta.message ? String(meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  return CODE_MAP[event.code] || 'You have a new notification';
}

function buildPushBody(event) {
  const normalizedEvent = normalizeNotificationSession(event);
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = buildPushMessage(normalizedEvent);

  return {
    title: sessionName || 'VibeSpace',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

async function sendTelegram(telegram, event) {
  const text = buildTelegramText(event, { sessionName: resolveSessionName(event) });
  const result = await sendTelegramMessage({
    botToken: telegram.botToken,
    chatId: telegram.chatId,
    text,
  });
  if (!result.ok) {
    console.error('Telegram notification error:', result.error);
  }
}

async function sendWebPush(userId, event) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return;

  const payload = JSON.stringify(buildPushBody(event));

  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        payload
      )
    )
  );

  // Clean up gone subscriptions (410 Gone or 404)
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const statusCode = result.reason?.statusCode;
      if (statusCode === 410 || statusCode === 404) {
        pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
      }
    }
  });
}

/**
 * Whether the event belongs to a session the user started private.
 *
 * Private means unreported, and VibeSpace's own outbound channels — push,
 * Telegram, desktop — are reporting too: a "Claude finished: <title>" in a
 * Telegram chat is exactly the trace the flag exists to prevent. Resolved
 * through either id the runtimes use, app or provider-native.
 */
function isPrivateSessionEvent(event) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return false;
  }
  const row = resolveSessionRow(event.sessionId, event.provider);
  return Boolean(row?.is_private);
}

function notifyUserIfEnabled({ userId, event }) {
  if (!userId || !event) {
    return;
  }

  if (isPrivateSessionEvent(event)) {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(event);
  const preferences = notificationPreferencesDb.getPreferences(userId);
  const wantPush = shouldSendPush(preferences, normalizedEvent);
  const wantTelegram = shouldSendTelegram(preferences, normalizedEvent);
  const wantDesktop = shouldSendDesktop(preferences, normalizedEvent);
  if (!wantPush && !wantTelegram && !wantDesktop) {
    return;
  }
  if (isDuplicate(normalizedEvent)) {
    return;
  }

  if (wantPush) {
    sendWebPush(userId, normalizedEvent).catch((err) => {
      console.error('Web push send error:', err);
    });
  }
  if (wantTelegram) {
    sendTelegram(preferences.telegram, normalizedEvent).catch((err) => {
      console.error('Telegram send error:', err);
    });
  }
  if (wantDesktop) {
    // Desktop clients (Electron shell / websocket listeners) get the same
    // payload as web push and render it natively.
    Promise.resolve(sendDesktopNotificationToClients(userId, buildPushBody(normalizedEvent))).catch((err) => {
      console.error('Desktop notification send error:', err);
    });
  }
}

function notifyRunStopped({
  userId,
  provider,
  sessionId = null,
  stopReason = 'completed',
  sessionName = null,
  recap = '',
  toolNames = []
}) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName, recap, toolNames },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

/**
 * The turn died on the provider's usage limit and a wake is scheduled (see
 * rate-limit-wake.service). Rides the `stop` preference: it is the turn's
 * stop notification, replacing the ordinary run-stopped one.
 */
function notifyRunPaused({ userId, provider, sessionId = null, sessionName = null, resumeAt, limitType = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.paused',
      meta: { sessionName, resumeAt, limitType },
      severity: 'warning',
      dedupeKey: `${provider}:run:paused:${sessionId || 'none'}:${resumeAt}`
    })
  });
}

/**
 * Reports background work that finished after its turn had already completed.
 *
 * Uses the `stop` kind so it rides the existing "run stopped" preference rather
 * than needing a new opt-in that would default to off. No explicit dedupeKey, so
 * the default composite key collapses repeats inside the dedupe window.
 */
function notifyBackgroundWorkCompleted({ userId, provider, sessionId = null, sessionName = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.background_completed',
      meta: { sessionName },
      severity: 'info'
    })
  });
}

function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }) {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}

export {
  // Upstream name for the push/desktop payload builder; kept so the
  // notifications module barrel and its tests keep resolving.
  buildPushBody as buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunPaused,
  notifyRunFailed,
  notifyBackgroundWorkCompleted
};
