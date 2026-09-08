import { OPENCODE_AVATAR, OPENCODE_LABEL } from '../../constants/providerPolicy';
import type { LLMProvider } from '../../types/app';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import OpenCodeLogo from './OpenCodeLogo';

type LLMProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function LLMProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: LLMProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    if (OPENCODE_AVATAR) return <img src={OPENCODE_AVATAR} alt={OPENCODE_LABEL} className={`${className} rounded-full object-cover`} />;
    return <OpenCodeLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
