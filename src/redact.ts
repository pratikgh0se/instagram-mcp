// Central secret scrubbing. Every URL, error, cause and log line passes through redact().
const live = new Set<string>();

/** Register a live secret value (token, app secret, bearer) so it is scrubbed everywhere. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) {
    for (const v of secretVariants(value)) live.add(v);
  }
}

/** Raw, percent-encoded (upper/lower), form-encoded and JSON-escaped renderings of a secret. */
export function secretVariants(value: string): string[] {
  const out = new Set<string>([value]);
  const enc = encodeURIComponent(value);
  const lower = (x: string): string => x.replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toLowerCase());
  out.add(enc);
  out.add(lower(enc));
  const form = enc.replace(/%20/gi, '+');
  out.add(form);
  out.add(lower(form));
  const jsonEsc = JSON.stringify(value).slice(1, -1);
  out.add(jsonEsc);
  out.add(value.replace(/\//g, '\\/'));
  out.add(jsonEsc.replace(/\//g, '\\/'));
  out.add(encodeURIComponent(enc));
  return [...out].filter((v) => v.length >= 6);
}

export function unregisterSecret(value: string | undefined | null): void {
  if (value) for (const v of secretVariants(value)) live.delete(v);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/(access_token=)[^&\s"'<>]+/gi, '$1[REDACTED]'],
  [/(appsecret_proof=)[^&\s"'<>]+/gi, '$1[REDACTED]'],
  [/(client_secret=)[^&\s"'<>]+/gi, '$1[REDACTED]'],
  [/(fb_exchange_token=)[^&\s"'<>]+/gi, '$1[REDACTED]'],
  [/(input_token=)[^&\s"'<>]+/gi, '$1[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[REDACTED]'],
  [/("(?:access_token|client_secret|appsecret_proof)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"']
];

/** Replace only exact registered secret values (no generic patterns such as `Bearer xxx`). */
export function redactExact(input: string): string {
  let out = input;
  // Longest first so a secret containing another is fully removed.
  for (const secret of [...live].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return redactExact(out);
}

/** Deep exact-secret redaction (used for stored approval params so ordinary text such as "Bearer abcdefghij" survives). */
export function redactExactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactExact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactExactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redactExact(k)] = redactExactDeep(v);
    return out as T;
  }
  return value;
}

/** Deep-redact every string in a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redact(k)] = redactDeep(v);
    return out as T;
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
