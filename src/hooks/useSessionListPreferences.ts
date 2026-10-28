import { useSyncExternalStore } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { readShowBackgroundRuns, writeShowBackgroundRuns, subscribeSessionListPreferences } from '../utils/sessionListPreferences';

export function useSessionListPreferences() {
  const { user } = useAuth();
  const userId = user?.id ?? 'anonymous';
  const showBackgroundRuns = useSyncExternalStore(
    subscribeSessionListPreferences,
    () => readShowBackgroundRuns(userId),
    () => false,
  );
  return {
    listPreferenceKey: encodeURIComponent(String(userId)),
    showBackgroundRuns,
    setShowBackgroundRuns: (show: boolean) => writeShowBackgroundRuns(userId, show),
  };
}
