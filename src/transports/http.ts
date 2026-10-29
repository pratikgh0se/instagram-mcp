import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { registerSecret } from '../redact.js';
import { GLOBAL_SCOPE } from '../secrets/index.js';
import { buildServer } from '../server.js';

const MAX_BODY_BYTES = 1024 * 1024;
const AUTH_FAIL_LIMIT = 20;
const AUTH_FAIL_WINDOW_MS = 60_000;

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export interface HttpOptions {
  host: string;
  port: number;
  /** Extra routes (daemon webhooks). Return true when the request was handled. Runs only after Host/Origin checks. */
  extraRoutes?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** Paths that skip bearer auth (e.g. signed webhook callbacks). Host/Origin checks still apply. */
  unauthenticatedPaths?: string[];
  /** Serve the MCP endpoint (default true). False = only `exemptRoutes` are served (daemon without --http); no bearer needed. */
  mcp?: boolean;
  /** Routes exempt from the bearer AND Host/Origin checks (signed webhook callbacks, contract D6). Handled before every other check. */
  exemptRoutes?: { paths: string[]; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> };
}

export interface HttpHandle {
  server: HttpServer;
  host: string;
  port: number;
  close(): Promise<void>;
}

function sha(v: string): Buffer {
  return createHash('sha256').update(v).digest();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Streamable HTTP MCP endpoint at /mcp: loopback bind, mandatory bearer, Host/Origin allowlists, 1 MB body limit. */
export async function startHttpServer(ctx: AppContext, opts: HttpOptions): Promise<HttpHandle> {
  const cfg = ctx.config.http;
  if (!isLoopbackHost(opts.host) && !cfg.allow_remote) {
    throw new AppError('CONFIG_INVALID', `Refusing to bind ${opts.host}: not a loopback address.`, {
      action: 'Bind 127.0.0.1, or set http.allow_remote to true (and put TLS/auth in front) if you really need remote access.'
    });
  }
  const mcpEnabled = opts.mcp !== false;
  const bearer = mcpEnabled ? await ctx.secrets.get(GLOBAL_SCOPE, 'http_bearer') : 'unused-webhook-only-listener';
  if (!bearer) {
    throw new AppError('CONFIG_INVALID', 'No HTTP bearer token is configured; refusing to start the HTTP transport.', {
      action: 'Run `instagram-mcp http-token rotate` (or set INSTAGRAM_MCP_HTTP_TOKEN) and send it as "Authorization: Bearer <token>".'
    });
  }
  if (mcpEnabled) registerSecret(bearer);
  const expected = sha(bearer);

  // Host must be a loopback name on the bound port, the bound host, or the host part of an allowed origin / allowed_hosts entry.
  let boundPort = 0;
  const looseHosts = new Set<string>(cfg.allowed_hosts.map((h) => h.toLowerCase()));
  for (const o of cfg.allowed_origins) {
    try { looseHosts.add(new URL(o).hostname.toLowerCase().replace(/^\[|\]$/g, '')); } catch { /* ignore malformed entry */ }
  }
  const hostAllowed = (hostHeader: string): boolean => {
    const name = hostnameOf(hostHeader);
    const portPart = hostHeader.startsWith('[') ? hostHeader.slice(hostHeader.indexOf(']') + 1).replace(/^:/, '') : (hostHeader.split(':')[1] ?? '');
    const onBoundPort = portPart === String(boundPort);
    if (['127.0.0.1', 'localhost', '::1'].includes(name) && onBoundPort) return true;
    if (name === opts.host.replace(/^\[|\]$/g, '').toLowerCase() && onBoundPort) return true;
    return looseHosts.has(name);
  };
  const allowedOrigins = new Set(cfg.allowed_origins.map((o) => o.replace(/\/+$/, '').toLowerCase()));
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const failures = new Map<string, number[]>();

  const recentFailures = (ip: string): number => {
    const now = Date.now();
    const list = (failures.get(ip) ?? []).filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
    failures.set(ip, list);
    return list.length;
  };

  const hostnameOf = (hostHeader: string): string => {
    if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']')).toLowerCase();
    return hostHeader.split(':')[0]!.toLowerCase();
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (opts.exemptRoutes) {
      const p = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (opts.exemptRoutes.paths.includes(p)) {
        await opts.exemptRoutes.handler(req, res);
        return;
      }
    }
    if (!mcpEnabled) {
      sendJson(res, 404, rpcError(-32000, 'Not found'));
      return;
    }
    // Order (contract section 4): body size, Host (DNS-rebinding), Origin, bearer.
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      sendJson(res, 413, rpcError(-32000, 'Request body too large (1 MB limit)'), { connection: 'close' });
      return;
    }
    const host = req.headers.host;
    if (!host || !hostAllowed(host)) {
      sendJson(res, 403, rpcError(-32000, 'Host not allowed'));
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin.replace(/\/+$/, '').toLowerCase())) {
      sendJson(res, 403, rpcError(-32000, 'Origin not allowed'));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const open = opts.unauthenticatedPaths?.includes(url.pathname) ?? false;

    if (!open) {
      if (recentFailures(ip) >= AUTH_FAIL_LIMIT) {
        // Only requests that also fail authentication get 429; a valid bearer is unaffected (contract section 4).
        const hdr = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
        if (!hdr || !timingSafeEqual(sha(hdr[1]!.trim()), expected)) {
          sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many failed authentication attempts.' } }, { 'retry-after': String(AUTH_FAIL_WINDOW_MS / 1000) });
          return;
        }
      }
      const header = req.headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/i.exec(header);
      const valid = m ? timingSafeEqual(sha(m[1]!.trim()), expected) : false;
      if (!valid) {
        failures.get(ip)!.push(Date.now());
        sendJson(res, 401, { error: { code: m ? 'AUTH_FAILED' : 'AUTH_REQUIRED', message: m ? 'Invalid bearer token.' : 'Missing bearer token.' } }, { 'www-authenticate': 'Bearer' });
        return;
      }
    }

    if (opts.extraRoutes && (await opts.extraRoutes(req, res))) return;
    if (url.pathname !== '/mcp') {
      sendJson(res, 404, rpcError(-32000, 'Not found'));
      return;
    }

    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;

    if (req.method === 'POST') {
      let parsed: unknown;
      try {
        const raw = await readBody(req);
        parsed = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        if (error instanceof BodyTooLarge) sendJson(res, 413, rpcError(-32000, 'Request body too large (1 MB limit)'));
        else sendJson(res, 400, rpcError(-32700, 'Parse error'));
        return;
      }
      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        if (sessionId || !isInitializeRequest(parsed)) {
          sendJson(res, sessionId ? 404 : 400, rpcError(-32000, sessionId ? 'Unknown session' : 'Missing session; send initialize first'));
          return;
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, t); }
        });
        t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
        await buildServer(ctx).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, parsed);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        sendJson(res, sessionId ? 404 : 400, rpcError(-32000, sessionId ? 'Unknown session' : 'Missing session id'));
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }
    sendJson(res, 405, rpcError(-32000, 'Method not allowed'), { allow: 'GET, POST, DELETE' });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      ctx.log.error(`http handler error: ${(error as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal server error'));
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(new AppError('CONFIG_INVALID', `Cannot listen on ${opts.host}:${opts.port}: ${error.message}`, { cause: error }))
    );
    server.listen(opts.port, opts.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  boundPort = port;
  process.stderr.write(JSON.stringify({ event: 'listening', host: opts.host, port, transport: 'http' }) + '\n');

  return {
    server, host: opts.host, port,
    close: async () => {
      for (const t of sessions.values()) await t.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export async function runHttp(ctx: AppContext, opts: HttpOptions): Promise<void> {
  const handle = await startHttpServer(ctx, opts);
  await new Promise<void>((resolve) => {
    const stop = (): void => { handle.close().finally(resolve); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
