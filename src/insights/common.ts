import type { GraphClient } from '../graph/client.js';
import type { QueryValue } from '../graph/http.js';

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEK_ORDER: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const DAY_MS = 86_400_000;
export const unix = (ms: number): number => Math.floor(ms / 1000);

export const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export interface MediaItem {
  id: string;
  media_type: string | null;
  media_product_type: string | null;
  permalink: string | null;
  timestamp: string | null;
  like_count: number | null;
  comments_count: number | null;
  caption: string | null;
  ts: number; // epoch ms, NaN when unknown
}

/** Meta timestamps look like 2026-10-01T10:00:00+0000; normalise the offset so Date.parse is safe. */
export function parseMetaTime(s: string | null): number {
  if (!s) return NaN;
  return Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function toMediaItem(raw: Record<string, unknown>): MediaItem {
  const timestamp = strOrNull(raw.timestamp);
  return {
    id: String(raw.id ?? ''),
    media_type: strOrNull(raw.media_type),
    media_product_type: strOrNull(raw.media_product_type),
    permalink: strOrNull(raw.permalink),
    timestamp,
    like_count: numOrNull(raw.like_count),
    comments_count: numOrNull(raw.comments_count),
    caption: strOrNull(raw.caption),
    ts: parseMetaTime(timestamp)
  };
}

/** GET /{IG}/media following paging (max `maxPages` pages). */
export async function fetchMediaPages(
  graph: GraphClient,
  igId: string,
  query: Record<string, QueryValue>,
  maxPages = 5
): Promise<MediaItem[]> {
  const out: MediaItem[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q: Record<string, QueryValue> = { ...query };
    if (after) q.after = after;
    const res = await graph.get<{ data?: Array<Record<string, unknown>>; paging?: { cursors?: { after?: string }; next?: string } }>(`/${igId}/media`, q);
    for (const r of res.data ?? []) out.push(toMediaItem(r));
    const next = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!next || next === after) break;
    after = next;
  }
  return out;
}

export type Format = 'reel' | 'feed' | 'carousel' | 'story';

export function formatOf(m: Pick<MediaItem, 'media_product_type' | 'media_type'>): Format | null {
  switch (m.media_product_type) {
    case 'REELS': return 'reel';
    case 'STORY': return 'story';
    case 'FEED': return m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'feed';
    case null: return m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : m.media_type ? 'feed' : null;
    default: return null;
  }
}

export const engagementOf = (m: MediaItem): number => (m.like_count ?? 0) + (m.comments_count ?? 0);

export const mean = (xs: number[]): number | null => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null);

export function errInfo(e: unknown): { code: string; message: string } {
  const x = e as { code?: unknown; message?: unknown };
  return { code: typeof x.code === 'string' ? x.code : 'INTERNAL', message: typeof x.message === 'string' ? x.message : 'Unknown error' };
}
