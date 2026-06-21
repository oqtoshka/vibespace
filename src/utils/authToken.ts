import { AUTH_TOKEN_STORAGE_KEY } from '../components/auth/constants';

// The auth token is tiny (~200 bytes) but critical: if its localStorage write
// fails (e.g. QuotaExceededError when storage is full), a fresh login is
// silently not persisted and the user is bounced to the login screen on every
// reload. So these regenerable, non-essential caches are evicted to make room
// rather than ever letting the token write lose. Everything listed here is
// either re-fetched from the server or a UI convenience that rebuilds itself.
const EVICTABLE_EXACT_KEYS = ['projects-cache-v1', 'sidebar-session-read-state'];
const EVICTABLE_KEY_PREFIXES = ['draft_input_', 'command_history_', 'permissionMode-'];

const evictNonCriticalStorage = (): boolean => {
  let removedAny = false;
  for (const key of Object.keys(localStorage)) {
    if (key === AUTH_TOKEN_STORAGE_KEY) continue;
    const evictable =
      EVICTABLE_EXACT_KEYS.includes(key) ||
      EVICTABLE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (evictable) {
      localStorage.removeItem(key);
      removedAny = true;
    }
  }
  return removedAny;
};

export const readAuthToken = (): string | null => {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch (error) {
    console.error('[auth] Failed to read auth token from localStorage:', error);
    return null;
  }
};

export const persistAuthToken = (token: string): void => {
  try {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    return;
  } catch (error) {
    if ((error as { name?: string })?.name !== 'QuotaExceededError') {
      console.error('[auth] Failed to persist auth token:', error);
      return;
    }
  }

  // Storage is full — drop regenerable caches and retry once. The token must
  // never be the write that fails.
  console.warn('[auth] localStorage quota exceeded; evicting caches to persist auth token');
  evictNonCriticalStorage();
  try {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch (retryError) {
    console.error('[auth] Failed to persist auth token even after eviction:', retryError);
  }
};

export const clearAuthToken = (): void => {
  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    // Drop the projects-list cache too; otherwise a different user logging in on
    // the same browser would briefly see the previous user's projects.
    localStorage.removeItem('projects-cache-v1');
  } catch (error) {
    console.error('[auth] Failed to clear auth token:', error);
  }
};
