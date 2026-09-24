export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
export {
  registerChatDependenciesAtBoot,
  serverAbortRun,
  serverEnqueueMessage,
  serverEnqueueMessageChecked,
  // PluginHost.enqueueMessage, including its `deliverMidTurn` steering flag.
  pluginHostEnqueueMessage,
  // idle-only admission: PluginHost.enqueueMessageIfIdle (the Janitor's owner check).
  serverEnqueueMessageIfIdle,
  // peer outbox: used by server/index.js to expose PluginHost.peerOutbox.
  admitPeerMessage,
  getPeerMessage,
  // peer outbox: started by server/index.js startServer() once the schema exists.
  startPeerOutboxSweeper,
} from './services/chat-websocket.service.js';
