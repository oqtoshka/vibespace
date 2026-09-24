import { useEffect, useState } from 'react';
import { ArrowRight, Loader2, RotateCw, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePlugins } from '../../../../contexts/PluginsContext';
import { findLaunchOptionBannerAction } from '../../../../utils/launchOptionMarks';
import { resolvePluginSessionActionUrl } from '../../../../utils/pluginSessionActions';
import type { LaunchOptionDeclaration } from '../../../../types/app';

type LinkState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' };

/**
 * A plugin launch option's persistent banner at the top of a session's chat:
 * the plugin's text and, when the banner names one of the plugin's session
 * actions, a link resolved through that action's endpoint — the same URL the
 * session menu opens. Informational only: the composer stays usable.
 */
export default function LaunchOptionBanner({
  option,
  sessionId,
}: {
  option: LaunchOptionDeclaration;
  sessionId: string | null;
}) {
  const { t } = useTranslation('chat');
  const { plugins } = usePlugins();
  const action = findLaunchOptionBannerAction(plugins, option);
  const [link, setLink] = useState<LinkState>({ status: 'none' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!action || !sessionId) {
      setLink({ status: 'none' });
      return;
    }
    let cancelled = false;
    setLink({ status: 'loading' });
    resolvePluginSessionActionUrl(action, sessionId)
      .then((url) => { if (!cancelled) setLink({ status: 'ready', url }); })
      .catch(() => { if (!cancelled) setLink({ status: 'error' }); });
    return () => { cancelled = true; };
  }, [action, sessionId, attempt]);

  if (!option.banner) return null;
  const linkLabel = option.banner.actionLabel || action?.label;

  return (
    <div
      className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-900 dark:text-sky-100"
      role="status"
      data-testid={`launch-option-banner-${option.id}`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-sky-600 text-white dark:bg-sky-500">
          <SlidersHorizontal className="h-3 w-3" aria-hidden strokeWidth={2.5} />
        </span>
        <span className="min-w-0">
          <span className="mr-1.5 font-semibold">{option.badge || option.label}</span>
          <span>{option.banner.text}</span>
        </span>
      </span>
      {link.status === 'ready' && (
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600"
          data-testid={`launch-option-banner-link-${option.id}`}
        >
          {linkLabel}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </a>
      )}
      {link.status === 'loading' && (
        <span className="inline-flex flex-shrink-0 items-center gap-1 text-xs text-sky-800/80 dark:text-sky-200/80">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {linkLabel}
        </span>
      )}
      {link.status === 'error' && (
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-sky-600/40 px-2 py-1 text-xs font-medium hover:bg-sky-500/10"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          {t('launchOptionBanner.linkUnavailable', { label: linkLabel, defaultValue: '{{label}} unavailable — retry' })}
        </button>
      )}
    </div>
  );
}
