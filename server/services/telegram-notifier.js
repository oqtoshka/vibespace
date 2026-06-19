/**
 * Telegram notifier.
 *
 * Thin wrapper over the Telegram Bot API `sendMessage` endpoint. Used as a
 * delivery channel for notification events (run stopped / action required /
 * run failed) alongside web push. Uses the global `fetch` (Node 18+).
 */

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

const KIND_EMOJI = {
  stop: '✅',
  action_required: '⏳',
  error: '❌',
  info: '🔔',
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
 * Mirrors the wording of the web-push body so both channels read the same.
 */
function buildTelegramText(event, { sessionName } = {}) {
  const providerLabel = PROVIDER_LABELS[event.provider] || 'Assistant';
  const emoji = KIND_EMOJI[event.kind] || KIND_EMOJI.info;

  const CODE_MAP = {
    'permission.required': event.meta?.toolName
      ? `needs approval for "${event.meta.toolName}"`
      : 'needs your approval',
    'run.stopped': event.meta?.stopReason === 'aborted' ? 'run was stopped' : 'finished',
    'run.failed': event.meta?.error ? `failed: ${event.meta.error}` : 'failed',
    'agent.notification': event.meta?.message ? String(event.meta.message) : 'sent a notification',
    'push.enabled': 'notifications are now enabled',
  };
  const message = CODE_MAP[event.code] || 'has an update';

  const headline = `${emoji} <b>${escapeHtml(providerLabel)}</b> ${escapeHtml(message)}`;
  const name = typeof sessionName === 'string' ? sessionName.trim() : '';
  return name ? `${headline}\n<i>${escapeHtml(name)}</i>` : headline;
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
