import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Thin transport adapter that gives WebSocket connections the same interface as
 * SSE writers used by API routes (`send`, `setSessionId`, `getSessionId`).
 *
 * A writer can fan out to several sockets: the same session may be watched from
 * multiple tabs/devices, and each one attaches via `updateWebSocket` when it
 * opens the session (check-session-status). Replacing the socket instead of
 * attaching made streaming last-claimer-wins — every other client silently
 * missed the events sent while it didn't hold the writer.
 */
export class WebSocketWriter {
  ws: RealtimeClientConnection;
  sessionId: string | null;
  userId: string | number | null;
  isWebSocketWriter: boolean;
  private attachedSockets: Set<RealtimeClientConnection>;

  constructor(ws: RealtimeClientConnection, userId: string | number | null = null) {
    this.ws = ws;
    this.sessionId = null;
    this.userId = userId;
    this.isWebSocketWriter = true;
    this.attachedSockets = new Set([ws]);
  }

  send(data: unknown): void {
    const payload = JSON.stringify(data);
    for (const socket of this.attachedSockets) {
      if (socket.readyState === WS_OPEN_STATE) {
        socket.send(payload);
      } else {
        // Closed sockets (page refresh, dropped connection) are pruned lazily.
        this.attachedSockets.delete(socket);
      }
    }
  }

  updateWebSocket(newRawWs: RealtimeClientConnection): void {
    this.attachedSockets.add(newRawWs);
    // Keep the legacy single-socket reference pointing at the latest attachee.
    this.ws = newRawWs;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}
