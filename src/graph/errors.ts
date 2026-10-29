import { AppError, type ErrorCode } from '../errors.js';
import { redact } from '../redact.js';

export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_user_msg?: string;
}

/** Meta codes whose GET is retried (contract 1.8). */
export const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613, 80002]);

/**
 * Meta error body (+ HTTP status) to AppError. First matching row of contract 1.7 wins.
 * details.meta = {code, subcode, fbtrace_id, http_status}; the message is redacted.
 */
export function mapMetaError(status: number, error: MetaErrorBody | undefined, opts: { write?: boolean } = {}): AppError {
  const code = error?.code;
  const sub = error?.error_subcode;
  // Upstream bodies are hostile input: coerce to string and scrub before anything else sees them.
  const rawText = [error?.message, error?.error_user_msg].find((v) => typeof v === 'string' && v.length > 0) as string | undefined;
  const text = redact(rawText ?? `Meta API returned HTTP ${status}`);
  const details: Record<string, unknown> = { meta: { code, subcode: sub, fbtrace_id: typeof error?.fbtrace_id === 'string' ? redact(error.fbtrace_id) : undefined, http_status: status } };
  const mk = (c: ErrorCode, extra: { action?: string; retryable?: boolean } = {}): AppError => new AppError(c, text, { details, ...extra });
  const reauth = 'Re-authenticate: run `instagram-mcp auth set-token --account <alias>` with a fresh token.';

  if (error && code !== undefined) {
    if (code === 9 && sub === 2207042) return mk('PUBLISH_QUOTA_EXHAUSTED', { action: 'Wait for the 24 h publishing quota window to reset (see instagram_get_rate_limits).' });
    if (code === 10 && sub === 2534022) return mk('MESSAGING_WINDOW_CLOSED', { action: 'The user has not messaged within the allowed window.' });
    if (code === 10 && /enough viewers/i.test(text)) return mk('UPSTREAM_REJECTED');
    if (code === 9007 || String(sub ?? '').startsWith('2207')) return mk('UPSTREAM_REJECTED');
    if (code === 190 && (sub === 463 || sub === 467)) return mk('TOKEN_EXPIRED', { action: reauth });
    if (code === 190) return mk('AUTH_FAILED', { action: reauth });
    if (code === 10 || (code >= 200 && code <= 299)) {
      return mk('MISSING_PERMISSION', { action: 'The token lacks a permission/scope for this call. Re-authorise with the needed scope.' });
    }
    if ([4, 17, 32, 613, 80002].includes(code)) return mk('RATE_LIMITED', { retryable: true, action: 'Wait and retry; see instagram_get_rate_limits.' });
    if (code === 1 || code === 2) return mk('UPSTREAM_TRANSIENT', { retryable: true });
    if (code === 803 || code === 110 || code === 24 || (code === 100 && sub === 33) || status === 404) return mk('NOT_FOUND');
    if (code === 100) return mk('INVALID_INPUT');
    if (status >= 500) return mk('UPSTREAM_TRANSIENT', { retryable: true });
    return mk('UPSTREAM_REJECTED');
  }
  void opts;
  if (status === 401) return mk('AUTH_FAILED', { action: reauth });
  if (status === 429) return mk('RATE_LIMITED', { retryable: true });
  if (status === 404) return mk('NOT_FOUND');
  if (status >= 500) return mk('UPSTREAM_TRANSIENT', { retryable: true });
  return mk('UPSTREAM_REJECTED');
}

/**
 * True when the failure means the feature is unsupported for this account (capability probes, contract 1.12):
 * MISSING_PERMISSION, Meta code 3, or Meta code 100 with an "unsupported" message.
 */
export function looksUnsupported(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code === 'MISSING_PERMISSION') return true;
  const code = (error.details?.meta as { code?: number } | undefined)?.code;
  if (code === 3) return true;
  return code === 100 && /unsupported|not supported|does not support/i.test(error.message);
}
