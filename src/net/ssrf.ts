import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from '../errors.js';

/*
 * One shared SSRF classifier for every outbound non-Meta request (remote media verification, downloads) and
 * every remote-URL syntax check (publish media/cover, DM media).
 */

// ---------- IP parsing ----------

/** inet_aton-style IPv4 (1-4 parts; decimal, 0-octal, 0x-hex). Returns the 32-bit value or undefined. */
export function parseIPv4Loose(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return undefined;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = p === '0' ? 0 : parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return undefined;
    if (!Number.isFinite(n) || n < 0) return undefined;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (last >= 2 ** (8 * (4 - nums.length))) return undefined;
  if (nums.some((n) => n > 255)) return undefined;
  let value = last;
  nums.forEach((n, i) => { value += n * 2 ** (8 * (3 - i)); });
  return value >>> 0;
}

/** IPv6 text to 16 bytes (handles `::`, embedded dotted IPv4 and hex forms). Undefined when invalid; zone ids are invalid. */
export function parseIPv6(text: string): Uint8Array | undefined {
  if (text.includes('%') || isIP(text) !== 6) return undefined;
  let t = text.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (tail) {
    const v4 = parseIPv4Loose(tail[1]!);
    if (v4 === undefined) return undefined;
    t = `${t.slice(0, -tail[1]!.length)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = t.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return undefined;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i]!)) return undefined;
    const v = parseInt(groups[i]!, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

// ---------- classification ----------

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

const V4_RANGES = V4_BLOCKED.map(([base, bits]) => ({ base: parseIPv4Loose(base)!, mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }));

export function isBlockedIPv4(n: number): boolean {
  return V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.base);
}

const v4Of = (b: Uint8Array, at: number): number => (((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0);
const zero = (b: Uint8Array, from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);

export function isBlockedIPv6(b: Uint8Array): boolean {
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIPv4(v4Of(b, 12)); // ::ffff:0:0/96 mapped
  if (zero(b, 0, 12)) {
    const v = v4Of(b, 12);
    return v <= 1 || isBlockedIPv4(v); // ::/128, ::1, ::/96 compat -> embedded IPv4
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(b, 4, 12)) return isBlockedIPv4(v4Of(b, 12)); // 64:ff9b::/96 NAT64
    return true; // 64:ff9b:1::/48 local-use NAT64 (and any other 64:ff9b::/32 space)
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIPv4(v4Of(b, 2)); // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2]! <= 0x01) return true; // 2001::/23 (Teredo 2001::/32, benchmarking, ORCHID, ...)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x3f && (b[1]! & 0xf0) === 0xf0) return true; // 3fff::/20 documentation
  if (b[0] === 0x01 && zero(b, 1, 8)) return true; // 100::/64 discard-only
  // Only global unicast 2000::/3 is allowed; fc00::/7, fe80::/10, fec0::/10, ff00::/8 and the rest are reserved.
  return (b[0]! & 0xe0) !== 0x20;
}

/** True when the textual IP (any IPv4 form or IPv6 form) must not be contacted. Unparseable input is blocked. */
export function isBlockedAddress(text: string): boolean {
  const host = text.replace(/^\[|\]$/g, '');
  if (host.includes(':')) {
    const b = parseIPv6(host);
    return b ? isBlockedIPv6(b) : true;
  }
  const n = parseIPv4Loose(host);
  return n === undefined ? true : isBlockedIPv4(n);
}

/** Does this host string denote an IP literal (IPv6, or an IPv4 in any inet_aton form)? */
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h.includes(':')) return true;
  return /^[0-9a-fx.]+$/i.test(h) && /^(0x[0-9a-f]*|[0-9]+)(\.|$)/i.test(h) && parseIPv4Loose(h) !== undefined;
}

// ---------- DNS pinning ----------

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

const blockedError = (): AppError => new AppError('INVALID_INPUT', 'Media URL resolves to a loopback, private or otherwise non-public address.', { details: { reason: 'non_public_address' } });

/** Resolve once, validate every address, return the validated list (never empty). Throws INVALID_INPUT. */
export async function resolvePublic(host: string): Promise<PinnedAddress[]> {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIpLiteral(h)) {
    if (isBlockedAddress(h)) throw blockedError();
    return [{ address: h, family: h.includes(':') ? 6 : 4 }];
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dnsLookup(h, { all: true, verbatim: true });
  } catch {
    throw new AppError('UPSTREAM_TRANSIENT', 'The media host name could not be resolved.', { details: { reason: 'dns_failed' } });
  }
  if (addrs.length === 0) throw new AppError('UPSTREAM_TRANSIENT', 'The media host name could not be resolved.', { details: { reason: 'dns_failed' } });
  if (addrs.some((a) => isBlockedAddress(a.address))) throw blockedError();
  return addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

export interface PinnedRequestOptions {
  method: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Test mode only: skip validation (loopback http fakes). */
  skipValidation?: boolean;
}

/**
 * Perform one request without following redirects, connecting ONLY to an address validated just before connecting
 * (DNS is resolved once; the socket's lookup returns that validated address). The caller consumes/destroys the response.
 */
export async function pinnedRequest(url: URL, opts: PinnedRequestOptions): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const pins: PinnedAddress[] = opts.skipValidation ? [] : await resolvePublic(host);
  const pin = pins[0];
  const make = (url.protocol === 'https:' ? httpsRequest : httpRequest) as typeof httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = make(
      {
        protocol: url.protocol,
        host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: opts.headers,
        timeout: opts.timeoutMs,
        ...(url.protocol === 'https:' ? { servername: isIP(host) ? undefined : host } : {}),
        ...(pin
          ? {
              lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void): void => {
                if (o?.all) cb(null, [{ address: pin.address, family: pin.family }]);
                else cb(null, pin.address, pin.family);
              }) as never
            }
          : {})
      },
      (res) => resolve(res)
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}
