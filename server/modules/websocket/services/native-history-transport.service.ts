import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

const CHUNK_BYTES = 1024 * 1024;

/** Application frames stay below the edge/iOS WebSocket message limit. Await
 * writes so a page of inline tool images cannot overflow the socket buffer. */
export async function sendNativeHistory(ws: WebSocket, payload: Record<string, unknown>, chunked: boolean): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(payload));
  const write = (value: string) => new Promise<void>((resolve, reject) => {
    if (ws.readyState !== 1) { reject(new Error('Chat disconnected')); return; }
    ws.send(value, error => error ? reject(error) : resolve());
  });
  if (!chunked || bytes.length <= CHUNK_BYTES) { await write(bytes.toString()); return; }
  if (bytes.length > 64 * 1024 * 1024) throw new Error('History page is too large. Request fewer messages.');
  const transferId = randomUUID();
  const count = Math.ceil(bytes.length / CHUNK_BYTES);
  for (let index = 0; index < count; index++) {
    await write(JSON.stringify({ kind: 'native.chunk', transferId, index, count,
      data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') }));
  }
}
