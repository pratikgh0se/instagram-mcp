import { createHmac } from 'node:crypto';
import { AppError } from '../errors.js';
import { redact, registerSecret } from '../redact.js';
import type { LoginPath } from '../config/schema.js';
import { checkUrlOverride } from '../config/load.js';
import { mapMetaError, TRANSIENT_CODES, type MetaErrorBody } from './errors.js';

export type QueryValue = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>;

export interface GraphUsage {
  source: 'app' | 'business';
  data: unknown;
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  /** POST bodies are sent as application/x-www-form-urlencoded (objects/arrays are JSON-encoded). */
  body?: Record<string, QueryValue>;
  token?: string;
  tokenPlacement?: 'query' | 'header';
  appSecret?: string;
  /** Override the default (GET only) retry behaviour. Writes must never be retried automatically. */
  retry?: boolean;
  timeoutMs?: number;
}

export interface GraphResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

export interface GraphHttpOptions {
  login: LoginPath;
  version: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  onUsage?: (usage: GraphUsage) => void;
  env?: NodeJS.ProcessEnv;
}

export const RETRY_BASE_MS = 500;
export const RETRY_CAP_MS = 30_000;
export const MAX_ATTEMPTS = 4;
export const MIN_DELAY_MS = 1;
export const MAX_RETRY_AFTER_MS = 30_000;

export function graphBaseUrl(login: LoginPath, version: string, env: NodeJS.ProcessEnv = process.env): string {
  // facebook and unified share graph.facebook.com (contract 1.4).
  const name = login === 'instagram' ? 'INSTAGRAM_MCP_GRAPH_URL_INSTAGRAM' : 'INSTAGRAM_MCP_GRAPH_URL_FACEBOOK';
  const override = checkUrlOverride(name, env[name], env);
  const host = override?.replace(/\/+$/, '') || (login === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com');
  // An empty version yields the bare host: Meta documents the Instagram-Login token exchange/refresh endpoints unversioned.
  return version ? `${host}/${version}` : host;
}

export function appSecretProof(token: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}

/** Retry-After as seconds or HTTP-date, in ms; never below MIN_DELAY_MS. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
  else {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return undefined;
    ms = t - nowMs;
  }
  return Math.max(ms, MIN_DELAY_MS);
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.max(MIN_DELAY_MS, Math.floor(random() * ceiling));
}

function encode(v: QueryValue): string {
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export class GraphHttp {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: GraphHttpOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get baseUrl(): string {
    return graphBaseUrl(this.opts.login, this.opts.version, this.opts.env);
  }

  async request<T = Record<string, unknown>>(req: GraphRequest): Promise<GraphResponse<T>> {
    const method = req.method ?? 'GET';
    const isWrite = method !== 'GET';
    const canRetry = req.retry ?? !isWrite;
    const maxAttempts = canRetry ? MAX_ATTEMPTS : 1;

    let lastError: AppError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let retryAfter: number | undefined;
      try {
        return await this.once<T>(req, method, isWrite, (ms) => (retryAfter = ms));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        lastError = error;
        if (retryAfter !== undefined) {
          error.details = { ...(error.details ?? {}), retry_after_seconds: Math.ceil(retryAfter / 1000) };
        }
        if (!canRetry || attempt === maxAttempts || !this.isRetryable(error)) throw error;
        // A Retry-After beyond 30 s is not worth waiting for: fail immediately.
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) throw error;
        await this.sleep(Math.max(retryAfter ?? 0, backoffDelay(attempt)));
      }
    }
    throw lastError!;
  }

  private isRetryable(error: AppError): boolean {
    if (error.code === 'UPSTREAM_TRANSIENT') return true;
    if (error.code === 'RATE_LIMITED') return true;
    const meta = error.details?.meta as { code?: number } | undefined;
    return meta?.code !== undefined && TRANSIENT_CODES.has(meta.code);
  }

  private buildUrl(req: GraphRequest): URL {
    const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, encode(v));
    }
    if (req.token && req.tokenPlacement !== 'header') url.searchParams.set('access_token', req.token);
    if (req.token) registerSecret(req.token);
    if (req.appSecret) registerSecret(req.appSecret);
    if (req.token && req.appSecret) {
      const proof = appSecretProof(req.token, req.appSecret);
      // Meta may echo the proof or the secret in an error body: scrub both everywhere.
      registerSecret(proof);
      url.searchParams.set('appsecret_proof', proof);
    }
    return url;
  }

  private async once<T>(req: GraphRequest, method: string, isWrite: boolean, setRetryAfter: (ms: number | undefined) => void): Promise<GraphResponse<T>> {
    const url = this.buildUrl(req);
    const headers: Record<string, string> = { accept: 'application/json' };
    // Plain-http endpoints (env overrides, local fakes): a reused keep-alive socket can stall ~500 ms per request after a
    // short idle gap (observed with Node's fetch against node:http servers), which starves tight poll loops. https keeps pooling.
    if (url.protocol === 'http:') headers.connection = 'close';
    if (req.token && req.tokenPlacement === 'header') headers.authorization = `Bearer ${req.token}`;
    let body: string | undefined;
    if (req.body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(req.body)) if (v !== undefined && v !== null) form.set(k, encode(v));
      body = form.toString();
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? 30_000) });
    } catch (cause) {
      throw new AppError('UPSTREAM_TRANSIENT', redact(`Network error calling Meta (${method} ${url.pathname}): ${(cause as Error).message}`), {
        retryable: !isWrite,
        details: isWrite ? { ambiguous: true, method } : { method },
        action: isWrite ? 'The write may or may not have been applied; reconcile before retrying.' : 'Retry shortly.'
      });
    }

    this.captureUsage(res.headers);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }

    if (!res.ok || (json && typeof json === 'object' && 'error' in (json as object) && (json as { error?: MetaErrorBody }).error)) {
      setRetryAfter(parseRetryAfter(res.headers.get('retry-after')));
      const err = mapMetaError(res.status, (json as { error?: MetaErrorBody } | undefined)?.error, { write: isWrite });
      if (isWrite && res.status >= 500) err.details = { ...err.details, ambiguous: true, method };
      throw err;
    }
    if (json === undefined) {
      throw new AppError('UPSTREAM_TRANSIENT', `Meta returned a non-JSON response (HTTP ${res.status}).`, {
        retryable: !isWrite,
        details: isWrite ? { ambiguous: true, method } : { method }
      });
    }
    return { data: json as T, status: res.status, headers: res.headers };
  }

  private captureUsage(headers: Headers): void {
    if (!this.opts.onUsage) return;
    for (const [header, source] of [['x-business-use-case-usage', 'business'], ['x-app-usage', 'app']] as const) {
      const raw = headers.get(header);
      if (!raw) continue;
      try {
        this.opts.onUsage({ source, data: JSON.parse(raw) });
      } catch {
        /* ignore malformed usage headers */
      }
    }
  }
}
