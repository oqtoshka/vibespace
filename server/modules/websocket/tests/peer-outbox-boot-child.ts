/**
 * A fresh process on an empty, never-initialized database file — a first boot
 * of a release that adds `peer_outbox`. Mirrors server/index.js: the chat
 * dependencies are registered at module load, before initializeDatabase().
 * Prints one JSON line; a throw exits non-zero.
 */
import './peer-outbox-env.js';

import { getConnection, initializeDatabase } from '@/modules/database/index.js';
import { registerChatDependenciesAtBoot, startPeerOutboxSweeper, stopPeerOutboxSweeper } from '@/modules/websocket/services/chat-websocket.service.js';

import { recordingRuntime, type RuntimeCall } from './peer-message-fixture.js';

const received: RuntimeCall[] = [];
registerChatDependenciesAtBoot(recordingRuntime(received, { hasRuntime: true }));
await initializeDatabase();
startPeerOutboxSweeper();
stopPeerOutboxSweeper();
const table = getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peer_outbox'").get();
process.stdout.write(`${JSON.stringify({ booted: true, table: Boolean(table) })}\n`);
process.exit(0);
