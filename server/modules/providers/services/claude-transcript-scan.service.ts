import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type {
  ClaudeTranscriptScanRequest,
  ClaudeTranscriptScanResult,
  ClaudeTranscriptScanState,
} from '@/shared/index.js';

/** Two at once: each is a long sequential read, and the file system pool is shared. */
const MAX_CONCURRENT_SCANS = 2;
/** Bounds the worker's own heap, so a pathological file cannot take the server down. */
const SCAN_HEAP_LIMIT_MB = 512;
const SCAN_TIMEOUT_MS = 10 * 60_000;
/** Each entry is small and bounded; the cap only stops unbounded growth over months. */
const MAX_CACHED_STATES = 64;

const scanStates = new Map<string, ClaudeTranscriptScanState>();
const waiting: Array<() => void> = [];
let activeScans = 0;

async function acquireScanSlot(): Promise<void> {
  if (activeScans < MAX_CONCURRENT_SCANS) {
    activeScans += 1;
    return;
  }
  // The releasing scan hands its slot over, so the count does not change here.
  await new Promise<void>(resolve => { waiting.push(resolve); });
}

function releaseScanSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else activeScans -= 1;
}

/** The sibling worker file: `.js` in the build, `.ts` when run under tsx. */
function scanWorkerUrl(): URL {
  const extension = path.extname(fileURLToPath(import.meta.url));
  return new URL(`./claude-transcript-scan.worker${extension}`, import.meta.url);
}

function runScanWorker(request: ClaudeTranscriptScanRequest): Promise<ClaudeTranscriptScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(scanWorkerUrl(), {
      workerData: request,
      resourceLimits: { maxOldGenerationSizeMb: SCAN_HEAP_LIMIT_MB },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`Transcript scan timed out after ${SCAN_TIMEOUT_MS} ms`));
    }, SCAN_TIMEOUT_MS);
    timeout.unref?.();
    worker.once('message', (result: ClaudeTranscriptScanResult) => {
      clearTimeout(timeout);
      resolve(result);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      // After a delivered result this reject is a no-op.
      reject(new Error(`Transcript scan worker exited with code ${code} before a result`));
    });
  });
}

/**
 * Reads a Claude transcript of any size off the main thread.
 *
 * Consumed by the session recap service, which runs this about once a minute per
 * active session. State is remembered per file, so after the first pass only the
 * bytes appended since the previous scan are parsed.
 *
 * @param filePath Transcript path.
 * @param options.cursor Conversation-row index to return rows from; null for none.
 * @param options.maxUserChars How much user text to return from the cursor on.
 */
export async function scanClaudeTranscript(
  filePath: string,
  options: { cursor: number | null; maxUserChars: number },
): Promise<ClaudeTranscriptScanResult> {
  await acquireScanSlot();
  try {
    const result = await runScanWorker({ filePath, state: scanStates.get(filePath) ?? null, ...options });
    // Delete first, so re-insertion makes this the most recently used entry.
    scanStates.delete(filePath);
    scanStates.set(filePath, result.state);
    if (scanStates.size > MAX_CACHED_STATES) {
      const oldest = scanStates.keys().next().value as string;
      scanStates.delete(oldest);
    }
    return result;
  } finally {
    releaseScanSlot();
  }
}
