import { createHmac, timingSafeEqual } from 'node:crypto';

/** Used by the native gateway to bind a backend-held MC capability to one chat. */
export function validNativeCapability(sessionId: string, supplied: unknown, secret: string): boolean {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(sessionId) || typeof supplied !== 'string') return false;
  const expected = createHmac('sha256', secret).update(`mission-control:vibespace-session:v1:${sessionId}`).digest('base64url');
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

/** Native gateway accepts a narrow command vocabulary; no arbitrary runtime options. */
export function scopeNativeCommand(data: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  if (data.sessionId !== undefined && data.sessionId !== sessionId) throw new Error('Wrong session');
  switch (data.type) {
    case 'chat.subscribe': return { type: data.type, sessions: [{ sessionId, lastSeq: 0 }] };
    case 'chat.abort': return { type: data.type, sessionId };
    case 'chat.send':
      if (typeof data.content !== 'string' || !data.content.trim() || data.content.length > 200_000 ||
          typeof data.clientMsgId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(data.clientMsgId)) throw new Error('Invalid message');
      return { type: data.type, sessionId, content: data.content, clientMsgId: data.clientMsgId };
    case 'chat.permission-response':
      if (typeof data.requestId !== 'string' || typeof data.allow !== 'boolean') throw new Error('Invalid permission answer');
      return { type: data.type, requestId: data.requestId, allow: data.allow, message: typeof data.message === 'string' ? data.message.slice(0, 4000) : undefined };
    default: throw new Error('This command is not available in the native prototype');
  }
}
