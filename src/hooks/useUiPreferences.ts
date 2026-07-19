import { useEffect, useReducer, useRef } from 'react';

type UiPreferences = {
  showRawParameters: boolean;
  showThinking: boolean;
  sendByCtrlEnter: boolean;
  sidebarVisible: boolean;
  voiceEnabled: boolean;
};

type UiPreferenceKey = keyof UiPreferences;

type SetPreferenceAction = {
  type: 'set';
  key: UiPreferenceKey;
  value: unknown;
};

type SetManyPreferencesAction = {
  type: 'set_many';
  value?: Partial<Record<UiPreferenceKey, unknown>>;
};

type ResetPreferencesAction = {
  type: 'reset';
  value?: Partial<UiPreferences>;
};

type UiPreferencesAction =
  | SetPreferenceAction
  | SetManyPreferencesAction
  | ResetPreferencesAction;

const DEFAULTS: UiPreferences = {
  showRawParameters: false,
  showThinking: true,
  // Default to Ctrl/Cmd+Enter-only sending: plain Enter inserts a newline.
  // A per-browser Quick Settings toggle can still flip this back, but a fresh
  // browser/profile should not silently revert to send-on-Enter.
  sendByCtrlEnter: true,
  sidebarVisible: true,
  voiceEnabled: false,
};

const PREFERENCE_KEYS = Object.keys(DEFAULTS) as UiPreferenceKey[];
const VALID_KEYS = new Set<UiPreferenceKey>(PREFERENCE_KEYS); // prevents unknown keys from being written
const SYNC_EVENT = 'ui-preferences:sync';

type SyncEventDetail = {
  storageKey: string;
  sourceId: string;
  value: Partial<Record<UiPreferenceKey, unknown>>;
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return fallback;
};

const readLegacyPreference = (key: UiPreferenceKey, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;

    // Supports values written by both JSON.stringify and plain strings.
    const parsed = JSON.parse(raw);
    return parseBoolean(parsed, fallback);
  } catch {
    return fallback;
  }
};

// Storage key for the pre-v2 unified preferences blob. Because the hook
// persists the full state (defaults included) on first load, every browser
// that ever opened the app carries an explicit `sendByCtrlEnter: false` from
// the old default — indistinguishable from a deliberate choice. The v2 key
// migrates the other preferences once and re-applies the new send default.
const LEGACY_UNIFIED_STORAGE_KEY = 'uiPreferences';

const parseStoredPreferences = (raw: string | null): UiPreferences | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const parsedRecord = parsed as Record<string, unknown>;
      return PREFERENCE_KEYS.reduce((acc, key) => {
        acc[key] = parseBoolean(parsedRecord[key], DEFAULTS[key]);
        return acc;
      }, { ...DEFAULTS });
    }
  } catch {
    // Malformed blob — treat as absent.
  }
  return null;
};

const readInitialPreferences = (storageKey: string): UiPreferences => {
  if (typeof window === 'undefined') {
    return DEFAULTS;
  }

  try {
    const current = parseStoredPreferences(localStorage.getItem(storageKey));
    if (current) {
      return current;
    }

    const legacyUnified = parseStoredPreferences(localStorage.getItem(LEGACY_UNIFIED_STORAGE_KEY));
    if (legacyUnified) {
      return { ...legacyUnified, sendByCtrlEnter: DEFAULTS.sendByCtrlEnter };
    }
  } catch {
    // Fall back to legacy keys when unified keys are missing or invalid.
  }

  return PREFERENCE_KEYS.reduce((acc, key) => {
    acc[key] = readLegacyPreference(key, DEFAULTS[key]);
    return acc;
  }, { ...DEFAULTS });
};

function reducer(state: UiPreferences, action: UiPreferencesAction): UiPreferences {
  switch (action.type) {
    case 'set': {
      const { key, value } = action;
      if (!VALID_KEYS.has(key)) {
        return state;
      }

      const nextValue = parseBoolean(value, state[key]);
      if (state[key] === nextValue) {
        return state;
      }

      return { ...state, [key]: nextValue };
    }
    case 'set_many': {
      const updates = action.value || {};
      let changed = false;
      const nextState = { ...state };

      for (const key of PREFERENCE_KEYS) {
        if (!(key in updates)) continue;

        const value = updates[key];
        const nextValue = parseBoolean(value, state[key]);
        if (nextState[key] !== nextValue) {
          nextState[key] = nextValue;
          changed = true;
        }
      }

      return changed ? nextState : state;
    }
    case 'reset':
      return { ...DEFAULTS, ...(action.value || {}) };
    default:
      return state;
  }
}

export function useUiPreferences(storageKey = 'uiPreferences.v2') {
  const instanceIdRef = useRef(`ui-preferences-${Math.random().toString(36).slice(2)}`);
  const [state, dispatch] = useReducer(
    reducer,
    storageKey,
    readInitialPreferences
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    localStorage.setItem(storageKey, JSON.stringify(state));

    window.dispatchEvent(
      new CustomEvent<SyncEventDetail>(SYNC_EVENT, {
        detail: {
          storageKey,
          sourceId: instanceIdRef.current,
          value: state,
        },
      })
    );
  }, [state, storageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const applyExternalUpdate = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
      }
      dispatch({ type: 'set_many', value: value as Partial<Record<UiPreferenceKey, unknown>> });
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== storageKey || event.newValue === null) {
        return;
      }

      try {
        const parsed = JSON.parse(event.newValue);
        applyExternalUpdate(parsed);
      } catch {
        // Ignore malformed storage updates.
      }
    };

    const handleSyncEvent = (event: Event) => {
      const syncEvent = event as CustomEvent<SyncEventDetail>;
      const detail = syncEvent.detail;
      if (!detail || detail.storageKey !== storageKey || detail.sourceId === instanceIdRef.current) {
        return;
      }

      applyExternalUpdate(detail.value);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(SYNC_EVENT, handleSyncEvent as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(SYNC_EVENT, handleSyncEvent as EventListener);
    };
  }, [storageKey]);

  const setPreference = (key: UiPreferenceKey, value: unknown) => {
    dispatch({ type: 'set', key, value });
  };

  const setPreferences = (value: Partial<Record<UiPreferenceKey, unknown>>) => {
    dispatch({ type: 'set_many', value });
  };

  const resetPreferences = (value?: Partial<UiPreferences>) => {
    dispatch({ type: 'reset', value });
  };

  return {
    preferences: state,
    setPreference,
    setPreferences,
    resetPreferences,
    dispatch,
  };
}
