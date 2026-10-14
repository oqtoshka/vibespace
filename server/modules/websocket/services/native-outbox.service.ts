import type { WebSocket } from 'ws';

/**
 * Ordered, back-pressured writer for one /native-chat socket.
 *
 * The native chat used to drop a frame whenever the socket buffer held 12 MiB
 * or more. A dropped history page or `complete` frame left the phone waiting
 * forever ("Connected · Working", or an old tail). Instead, frames are written
 * straight through while the buffer is below the high-water mark and queued
 * in order above it, draining as the buffer falls. A socket that cannot drain
 * (the queue exceeds its byte bound, or nothing drains for the stall window)
 * is closed with OVERFLOW_CLOSE_CODE so the client reconnects and re-reads
 * history; no frame is ever lost without the connection ending.
 */

/** Close code for a socket whose backlog could not drain; the phone reconnects on it. */
export const NATIVE_OUTBOX_OVERFLOW_CLOSE_CODE = 1013;

type OutboxSocket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close'>;
type QueuedFrame = { data: string; bytes: number; callback?: (error?: Error) => void };
type OutboxLimits = {
  /** Write straight through while ws.bufferedAmount is below this. */
  highWaterBytes: number;
  /** Close the socket once queued (not yet handed to ws) bytes exceed this. */
  maxQueuedBytes: number;
  /** Close the socket when neither the queue nor the ws buffer shrank for this long. */
  stallMs: number;
  /** How often a non-empty queue re-checks the buffer (ws has no drain event). */
  pollMs: number;
};

const DEFAULT_LIMITS: OutboxLimits = {
  highWaterBytes: 8 * 1024 * 1024,
  maxQueuedBytes: 64 * 1024 * 1024,
  stallMs: 30_000,
  pollMs: 25,
};

/**
 * Native chat (native-chat.service) sends every frame through one of these,
 * history pages included, so frames keep their order and none is dropped.
 */
export class NativeOutbox {
  private readonly queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private lastProgress = 0;
  private lastBuffered = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly limits: OutboxLimits;

  constructor(private readonly ws: OutboxSocket, limits: Partial<OutboxLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Writes or queues one frame. `callback` fires once ws has accepted the
   * frame (or with an error if the socket closed first), so a caller that
   * awaits it gets end-to-end backpressure.
   */
  send(data: string, callback?: (error?: Error) => void): void {
    if (this.closed || this.ws.readyState !== 1) {
      callback?.(new Error('Chat disconnected'));
      return;
    }
    if (!this.queue.length && this.ws.bufferedAmount < this.limits.highWaterBytes) {
      this.ws.send(data, callback);
      return;
    }
    const bytes = Buffer.byteLength(data);
    if (!this.queue.length) { this.lastProgress = Date.now(); this.lastBuffered = this.ws.bufferedAmount; }
    this.queue.push({ data, bytes, callback });
    this.queuedBytes += bytes;
    if (this.queuedBytes > this.limits.maxQueuedBytes) {
      this.overflow('Native chat send backlog exceeded its limit; reconnect and reload history');
      return;
    }
    this.schedule();
  }

  /** Native chat calls this when the socket closes: queued frames fail, timers stop. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const pending = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const frame of pending) frame.callback?.(new Error('Chat disconnected'));
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this.drain(); }, this.limits.pollMs);
    this.timer.unref?.();
  }

  private drain(): void {
    if (this.closed) return;
    if (this.ws.readyState !== 1) { this.dispose(); return; }
    // A buffer that is shrinking is progress too: a slow link still drains.
    let progressed = this.ws.bufferedAmount < this.lastBuffered;
    while (this.queue.length && this.ws.bufferedAmount < this.limits.highWaterBytes) {
      const frame = this.queue.shift()!;
      this.queuedBytes -= frame.bytes;
      this.ws.send(frame.data, frame.callback);
      progressed = true;
    }
    this.lastBuffered = this.ws.bufferedAmount;
    if (!this.queue.length) return;
    const now = Date.now();
    if (progressed) this.lastProgress = now;
    else if (now - this.lastProgress >= this.limits.stallMs) {
      this.overflow('Native chat could not deliver frames in time; reconnect and reload history');
      return;
    }
    this.schedule();
  }

  private overflow(reason: string): void {
    this.dispose();
    try { this.ws.close(NATIVE_OUTBOX_OVERFLOW_CLOSE_CODE, reason); } catch { /* already closing */ }
  }
}
