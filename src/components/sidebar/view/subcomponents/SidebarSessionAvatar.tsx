import { useEffect, useState } from 'react';

import type { LLMProvider } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';

type SidebarSessionAvatarProps = {
  provider: LLMProvider;
  avatarUrl?: string | null;
  className?: string;
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

  return (
    <span
      className={cn(
        'relative flex h-7 w-7 flex-shrink-0 overflow-hidden rounded-lg bg-muted/70 ring-1 ring-border/60',
        className,
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
}
