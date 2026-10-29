import { AppError } from '../errors.js';

/** Deprecated metric -> replacement (contract 2.6). */
export const DEPRECATED_METRICS: Record<string, string> = {
  impressions: 'views',
  video_views: 'views',
  plays: 'views',
  clips_replays_count: 'views',
  ig_reels_aggregated_all_plays_count: 'views',
  profile_views: 'views',
  website_clicks: 'profile_links_taps',
  phone_call_clicks: 'profile_links_taps',
  reached_audience_demographics: 'engaged_audience_demographics'
};

export function rejectDeprecated(metric: string): void {
  const replacement = DEPRECATED_METRICS[metric];
  if (replacement) {
    throw new AppError('INVALID_INPUT', `Metric "${metric}" is deprecated; use "${replacement}" instead.`, {
      action: `Request "${replacement}".`,
      details: { metric, replacement }
    });
  }
}

export interface AccountMetricSpec {
  period: 'day' | 'lifetime';
  types: Array<'total_value' | 'time_series'>;
  breakdowns: string[];
  /** Metric needs a breakdown (demographics). */
  demographic?: boolean;
}

const DEMO = ['age', 'city', 'country', 'gender'];
const MPT = ['media_product_type'];

export const ACCOUNT_METRICS: Record<string, AccountMetricSpec> = {
  accounts_engaged: { period: 'day', types: ['total_value'], breakdowns: [] },
  comments: { period: 'day', types: ['total_value'], breakdowns: MPT },
  engaged_audience_demographics: { period: 'lifetime', types: ['total_value'], breakdowns: DEMO, demographic: true },
  follower_demographics: { period: 'lifetime', types: ['total_value'], breakdowns: DEMO, demographic: true },
  follows_and_unfollows: { period: 'day', types: ['total_value'], breakdowns: ['follow_type'] },
  likes: { period: 'day', types: ['total_value'], breakdowns: MPT },
  profile_links_taps: { period: 'day', types: ['total_value'], breakdowns: ['contact_button_type'] },
  reach: { period: 'day', types: ['total_value', 'time_series'], breakdowns: ['media_product_type', 'follow_type'] },
  replies: { period: 'day', types: ['total_value'], breakdowns: [] },
  reposts: { period: 'day', types: ['total_value'], breakdowns: [] },
  saves: { period: 'day', types: ['total_value'], breakdowns: MPT },
  shares: { period: 'day', types: ['total_value'], breakdowns: MPT },
  total_interactions: { period: 'day', types: ['total_value'], breakdowns: MPT },
  views: { period: 'day', types: ['total_value'], breakdowns: ['follow_type', 'media_product_type'] },
  follower_count: { period: 'day', types: ['time_series'], breakdowns: [] },
  online_followers: { period: 'lifetime', types: [], breakdowns: [] }
};

export const TIMEFRAMES = ['last_14_days', 'last_30_days', 'last_90_days', 'prev_month', 'this_month', 'this_week'] as const;

const FB_EXTRA = ['total_comments', 'total_likes', 'total_views', 'facebook_views'];
const FEED = ['comments', 'follows', 'likes', 'profile_activity', 'profile_visits', 'reach', 'reposts', 'saved', 'shares', 'total_interactions', 'views'];
const REELS = ['comments', 'crossposted_views', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'likes', 'reach', 'reels_skip_rate', 'reposts', 'saved', 'shares', 'total_interactions', 'views'];
const STORY = ['follows', 'navigation', 'profile_activity', 'profile_visits', 'reach', 'replies', 'reposts', 'shares', 'total_interactions', 'views'];

export type MediaProductType = 'FEED' | 'REELS' | 'STORY';

export function validMediaMetrics(type: MediaProductType, login: 'instagram' | 'facebook'): string[] {
  const base = type === 'FEED' ? FEED : type === 'REELS' ? REELS : STORY;
  const extra = type === 'STORY' ? ['total_views', 'facebook_views', 'link_clicks'] : FB_EXTRA;
  return login === 'facebook' ? [...base, ...extra] : [...base];
}

export const DEFAULT_MEDIA_METRICS: Record<MediaProductType, string[]> = {
  FEED: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'],
  REELS: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'reposts', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'],
  STORY: ['reach', 'views', 'replies', 'shares', 'follows', 'profile_visits', 'total_interactions']
};

export interface MetricEntry {
  name: string;
  period: string | null;
  title: string | null;
  description: string | null;
  value: number | Record<string, unknown> | null;
  breakdowns: unknown[] | null;
  values: unknown[] | null;
}

interface RawMetric {
  name?: unknown;
  period?: unknown;
  title?: unknown;
  description?: unknown;
  total_value?: { value?: unknown; breakdowns?: unknown } | null;
  values?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function normalizeMetric(raw: RawMetric): MetricEntry {
  const values = Array.isArray(raw.values) ? raw.values : null;
  let value: unknown = null;
  if (raw.total_value && typeof raw.total_value === 'object' && raw.total_value.value !== undefined) value = raw.total_value.value;
  else if (values && values.length > 0) value = (values[0] as { value?: unknown } | null)?.value ?? null;
  const tv = raw.total_value && typeof raw.total_value === 'object' ? raw.total_value : null;
  return {
    name: String(raw.name ?? ''),
    period: str(raw.period),
    title: str(raw.title),
    description: str(raw.description),
    value: (typeof value === 'number' || (value && typeof value === 'object') ? value : null) as MetricEntry['value'],
    breakdowns: Array.isArray(tv?.breakdowns) ? (tv!.breakdowns as unknown[]) : null,
    values
  };
}

export function normalizeData(body: unknown, requested: string[]): { metrics: MetricEntry[]; missing: string[] } {
  const data = (body as { data?: unknown } | null)?.data;
  const metrics = Array.isArray(data) ? (data as RawMetric[]).map(normalizeMetric) : [];
  const seen = new Set(metrics.map((m) => m.name));
  return { metrics, missing: requested.filter((m) => !seen.has(m)) };
}

/** Numeric value of a named metric entry, else null. */
export function numericValue(metrics: MetricEntry[], name: string): number | null {
  const m = metrics.find((e) => e.name === name);
  return m && typeof m.value === 'number' ? m.value : null;
}
