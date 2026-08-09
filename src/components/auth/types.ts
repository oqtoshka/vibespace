import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
  /** Logout only: where the identity provider wants the browser sent next. */
  redirectTo?: string;
};

/** How this deployment expects users to sign in. */
export type AuthMode = 'password' | 'oidc';

export type AuthStatusPayload = {
  needsSetup?: boolean;
  /** Absent on an older server, which only ever meant password auth. */
  authMode?: AuthMode;
  /** Where to send the browser to start an SSO login. */
  loginUrl?: string;
  /** Operator-supplied name for the identity provider, for the button. */
  providerLabel?: string;
};

export type SsoConfig = {
  loginUrl: string;
  providerLabel: string;
};

export type AuthUserPayload = {
  user?: AuthUser;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  /** Non-null when the server hands login off to an identity provider. */
  sso: SsoConfig | null;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
