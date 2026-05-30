// Fire-and-forget client telemetry — sends event objects to /api/debug-log so
// they appear in the dev server stderr. Used to reproduce iOS issues without
// attaching Safari Web Inspector. Batches with a short timer to avoid one
// request per event.

type DebugEvent = Record<string, unknown> & { tag: string };

// Telemetry is OFF by default — the heartbeat alone fired a POST to
// /api/debug-log every 200ms, flooding the network tab. Opt in at runtime with
// `localStorage.setItem('cloudcli-debug', '1')` and reload; no rebuild needed.
const DEBUG_ENABLED =
  typeof window !== 'undefined' &&
  (() => {
    try {
      return window.localStorage.getItem('cloudcli-debug') === '1';
    } catch {
      return false;
    }
  })();

let seq = 0;
const sessionTag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function send(events: DebugEvent[]): void {
  const body = JSON.stringify({ events });
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const ok = navigator.sendBeacon('/api/debug-log', new Blob([body], { type: 'application/json' }));
      if (ok) return;
    } catch {
      /* fall through */
    }
  }
  fetch('/api/debug-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => { /* swallow */ });
}

export function dbg(tag: string, extra?: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  const ev: DebugEvent = {
    tag,
    seq: ++seq,
    t: Date.now(),
    sess: sessionTag,
    ...(extra || {}),
  };
  // Send synchronously per-event via sendBeacon — non-blocking, survives main-thread hangs.
  send([ev]);
}

export function dbgMark(tag: string): () => void {
  const start = performance.now();
  dbg(`${tag}.start`);
  return () => dbg(`${tag}.end`, { dur_ms: Math.round(performance.now() - start) });
}

if (DEBUG_ENABLED) {
  try {
    if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          dbg('longtask', {
            dur_ms: Math.round(entry.duration),
            startTime: Math.round(entry.startTime),
            name: entry.name,
          });
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    }
  } catch {
    /* no-op */
  }

  window.addEventListener('error', (ev) => {
    dbg('window.error', {
      message: ev.message,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      stack: ev.error?.stack,
    });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    dbg('window.unhandledrejection', {
      reason: String(ev.reason),
      stack: (ev.reason as Error | undefined)?.stack,
    });
  });
  dbg('debugLog.init', {
    ua: navigator.userAgent,
    online: navigator.onLine,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${window.screen.width}x${window.screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  });

  // Heartbeat — every 200ms. If the stream stops, the main thread is wedged.
  let beat = 0;
  setInterval(() => {
    dbg('heartbeat', { beat: ++beat });
  }, 200);
}
