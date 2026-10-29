import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { openNoFollow } from '../publish/localmedia.js';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { errorMessage } from '../redact.js';

/** Staged files live 24 h after container creation (contract section 6, D27). */
export const STAGED_TTL_MS = 24 * 3_600_000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PATH_RE = /^\/m\/([A-Za-z0-9_-]{43})$/;

export interface StagedFile {
  token: string;
  path: string;
  content_type: string;
  size: number;
  sha256: string;
  expires_at: string;
}

interface StagedRow {
  token: string;
  path: string;
  content_type: string;
  size: number;
  sha256: string | null;
  expires_at: string;
  deleted_at: string | null;
  owner_id: string | null;
}

// ---------- staging (files + staged_media rows) ----------

export interface StageInput {
  sourcePath: string;
  contentType: string;
  account: string;
  /** Approval id or scheduled-job id that uses the file; used for cleanup. */
  ownerId: string;
  expiresAt: string;
  /** When given, the copy must hash to this value, else STALE_PREVIEW (the source changed since preflight). */
  expectedSha256?: string;
}

/** Copy a local file into staging/<token> (mode 0600), hashing while copying, and record it. */
export async function stageFile(ctx: AppContext, input: StageInput): Promise<StagedFile> {
  const token = randomBytes(32).toString('base64url');
  const dest = join(ctx.paths.stagingDir, token);
  const hash = createHash('sha256');
  let size = 0;
  try {
    const src = openNoFollow(input.sourcePath);
    src.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      size += buf.length;
    });
    await pipeline(src, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    rmSync(dest, { force: true });
    throw new AppError('STALE_PREVIEW', `The local media file is missing or unreadable (${errorMessage(error)}); nothing was sent.`, {
      action: 'Run instagram_preflight_publish again.'
    });
  }
  const sha256 = hash.digest('hex');
  if (input.expectedSha256 && input.expectedSha256 !== sha256) {
    rmSync(dest, { force: true });
    throw new AppError('STALE_PREVIEW', 'A local media file changed since the preflight; nothing was sent.', { action: 'Run instagram_preflight_publish again.' });
  }
  ctx.storage.db
    .prepare(
      `INSERT INTO staged_media (token, account, source_path, path, content_type, size, sha256, created_at, expires_at, owner_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(token, input.account, input.sourcePath, dest, input.contentType, size, sha256, ctx.clock.nowIso(), input.expiresAt, input.ownerId);
  return { token, path: dest, content_type: input.contentType, size, sha256, expires_at: input.expiresAt };
}

/** On-disk path of a staged (not deleted) file, if it still exists. */
export function getStagedPath(ctx: AppContext, token: string): string | undefined {
  const row = ctx.storage.db.prepare('SELECT path FROM staged_media WHERE token=? AND deleted_at IS NULL').get(token) as { path: string } | undefined;
  return row && existsSync(row.path) ? row.path : undefined;
}

export function stagedExpiry(ctx: AppContext): string {
  return new Date(ctx.clock.nowMs() + STAGED_TTL_MS).toISOString();
}

/** Restart the 24 h expiry of already staged files (scheduled jobs: counted from container creation). */
export function refreshStagedExpiry(ctx: AppContext, tokens: string[]): void {
  const expires = stagedExpiry(ctx);
  const stmt = ctx.storage.db.prepare('UPDATE staged_media SET expires_at=? WHERE token=? AND deleted_at IS NULL');
  for (const t of tokens) stmt.run(expires, t);
}

function removeRow(ctx: AppContext, row: { token: string; path: string }): void {
  rmSync(row.path, { force: true });
  ctx.storage.db.prepare('UPDATE staged_media SET deleted_at=? WHERE token=?').run(ctx.clock.nowIso(), row.token);
}

/** Delete staged files by token (their URLs return 404 afterwards). */
export function deleteStaged(ctx: AppContext, tokens: string[]): void {
  const get = ctx.storage.db.prepare('SELECT token, path FROM staged_media WHERE token=? AND deleted_at IS NULL');
  for (const t of tokens) {
    const row = get.get(t) as { token: string; path: string } | undefined;
    if (row) removeRow(ctx, row);
  }
}

export function deleteStagedByOwner(ctx: AppContext, ownerId: string): void {
  const rows = ctx.storage.db.prepare('SELECT token, path FROM staged_media WHERE owner_id=? AND deleted_at IS NULL').all(ownerId) as Array<{ token: string; path: string }>;
  for (const row of rows) removeRow(ctx, row);
}

/** Delete expired staged files. Returns how many were removed. Registered as the "staging-cleanup" job. */
export function cleanupStaging(ctx: AppContext): number {
  const rows = ctx.storage.db
    .prepare('SELECT token, path FROM staged_media WHERE deleted_at IS NULL AND expires_at <= ?')
    .all(ctx.clock.nowIso()) as Array<{ token: string; path: string }>;
  for (const row of rows) removeRow(ctx, row);
  return rows.length;
}

export function mediaHostUnavailable(reason: string): AppError {
  return new AppError('MEDIA_HOST_UNAVAILABLE', reason, {
    action:
      'Set media_host.public_base_url in the config to a public HTTPS URL that tunnels to the media host port (e.g. a Cloudflare Tunnel to http://127.0.0.1:<media_host.port>), or use public media URLs instead of local paths.'
  });
}

/** `{public_base_url}/m/{token}`; MEDIA_HOST_UNAVAILABLE when no public base URL is configured. */
export function publicUrl(ctx: AppContext, token: string): string {
  const base = ctx.config.media_host.public_base_url;
  if (!base) throw mediaHostUnavailable('A local file needs the media host, but media_host.public_base_url is not configured.');
  return `${base}/m/${token}`;
}

// ---------- HTTP server ----------

interface Host {
  server: Server;
  ctx: AppContext;
}

let host: Host | undefined;
let starting: Promise<void> | undefined;

function lookup(ctx: AppContext, token: string): StagedRow | undefined {
  if (!TOKEN_RE.test(token)) return undefined;
  const row = ctx.storage.db
    .prepare('SELECT token, path, content_type, size, sha256, expires_at, deleted_at, owner_id FROM staged_media WHERE token=?')
    .get(token) as StagedRow | undefined;
  if (!row || row.deleted_at || row.expires_at <= ctx.clock.nowIso() || !existsSync(row.path)) return undefined;
  return row;
}

/** Single `bytes=a-b` / `bytes=a-` / `bytes=-n` range; undefined = unsatisfiable or malformed. */
function parseRange(header: string, size: number): { start: number; end: number } | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return undefined;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return undefined;
  return { start, end };
}

function plain(res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': 0, ...headers });
  res.end();
}

/**
 * Port-owner probe (challenge-response). The owner keeps a random 32-byte secret in `<home>/media-host.key` (0600, created on
 * first use). A prober sends `GET /m/__health?nonce=<random>`; only that request is answered with
 * `x-instagram-mcp-media-host-proof: HMAC-SHA256(secret, nonce)` (hex). No other response carries any marker.
 */
export const HOST_PROOF_HEADER = 'x-instagram-mcp-media-host-proof';

function hostSecret(ctx: AppContext): Buffer {
  const file = join(ctx.paths.home, 'media-host.key');
  try {
    const existing = readFileSync(file);
    if (existing.length === 32) return existing;
  } catch { /* create below */ }
  const secret = randomBytes(32);
  try {
    writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
  } catch {
    // Lost a creation race (or it exists but is malformed): use whatever is on disk now.
    const again = readFileSync(file);
    if (again.length === 32) return again;
    writeFileSync(file, secret, { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return secret;
}

const hostProof = (ctx: AppContext, nonce: string): string => createHmac('sha256', hostSecret(ctx)).update(nonce).digest('hex');

/** True when 127.0.0.1:port proves, by HMAC of a fresh nonce, that it holds this home's media-host secret. */
function probeSameHost(ctx: AppContext): Promise<boolean> {
  return new Promise((resolve) => {
    const nonce = randomBytes(16).toString('hex');
    const expected = Buffer.from(hostProof(ctx, nonce));
    const req = httpRequest(
      { host: '127.0.0.1', port: ctx.config.media_host.port, path: `/m/__health?nonce=${nonce}`, method: 'GET', timeout: 2000 },
      (res) => {
        res.resume();
        const got = res.headers[HOST_PROOF_HEADER];
        resolve(typeof got === 'string' && got.length === expected.length && timingSafeEqual(Buffer.from(got), expected));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const ctx = host!.ctx;
  try {
    const rawPath = (req.url ?? '').split('?')[0] ?? '';
    if (rawPath === '/m/__health') {
      const nonce = new URL(req.url ?? '', 'http://x').searchParams.get('nonce') ?? '';
      if (/^[0-9a-f]{32}$/.test(nonce)) return plain(res, 204, { [HOST_PROOF_HEADER]: hostProof(ctx, nonce) });
      return plain(res, 404);
    }
    const match = PATH_RE.exec(rawPath);
    if (!match) return plain(res, 404);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return plain(res, 405, { allow: 'GET, HEAD' });
    const row = lookup(ctx, match[1]!);
    if (!row) return plain(res, 404);

    // Serve from the real file size (identical to the bytes staged).
    const size = statSync(row.path).size;
    const headers: Record<string, string | number> = { 'content-type': row.content_type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (typeof rangeHeader === 'string') {
      const range = parseRange(rangeHeader, size);
      if (!range) return plain(res, 416, { 'content-range': `bytes */${size}` });
      ({ start, end } = range);
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (method === 'HEAD' || size === 0) return void res.end();
    const stream = createReadStream(row.path, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    if (!res.headersSent) plain(res, 404);
    else res.destroy();
  }
}

/** Start the loopback media server on media_host.port if this process is not already serving. Idempotent. */
export async function ensureMediaHost(ctx: AppContext): Promise<void> {
  if (host) {
    host.ctx = ctx;
    return;
  }
  if (!ctx.config.media_host.public_base_url) {
    throw mediaHostUnavailable('A local file needs the media host, but media_host.public_base_url is not configured.');
  }
  starting ??= new Promise<void>((resolve, reject) => {
    hostSecret(ctx); // create <home>/media-host.key (0600) on first use
    const server = createServer(handle);
    server.once('error', (error: NodeJS.ErrnoException) => {
      starting = undefined;
      if (error.code === 'EADDRINUSE') {
        // Another instance (e.g. the daemon) with the same state dir may own the port; it serves the same staged files.
        void probeSameHost(ctx).then((same) => {
          if (same) resolve();
          else reject(mediaHostUnavailable(`The media host could not bind ${ctx.config.media_host.bind}:${ctx.config.media_host.port} (EADDRINUSE, and the port is not served by this server's state dir).`));
        });
        return;
      }
      reject(mediaHostUnavailable(`The media host could not bind ${ctx.config.media_host.bind}:${ctx.config.media_host.port} (${error.code ?? errorMessage(error)}).`));
    });
    server.listen(ctx.config.media_host.port, ctx.config.media_host.bind, () => {
      server.removeAllListeners('error');
      server.on('error', (error) => ctx.log.warn(`media host error: ${errorMessage(error)}`));
      server.unref();
      host = { server, ctx };
      resolve();
    });
  });
  await starting;
}

export async function stopMediaHost(): Promise<void> {
  const current = host;
  host = undefined;
  starting = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
    current.server.closeAllConnections();
  });
}
