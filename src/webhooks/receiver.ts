import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../context.js';
import { listAccounts } from '../config/index.js';
import { errorMessage, registerSecret } from '../redact.js';
import { GLOBAL_SCOPE } from '../secrets/index.js';

import { BodyTooLarge, MAX_BODY_BYTES, readBodyLimited, respondTooLarge } from '../transports/limits.js';

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const digest = (v: string): Buffer => createHash('sha256').update(v).digest();

/** Constant-time string comparison (hash both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Verify `X-Hub-Signature-256: sha256=<hex>` over the raw body bytes. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header ?? '');
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(m[1]!, 'hex'));
}

/** Canonical JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function messagingField(item: Record<string, unknown>): string {
  if (item.message !== undefined) return 'messages';
  if (item.reaction !== undefined) return 'message_reactions';
  if (item.postback !== undefined) return 'messaging_postbacks';
  if (item.read !== undefined) return 'messaging_seen';
  return 'unknown';
}

export interface StoredEvent {
  event_key: string;
  field: string;
  ig_id: string | null;
  account: string | null;
  received_at: string;
  payload: unknown;
}

/** Entry time to ISO (contract section 5, U34): >= 1e12 is milliseconds (messaging entries), smaller is seconds (changes entries). Null when unusable. */
function entryTimeIso(time: unknown): string | null {
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return null;
  const date = new Date(time >= 1e12 ? time : time * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Extract the events of a Meta webhook body (contract section 5). Pure apart from account lookup. */
export function extractEvents(body: unknown, accountFor: (igId: string) => string | null, nowIso: string): { object: string | null; events: StoredEvent[] } {
  const events: StoredEvent[] = [];
  const root = (body && typeof body === 'object' ? body : {}) as { object?: unknown; entry?: unknown };
  const object = typeof root.object === 'string' ? root.object : null;
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { id?: unknown; time?: unknown; changes?: unknown; messaging?: unknown };
    const igId = entry.id !== undefined && entry.id !== null ? String(entry.id) : null;
    const account = igId ? accountFor(igId) : null;
    const receivedAt = entryTimeIso(entry.time) ?? nowIso;
    const push = (item: unknown, field: string, payload: unknown): void => {
      events.push({ event_key: createHash('sha256').update(canonicalJson(item)).digest('hex'), field, ig_id: igId, account, received_at: receivedAt, payload });
    };
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!change || typeof change !== 'object') continue;
      const c = change as { field?: unknown; value?: unknown };
      push(change, typeof c.field === 'string' ? c.field : 'unknown', c.value ?? null);
    }
    for (const item of Array.isArray(entry.messaging) ? entry.messaging : []) {
      if (!item || typeof item !== 'object') continue;
      push(item, messagingField(item as Record<string, unknown>), item);
    }
  }
  return { object, events };
}

/** Persist events; identical events are stored once. Returns the number newly stored. */
export function storeEvents(ctx: AppContext, object: string | null, events: StoredEvent[]): number {
  const stmt = ctx.storage.db.prepare(
    'INSERT OR IGNORE INTO webhook_events (event_key, received_at, object, field, ig_id, account, payload_json) VALUES (?,?,?,?,?,?,?)'
  );
  let added = 0;
  ctx.storage.tx(() => {
    for (const e of events) {
      const r = stmt.run(e.event_key, e.received_at, object, e.field, e.ig_id, e.account, JSON.stringify(e.payload));
      added += Number(r.changes);
    }
  });
  return added;
}

/** Account of an Instagram id: when several configured accounts hold it, the first (config order) whose app secret signed the request, else the first. */
function accountResolver(ctx: AppContext, signers: ReadonlySet<string>): (igId: string) => string | null {
  return (igId) => {
    const holders = listAccounts(ctx.config)
      .filter((a) => (a.ig_user_id ?? ctx.storage.kv.get<string>(`ig_user_id:${a.alias}`) ?? null) === igId)
      .map((a) => a.alias);
    return holders.find((alias) => signers.has(alias)) ?? holders[0] ?? null;
  };
}
/** Handler for the configured webhook path. Bearer and Host/Origin checks do not apply (verify token / HMAC instead). */
export function createWebhookHandler(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET') {
      // Cheap checks first: nothing below touches the secret store unless the handshake is well formed.
      const mode = url.searchParams.get('hub.mode');
      const given = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode !== 'subscribe' || given === null) return text(res, 403, 'Forbidden');
      const verifyToken = await ctx.secrets.get(GLOBAL_SCOPE, 'webhook_verify_token');
      registerSecret(verifyToken);
      if (!verifyToken || !safeEqual(given, verifyToken)) return text(res, 403, 'Forbidden');
      if (challenge === null) return text(res, 400, 'Missing hub.challenge');
      return text(res, 200, challenge);
    }
    if (req.method === 'POST') {
      // Cheap checks first (size, signature header shape); secrets come from the in-memory cache afterwards.
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return respondTooLarge(req, res, 'Payload too large', 'text/plain');
      const sigHeader = req.headers['x-hub-signature-256'];
      const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      if (!/^sha256=[0-9a-fA-F]{64}$/.test(sig ?? '')) {
        req.resume();
        return text(res, 401, 'Invalid signature');
      }
      // Contract section 5: the signature may be valid under the global or any account's own app secret.
      const appSecrets: string[] = [];
      const globalSecret = await ctx.secrets.get(GLOBAL_SCOPE, 'app_secret').catch(() => undefined);
      if (globalSecret) appSecrets.push(globalSecret);
      const effective = new Map<string, string>(); // alias -> own app secret, else the global one (1.16.6)
      for (const a of listAccounts(ctx.config)) {
        const own = await ctx.secrets.get(a.alias, 'app_secret').catch(() => undefined);
        const v = own || globalSecret;
        if (v) effective.set(a.alias, v);
        if (own && !appSecrets.includes(own)) appSecrets.push(own);
      }
      if (appSecrets.length === 0) {
        req.resume();
        return text(res, 503, 'Webhook receiver is not configured (no app secret)');
      }
      appSecrets.forEach((s) => registerSecret(s));
      let raw: Buffer;
      try {
        raw = await readBodyLimited(req);
      } catch (error) {
        if (error instanceof BodyTooLarge) return respondTooLarge(req, res, 'Payload too large', 'text/plain');
        throw error;
      }
      if (!appSecrets.some((s) => verifySignature(raw, sig, s))) {
        // A steady stream of these usually means a wrong app secret for the app that sends them.
        ctx.log.warn('webhook rejected: signature does not match any configured app secret');
        return text(res, 401, 'Invalid signature');
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return text(res, 400, 'Body is not JSON');
      }
      try {
        const signers = new Set([...effective].filter(([, secret]) => verifySignature(raw, sig, secret)).map(([alias]) => alias));
        const { object, events } = extractEvents(body, accountResolver(ctx, signers), ctx.clock.nowIso());
        const added = storeEvents(ctx, object, events);
        ctx.log.debug(`webhook accepted: signed for ${[...signers].join(',') || 'none'}, ${events.length} event(s), ${added} new`);
      } catch (error) {
        ctx.log.error(`webhook store failed: ${errorMessage(error)}`);
        return text(res, 500, 'Storage error');
      }
      return text(res, 200, 'EVENT_RECEIVED');
    }
    res.setHeader('allow', 'GET, POST');
    return text(res, 405, 'Method not allowed');
  };
}
