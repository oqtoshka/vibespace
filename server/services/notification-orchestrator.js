import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '../modules/database/index.js';
import { sendTelegramMessage, buildTelegramText } from './telegram-notifier.js';
import { summarizeRecap, classifyAssistantState } from './notification-content.js';

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

  const CODE_MAP = {
    'agent.notification': meta.message ? String(meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  return CODE_MAP[event.code] || 'You have a new notification';
}

function buildPushBody(event) {
  const providerLabel = PROVIDER_LABELS[event.provider] || 'Assistant';
  const sessionName = resolveSessionName(event);
  const message = buildPushMessage(event);

  return {
    title: sessionName || 'VibeSpace',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: event.sessionId || null,
      code: event.code,
      provider: event.provider || null,
      sessionName,
      tag: `${event.provider || 'assistant'}:${event.sessionId || 'none'}:${event.code}`
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

function notifyUserIfEnabled({ userId, event }) {
  if (!userId || !event) {
    return;
  }

  const preferences = notificationPreferencesDb.getPreferences(userId);
  const wantPush = shouldSendPush(preferences, event);
  const wantTelegram = shouldSendTelegram(preferences, event);
  if (!wantPush && !wantTelegram) {
    return;
  }
  if (isDuplicate(event)) {
    return;
  }

  if (wantPush) {
    sendWebPush(userId, event).catch((err) => {
      console.error('Web push send error:', err);
    });
  }
  if (wantTelegram) {
    sendTelegram(preferences.telegram, event).catch((err) => {
      console.error('Telegram send error:', err);
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
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunFailed,
} from '../modules/notifications/services/notification-orchestrator.service.js';
