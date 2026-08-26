/**
 * Telegram notifier.
 *
 * Thin wrapper over the Telegram Bot API `sendMessage` endpoint. Used as a
 * delivery channel for notification events (run stopped / action required /
 * run failed) alongside web push. Uses the global `fetch` (Node 18+).
 */

import { summarizeRecap, classifyAssistantState, formatResumeAt } from './notification-content.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 10000;

const PROVIDER_LABELS = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  system: 'System',
};

/** Minimal HTML escaping for Telegram `parse_mode: HTML`. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Builds the human-readable message body for a notification event.
 * For finished runs it carries a state (finished / needs answer / background) +
 * a one-line recap; for permission prompts it shows the exact pending action.
 * Mirrors the web-push body so both channels read the same.
 */
function buildTelegramText(event, { sessionName } = {}) {
  const providerLabel = PROVIDER_LABELS[event.provider] || 'Assistant';
  const meta = event.meta || {};
  const name = typeof sessionName === 'string' ? sessionName.trim() : '';
  const nameLine = name ? `\n📁 ${escapeHtml(name)}` : '';

  if (event.code === 'permission.required') {
    const detail = meta.toolDetail || (meta.toolName ? `Tool "${meta.toolName}"` : 'A tool needs approval');
    return `🔐 <b>${escapeHtml(providerLabel)}</b> — Approval needed\n<code>${escapeHtml(detail)}</code>${nameLine}`;
  }

  if (event.code === 'run.stopped') {
    if (meta.stopReason === 'aborted') {
      return `⏹️ <b>${escapeHtml(providerLabel)}</b> — Stopped${nameLine}`;
    }
    const { emoji, label } = classifyAssistantState({ recap: meta.recap, toolNames: meta.toolNames });
    const recap = summarizeRecap(meta.recap);
    const recapLine = recap ? `\n<i>${escapeHtml(recap)}</i>` : '';
    return `${emoji} <b>${escapeHtml(providerLabel)}</b> — ${label}${recapLine}${nameLine}`;
  }

  if (event.code === 'run.failed') {
    const detail = meta.error ? `: ${escapeHtml(meta.error)}` : '';
    return `❌ <b>${escapeHtml(providerLabel)}</b> — Failed${detail}${nameLine}`;
  }

  if (event.code === 'run.paused') {
    const limit = meta.limitType ? ` (${escapeHtml(String(meta.limitType).replace(/_/g, ' '))})` : '';
    return `⏳ <b>${escapeHtml(providerLabel)}</b> — Usage limit hit${limit}, auto-resume at ${escapeHtml(formatResumeAt(meta.resumeAt))}${nameLine}`;
  }

  const CODE_MAP = {
    'agent.notification': meta.message ? String(meta.message) : 'sent a notification',
    'push.enabled': 'notifications are now enabled',
  };
  const message = CODE_MAP[event.code] || 'has an update';
  return `🔔 <b>${escapeHtml(providerLabel)}</b> ${escapeHtml(message)}${nameLine}`;
}

/**
 * Sends a message via the Telegram Bot API.
 * Resolves to `{ ok: true }` on success or `{ ok: false, error }` on failure
 * (never throws — callers fire-and-forget).
 */
async function sendTelegramMessage({ botToken, chatId, text }) {
  if (!botToken || !chatId) {
    return { ok: false, error: 'Missing bot token or chat id' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.description) detail = body.description;
      } catch {
        /* non-JSON error body — keep the status text */
      }
      return { ok: false, error: detail };
    }

    return { ok: true };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'Request timed out' : error?.message || String(error);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export { sendTelegramMessage, buildTelegramText };
