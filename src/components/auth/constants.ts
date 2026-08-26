export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

/**
 * Why the last SSO callback failed, handed from the callback screen to the
 * login screen. sessionStorage rather than router state because the two are
 * separated by a full page load — the callback stores the token in
 * localStorage, so it must reload for the app to pick the session up.
 */
export const SSO_ERROR_STORAGE_KEY = 'sso-error';

export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
  sessionExpired: 'Your session expired. Please log in again.',
} as const;
