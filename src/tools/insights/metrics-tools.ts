import { z } from 'zod';
import { AppError } from '../../errors.js';
import {
  ACCOUNT_METRICS, DEFAULT_MEDIA_METRICS, TIMEFRAMES, normalizeData, rejectDeprecated, validMediaMetrics,
  type MediaProductType
} from '../../insights/metrics.js';
import { DAY_MS, unix } from '../../insights/common.js';
import { accountParam, parseTimestamp } from '../shared.js';
import { defineTool, ok, READ_ONLY } from '../types.js';

const invalid = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('INVALID_INPUT', message, details ? { details } : {});

const DEFAULT_ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions'];

// ---------- instagram_get_account_insights ----------
export const getAccountInsights = defineTool({
  name: 'instagram_get_account_insights',
  title: 'Get account insights',
  description:
    'Account-level insights (reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves, follows_and_unfollows, profile_links_taps, demographics, ...). Validates metrics against the current Meta list and rejects deprecated names (impressions, plays, profile_views ...) naming the replacement ("views"). All metrics in one call must share one period.',
  inputSchema: {
    account: accountParam,
    metrics: z.array(z.string().min(1)).min(1).max(16).optional().describe('Metric names (default reach, views, accounts_engaged, total_interactions).'),
    period: z.enum(['day', 'lifetime']).optional().describe('Derived from the metrics; an explicit value must agree.'),
    metric_type: z.enum(['total_value', 'time_series']).optional().describe('Default total_value (time_series for follower_count).'),
    breakdown: z.string().min(1).optional().describe('Breakdown dimension; required for the demographics metrics.'),
    timeframe: z.enum(TIMEFRAMES).optional().describe('Demographics metrics only (default this_month).'),
    since: z.string().optional().describe('ISO 8601 or YYYY-MM-DD.'),
    until: z.string().optional().describe('ISO 8601 or YYYY-MM-DD.')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const metrics = input.metrics ?? DEFAULT_ACCOUNT_METRICS;
    const valid = Object.keys(ACCOUNT_METRICS);
    for (const m of metrics) {
      rejectDeprecated(m);
      if (!ACCOUNT_METRICS[m]) throw invalid(`Unknown account metric "${m}".`, { metric: m, valid });
    }
    const specs = metrics.map((m) => ACCOUNT_METRICS[m]!);
    const periods = new Set(specs.map((s) => s.period));
    if (periods.size > 1) throw invalid('All metrics in one request must share one period (day vs lifetime); split the request.', { periods: [...periods] });
    const period = specs[0]!.period;
    if (input.period && input.period !== period) throw invalid(`period "${input.period}" disagrees with the metrics, which use "${period}".`, { period: input.period, expected: period });

    const onlyOnline = metrics.length === 1 && metrics[0] === 'online_followers';
    const hasFollowerCount = metrics.includes('follower_count');
    const metricType = input.metric_type ?? (hasFollowerCount ? 'time_series' : 'total_value');
    if (metricType === 'time_series') {
      const bad = metrics.filter((m) => !ACCOUNT_METRICS[m]!.types.includes('time_series'));
      if (bad.length) throw invalid(`time_series is not supported for: ${bad.join(', ')}.`, { metrics: bad });
    } else if (hasFollowerCount) {
      throw invalid('follower_count only supports metric_type time_series.', { metric: 'follower_count' });
    }

    const demographic = specs.every((s) => s.demographic);
    if (input.timeframe && !demographic) throw invalid('timeframe is only valid with the demographics metrics (follower_demographics, engaged_audience_demographics).');
    if (specs.some((s) => s.demographic) && !demographic) throw invalid('Demographics metrics must be requested without other metrics.');

    if (input.breakdown) {
      if (metricType !== 'total_value') throw invalid('breakdown is only valid with metric_type total_value.');
      const bad = metrics.filter((m) => !ACCOUNT_METRICS[m]!.breakdowns.includes(input.breakdown!));
      if (bad.length) throw invalid(`breakdown "${input.breakdown}" is not allowed for: ${bad.join(', ')}.`, { breakdown: input.breakdown, metrics: bad });
    } else if (demographic) {
      throw invalid('breakdown is required for the demographics metrics (age, city, country, gender).', { valid: ['age', 'city', 'country', 'gender'] });
    }

    const warnings: string[] = [];
    let since = input.since ? parseTimestamp(input.since, 'since') : null;
    let until = input.until ? parseTimestamp(input.until, 'until') : null;
    const timeframe = demographic ? (input.timeframe ?? 'this_month') : null;
    if (input.timeframe && (since || until)) {
      since = null;
      until = null;
      warnings.push('TIMEFRAME_OVERRIDES_RANGE: since/until were ignored because timeframe was given.');
    }

    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const query: Record<string, string | number> = { metric: metrics.join(','), period };
    if (!onlyOnline) query.metric_type = metricType;
    if (input.breakdown) query.breakdown = input.breakdown;
    if (timeframe) query.timeframe = timeframe;
    if (since) query.since = unix(since.getTime());
    if (until) query.until = unix(until.getTime());
    const body = await graph.get(`/${igId}/insights`, query);
    const { metrics: entries, missing } = normalizeData(body, metrics);
    return ok(
      {
        metrics: entries,
        missing_metrics: missing,
        request: {
          period, metric_type: onlyOnline ? null : metricType, breakdown: input.breakdown ?? null, timeframe,
          since: since ? since.toISOString() : null, until: until ? until.toISOString() : null
        },
        warnings
      },
      `${entries.length} of ${metrics.length} metric(s) returned for ${account.alias}${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`
    );
  }
});

// ---------- instagram_get_media_insights ----------
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const getMediaInsights = defineTool({
  name: 'instagram_get_media_insights',
  title: 'Get media insights',
  description:
    'Insights for one media item. Picks the valid metric set for its product type (FEED incl. carousels, REELS, STORY) when metrics is omitted; an explicit list is validated against that product type. Optional breakdown only for navigation or profile_activity.',
  inputSchema: {
    account: accountParam,
    media_id: z.string().regex(MEDIA_ID, 'must match ^[A-Za-z0-9_-]{1,64}$'),
    metrics: z.array(z.string().min(1)).min(1).max(30).optional(),
    breakdown: z.string().min(1).optional().describe('story_navigation_action_type (navigation) or action_type (profile_activity).')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const media = await graph.get<Record<string, unknown>>(`/${input.media_id}`, { fields: 'id,media_product_type,media_type,timestamp' });
    const productType = typeof media.media_product_type === 'string' ? media.media_product_type : 'FEED';
    if (productType === 'AD') throw invalid('Insights for AD media are not supported.', { media_product_type: productType });
    if (productType !== 'FEED' && productType !== 'REELS' && productType !== 'STORY') {
      throw invalid(`Unsupported media_product_type "${productType}".`, { media_product_type: productType });
    }
    const type: MediaProductType = productType;
    const valid = validMediaMetrics(type, account.login);
    const metrics = input.metrics ?? DEFAULT_MEDIA_METRICS[type];
    for (const m of metrics) {
      rejectDeprecated(m);
      if (!valid.includes(m)) throw invalid(`Metric "${m}" is not valid for ${type} media on the ${account.login} login path.`, { metric: m, media_product_type: type, valid });
    }
    if (input.breakdown) {
      const allNav = metrics.every((m) => m === 'navigation');
      const allAct = metrics.every((m) => m === 'profile_activity');
      if (!((allNav && input.breakdown === 'story_navigation_action_type') || (allAct && input.breakdown === 'action_type'))) {
        throw invalid('breakdown is only valid when every metric is navigation (story_navigation_action_type) or profile_activity (action_type).', { breakdown: input.breakdown, metrics });
      }
    }
    const warnings: string[] = [];
    if (type === 'STORY' && typeof media.timestamp === 'string') {
      const t = Date.parse(media.timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
      if (!Number.isNaN(t) && ctx.clock.nowMs() - t > DAY_MS) warnings.push('STORY_OLDER_THAN_24H: story insights may be unavailable after 24 hours.');
    }
    const query: Record<string, string> = { metric: metrics.join(',') };
    if (input.breakdown) query.breakdown = input.breakdown;
    const body = await graph.get(`/${input.media_id}/insights`, query);
    const { metrics: entries, missing } = normalizeData(body, metrics);
    return ok(
      { media_id: input.media_id, media_product_type: type, metrics: entries, missing_metrics: missing, warnings },
      `${entries.length} of ${metrics.length} ${type} metric(s) returned for ${input.media_id}.`
    );
  }
});
