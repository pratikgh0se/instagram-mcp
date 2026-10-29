// Central secret scrubbing. Every URL, error, cause and log line passes through redact().
const live = new Set<string>();

/** Register a live secret value (token, app secret, bearer) so it is scrubbed everywhere. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) {
    live.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) live.add(encoded);
  }
}

export function unregisterSecret(value: string | undefined | null): void {
  if (value) live.delete(value);
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

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  // Longest first so a secret containing another is fully removed.
  for (const secret of [...live].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** Deep-redact every string in a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
