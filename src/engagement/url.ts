import { AppError } from '../errors.js';
import { isBlockedAddress, isIpLiteral, resolvePublic } from '../net/ssrf.js';

export const isPrivateAddress = (ip: string): boolean => isBlockedAddress(ip);

/**
 * Remote media URL rules (contract 1.11). Syntax only by default: no DNS lookup and no request to the URL.
 * With `verify` (policy.verify_remote_media) the host name is also resolved and every address must be public.
 */
export async function assertRemoteMediaUrl(raw: string, field: string, testMode: boolean, verify = false): Promise<void> {
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
  if (isIpLiteral(host)) {
    if (isBlockedAddress(host)) bad('host is a loopback/private/link-local or otherwise non-public address');
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) bad('host is not publicly routable');
  if (!verify) return;
  try {
    await resolvePublic(host);
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_INPUT') bad('host resolves to a non-public address');
    // Unresolvable here: Meta fetches the URL itself; nothing to verify locally.
  }
}
