import { APP_TITLE } from '../constants/config';

const COMPLETION_TITLE_INDICATOR = '[Done]';
const TITLE_INDICATOR_CLEAR_DELAY_MS = 2000;

let clearTimer: number | null = null;
let returnListenersAttached = false;

const getIndicatorPrefix = () => `${COMPLETION_TITLE_INDICATOR} `;

const stripIndicator = (title: string): string => {
  const prefix = getIndicatorPrefix();
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
};

const pageIsActive = (): boolean => (
  document.visibilityState === 'visible' && document.hasFocus()
);

const removeReturnListeners = (): void => {
  if (!returnListenersAttached || typeof window === 'undefined') {
    return;
  }

  document.removeEventListener('visibilitychange', handleUserReturn);
  window.removeEventListener('focus', handleUserReturn, true);
  window.removeEventListener('click', handleUserReturn, true);
  returnListenersAttached = false;
};

const clearTitleIndicator = (): void => {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }

  removeReturnListeners();
  removePageInactiveListener();

  if (document.title.startsWith(getIndicatorPrefix())) {
    document.title = stripIndicator(document.title);
  }
};

const removePageInactiveListener = (): void => {
  document.removeEventListener('visibilitychange', handlePageInactive);
};

const scheduleClear = (): void => {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
  }

  clearTimer = window.setTimeout(() => {
    clearTitleIndicator();
  }, TITLE_INDICATOR_CLEAR_DELAY_MS);

  removePageInactiveListener();
  document.addEventListener('visibilitychange', handlePageInactive, { once: true });
};

function handleUserReturn(): void {
  if (!pageIsActive()) {
    return;
  }

  // Background completions keep the marker indefinitely. A tab click normally
  // surfaces as visibility/focus, while an in-page click is a useful fallback.
  scheduleClear();
}

function handlePageInactive(): void {
  if (document.visibilityState !== 'hidden') {
    return;
  }

  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }

  if (!returnListenersAttached) {
    document.addEventListener('visibilitychange', handleUserReturn);
    window.addEventListener('focus', handleUserReturn, true);
    window.addEventListener('click', handleUserReturn, true);
    returnListenersAttached = true;
  }
}

/**
 * Swap the title's base text, preserving a completion indicator if one is up.
 * The base tracks the selected project/session, and both can change while the
 * tab sits in the background with the marker still doing its job.
 */
export const setBasePageTitle = (baseTitle: string): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const prefix = document.title.startsWith(getIndicatorPrefix()) ? getIndicatorPrefix() : '';
  document.title = `${prefix}${baseTitle}`;
};

export const showCompletionTitleIndicator = (): void => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  const baseTitle = stripIndicator(document.title || APP_TITLE);
  document.title = `${getIndicatorPrefix()}${baseTitle}`;

  if (pageIsActive()) {
    scheduleClear();
    return;
  }

  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }

  if (!returnListenersAttached) {
    document.addEventListener('visibilitychange', handleUserReturn);
    window.addEventListener('focus', handleUserReturn, true);
    window.addEventListener('click', handleUserReturn, true);
    returnListenersAttached = true;
  }
};
