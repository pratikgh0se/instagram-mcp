import type { Config, LoginPath, ResolvedAccount, Clock } from '../config/index.js';
import { AppError, isAppError } from '../errors.js';
import { log } from '../log.js';
import { registerSecret } from '../redact.js';
import { GraphHttp, type GraphUsage } from '../graph/http.js';
import type { Storage } from '../storage/index.js';
import { envTokenName, GLOBAL_SCOPE, type TokenStore } from '../secrets/index.js';

export interface TokenMeta {
  login: LoginPath;
  obtained_at: string;
  refreshed_at: string | null;
  /** null = unknown or non-expiring (Page tokens). */
  expires_at: string | null;
  scopes: string[] | null;
  source: 'exchange' | 'as-is' | 'refresh';
}

export interface AuthStatus {
  alias: string;
  login: LoginPath;
  has_token: boolean;
  backend: string;
  expires_at: string | null;
  days_remaining: number | null;
  scopes: string[] | null;
  obtained_at: string | null;
  refreshed_at: string | null;
  expired: boolean;
}

const DAY = 86_400_000;
const REFRESH_MIN_AGE_MS = DAY;
const REFRESH_WINDOW_MS = 15 * DAY;

export interface StoreTokenOptions {
  scopes?: string[];
  /** Instagram path: try short-lived -> long-lived exchange when an app secret is available (default true). */
  exchange?: boolean;
}

export interface StoreTokenResult {
  alias: string;
  login: LoginPath;
  expires_at: string | null;
  exchanged: boolean;
  ig_user_id: string | null;
  username: string | null;
  scopes: string[] | null;
  notes: string[];
}

export class TokenManager {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      config: Config;
      store: TokenStore;
      storage: Storage;
      clock: Clock;
      fetch?: typeof globalThis.fetch;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {}

  // ---- plumbing ----
  http(login: LoginPath, account?: string): GraphHttp {
    return new GraphHttp({
      login,
      version: this.deps.config.graph_api_version,
      fetch: this.deps.fetch,
      sleep: this.deps.sleep,
      onUsage: account ? (u: GraphUsage) => this.deps.storage.rateUsage.upsert(account, u.source, u.data, this.deps.clock.nowIso()) : undefined
    });
  }

  /** Unversioned Instagram host (token exchange/refresh are documented without a version segment). Honors INSTAGRAM_MCP_GRAPH_URL_INSTAGRAM. */
  private httpUnversioned(account?: string): GraphHttp {
    return new GraphHttp({
      login: 'instagram',
      version: '',
      fetch: this.deps.fetch,
      sleep: this.deps.sleep,
      onUsage: account ? (u: GraphUsage) => this.deps.storage.rateUsage.upsert(account, u.source, u.data, this.deps.clock.nowIso()) : undefined
    });
  }

  async appSecret(): Promise<string | undefined> {
    return this.deps.store.get(GLOBAL_SCOPE, 'app_secret');
  }

  private placement(account: ResolvedAccount): 'query' | 'header' {
    return account.login === 'facebook' || account.token_in_header ? 'header' : 'query';
  }

  meta(alias: string): TokenMeta | undefined {
    return this.deps.storage.kv.get<TokenMeta>(`token_meta:${alias}`);
  }

  private saveMeta(alias: string, meta: TokenMeta): void {
    this.deps.storage.kv.set(`token_meta:${alias}`, meta, this.deps.clock.nowIso());
  }

  private noTokenError(account: ResolvedAccount): AppError {
    return new AppError('AUTH_REQUIRED', `No access token stored for account "${account.alias}".`, {
      action: `Run \`instagram-mcp auth set-token --account ${account.alias}\` (or set ${envTokenName(account.alias)} with the env backend).`
    });
  }

  // ---- read path ----
  /** Current access token for the account, lazily refreshing instagram-path tokens that are close to expiry. */
  async getAccessToken(account: ResolvedAccount): Promise<string> {
    if (account.login === 'instagram') await this.maybeRefresh(account);
    const token = await this.deps.store.get(account.alias, 'access_token');
    if (!token) throw this.noTokenError(account);
    registerSecret(token);
    return token;
  }

  async getAppSecretOrUndefined(): Promise<string | undefined> {
    return this.appSecret();
  }

  async resolveIgUserId(account: ResolvedAccount): Promise<string> {
    if (account.ig_user_id) return account.ig_user_id;
    const cached = this.deps.storage.kv.get<string>(`ig_user_id:${account.alias}`);
    if (cached) return cached;
    if (account.login === 'instagram') return 'me';
    const token = await this.getAccessToken(account);
    const found = await this.discoverFacebookIgUserId(account, token);
    if (!found) {
      throw new AppError('CONFIG_INVALID', `Page ${account.page_id} has no linked Instagram professional account.`, {
        action: 'Link the Instagram account to the Page in Meta Business settings, or set ig_user_id in the config.'
      });
    }
    return found;
  }

  private async discoverFacebookIgUserId(account: ResolvedAccount, token: string): Promise<string | null> {
    const res = await this.http('facebook', account.alias).request<{ instagram_business_account?: { id: string } }>({
      path: `/${account.page_id}`,
      query: { fields: 'instagram_business_account' },
      token,
      tokenPlacement: 'header',
      appSecret: await this.appSecret()
    });
    const id = res.data.instagram_business_account?.id ?? null;
    if (id) this.deps.storage.kv.set(`ig_user_id:${account.alias}`, id, this.deps.clock.nowIso());
    return id;
  }

  // ---- refresh (instagram path) ----
  private async maybeRefresh(account: ResolvedAccount): Promise<void> {
    try {
      await this.refreshIfDue(account);
    } catch (error) {
      if (error instanceof AppError && error.code === 'TOKEN_EXPIRED') throw error;
      log.warn(`token refresh failed for ${account.alias}: ${(error as Error).message}`);
    }
  }

  /**
   * Refresh when the token is at least 24 h old and expires within 15 days (spec 2.6). Used lazily by tools and daily by the daemon.
   * Env-provided tokens and the read-only backend are never refreshed. Errors propagate (the lazy caller swallows them).
   */
  async refreshIfDue(account: ResolvedAccount): Promise<{ refreshed: boolean; reason: string }> {
    if (this.deps.store.readOnly || process.env[envTokenName(account.alias)]) return { refreshed: false, reason: 'env or read-only token' };
    const meta = this.meta(account.alias);
    if (!meta?.expires_at) return { refreshed: false, reason: 'no known expiry' };
    const now = this.deps.clock.nowMs();
    const expires = Date.parse(meta.expires_at);
    const last = Date.parse(meta.refreshed_at ?? meta.obtained_at);
    if (Number.isNaN(expires) || Number.isNaN(last)) return { refreshed: false, reason: 'unreadable token metadata' };
    if (expires <= now) {
      throw new AppError('TOKEN_EXPIRED', `Access token for "${account.alias}" expired on ${meta.expires_at}.`, {
        action: `Generate a new token in the Meta app dashboard and run \`instagram-mcp auth set-token --account ${account.alias}\`.`
      });
    }
    if (now - last < REFRESH_MIN_AGE_MS) return { refreshed: false, reason: 'younger than 24 hours' };
    if (expires - now >= REFRESH_WINDOW_MS) return { refreshed: false, reason: 'more than 15 days left' };
    const res = await this.refresh(account);
    return { refreshed: res.refreshed, reason: res.reason ?? 'refreshed' };
  }

  /** Single-flight per account. `force` skips the age/expiry heuristics (CLI `auth refresh`). */
  async refresh(account: ResolvedAccount, opts: { force?: boolean } = {}): Promise<{ refreshed: boolean; expires_at: string | null; reason?: string }> {
    if (account.login !== 'instagram') {
      return { refreshed: false, expires_at: this.meta(account.alias)?.expires_at ?? null, reason: 'Page tokens do not need refreshing.' };
    }
    if (this.deps.store.readOnly) return { refreshed: false, expires_at: null, reason: 'Secrets backend is read-only.' };
    const existing = this.inflight.get(account.alias);
    if (existing) {
      await existing;
      return { refreshed: true, expires_at: this.meta(account.alias)?.expires_at ?? null };
    }
    const meta = this.meta(account.alias);
    if (!opts.force && meta) {
      const age = this.deps.clock.nowMs() - Date.parse(meta.refreshed_at ?? meta.obtained_at);
      if (age < REFRESH_MIN_AGE_MS) return { refreshed: false, expires_at: meta.expires_at, reason: 'Token is younger than 24 hours.' };
    }
    const work = this.doRefresh(account).finally(() => this.inflight.delete(account.alias));
    this.inflight.set(account.alias, work);
    await work;
    return { refreshed: true, expires_at: this.meta(account.alias)?.expires_at ?? null };
  }

  private async doRefresh(account: ResolvedAccount): Promise<void> {
    const token = await this.deps.store.get(account.alias, 'access_token');
    if (!token) throw this.noTokenError(account);
    registerSecret(token);
    const res = await this.httpUnversioned(account.alias).request<{ access_token: string; expires_in?: number }>({
      path: '/refresh_access_token',
      query: { grant_type: 'ig_refresh_token' },
      token,
      tokenPlacement: 'query'
    });
    const fresh = res.data.access_token;
    if (!fresh) throw new AppError('UPSTREAM_REJECTED', 'Meta refresh response had no access_token.');
    registerSecret(fresh);
    await this.deps.store.set(account.alias, 'access_token', fresh);
    const prev = this.meta(account.alias);
    const now = this.deps.clock.nowMs();
    this.saveMeta(account.alias, {
      login: 'instagram',
      obtained_at: prev?.obtained_at ?? new Date(now).toISOString(),
      refreshed_at: new Date(now).toISOString(),
      expires_at: res.data.expires_in ? new Date(now + res.data.expires_in * 1000).toISOString() : prev?.expires_at ?? null,
      scopes: prev?.scopes ?? null,
      source: 'refresh'
    });
  }

  // ---- store / exchange (CLI `auth set-token`) ----
  async storeToken(account: ResolvedAccount, rawToken: string, opts: StoreTokenOptions = {}): Promise<StoreTokenResult> {
    if (this.deps.store.readOnly) {
      throw new AppError('CONFIG_INVALID', 'The secrets backend is read-only (env).', {
        action: `Set ${envTokenName(account.alias)} in the environment instead.`
      });
    }
    let token = rawToken.trim();
    registerSecret(token);
    const notes: string[] = [];
    const now = this.deps.clock.nowMs();
    const nowIso = new Date(now).toISOString();
    const appSecret = await this.appSecret();
    registerSecret(appSecret);
    let expiresAt: string | null = null;
    let scopes: string[] | null = opts.scopes ?? null;
    let exchanged = false;
    let igUserId: string | null = account.ig_user_id;
    let username: string | null = null;

    if (account.login === 'instagram') {
      if (opts.exchange !== false && appSecret) {
        try {
          const res = await this.httpUnversioned().request<{ access_token: string; expires_in?: number }>({
            path: '/access_token',
            query: { grant_type: 'ig_exchange_token', client_secret: appSecret },
            token,
            tokenPlacement: 'query'
          });
          token = res.data.access_token;
          registerSecret(token);
          exchanged = true;
          if (res.data.expires_in) expiresAt = new Date(now + res.data.expires_in * 1000).toISOString();
        } catch (error) {
          // Dashboard-generated Instagram tokens are already long-lived, so Meta rejects the exchange. Not an error.
          void error;
          notes.push('Token stored as-is (it looks long-lived already, so no exchange was needed).');
        }
      } else if (!appSecret) {
        notes.push('No app secret available: stored the token as given (a long-lived token is needed; short-lived tokens last about 1 hour).');
      }
      const me = await this.http('instagram').request<{ user_id?: string; id?: string; username?: string }>({
        path: '/me',
        query: { fields: 'user_id,username' },
        token,
        tokenPlacement: account.token_in_header ? 'header' : 'query'
      });
      igUserId = me.data.user_id ?? igUserId ?? me.data.id ?? null;
      username = me.data.username ?? null;
    } else {
      const appId = this.deps.config.app.app_id;
      const fb = this.http('facebook');
      if (appId && appSecret && opts.exchange !== false) {
        try {
          const res = await fb.request<{ access_token: string; expires_in?: number }>({
            path: '/oauth/access_token',
            query: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token }
          });
          token = res.data.access_token;
          registerSecret(token);
          exchanged = true;
        } catch (error) {
          const code = isAppError(error) ? error.code : 'ERROR';
          notes.push(`SHORT_LIVED: the long-lived exchange failed (${code}); the stored token expires in about 1 hour. Fix the cause and run auth set-token again.`);
          notes.push(`Long-lived user-token exchange failed (${(error as Error).message}); continuing with the token as given.`);
        }
      } else {
        const why = opts.exchange === false ? 'the exchange was skipped (--no-exchange)' : [!appId ? 'app.app_id is not set' : '', !appSecret ? 'the app secret is not set' : ''].filter(Boolean).join(' and ');
        notes.push(`SHORT_LIVED: the long-lived exchange was not done (${why}); the stored token expires in about 1 hour.${opts.exchange === false ? '' : ' Run app set --app-id <APP_ID> and/or auth set-app-secret, then auth set-token again.'}`);
        notes.push('app.app_id and the app secret are needed to exchange to a long-lived token; using the token as given.');
      }
      const page = await fb.request<{ access_token?: string; instagram_business_account?: { id: string } }>({
        path: `/${account.page_id}`,
        query: { fields: 'access_token,instagram_business_account' },
        token,
        tokenPlacement: 'header',
        appSecret
      });
      if (page.data.access_token) {
        token = page.data.access_token;
        registerSecret(token);
      } else {
        notes.push('Page response had no access_token; the supplied token is assumed to already be a Page token.');
      }
      igUserId = page.data.instagram_business_account?.id ?? igUserId;
      if (!igUserId) notes.push(`Page ${account.page_id} has no linked Instagram professional account.`);
      if (igUserId) {
        try {
          const who = await fb.request<{ username?: string }>({
            path: `/${igUserId}`, query: { fields: 'username' }, token, tokenPlacement: 'header', appSecret
          });
          username = who.data.username ?? null;
        } catch {
          notes.push('Could not look up the Instagram username (GET /{ig_user_id}?fields=username failed); token stored anyway.');
        }
      }
      if (appId && appSecret) {
        try {
          const dbg = await fb.request<{ data?: { scopes?: string[]; expires_at?: number; data_access_expires_at?: number } }>({
            path: '/debug_token',
            query: { input_token: token, access_token: `${appId}|${appSecret}` }
          });
          if (dbg.data.data?.scopes) scopes = dbg.data.data.scopes;
          const exp = dbg.data.data?.expires_at;
          expiresAt = exp ? new Date(exp * 1000).toISOString() : null;
        } catch {
          notes.push('debug_token lookup failed; scopes/expiry unknown.');
        }
      }
    }

    await this.deps.store.set(account.alias, 'access_token', token);
    this.saveMeta(account.alias, { login: account.login, obtained_at: nowIso, refreshed_at: null, expires_at: expiresAt, scopes, source: exchanged ? 'exchange' : 'as-is' });
    if (igUserId) this.deps.storage.kv.set(`ig_user_id:${account.alias}`, igUserId, nowIso);
    return { alias: account.alias, login: account.login, expires_at: expiresAt, exchanged, ig_user_id: igUserId, username, scopes, notes };
  }

  async logout(account: ResolvedAccount): Promise<void> {
    await this.deps.store.delete(account.alias, 'access_token');
    this.deps.storage.kv.delete(`token_meta:${account.alias}`);
  }

  async status(account: ResolvedAccount): Promise<AuthStatus> {
    const token = await this.deps.store.get(account.alias, 'access_token');
    const meta = this.meta(account.alias);
    const now = this.deps.clock.nowMs();
    const exp = meta?.expires_at ? Date.parse(meta.expires_at) : NaN;
    return {
      alias: account.alias,
      login: account.login,
      has_token: Boolean(token),
      backend: this.deps.store.backend,
      expires_at: meta?.expires_at ?? null,
      days_remaining: Number.isNaN(exp) ? null : Math.floor((exp - now) / DAY),
      scopes: meta?.scopes ?? null,
      obtained_at: meta?.obtained_at ?? null,
      refreshed_at: meta?.refreshed_at ?? null,
      expired: !Number.isNaN(exp) && exp <= now
    };
  }
}
