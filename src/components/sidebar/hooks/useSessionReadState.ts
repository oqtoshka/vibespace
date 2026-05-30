import { useCallback, useState } from 'react';

import {
  readSessionReadMap,
  writeSessionReadMap,
  type SessionReadMap,
} from '../utils/sessionReadState';

/**
 * Holds the per-session read-receipt map in React state (so unread badges
 * re-render on change) and persists every update to localStorage.
 */
export function useSessionReadState() {
  const [readMap, setReadMap] = useState<SessionReadMap>(() => readSessionReadMap());

  const markRead = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setReadMap((previous) => {
      const next = { ...previous, [sessionId]: Date.now() };
      writeSessionReadMap(next);
      return next;
    });
  }, []);

  return { readMap, markRead };
}
