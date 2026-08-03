import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { AUTH_SESSION_EXPIRED_EVENT, WS_CLOSE_CODE_AUTH_FAILED } from '../utils/authEvents';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  /**
   * Legacy state-based access to the most recent frame.
   *
   * Kept only for low-frequency consumers (TaskMaster broadcasts). High-rate
   * chat streams must use `subscribe` — React may batch state updates, which
   * makes `latestMessage` lossy under load.
   */
  latestMessage: ServerEvent | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

/**
 * Subscribe to every inbound WebSocket frame without missing any. The handler
 * is kept in a ref so it always sees the latest closure (current props/state)
 * without re-subscribing on every render — exactly-once, in-order delivery is
 * preserved regardless of re-render frequency. Thin wrapper over `subscribe`.
 */
export const useWebSocketEvent = (handler: (message: ServerEvent) => void) => {
  const { subscribe } = useWebSocket();
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => subscribe((message) => handlerRef.current(message)), [subscribe]);
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

/**
 * Upper bound on outbound frames buffered while the socket is down. Sends are
 * intent the UI already assumes happened (optimistic message bubble, queue
 * optimism), so they are held and flushed on (re)connect rather than dropped —
 * the cap only guards against a pathological offline pile-up.
 */
const MAX_BUFFERED_OUTBOUND_FRAMES = 100;

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Frames sent while the socket was CONNECTING/closed, waiting for the next
   * open to be delivered in order. Dropping them instead loses user messages
   * silently: the composer has already rendered the optimistic bubble, so a
   * send that never leaves the browser looks like the message just vanished.
   */
  const outboundBufferRef = useRef<string[]>([]);
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();
  /**
   * The token is read when a socket is *opened*, never while one is live — the
   * server authenticates the upgrade and does not re-check the JWT afterwards.
   * Keeping it in a ref is what lets the connect effect ignore rotation: the
   * next connect (reconnect, re-login) still picks up the freshest value.
   */
  const tokenRef = useRef(token);
  // Layout effects run before passive ones, so the ref is current by the time
  // the connect effect below fires on the same render.
  useLayoutEffect(() => {
    tokenRef.current = token;
  }, [token]);
  // `authenticatedFetch` rotates the token once it passes half-life, and every
  // response in flight at that moment carries its OWN new token — so a burst of
  // concurrent requests used to produce a burst of `setToken` calls. Keyed on
  // the token value, this effect tore down and rebuilt the socket for each one,
  // and every reconnect dispatches `websocket_reconnected`, which makes
  // subscribers re-fetch: the UI visibly reloaded itself several times over.
  // Only the presence of a session can require a (dis)connect.
  const isAuthenticated = Boolean(token);

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on login after a logout) would short-circuit
    // connect() at its unmounted guard and leave the socket permanently
    // disconnected.
    unmountedRef.current = false;
    if (isAuthenticated) {
      connect();
    }

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [isAuthenticated]); // log in / log out — a rotated token reuses the live socket

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(tokenRef.current);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        setIsConnected(true);
        wsRef.current = websocket;

        // Deliver frames sent while the socket was down, in order, before any
        // reconnect catch-up traffic. The socket can close again mid-flush;
        // the remainder stays buffered for the next reconnect.
        while (outboundBufferRef.current.length > 0 && websocket.readyState === WebSocket.OPEN) {
          const payload = outboundBufferRef.current.shift();
          if (payload !== undefined) {
            websocket.send(payload);
          }
        }

        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = (event) => {
        setIsConnected(false);
        wsRef.current = null;

        // The server rejected our JWT — retrying with the same token would
        // loop forever. Hand off to AuthContext so the login screen renders;
        // a successful login changes `token`, which reconnects via the effect.
        if (event.code === WS_CLOSE_CODE_AUTH_FAILED && !IS_PLATFORM) {
          window.dispatchEvent(new CustomEvent(AUTH_SESSION_EXPIRED_EVENT));
          return;
        }

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch]); // the token is read through tokenRef, so rotation can't churn this

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    const payload = JSON.stringify(message);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
    // Not connected (initial CONNECTING window, or between reconnect
    // attempts): hold the frame and deliver it when the socket opens.
    console.warn('WebSocket not connected — buffering outbound message');
    outboundBufferRef.current.push(payload);
    if (outboundBufferRef.current.length > MAX_BUFFERED_OUTBOUND_FRAMES) {
      outboundBufferRef.current.splice(
        0,
        outboundBufferRef.current.length - MAX_BUFFERED_OUTBOUND_FRAMES,
      );
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  // The composer restores journaled sends it presumes lost back into the
  // input. If such a frame is still sitting in the outbound buffer, a later
  // reconnect would deliver it anyway — the same content twice. The restore
  // path announces the ids it reclaimed; drop any buffered frame carrying one.
  useEffect(() => {
    const onDropFrames = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        return;
      }
      outboundBufferRef.current = outboundBufferRef.current.filter(
        (payload) => !ids.some((id) => payload.includes(`"${id}"`)),
      );
    };
    window.addEventListener('vibespace:drop-outbound-frames', onDropFrames);
    return () => window.removeEventListener('vibespace:drop-outbound-frames', onDropFrames);
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    latestMessage,
    isConnected
  }), [sendMessage, subscribe, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
