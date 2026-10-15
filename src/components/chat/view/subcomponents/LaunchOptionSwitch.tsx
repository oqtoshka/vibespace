import { useState } from 'react';
import { Loader2, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import type { LaunchOptionDeclaration } from '../../../../types/app';

type SwitchResponse = {
  success?: boolean;
  data?: { launchOptions?: Record<string, unknown> | null };
  error?: { message?: string };
};

/**
 * Turns a switchable plugin launch option on or off in an existing session —
 * "Switch to briefing" / "Back to chat" for the Mission Control briefing. The
 * server stores the choice; the next message relaunches the agent with the
 * session's history and the new launch. `onSwitched` receives the options the
 * server stored, so the badge and banner change at once instead of waiting for
 * the session list event. Refused while a turn runs (the server says so too).
 */
export default function LaunchOptionSwitch({
  option,
  isOn,
  sessionId,
  busy,
  onSwitched,
  tone = 'muted',
}: {
  option: LaunchOptionDeclaration;
  isOn: boolean;
  sessionId: string;
  busy: boolean;
  onSwitched: (sessionId: string, launchOptions: Record<string, unknown> | null) => void;
  /** `banner`: sits on the option's own sky-blue banner. */
  tone?: 'muted' | 'banner';
}) {
  const { t } = useTranslation('chat');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = isOn
    ? t('launchOptionSwitch.turnOff', { label: option.offLabel ?? 'chat', defaultValue: 'Back to {{label}}' })
    : t('launchOptionSwitch.turnOn', { label: option.label, defaultValue: 'Switch to {{label}}' });
  const title = busy
    ? t('launchOptionSwitch.busy', { defaultValue: 'Wait for the current turn to finish, or stop it.' })
    : [isOn ? option.offHint : option.hint, t('launchOptionSwitch.nextTurn', {
      defaultValue: "Takes effect with your next message: the agent restarts with this session's history.",
    })].filter(Boolean).join('\n');

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/launch-options`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchOptions: { [option.id]: !isOn } }),
      });
      const body = (await response.json().catch(() => ({}))) as SwitchResponse;
      if (!response.ok || !body.success) {
        throw new Error(body.error?.message || `HTTP ${response.status}`);
      }
      onSwitched(sessionId, body.data?.launchOptions ?? null);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setPending(false);
    }
  };

  const buttonClass = tone === 'banner'
    ? 'border-sky-600/40 text-sky-900 hover:bg-sky-500/15 dark:text-sky-100'
    : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted';

  return (
    <span className="inline-flex min-w-0 flex-shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => { void submit(); }}
        disabled={busy || pending}
        title={title}
        data-testid={`launch-option-switch-${option.id}`}
        className={`inline-flex flex-shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonClass}`}
      >
        {pending
          ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          : <SlidersHorizontal className="h-3 w-3" aria-hidden />}
        {label}
      </button>
      {error && (
        <span className="truncate text-xs text-red-600 dark:text-red-400" role="alert">
          {t('launchOptionSwitch.failed', { error, defaultValue: 'Could not switch: {{error}}' })}
        </span>
      )}
    </span>
  );
}
