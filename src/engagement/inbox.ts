import type { AppContext } from '../context.js';
import type { ResolvedAccount } from '../config/index.js';
import { AppError } from '../errors.js';
import { decodeCursor, encodeCursor } from '../tools/shared.js';
import { isRecord, num, str, tsMs } from './common.js';

export interface InboxItem {
  item_id: string;
  type: 'comment' | 'mention' | 'tag' | 'message' | 'reaction' | 'postback' | 'other';
  source: 'api' | 'webhook';
  via_webhook: boolean;
  media_id: string | null;
  comment_id: string | null;
  username: string | null;
  text: string | null;
  timestamp: string | null;
  permalink: string | null;
  unanswered: boolean | null;
  handled: boolean;
}

export interface InboxParams {
  days: number;
  since?: Date;
  include_handled: boolean;
  unanswered_only: boolean;
  limit: number;
  cursor?: string;
}

const TYPE_BY_FIELD: Record<string, InboxItem['type']> = {
  comments: 'comment', mentions: 'mention', messages: 'message', message_reactions: 'reaction', messaging_postbacks: 'postback'
};

interface WebhookRow { event_key: string; received_at: string; field: string | null; payload_json: string }

export function handledSet(ctx: AppContext, alias: string): Set<string> {
  const rows = ctx.storage.db.prepare("SELECT key FROM inbox_state WHERE account = ? AND kind = 'handled'").all(alias) as Array<{ key: string }>;
  return new Set(rows.map((r) => r.key));
}

export function setHandled(ctx: AppContext, alias: string, ids: string[], handled: boolean): void {
  const now = ctx.clock.nowIso();
  ctx.storage.tx(() => {
    for (const id of ids) {
      if (handled) {
        ctx.storage.db.prepare(
          "INSERT INTO inbox_state (account, kind, key, value, updated_at) VALUES (?, 'handled', ?, '1', ?) ON CONFLICT(account, kind, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run(alias, id, now);
      } else {
        ctx.storage.db.prepare("DELETE FROM inbox_state WHERE account = ? AND kind = 'handled' AND key = ?").run(alias, id);
      }
    }
  });
}

function webhookEvents(ctx: AppContext, alias: string, windowStartMs: number): WebhookRow[] {
  const rows = ctx.storage.db
    .prepare('SELECT event_key, received_at, field, payload_json FROM webhook_events WHERE account = ? ORDER BY received_at DESC, id DESC')
    .all(alias) as unknown as WebhookRow[];
  return rows.filter((r) => {
    const t = tsMs(r.received_at);
    return !Number.isNaN(t) && t >= windowStartMs;
  });
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

function fromWebhook(row: WebhookRow): InboxItem {
  const p = parsePayload(row.payload_json);
  const type = TYPE_BY_FIELD[row.field ?? ''] ?? 'other';
  const item: InboxItem = {
    item_id: `webhook:${row.event_key}`, type, source: 'webhook', via_webhook: true, media_id: null, comment_id: null,
    username: null, text: null, timestamp: row.received_at, permalink: null, unanswered: null, handled: false
  };
  if (row.field === 'comments') {
    item.comment_id = str(p.id);
    item.text = str(p.text);
    item.username = isRecord(p.from) ? str(p.from.username) : null;
    item.media_id = isRecord(p.media) ? str(p.media.id) : null;
  } else if (row.field === 'mentions') {
    item.comment_id = str(p.comment_id);
    item.media_id = str(p.media_id);
  } else if (row.field === 'messages') {
    item.text = isRecord(p.message) ? str(p.message.text) : null;
  }
  return item;
}

function compare(a: InboxItem, b: InboxItem): number {
  const ta = tsMs(a.timestamp);
  const tb = tsMs(b.timestamp);
  const na = Number.isNaN(ta);
  const nb = Number.isNaN(tb);
  if (na !== nb) return na ? 1 : -1;
  if (!na && ta !== tb) return tb - ta;
  return a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0;
}

/** instagram_get_inbox (contract 2.4, decision D19). */
export async function buildInbox(ctx: AppContext, account: ResolvedAccount, p: InboxParams): Promise<Record<string, unknown>> {
  const graph = ctx.graph(account);
  const igId = await graph.igUserId();
  const windowStart = p.since ?? new Date(ctx.clock.nowMs() - p.days * 86_400_000);
  const windowMs = windowStart.getTime();
  const warnings: string[] = [];

  const me = await graph.get<Record<string, unknown>>(`/${igId}`, { fields: 'username' });
  const ownUsername = str(me.username);

  const mediaRes = await graph.get<{ data?: Array<Record<string, unknown>> }>(`/${igId}/media`, {
    fields: 'id,permalink,timestamp,comments_count,caption', since: Math.floor(windowMs / 1000), limit: 25
  });
  const media = mediaRes.data ?? [];

  const items: InboxItem[] = [];
  for (const m of media) {
    const mediaId = str(m.id);
    if (!mediaId || (num(m.comments_count) ?? 0) <= 0) continue;
    const res = await graph.get<{ data?: Array<Record<string, unknown>> }>(`/${mediaId}/comments`, {
      fields: 'id,text,username,timestamp,hidden,replies{id,text,username,timestamp}', limit: 50
    });
    for (const c of res.data ?? []) {
      const t = tsMs(c.timestamp);
      if (Number.isNaN(t) || t < windowMs) continue;
      const replies = isRecord(c.replies) && Array.isArray(c.replies.data) ? (c.replies.data as Array<Record<string, unknown>>) : [];
      const answered = ownUsername !== null && replies.some((r) => str(r.username) === ownUsername);
      items.push({
        item_id: `comment:${str(c.id)}`, type: 'comment', source: 'api', via_webhook: false, media_id: mediaId, comment_id: str(c.id),
        username: str(c.username), text: str(c.text), timestamp: str(c.timestamp), permalink: str(m.permalink), unanswered: !answered, handled: false
      });
    }
  }

  const tagsState: { ok: boolean; error?: { code: string; message: string } } = { ok: true };
  try {
    const tags = await graph.get<{ data?: Array<Record<string, unknown>> }>(`/${igId}/tags`, {
      fields: 'id,caption,media_type,permalink,timestamp,username', limit: 25
    });
    for (const t of tags.data ?? []) {
      const ms = tsMs(t.timestamp);
      if (!Number.isNaN(ms) && ms < windowMs) continue;
      items.push({
        item_id: `tag:${str(t.id)}`, type: 'tag', source: 'api', via_webhook: false, media_id: str(t.id), comment_id: null,
        username: str(t.username), text: str(t.caption), timestamp: str(t.timestamp), permalink: str(t.permalink), unanswered: null, handled: false
      });
    }
  } catch (error) {
    if (error instanceof AppError && ['MISSING_PERMISSION', 'NOT_FOUND', 'INVALID_INPUT'].includes(error.code)) {
      tagsState.ok = false;
      tagsState.error = { code: error.code, message: error.message };
      warnings.push(`TAGS_UNAVAILABLE: ${error.code}: ${error.message}`);
    } else throw error;
  }

  // Merge webhook events (by comment id when it matches an API item).
  const events = webhookEvents(ctx, account.alias, windowMs);
  const byCommentId = new Map(items.filter((i) => i.comment_id).map((i) => [i.comment_id!, i]));
  for (const row of events) {
    const w = fromWebhook(row);
    const existing = (w.type === 'comment' || w.type === 'mention') && w.comment_id ? byCommentId.get(w.comment_id) : undefined;
    if (existing) existing.via_webhook = true;
    else items.push(w);
  }

  const handled = handledSet(ctx, account.alias);
  let out = items.map((i) => ({ ...i, handled: handled.has(i.item_id) }));
  if (!p.include_handled) out = out.filter((i) => !i.handled);
  if (p.unanswered_only) out = out.filter((i) => i.unanswered === true);
  out.sort(compare);

  const offset = decodeCursor<{ offset?: number }>(p.cursor)?.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new AppError('INVALID_INPUT', 'Invalid cursor.');
  const page = out.slice(offset, offset + p.limit);
  const next = offset + p.limit < out.length ? encodeCursor({ offset: offset + p.limit }) : null;

  return {
    items: page,
    next_cursor: next,
    window: { since: windowStart.toISOString() },
    sources: { comments: { ok: true, media_scanned: media.length }, tags: tagsState, webhooks: { count: events.length } },
    warnings
  };
}
