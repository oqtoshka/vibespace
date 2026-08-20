/**
 * Anthill mac-pool watcher — the R-mac runner (phase 2c of the agent-tasks
 * plan).
 *
 * Polls the Anthill agent-task queue for QUEUED tasks in pool `mac` and, for
 * each, creates a VibeSpace claude session on the anthill workspace and pushes
 * a first prompt through the server-owned message queue (`serverEnqueueMessage`
 * → drain), so the run starts with no browser behind it and is visible live in
 * the UI the moment one connects.
 *
 * Deliberate boundaries:
 * - The watcher itself NEVER claims tasks. Claiming with the watcher's token
 *   and working with the session's would break holder-only submit/block; the
 *   spawned session claims by --id with the Mac's own keychain token, so
 *   `claimed_by` says exactly who did the work.
 * - Dedup is a spawn ledger (task id → session id) persisted under
 *   ~/.vibespace/, NOT queue state: a task the session fails to claim stays
 *   QUEUED, and the ledger stops us respawning it every poll. One respawn is
 *   allowed after RESPAWN_AFTER_MS (the queue's 4h lease) so a crashed session
 *   doesn't orphan its task forever.
 * - A failed poll is a failed OBSERVATION, not an empty queue: it logs and
 *   returns without touching the ledger.
 *
 * Enabled only when ANTHILL_MAC_WATCHER=1 (set in the Mac install's .env; the
 * agents-container vibespace must never run this).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsService } from '@/modules/providers/index.js';
import { serverEnqueueMessage } from '@/modules/websocket/index.js';

const API_URL = process.env.ANTHILL_API_URL ?? 'https://anthill.dudin.net/api/graphql';
// The task DEFINITION lives in the web app, not at the GraphQL endpoint. Derived
// from API_URL so a watcher pointed at another instance links to that one.
const WEB_URL = process.env.ANTHILL_WEB_URL ?? API_URL.replace(/\/api\/graphql$/, '');
const PROJECT_PATH = process.env.ANTHILL_MAC_PROJECT ?? '/Users/dudin/projects/anthill';
const POLL_MS = Number(process.env.ANTHILL_MAC_POLL_MS) > 0 ? Number(process.env.ANTHILL_MAC_POLL_MS) : 120_000;
const RESPAWN_AFTER_MS = 4 * 60 * 60 * 1000; // queue lease length
const LEDGER_PATH = path.join(os.homedir(), '.vibespace', 'anthill-mac-watcher.json');

type LedgerEntry = { sessionId: string; spawnedAt: number; title?: string };
type Ledger = Record<string, LedgerEntry>;

let timer: NodeJS.Timeout | null = null;
let cachedToken: string | null = null;
let ticking = false;

function readLedger(): Ledger {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) as Ledger;
  } catch {
    return {};
  }
}

function writeLedger(ledger: Ledger): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

/**
 * The queue token comes from the macOS keychain (same `mac-cli` service token
 * the CLI uses), read once and cached; ANTHILL_SERVICE_TOKEN in the
 * environment overrides for non-keychain installs. The watcher only LISTS
 * with it — see the claiming note in the module doc.
 */
function getToken(): Promise<string | null> {
  if (process.env.ANTHILL_SERVICE_TOKEN) {
    return Promise.resolve(process.env.ANTHILL_SERVICE_TOKEN);
  }
  if (cachedToken) {
    return Promise.resolve(cachedToken);
  }
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-a', 'anthill', '-s', 'anthill-mac-cli-token', '-w'],
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        cachedToken = stdout.trim();
        resolve(cachedToken);
      },
    );
  });
}

type QueuedTask = { id: string; title: string; description: string | null };

async function fetchQueuedMacTasks(token: string): Promise<QueuedTask[] | null> {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
      body: JSON.stringify({
        query:
          'query { tasks(filter: {executor: {eq: AGENT}, agentState: {eq: QUEUED}, agentPool: {eq: "mac"}}, paging: {limit: 10}) { nodes { id title description } } }',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      console.warn(`[AnthillWatcher] queue poll HTTP ${response.status} — skipping tick`);
      return null;
    }
    const payload = (await response.json()) as {
      data?: { tasks?: { nodes?: QueuedTask[] } };
      errors?: unknown[];
    };
    if (!payload.data?.tasks?.nodes) {
      console.warn('[AnthillWatcher] queue poll returned no data — skipping tick', payload.errors ?? '');
      return null;
    }
    return payload.data.tasks.nodes;
  } catch (error) {
    console.warn(`[AnthillWatcher] queue poll failed — skipping tick: ${(error as Error).message}`);
    return null;
  }
}

function buildPrompt(task: QueuedTask): string {
  return [
    `You are the R-mac agent-task runner. Work Anthill queue task ${task.id}.`,
    '',
    `TITLE: ${task.title}`,
    'DESCRIPTION:',
    task.description ?? '(none)',
    '',
    'Protocol (the queue contract):',
    '1. First claim the task so the lease and audit trail are yours:',
    '   export ANTHILL_API_URL=https://anthill.dudin.net/api/graphql',
    '   export ANTHILL_SERVICE_TOKEN=$(security find-generic-password -a anthill -s anthill-mac-cli-token -w)',
    `   anthill claim-task --id ${task.id}`,
    '   If the claim returns null or errors, the task was taken by someone else — stop immediately and do nothing further.',
    '2. Do the work. Verify what you build (run it, query it, read it back) — never report what a commit message claims.',
    `3. Deliver: anthill submit-task --id ${task.id} --result "<what was done and VERIFIED, where it landed: commits/paths/links>"`,
    `   Stuck on a question only Dmitri can answer: anthill block-task --id ${task.id} --reason "<the question>"`,
    '4. NEVER mark the task DONE — acceptance is Dmitri\'s alone, REVIEW is as far as you go.',
    '5. File discovered follow-up work with anthill create-task under the same desiredState.',
    '',
    'Mission Control (https://mc.dudin.net) is the board this run appears on. Two things make it legible there, both before you start work:',
    'a. Register the task definition, so the card can jump to it:',
    `   mc-reporter link --kind anthill-task --label ${JSON.stringify(`Task: ${task.title.slice(0, 100)}`)} --url ${WEB_URL}/tasks/${task.id}`,
    '   (it reads CLAUDE_CODE_SESSION_ID from your environment — no session id to pass).',
    'b. Keep a task ledger: write the plan down with the task tools BEFORE starting, one entry per step, and move each to in_progress/completed as it happens.',
    '   The board reads that list. A runner with no ledger is a blank card for however long it runs, indistinguishable from one that has hung.',
  ].join('\n');
}

async function tick(): Promise<void> {
  if (ticking) {
    return;
  }
  ticking = true;
  try {
    const token = await getToken();
    if (!token) {
      console.warn('[AnthillWatcher] no queue token available (keychain/env) — skipping tick');
      return;
    }
    const tasks = await fetchQueuedMacTasks(token);
    if (tasks === null) {
      return; // failed observation — do not touch the ledger
    }
    if (tasks.length === 0) {
      return;
    }
    const ledger = readLedger();
    for (const task of tasks) {
      const existing = ledger[task.id];
      if (existing && Date.now() - existing.spawnedAt < RESPAWN_AFTER_MS) {
        continue;
      }
      try {
        const { sessionId } = sessionsService.createAppSession('claude', PROJECT_PATH);
        const sent = serverEnqueueMessage(sessionId, buildPrompt(task), {
          permissionMode: 'bypassPermissions',
        });
        if (!sent) {
          console.warn(`[AnthillWatcher] session ${sessionId} vanished before first send (task ${task.id})`);
          continue;
        }
        ledger[task.id] = { sessionId, spawnedAt: Date.now(), title: task.title.slice(0, 80) };
        console.log(`[AnthillWatcher] spawned session ${sessionId} for task ${task.id} (${task.title.slice(0, 60)})`);
      } catch (error) {
        console.error(`[AnthillWatcher] failed to spawn for task ${task.id}: ${(error as Error).message}`);
      }
    }
    writeLedger(ledger);
  } finally {
    ticking = false;
  }
}

export function initializeAnthillMacWatcher(): void {
  if (process.env.ANTHILL_MAC_WATCHER !== '1') {
    return;
  }
  if (timer) {
    return;
  }
  console.log(`[AnthillWatcher] enabled — polling ${API_URL} pool=mac every ${POLL_MS / 1000}s`);
  // First look shortly after boot (give the ws/session machinery a beat), then steady polls.
  setTimeout(() => void tick(), 15_000);
  timer = setInterval(() => void tick(), POLL_MS);
}

export function closeAnthillMacWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
