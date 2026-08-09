import { useEffect, useMemo } from 'react';
import { useHref } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { persistAuthToken } from '../../../utils/authToken';
import { writeSsoError } from '../utils';

import AuthLoadingScreen from './AuthLoadingScreen';

/**
 * Where the identity provider's redirect lands.
 *
 * The server put the outcome in the URL fragment: a fragment never reaches a
 * server, so the session token stays out of proxy logs and the Referer header
 * on the way through. This screen's whole job is to move that token into
 * storage and get the fragment off the address bar.
 *
 * It finishes with a real navigation rather than a router push. `AuthProvider`
 * reads the token from localStorage when it mounts, so a client-side route
 * change would leave the app holding the session it had a moment ago — none.
 */
export default function SsoCallback() {
  const { t } = useTranslation('auth');
  const home = useHref('/');

  const outcome = useMemo(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const rawReturnTo = params.get('returnTo') || '/';
    return {
      token: params.get('token'),
      error: params.get('error'),
      message: params.get('message'),
      // Only ever an in-app path. `//host` is protocol-relative and would send
      // the browser off-origin, so it is rejected alongside absolute URLs.
      returnTo: rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//') ? rawReturnTo : '/',
    };
  }, []);

  const returnHref = useHref(outcome.returnTo);

  useEffect(() => {
    if (outcome.token) {
      persistAuthToken(outcome.token);
      window.location.replace(returnHref);
      return;
    }

    writeSsoError(outcome.message || outcome.error || t('sso.errors.failed'));
    window.location.replace(home);
  }, [home, outcome, returnHref, t]);

  return <AuthLoadingScreen />;
}
