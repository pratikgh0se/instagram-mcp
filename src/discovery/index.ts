import type { AppContext } from '../context.js';
import type { ResolvedAccount } from '../config/index.js';
import { AppError } from '../errors.js';

export const HASHTAG_LIMIT = 30;
export const HASHTAG_WINDOW_SECONDS = 604_800;

export const USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

/** Strip a leading "@" and validate; INVALID_INPUT with details.issues otherwise. */
export function normalizeUsername(raw: string, path = 'username'): string {
  const u = raw.startsWith('@') ? raw.slice(1) : raw;
  if (!USERNAME_PATTERN.test(u)) {
    throw new AppError('INVALID_INPUT', 'username must match ^[A-Za-z0-9._]{1,30}$ (a leading @ is allowed).', {
      details: { issues: [{ path, message: 'invalid username' }] }
    });
  }
  return u;
}

// ---------- business discovery ----------
const MEDIA_SUBFIELDS = 'id,media_type,media_product_type,permalink,timestamp,like_count,comments_count,view_count';
const FULL_PROFILE = 'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count';
const MINIMAL_MEDIA = 'id,comments_count,like_count,view_count';

export interface DiscoveredMedia {
  id: string | null; media_type: string | null; media_product_type: string | null; permalink: string | null; timestamp: string | null;
  like_count: number | null; comments_count: number | null; view_count: number | null;
}

export interface DiscoveredAccount {
  username: string; name: string | null; biography: string | null; website: string | null; profile_picture_url: string | null;
  followers_count: number | null; follows_count: number | null; media_count: number | null;
  recent_media: DiscoveredMedia[]; fallback_fields: boolean;
}

const FALLBACK_MESSAGE = /nonexisting field|does not exist|unsupported/i;

function isFieldError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const code = (error.details?.meta as { code?: number } | undefined)?.code;
  return code === 100 && FALLBACK_MESSAGE.test(error.message);
}

function shape(username: string, bd: Record<string, unknown>, fallback: boolean): DiscoveredAccount {
  const g = (k: string): unknown => bd[k] ?? null;
  const media = (bd.media as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
  return {
    username: typeof bd.username === 'string' ? bd.username : username,
    name: g('name') as string | null, biography: g('biography') as string | null, website: g('website') as string | null,
    profile_picture_url: g('profile_picture_url') as string | null,
    followers_count: g('followers_count') as number | null, follows_count: g('follows_count') as number | null,
    media_count: g('media_count') as number | null,
    recent_media: media.map((m) => ({
      id: (m.id ?? null) as string | null, media_type: (m.media_type ?? null) as string | null,
      media_product_type: (m.media_product_type ?? null) as string | null, permalink: (m.permalink ?? null) as string | null,
      timestamp: (m.timestamp ?? null) as string | null, like_count: (m.like_count ?? null) as number | null,
      comments_count: (m.comments_count ?? null) as number | null, view_count: (m.view_count ?? null) as number | null
    })),
    fallback_fields: fallback
  };
}

/** One business_discovery lookup with the one-time minimal-field fallback (contract U11). */
export async function businessDiscovery(ctx: AppContext, account: ResolvedAccount, username: string, mediaLimit: number): Promise<DiscoveredAccount> {
  const graph = ctx.graph(account);
  const igId = await graph.igUserId();
  const full = `business_discovery.username(${username}){${FULL_PROFILE},media.limit(${mediaLimit}){${MEDIA_SUBFIELDS}}}`;
  const minimal = `business_discovery.username(${username}){followers_count,media_count,media.limit(${mediaLimit}){${MINIMAL_MEDIA}}}`;
  let fallback = false;
  let res: { business_discovery?: Record<string, unknown> };
  try {
    res = await graph.get(`/${igId}`, { fields: full });
  } catch (error) {
    if (!isFieldError(error)) throw error;
    fallback = true;
    res = await graph.get(`/${igId}`, { fields: minimal });
  }
  if (!res.business_discovery || typeof res.business_discovery !== 'object') {
    throw new AppError('NOT_FOUND', `No business or creator account found for "${username}".`, {
      action: 'Business discovery only works for public Instagram professional accounts; check the username.'
    });
  }
  return shape(username, res.business_discovery, fallback);
}

// ---------- compare metrics ----------
export interface AccountMetrics {
  username: string; followers_count: number | null; media_count: number | null; posts_sampled: number;
  posts_per_week: number | null; avg_likes: number | null; avg_comments: number | null;
  format_mix: { IMAGE: number; VIDEO: number; CAROUSEL_ALBUM: number };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function avg(values: unknown[]): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? round2(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
}

export function computeMetrics(
  username: string, followers: number | null, mediaCount: number | null,
  posts: Array<{ media_type?: unknown; timestamp?: unknown; like_count?: unknown; comments_count?: unknown }>
): AccountMetrics {
  const mix = { IMAGE: 0, VIDEO: 0, CAROUSEL_ALBUM: 0 };
  for (const p of posts) if (p.media_type === 'IMAGE' || p.media_type === 'VIDEO' || p.media_type === 'CAROUSEL_ALBUM') mix[p.media_type] += 1;
  const times = posts.map((p) => (typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN)).filter((t) => !Number.isNaN(t));
  let perWeek: number | null = null;
  if (posts.length >= 2 && times.length >= 2) {
    const weeks = (Math.max(...times) - Math.min(...times)) / (7 * 86_400_000);
    if (weeks > 0) perWeek = round2((posts.length - 1) / weeks);
  }
  return {
    username, followers_count: followers, media_count: mediaCount, posts_sampled: posts.length, posts_per_week: perWeek,
    avg_likes: avg(posts.map((p) => p.like_count)), avg_comments: avg(posts.map((p) => p.comments_count)), format_mix: mix
  };
}

// ---------- hashtag budget ----------
export interface BudgetState { used: string[]; alreadyRecorded: boolean }

export function hashtagBudget(ctx: AppContext, account: ResolvedAccount, hashtag: string): BudgetState {
  const since = new Date(ctx.clock.nowMs() - HASHTAG_WINDOW_SECONDS * 1000).toISOString();
  const used = ctx.storage.hashtagBudget.usedSince(account.alias, since).map((h) => h.toLowerCase());
  return { used, alreadyRecorded: used.includes(hashtag.toLowerCase()) };
}
