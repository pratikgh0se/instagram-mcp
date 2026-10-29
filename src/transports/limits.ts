import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;

/** Longest we keep reading an oversized upload before answering 413 anyway. */
const DRAIN_MAX_MS = 3_000;

export class BodyTooLarge extends Error {}

/** Header/request/keep-alive timeouts for every listener we start (MCP, webhook, daemon). */
export function applyServerTimeouts(server: HttpServer): void {
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
}

/**
 * Collect a request body up to MAX_BODY_BYTES. On overflow it rejects with BodyTooLarge but keeps
 * consuming (and discarding) the rest of the upload, so the caller can answer 413 and the socket is
 * not reset under the client's feet.
 */
export function readBodyLimited(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) {
      req.resume();
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', (error) => { if (!over) reject(error); });
  });
}

/**
 * Answer 413 with `Connection: close`. The response is written only after the (capped) remainder of the
 * upload has been drained, because Node destroys the socket right after a `Connection: close` response and
 * unread incoming data would turn that into a TCP reset the client sees instead of the 413.
 */
export function respondTooLarge(req: IncomingMessage, res: ServerResponse, body: string, contentType = 'application/json'): void {
  const payload = Buffer.from(body);
  let sent = false;
  const send = (): void => {
    if (sent) return;
    sent = true;
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(413, { 'content-type': contentType, 'content-length': payload.length, connection: 'close' });
    }
    res.end(payload);
  };
  const timer = setTimeout(send, DRAIN_MAX_MS);
  timer.unref();
  req.on('end', send);
  req.on('close', send);
  req.on('error', send);
  if (req.readableEnded) send();
  else req.resume();
}
