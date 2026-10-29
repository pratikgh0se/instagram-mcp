import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { extname } from 'node:path';
import { AppError } from '../errors.js';
import { isBlockedAddress, isIpLiteral, pinnedRequest } from '../net/ssrf.js';
import type { Kind, MediaType } from './types.js';

const MB = 1024 * 1024;

/** Size limit (bytes) per contract 2.3. `cover` is a reel cover image. */
export function maxBytes(kind: Kind | 'cover', type: MediaType): number {
  if (kind === 'cover' || type === 'image') return 8 * MB;
  return kind === 'story' ? 100 * MB : 300 * MB;
}

const invalid = (message: string, details?: Record<string, unknown>): AppError => new AppError('INVALID_INPUT', message, { details });

// ---------- type inference ----------

export function typeFromExtension(pathOrUrlPath: string): MediaType | undefined {
  const ext = extname(pathOrUrlPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image';
  if (ext === '.mp4' || ext === '.mov') return 'video';
  return undefined;
}

export function typeFromContentType(contentType: string | null | undefined): MediaType | undefined {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct === 'image/jpeg') return 'image';
  if (ct.startsWith('video/')) return 'video';
  return undefined;
}

// ---------- local files ----------

export interface LocalInfo {
  size: number;
  sha256: string;
  content_type: string;
  duration_seconds: number | null;
  warnings: string[];
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Image width/height from the first SOF marker; undefined when the header cannot be parsed. */
export function jpegDimensions(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined;
    let marker = buf[i + 1]!;
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1;
      marker = buf[i + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return undefined;
}

/** Duration in seconds from moov/mvhd, or null when not readable. */
export async function mp4Duration(path: string, fileSize: number): Promise<number | null> {
  const fh = await fsp.open(path, 'r');
  try {
    let pos = 0;
    const head = Buffer.alloc(16);
    while (pos + 8 <= fileSize) {
      await fh.read(head, 0, 16, pos);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (size === 1) {
        size = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (size === 0) size = fileSize - pos;
      if (size < header) return null;
      if (type === 'moov') {
        const payloadLen = size - header;
        if (payloadLen > 64 * MB) return null;
        const moov = Buffer.alloc(payloadLen);
        await fh.read(moov, 0, payloadLen, pos + header);
        return mvhdDuration(moov);
      }
      pos += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

function mvhdDuration(moov: Buffer): number | null {
  let p = 0;
  while (p + 8 <= moov.length) {
    const size = moov.readUInt32BE(p);
    const type = moov.toString('latin1', p + 4, p + 8);
    if (size < 8) return null;
    if (type === 'mvhd') {
      const version = moov[p + 8];
      if (version === 1) {
        const timescale = moov.readUInt32BE(p + 28);
        const duration = Number(moov.readBigUInt64BE(p + 32));
        return timescale ? duration / timescale : null;
      }
      const timescale = moov.readUInt32BE(p + 20);
      const duration = moov.readUInt32BE(p + 24);
      return timescale ? duration / timescale : null;
    }
    p += size;
  }
  return null;
}

export interface LocalCheck {
  kind: Kind | 'cover';
  type: MediaType;
}

/** Validate a local file per D15 and return size/hash/content-type. Throws INVALID_INPUT. */
export async function inspectLocalFile(path: string, check: LocalCheck): Promise<LocalInfo> {
  let st;
  try {
    st = await fsp.stat(path);
    if (!st.isFile()) throw new Error('not a regular file');
    await fsp.access(path, 0o4);
  } catch (error) {
    void error;
    throw invalid('The local media file does not exist, is not a regular file, or is not readable.', { reason: 'file_not_found' });
  }
  const limit = maxBytes(check.kind, check.type);
  if (st.size > limit) {
    throw invalid(`Local media file "${path}" is ${st.size} bytes; the limit for this media is ${limit} bytes.`, { path, bytes: st.size, limit });
  }
  const warnings: string[] = [];
  let contentType: string;
  let duration: number | null = null;
  if (check.type === 'image') {
    const buf = await fsp.readFile(path);
    if (!(buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
      throw invalid(`Local image "${path}" is not a JPEG (JPEG only; convert PNG and other formats first).`, { path });
    }
    contentType = 'image/jpeg';
    if (check.kind === 'image') {
      const dims = jpegDimensions(buf);
      if (dims && dims.width > 0 && dims.height > 0) {
        const ratio = dims.width / dims.height;
        if (ratio < 0.8 - 1e-3 || ratio > 1.91 + 1e-3) {
          throw invalid(`Image aspect ratio ${dims.width}x${dims.height} is outside 4:5 to 1.91:1 for a feed image.`, { path, width: dims.width, height: dims.height });
        }
      }
    }
  } else {
    const fh = await fsp.open(path, 'r');
    const head = Buffer.alloc(8);
    try {
      await fh.read(head, 0, 8, 0);
    } finally {
      await fh.close();
    }
    if (head.toString('latin1', 4, 8) !== 'ftyp') {
      throw invalid(`Local video "${path}" is not an MP4/MOV file (no ftyp box).`, { path });
    }
    contentType = extname(path).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4';
    duration = await mp4Duration(path, st.size);
    const range = check.kind === 'reel' ? [3, 900] : check.kind === 'story' ? [3, 60] : undefined;
    if (duration === null) {
      if (range) warnings.push('DURATION_UNKNOWN: could not read the video duration; Instagram will validate it.');
    } else if (range && (duration < range[0]! || duration > range[1]!)) {
      throw invalid(`Video duration ${duration.toFixed(1)} s is outside ${range[0]}-${range[1]} s for a ${check.kind}.`, { path, duration_seconds: duration });
    }
  }
  return { size: st.size, sha256: await hashFile(path), content_type: contentType, duration_seconds: duration, warnings };
}

// ---------- remote URLs ----------

function testMode(env: NodeJS.ProcessEnv): boolean {
  return env.INSTAGRAM_MCP_TEST_MODE === '1';
}

const isTestLoopback = (url: URL, env: NodeJS.ProcessEnv): boolean => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return testMode(env) && url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost') && Boolean(url.port);
};

/**
 * Contract 1.11 remote URL SYNTAX rules (https only; no credentials; IP literals in any form checked directly; no localhost-style
 * names; test mode allows loopback http). No DNS lookup and no request is made here. Throws INVALID_INPUT.
 */
export async function assertPublicUrl(raw: string, env: NodeJS.ProcessEnv = process.env): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`"${raw}" is not a valid URL.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isTestLoopback(url, env)) return url;
  if (url.protocol !== 'https:') throw invalid('Media URLs must use https://.');
  if (url.username || url.password) throw invalid('Media URLs must not contain credentials.');
  if (!host) throw invalid('Media URL has no host.');
  if (isIpLiteral(host)) {
    if (isBlockedAddress(host)) throw invalid('Media URL points at a loopback, private, link-local or otherwise non-public address.');
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw invalid('Media URL points at a loopback or non-public host name.');
  }
  return url;
}

/** `policy.verify_remote_media` (default false): when false, preflights make no outbound non-Meta request. */
export function verifyRemoteMedia(ctx: { config: unknown }): boolean {
  return (ctx.config as { policy?: { verify_remote_media?: boolean } }).policy?.verify_remote_media ?? false;
}

export interface HeadResult {
  verified: boolean;
  content_type: string | null;
  content_length: number | null;
}

/**
 * `HEAD <url>` without following redirects, connecting only to a freshly validated DNS answer (pinned). Used only when
 * policy.verify_remote_media is true. Unreachable/non-2xx -> `verified:false` (caller warns MEDIA_UNVERIFIED). A non-public
 * address is INVALID_INPUT. A 2xx with a wrong Content-Type or an oversize Content-Length is INVALID_INPUT with a generic
 * message (the upstream values are never echoed).
 */
export async function headRemote(url: string, expect: { type: MediaType | undefined; limit: number; label: string }, env: NodeJS.ProcessEnv = process.env): Promise<HeadResult> {
  const target = new URL(url);
  let res;
  try {
    res = await pinnedRequest(target, { method: 'HEAD', timeoutMs: 10_000, skipValidation: isTestLoopback(target, env) });
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_INPUT') throw error;
    return { verified: false, content_type: null, content_length: null };
  }
  res.destroy();
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 299) return { verified: false, content_type: null, content_length: null };
  const ct = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null;
  const lenRaw = typeof res.headers['content-length'] === 'string' ? res.headers['content-length'] : null;
  const length = lenRaw && /^\d+$/.test(lenRaw) ? Number(lenRaw) : null;
  if (ct) {
    const actual = typeFromContentType(ct);
    if (expect.type === 'image' && actual !== 'image') throw invalid(`${expect.label} does not have the expected media type (image/jpeg).`);
    if (expect.type === 'video' && actual !== 'video') throw invalid(`${expect.label} does not have the expected media type (video/*).`);
  }
  if (length !== null && length > expect.limit) throw invalid(`${expect.label} exceeds the size limit of ${expect.limit} bytes.`);
  return { verified: ct !== null || length !== null, content_type: ct, content_length: length };
}
