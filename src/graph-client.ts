import { InstagramError } from './config.js';
import type { TokenProvider } from './token-provider.js';

export interface InstagramGraphClientOptions {
  apiBaseUrl: string;
  apiVersion: string;
  tokenProvider: TokenProvider;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxReadAttempts?: number;
}

type MetaError = { error?: { message?: string; code?: number; error_subcode?: number } };

export class InstagramGraphClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxReadAttempts: number;

  constructor(private readonly options: InstagramGraphClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxReadAttempts = options.maxReadAttempts ?? 3;
  }

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query?: Record<string, string>,
    body?: Record<string, unknown>
  ): Promise<T> {
    const attempts = method === 'GET' ? this.maxReadAttempts : 1;
    let lastError: InstagramError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const token = await this.options.tokenProvider.getAccessToken();
      const url = new URL(`${this.options.apiBaseUrl}/${this.options.apiVersion}${path}`);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      url.searchParams.set('access_token', token);

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        });
      } catch (cause) {
        lastError = new InstagramError('UPSTREAM_TRANSIENT', 'Instagram API network request failed.', { cause: String(cause) });
        if (method !== 'GET' || attempt === attempts) throw lastError;
        await this.sleep(this.backoff(attempt));
        continue;
      }

      const payload = (await response.json().catch(() => ({}))) as MetaError & T;
      if (response.ok) return payload as T;

      lastError = this.toError(response.status, payload);
      if (method !== 'GET' || !this.isTransient(response.status) || attempt === attempts) throw lastError;
      await this.sleep(this.retryDelay(response, attempt));
    }

    throw lastError ?? new InstagramError('UPSTREAM_TRANSIENT', 'Instagram API request failed.');
  }

  private toError(status: number, payload: MetaError): InstagramError {
    const message = payload.error?.message ?? `Instagram API returned HTTP ${status}.`;
    if (status === 401) return new InstagramError('AUTHENTICATION_FAILED', message);
    if (status === 403) return new InstagramError('MISSING_PERMISSION', message);
    if (status === 429) return new InstagramError('RATE_LIMITED', message);
    if (status >= 500) return new InstagramError('UPSTREAM_TRANSIENT', message);
    return new InstagramError('UPSTREAM_REJECTED', message, { metaCode: payload.error?.code });
  }

  private isTransient(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
    return this.backoff(attempt);
  }

  private backoff(attempt: number): number {
    return Math.min(5_000, 250 * 2 ** (attempt - 1));
  }
}
