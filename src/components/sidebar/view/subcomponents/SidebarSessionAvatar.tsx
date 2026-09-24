import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import type { LLMProvider } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';

type SidebarSessionAvatarProps = {
  provider: LLMProvider;
  avatarUrl?: string | null;
  className?: string;
  /**
   * A plugin launch-option mark: a ring plus a corner glyph, with the label
   * and hint as the accessible name and tooltip. Never the ring's hue alone.
   */
  marker?: { label: string; hint?: string } | null;
};

const RETRY_MS = 30_000;

/**
 * The memorable session identity, with the provider mark as its immediate
 * placeholder while Mission Control is still generating the image.
 */
export default function SidebarSessionAvatar({
  provider,
  avatarUrl,
  className,
  marker,
}: SidebarSessionAvatarProps) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
  }, [avatarUrl]);

  useEffect(() => {
    if (!avatarUrl || loaded) {
      return;
    }
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [attempt, avatarUrl, loaded]);

  const source = avatarUrl
    ? `${avatarUrl}${avatarUrl.includes('?') ? '&' : '?'}attempt=${attempt}`
    : null;

  const avatar = (
    <span
      className={cn(
        'relative flex h-7 w-7 flex-shrink-0 overflow-hidden rounded-lg bg-muted/70 ring-1 ring-border/60',
        className,
        marker && 'ring-2 ring-sky-500 ring-offset-1 ring-offset-background dark:ring-sky-400',
      )}
    >
      <span className="absolute inset-0 flex items-center justify-center">
        <LLMProviderLogo provider={provider} className="h-3.5 w-3.5" />
      </span>
      {source && (
        <img
          key={source}
          src={source}
          alt=""
          className={cn(
            'relative h-full w-full object-cover transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
        />
      )}
    </span>
  );

  if (!marker) {
    return avatar;
  }

  const markerTitle = marker.hint ? `${marker.label} — ${marker.hint}` : marker.label;
  return (
    <span
      className="relative flex flex-shrink-0"
      title={markerTitle}
      data-testid="session-avatar-marker"
    >
      {avatar}
      <span
        role="img"
        aria-label={markerTitle}
        className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sky-600 text-white ring-2 ring-background dark:bg-sky-500"
      >
        <SlidersHorizontal className="h-2 w-2" aria-hidden strokeWidth={3} />
      </span>
    </span>
  );
}
