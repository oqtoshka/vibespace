/**
 * A fresh process for the restart test: nothing in memory, only the database
 * file named by DATABASE_PATH (kept as given via PEER_OUTBOX_KEEP_DATABASE_PATH).
 * Boots the host's chat dependencies with a recording runtime, which runs the
 * outbox sweep, and prints what the runtime received plus the rows' states.
 */
import './peer-outbox-env.js';

import { getConnection, initializeDatabase } from '@/modules/database/index.js';
import { registerChatDependenciesAtBoot } from '@/modules/websocket/services/chat-websocket.service.js';
import { stopPeerOutboxSweeper } from '@/modules/websocket/services/chat-websocket.service.js';

import { recordingRuntime, type RuntimeCall } from './peer-message-fixture.js';

await initializeDatabase();
const received: RuntimeCall[] = [];
registerChatDependenciesAtBoot(recordingRuntime(received, { hasRuntime: true }));
await new Promise((resolve) => setTimeout(resolve, 50));
stopPeerOutboxSweeper();
const rows = getConnection().prepare('SELECT request_id, status, reason FROM peer_outbox ORDER BY request_id').all();
process.stdout.write(`${JSON.stringify({ received: received.map((call) => call.content), rows })}\n`);
process.exit(0);
