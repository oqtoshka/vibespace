import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';

/**
 * Reports the two ways this server goes silent without dying.
 *
 * vs.dudin.net stops answering HTTP for minutes at a time, several times a
 * day: the heartbeat monitor `site-vibespace-mac` records 16s timeouts on
 * `GET /` and the Grafana rule `heartbeat-monitor-down` fires (2026-08-31,
 * 05:49-05:57Z). The process neither crashes nor logs anything, so the window
 * leaves no trace and every diagnosis so far has been inference.
 *
 * Two different faults produce that same symptom, and the fix for one does
 * nothing for the other:
 *
 *   - The main thread is blocked — a long synchronous call, or a major GC
 *     pause. Event-loop delay climbs to seconds and utilization sits near 1.
 *   - libuv's thread pool is saturated — transcript reads and chokidar's
 *     polling stats are all fs work, and the pool is four threads wide by
 *     default. The loop itself stays responsive, but every fs operation
 *     queues behind the backlog, including the one that serves the request.
 *     Delay stays low while the pending-request count climbs.
 *
 * Sampling both, and speaking up only when something is actually wrong, makes
 * the next occurrence a diagnosis instead of another guess.
 */

const SAMPLE_INTERVAL_MS = 5_000;
const LAG_WARN_MS = 1_000;
const GC_WARN_MS = 500;

let sampleTimer = null;
let gcObserver = null;
let delayHistogram = null;

/**
 * Starts sampling event-loop health. Idempotent; returns the stop function.
 */
export function startEventLoopHealthMonitor(options = {}) {
  if (sampleTimer) {
    return stopEventLoopHealthMonitor;
  }

  const lagWarnMs = options.lagWarnMs ?? LAG_WARN_MS;
  const sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
  const gcWarnMs = options.gcWarnMs ?? GC_WARN_MS;

  delayHistogram = monitorEventLoopDelay({ resolution: 20 });
  delayHistogram.enable();

  let previousUtilization = performance.eventLoopUtilization();

  sampleTimer = setInterval(() => {
    const maxLagMs = delayHistogram.max / 1e6;
    const meanLagMs = delayHistogram.mean / 1e6;
    delayHistogram.reset();

    const currentUtilization = performance.eventLoopUtilization();
    const windowUtilization = performance.eventLoopUtilization(currentUtilization, previousUtilization);
    previousUtilization = currentUtilization;

    if (maxLagMs < lagWarnMs) {
      return;
    }

    // `_getActiveRequests` is the only view Node offers of work handed to
    // libuv's pool. A long list next to a *small* lag is the saturation
    // signature; a large lag with a short list is a blocked main thread.
    const pendingRequests = typeof process._getActiveRequests === 'function'
      ? process._getActiveRequests().length
      : -1;
    const memory = process.memoryUsage();

    console.warn('[health] event loop stalled', {
      at: new Date().toISOString(),
      maxLagMs: Math.round(maxLagMs),
      meanLagMs: Math.round(meanLagMs),
      // 1 means the loop spent the whole window executing JS.
      utilization: Number(windowUtilization.utilization.toFixed(3)),
      pendingRequests,
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
      threadPoolSize: process.env.UV_THREADPOOL_SIZE ?? '4 (default)',
    });
  }, sampleIntervalMs);

  // The monitor must never be the reason the process stays alive.
  sampleTimer.unref();

  gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < gcWarnMs) {
        continue;
      }

      console.warn('[health] long GC pause', {
        at: new Date().toISOString(),
        durationMs: Math.round(entry.duration),
        kind: entry.detail?.kind,
      });
    }
  });
  gcObserver.observe({ entryTypes: ['gc'] });

  return stopEventLoopHealthMonitor;
}

/**
 * Stops sampling. Safe to call when the monitor was never started.
 */
export function stopEventLoopHealthMonitor() {
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }

  if (gcObserver) {
    gcObserver.disconnect();
    gcObserver = null;
  }

  if (delayHistogram) {
    delayHistogram.disable();
    delayHistogram = null;
  }
}
