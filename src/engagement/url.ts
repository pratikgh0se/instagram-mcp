import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '../errors.js';

function privateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  const [a, b] = [p[0]!, p[1]!];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function privateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return privateV4(mapped[1]!);
  return /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
}

export const isPrivateAddress = (ip: string): boolean => (isIP(ip) === 4 ? privateV4(ip) : privateV6(ip));

/** Remote media URL rules (contract 1.11). No request to the URL itself is made. */
export async function assertRemoteMediaUrl(raw: string, field: string, testMode: boolean): Promise<void> {
  const bad = (message: string): never => {
    throw new AppError('INVALID_INPUT', `${field}: ${message}`, { details: { issues: [{ path: field, message }] } });
  };
  let u: URL;
  try { u = new URL(raw); } catch { return bad('not a valid URL'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopbackHttp = testMode && u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost') && u.port !== '';
  if (loopbackHttp) return;
  if (u.protocol !== 'https:') return bad('must be an https:// URL');
  if (u.username || u.password) return bad('must not contain credentials');
  if (!host) return bad('missing host');
  if (isIP(host)) {
    if (isPrivateAddress(host)) bad('host is a loopback/private/link-local address');
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) bad('host is not publicly routable');
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) bad('host resolves to a loopback/private/link-local address');
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Unresolvable here: Meta fetches the URL itself; nothing to verify locally.
  }
}
