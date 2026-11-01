import { AppError, invalidCursor } from '../errors.js';
import type { ResolvedAccount } from '../config/index.js';
import type { TokenManager } from '../auth/manager.js';
import type { GraphHttp, GraphResponse, QueryValue } from './http.js';

export function encodeGraphCursor(after: string): string {
  return Buffer.from(JSON.stringify({ after })).toString('base64url');
}

/** Decode an opaque cursor to Meta's `after` value; garbled cursors are INVALID_INPUT. */
export function decodeGraphCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { after?: unknown };
    if (typeof parsed.after === 'string' && parsed.after) return parsed.after;
  } catch { /* fall through */ }
  throw invalidCursor();
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * Graph API client bound to one account. Token placement (header vs query), appsecret_proof and the
 * base URL (per login path, env overrides) are handled here; callers pass version-relative paths.
 * GET requests retry on transient failures; POST/DELETE are never retried automatically.
 */
export class GraphClient {
  constructor(
    readonly account: ResolvedAccount,
    private readonly http: GraphHttp,
    private readonly auth: TokenManager
  ) {}

  /** The id to use in `/{ig_user_id}/...` paths ("me" on the instagram path when none is configured). */
  igUserId(): Promise<string> {
    return this.auth.resolveIgUserId(this.account);
  }

  private async withAuth(): Promise<{ token: string; tokenPlacement: 'query' | 'header'; appSecret?: string }> {
    const token = await this.auth.getAccessToken(this.account);
    if (this.account.login === 'facebook') {
      return { token, tokenPlacement: 'header', appSecret: await this.auth.getAppSecretOrUndefined() };
    }
    return { token, tokenPlacement: this.account.token_in_header ? 'header' : 'query' };
  }

  async get<T = Record<string, unknown>>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    return (await this.getRaw<T>(path, query)).data;
  }

  async getRaw<T = Record<string, unknown>>(path: string, query: Record<string, QueryValue> = {}): Promise<GraphResponse<T>> {
    return this.http.request<T>({ method: 'GET', path, query, ...(await this.withAuth()) });
  }

  /** POST with a form-encoded body (query carries only credentials). Never retried. Network/5xx failures are flagged `details.ambiguous`. */
  async post<T = Record<string, unknown>>(path: string, body: Record<string, QueryValue> = {}): Promise<T> {
    return (await this.http.request<T>({ method: 'POST', path, body, ...(await this.withAuth()) })).data;
  }

  /** DELETE with parameters in a form body (the query carries only credentials). Never retried. */
  async delete<T = Record<string, unknown>>(path: string, body: Record<string, QueryValue> = {}): Promise<T> {
    return (await this.http.request<T>({ method: 'DELETE', path, body, ...(await this.withAuth()) })).data;
  }

  /** One page of a Graph edge: `{ data, next_cursor }` using paging.cursors.after. */
  async list<T = Record<string, unknown>>(
    path: string,
    query: Record<string, QueryValue> = {},
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<Page<T>> {
    const q: Record<string, QueryValue> = { ...query };
    if (opts.limit) q.limit = opts.limit;
    if (opts.cursor) q.after = decodeGraphCursor(opts.cursor);
    const res = await this.get<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, q);
    return { data: res.data ?? [], next_cursor: res.paging?.next && res.paging.cursors?.after ? encodeGraphCursor(res.paging.cursors.after) : null };
  }
}
