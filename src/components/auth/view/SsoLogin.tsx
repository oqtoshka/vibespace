import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2 } from 'lucide-react';

import type { SsoConfig } from '../types';
import { readSsoError, clearSsoError } from '../utils';

import AuthErrorAlert from './AuthErrorAlert';
import AuthScreenLayout from './AuthScreenLayout';

type SsoLoginProps = {
  sso: SsoConfig;
};

/**
 * The sign-in screen for deployments that authenticate against an identity
 * provider.
 *
 * A full navigation, not a fetch: the authorization code flow is a redirect to
 * a page on someone else's origin, where the user may face a password, a
 * passkey or an MFA prompt. Nothing about it can happen inside an XHR.
 */
export default function SsoLogin({ sso }: SsoLoginProps) {
  const { t } = useTranslation('auth');
  const [isRedirecting, setIsRedirecting] = useState(false);

  // A failed callback bounced through here and left its reason behind; show it
  // once, then forget it so a later visit starts clean.
  const [failure] = useState(() => {
    const stored = readSsoError();
    clearSsoError();
    return stored;
  });

  const startLogin = useCallback(() => {
    setIsRedirecting(true);
    // Come back to whatever was being viewed when the session ran out.
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const url = `${sso.loginUrl}?returnTo=${encodeURIComponent(returnTo)}`;
    window.location.href = url;
  }, [sso.loginUrl]);

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('sso.description', { provider: sso.providerLabel })}
      footerText={t('sso.footer', { provider: sso.providerLabel })}
    >
      <div className="space-y-4">
        <AuthErrorAlert errorMessage={failure ?? ''} />

        <button
          type="button"
          onClick={startLogin}
          disabled={isRedirecting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRedirecting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('sso.redirecting')}
            </>
          ) : (
            <>
              <KeyRound className="h-4 w-4" />
              {t('sso.submit', { provider: sso.providerLabel })}
            </>
          )}
        </button>
      </div>
    </AuthScreenLayout>
  );
}
