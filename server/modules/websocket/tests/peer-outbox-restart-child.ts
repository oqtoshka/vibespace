/**
 * A fresh process for the restart test: nothing in memory, only the database
 * file named by DATABASE_PATH (kept as given via PEER_OUTBOX_KEEP_DATABASE_PATH).
 * Boots the host's chat dependencies with a recording runtime and starts the
 * outbox sweeper in server/index.js's order, and prints what the runtime received plus the rows' states.
 */
import './peer-outbox-env.js';

import { getConnection, initializeDatabase } from '@/modules/database/index.js';
import { registerChatDependenciesAtBoot, startPeerOutboxSweeper, stopPeerOutboxSweeper } from '@/modules/websocket/services/chat-websocket.service.js';

import { recordingRuntime, type RuntimeCall } from './peer-message-fixture.js';

// The order server/index.js uses: chat dependencies at module load, then the
// schema, then the sweeper.
const received: RuntimeCall[] = [];
registerChatDependenciesAtBoot(recordingRuntime(received, { hasRuntime: true }));
await initializeDatabase();
startPeerOutboxSweeper();
await new Promise((resolve) => setTimeout(resolve, 50));
stopPeerOutboxSweeper();
const rows = getConnection().prepare('SELECT request_id, status, reason FROM peer_outbox ORDER BY request_id').all();
process.stdout.write(`${JSON.stringify({ received: received.map((call) => call.content), rows })}\n`);
process.exit(0);
