import { SSO_ERROR_STORAGE_KEY } from './constants';
import type { ApiErrorPayload } from './types';

export async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  return payload.error ?? payload.message ?? fallback;
}

/** Storage can throw in private modes; a lost error message is not worth a crash. */
export function writeSsoError(message: string): void {
  try {
    sessionStorage.setItem(SSO_ERROR_STORAGE_KEY, message);
  } catch {
    // Ignored — the callback screen still shows the message before redirecting.
  }
}

export function readSsoError(): string | null {
  try {
    return sessionStorage.getItem(SSO_ERROR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearSsoError(): void {
  try {
    sessionStorage.removeItem(SSO_ERROR_STORAGE_KEY);
  } catch {
    // Ignored.
  }
}
