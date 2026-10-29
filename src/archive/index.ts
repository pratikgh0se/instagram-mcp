import type { IncomingMessage } from 'node:http';
import { pinnedRequest } from '../net/ssrf.js';
import { chmodSync, constants, createWriteStream, openSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from '../context.js';
import { writePrivateFile, type ResolvedAccount } from '../config/index.js';
import { AppError, isAppError } from '../errors.js';
import { redact } from '../redact.js';

export const MEDIA_LIST_FIELDS =
  'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url,is_comment_enabled';

// ---------- media_index helpers ----------
export interface IndexedMedia {
  id: string;
  media_type?: unknown;
  media_product_type?: unknown;
  permalink?: unknown;
  caption?: unknown;
  timestamp?: unknown;
  like_count?: unknown;
  comments_count?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** Upsert listing data into media_index without clobbering existing values with nulls or touching download state. */
export function upsertMediaIndex(ctx: AppContext, account: string, items: IndexedMedia[]): void {
  if (items.length === 0) return;
  const now = ctx.clock.nowIso();
  const stmt = ctx.storage.db.prepare(`INSERT INTO media_index
      (account, media_id, media_type, product_type, permalink, caption, posted_at, like_count, comments_count, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account, media_id) DO UPDATE SET
        media_type=COALESCE(excluded.media_type, media_index.media_type),
        product_type=COALESCE(excluded.product_type, media_index.product_type),
        permalink=COALESCE(excluded.permalink, media_index.permalink),
        caption=COALESCE(excluded.caption, media_index.caption),
        posted_at=COALESCE(excluded.posted_at, media_index.posted_at),
        like_count=COALESCE(excluded.like_count, media_index.like_count),
        comments_count=COALESCE(excluded.comments_count, media_index.comments_count),
        updated_at=excluded.updated_at`);
  ctx.storage.tx(() => {
    for (const m of items) {
      stmt.run(account, m.id, str(m.media_type), str(m.media_product_type), str(m.permalink), str(m.caption), str(m.timestamp),
        int(m.like_count), int(m.comments_count), now);
    }
  });
}

export function isDownloaded(ctx: AppContext, account: string, mediaId: string): boolean {
  const row = ctx.storage.db.prepare('SELECT downloaded_at FROM media_index WHERE account=? AND media_id=?').get(account, mediaId) as
    | { downloaded_at: string | null } | undefined;
  return Boolean(row?.downloaded_at);
}

export function markDownloaded(ctx: AppContext, account: string, mediaId: string, localPath: string): void {
  const now = ctx.clock.nowIso();
  ctx.storage.db.prepare(`INSERT INTO media_index (account, media_id, downloaded_at, local_path, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(account, media_id) DO UPDATE SET downloaded_at=excluded.downloaded_at, local_path=excluded.local_path, updated_at=excluded.updated_at`)
    .run(account, mediaId, now, localPath, now);
}

// ---------- download ----------
export function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

const testMode = (): boolean => process.env.INSTAGRAM_MCP_TEST_MODE === '1';

/** Contract 1.11: https on *.cdninstagram.com / *.fbcdn.net; in test mode also http(s) loopback. Throws INVALID_INPUT otherwise. */
export function assertCdnUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new AppError('INVALID_INPUT', 'Media URL is not a valid URL.'); }
  const host = u.hostname.toLowerCase();
  const loopback = testMode() && (host === '127.0.0.1' || host === 'localhost');
  const cdn = host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net');
  const protocolOk = loopback ? (u.protocol === 'http:' || u.protocol === 'https:') : u.protocol === 'https:';
  if (!(loopback || cdn) || !protocolOk || u.username || u.password) {
    throw new AppError('INVALID_INPUT', `Refusing to download from host "${host}": only Instagram CDN hosts (*.cdninstagram.com, *.fbcdn.net) are allowed.`, {
      details: { issues: [{ path: 'media_url', message: 'host not allowed' }] }
    });
  }
  return u;
}

const EXT_BY_TYPE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

function deriveExt(contentType: string | null, url: URL): string {
  const ct = contentType?.split(';')[0]?.trim().toLowerCase();
  if (ct && EXT_BY_TYPE[ct]) return EXT_BY_TYPE[ct]!;
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(url.pathname);
  return m ? m[1]!.toLowerCase() : 'bin';
}

/** Throws INVALID_INPUT unless `target` resolves strictly inside `root`. */
function assertInside(root: string, target: string): void {
  const r = resolve(root);
  const t = resolve(target);
  if (t === r || !t.startsWith(r + sep)) {
    throw new AppError('INVALID_INPUT', 'Download path would escape the downloads directory.');
  }
}

/** Resolve (and create) `<root>/<username>`; escapes (".." names, symlinks) are rejected. */
export function userDir(root: string, username: string): string {
  const dir = join(root, username);
  assertInside(root, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const realRoot = realpathSync(root);
  const realDir = realpathSync(dir);
  if (!realDir.startsWith(realRoot + sep)) {
    throw new AppError('INVALID_INPUT', 'Download path would escape the downloads directory.');
  }
  return dir;
}

interface MediaChild { id?: string; media_type?: string; media_url?: string | null; thumbnail_url?: string | null }
interface MediaObject extends MediaChild {
  caption?: string | null; media_product_type?: string; permalink?: string; timestamp?: string;
  like_count?: number; comments_count?: number; username?: string; children?: { data?: MediaChild[] };
}

export interface DownloadedFile { path: string; kind: 'media' | 'child' | 'thumbnail'; bytes: number; skipped: boolean }
export interface DownloadResult { media_id: string; username: string; files: DownloadedFile[]; sidecar_path: string; warnings: string[] }

const DOWNLOAD_FIELDS =
  'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,media_url,thumbnail_url,username,children{id,media_type,media_url,thumbnail_url}';

interface Planned { name: string; url: URL; kind: DownloadedFile['kind']; fixedExt?: string }

async function fetchToFile(url: URL, dir: string, base: string, fixedExt: string | undefined): Promise<{ name: string; bytes: number }> {
  let res: IncomingMessage;
  try {
    // No credentials, no cookies, redirects are never followed; DNS is resolved once, validated and pinned (SSRF guard).
    const testLoopback = process.env.INSTAGRAM_MCP_TEST_MODE === '1' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    res = await pinnedRequest(url, { method: 'GET', headers: { accept: '*/*' }, timeoutMs: 120_000, skipValidation: testLoopback });
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('UPSTREAM_TRANSIENT', `Download failed: ${redact((cause as Error).message)}`, { retryable: true, cause });
  }
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 299) {
    res.destroy();
    throw new AppError('UPSTREAM_TRANSIENT', `Download failed with HTTP ${status}.`, { retryable: true, details: { http_status: status } });
  }
  const ctype = res.headers['content-type'];
  const name = `${base}.${fixedExt ?? deriveExt(typeof ctype === 'string' ? ctype : null, url)}`;
  const target = join(dir, name);
  assertInside(dir, target);
  const tmp = `${target}.${process.pid}.part`;
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await pipeline(res, createWriteStream(tmp, { fd, autoClose: true }));
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (cause) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new AppError('UPSTREAM_TRANSIENT', `Download failed: ${redact((cause as Error).message)}`, { retryable: true, cause });
  }
  return { name, bytes: statSync(target).size };
}

function findExisting(dir: string, base: string, fixedExt: string | undefined): string | null {
  if (fixedExt) return existsSync(join(dir, `${base}.${fixedExt}`)) ? `${base}.${fixedExt}` : null;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  return entries.find((e) => e.startsWith(`${base}.`) && /^[A-Za-z0-9]{1,5}$/.test(e.slice(base.length + 1))) ?? null;
}

export async function downloadMedia(
  ctx: AppContext,
  account: ResolvedAccount,
  mediaId: string,
  opts: { include_children?: boolean; include_thumbnail?: boolean } = {}
): Promise<DownloadResult> {
  const includeChildren = opts.include_children ?? true;
  const includeThumb = opts.include_thumbnail ?? true;
  const graph = ctx.graph(account);
  const media = await graph.get<MediaObject>(`/${mediaId}`, { fields: DOWNLOAD_FIELDS });
  const id = typeof media.id === 'string' ? media.id : mediaId;
  const username = sanitizeName(media.username || account.alias);
  const ts = media.timestamp ? new Date(media.timestamp) : null;
  const date = ts && !Number.isNaN(ts.getTime()) ? ts.toISOString().slice(0, 10) : 'undated';
  const warnings: string[] = [];
  const planned: Planned[] = [];
  const stem = `${date}_${sanitizeName(id)}`;

  const plan = (item: MediaChild, base: string, kind: 'media' | 'child', label: string): void => {
    if (item.media_url) planned.push({ name: base, url: assertCdnUrl(item.media_url), kind });
    else warnings.push(`MEDIA_URL_UNAVAILABLE: ${label} has no media_url (copyright or download disabled); file omitted.`);
    if (includeThumb && item.media_type === 'VIDEO' && item.thumbnail_url) {
      planned.push({ name: `${base}_thumb`, url: assertCdnUrl(item.thumbnail_url), kind: 'thumbnail', fixedExt: 'jpg' });
    }
  };

  const children = media.children?.data ?? [];
  if (media.media_type === 'CAROUSEL_ALBUM' || children.length > 0) {
    if (media.media_url) plan(media, stem, 'media', `media ${id}`);
    if (includeChildren) children.forEach((c, i) => plan(c, `${stem}_${i + 1}`, 'child', `child ${i + 1} of ${id}`));
  } else {
    plan(media, stem, 'media', `media ${id}`);
  }

  const root = ctx.paths.downloadsDir;
  const dir = userDir(root, username);
  const files: DownloadedFile[] = [];
  for (const p of planned) {
    const existing = findExisting(dir, p.name, p.fixedExt);
    if (existing) {
      files.push({ path: join(dir, existing), kind: p.kind, bytes: statSync(join(dir, existing)).size, skipped: true });
      continue;
    }
    const got = await fetchToFile(p.url, dir, p.name, p.fixedExt);
    files.push({ path: join(dir, got.name), kind: p.kind, bytes: got.bytes, skipped: false });
  }

  const sidecarPath = join(dir, `${sanitizeName(id)}.json`);
  assertInside(root, sidecarPath);
  const sidecar = {
    id, caption: media.caption ?? null, permalink: media.permalink ?? null, timestamp: media.timestamp ?? null,
    media_type: media.media_type ?? null, media_product_type: media.media_product_type ?? null,
    like_count: media.like_count ?? null, comments_count: media.comments_count ?? null, username: media.username ?? null,
    children: children.map((c) => ({ id: c.id ?? null, media_type: c.media_type ?? null })),
    files: files.map((f) => f.path.slice(dir.length + 1))
  };
  writePrivateFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  if (files.length > 0) markDownloaded(ctx, account.alias, id, dir);
  return { media_id: id, username, files, sidecar_path: sidecarPath, warnings };
}

// ---------- backup ----------
export interface BackupResult {
  username: string; total_seen: number; downloaded: number; skipped: number; failed: number;
  insights_file: string | null;
  errors: Array<{ media_id: string | null; error: { code: string; message: string } }>;
}

export async function backupAccount(ctx: AppContext, account: ResolvedAccount, maxItems: number): Promise<BackupResult> {
  const graph = ctx.graph(account);
  const igId = await graph.igUserId();
  const me = await graph.get<{ username?: string }>(`/${igId}`, { fields: 'username' });
  const username = sanitizeName(me.username || account.alias);
  const root = ctx.paths.downloadsDir;
  const dir = userDir(root, username);

  const seen: Array<{ id: string; timestamp?: string }> = [];
  let cursor: string | undefined;
  while (seen.length < maxItems) {
    const page = await graph.list<{ id: string; timestamp?: string }>(`/${igId}/media`, { fields: 'id,timestamp' }, { limit: 100, cursor });
    for (const m of page.data) {
      if (seen.length >= maxItems) break;
      if (m && typeof m.id === 'string') seen.push(m);
    }
    if (!page.next_cursor || page.data.length === 0) break;
    cursor = page.next_cursor;
  }
  upsertMediaIndex(ctx, account.alias, seen.map((m) => ({ id: m.id, timestamp: m.timestamp })));

  const result: BackupResult = { username, total_seen: seen.length, downloaded: 0, skipped: 0, failed: 0, insights_file: null, errors: [] };
  const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
  for (const m of seen) {
    if (isDownloaded(ctx, account.alias, m.id)) { result.skipped += 1; continue; }
    try {
      if (!idPattern.test(m.id)) throw new AppError('INVALID_INPUT', 'Media id has an unexpected format.');
      await downloadMedia(ctx, account, m.id);
      result.downloaded += 1;
    } catch (error) {
      result.failed += 1;
      const e = isAppError(error) ? error : new AppError('INTERNAL', redact((error as Error).message));
      result.errors.push({ media_id: m.id, error: { code: e.code, message: e.message } });
    }
  }

  try {
    const nowSec = Math.floor(ctx.clock.nowMs() / 1000);
    const res = await graph.get<{ data?: Array<{ name?: string; total_value?: { value?: number }; values?: Array<{ value?: number }> }> }>(
      `/${igId}/insights`,
      { metric: 'reach,views,accounts_engaged,total_interactions', period: 'day', metric_type: 'total_value', since: nowSec - 86400, until: nowSec }
    );
    const metrics: Record<string, number | null> = {};
    for (const d of res.data ?? []) if (d.name) metrics[d.name] = d.total_value?.value ?? d.values?.[0]?.value ?? null;
    const file = join(dir, 'insights-latest.json');
    assertInside(root, file);
    writePrivateFile(file, `${JSON.stringify({ taken_at: ctx.clock.nowIso(), metrics }, null, 2)}\n`);
    result.insights_file = file;
  } catch (error) {
    const e = isAppError(error) ? error : new AppError('INTERNAL', redact((error as Error).message));
    result.errors.push({ media_id: null, error: { code: e.code, message: `Insights snapshot skipped: ${e.message}` } });
  }
  return result;
}
