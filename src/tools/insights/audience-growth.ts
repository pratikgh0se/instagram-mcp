import { z } from 'zod';
import { AppError, isAppError } from '../../errors.js';
import { TIMEFRAMES, normalizeData } from '../../insights/metrics.js';
import { DAY_MS, errInfo, round } from '../../insights/common.js';
import { snapshotNow } from '../../insights/snapshot.js';
import { accountParam, parseTimestamp } from '../shared.js';
import { defineTool, ok, READ_ONLY, READ_ONLY_LOCAL, type ToolAnnotations } from '../types.js';

type Row = { key: string; value: number };
const BREAKDOWN_ORDER = ['age', 'gender', 'city', 'country'] as const;

function mapResults(body: unknown): Row[] {
  const data = (body as { data?: Array<{ total_value?: { breakdowns?: Array<{ results?: Array<{ dimension_values?: unknown[]; value?: unknown }> }> } }> } | null)?.data;
  const results = data?.[0]?.total_value?.breakdowns?.[0]?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({ key: (r.dimension_values ?? []).join(','), value: typeof r.value === 'number' ? r.value : 0 }));
}

function hourMap(v: unknown): Record<string, number> {
  const by_hour: Record<string, number> = {};
  if (v && typeof v === 'object') for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number') by_hour[k] = n;
  return by_hour;
}

// ---------- instagram_get_audience ----------
export const getAudience = defineTool({
  name: 'instagram_get_audience',
  title: 'Get audience',
  description:
    'Follower and engaged-audience demographics (age, gender, city, country) plus online followers by hour when Meta provides them. Engaged and online sections are best-effort: failures are listed in "unavailable", never fatal.',
  inputSchema: {
    account: accountParam,
    breakdowns: z.array(z.enum(BREAKDOWN_ORDER)).min(1).optional().describe('Default all four.'),
    timeframe: z.enum(TIMEFRAMES).optional().describe('Default this_month.'),
    include_engaged: z.boolean().optional().describe('Default true.'),
    include_online_followers: z.boolean().optional().describe('Default true.')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const timeframe = input.timeframe ?? 'this_month';
    const wanted = BREAKDOWN_ORDER.filter((b) => (input.breakdowns ?? BREAKDOWN_ORDER).includes(b));
    const unavailable: Array<{ section: 'engaged' | 'online_followers'; breakdown?: string; error: { code: string; message: string } }> = [];

    const demo = (metric: string, breakdown: string): Promise<unknown> =>
      graph.get(`/${igId}/insights`, { metric, period: 'lifetime', metric_type: 'total_value', breakdown, timeframe });

    const followers: Record<string, Row[]> = {};
    for (const b of wanted) followers[b] = mapResults(await demo('follower_demographics', b));

    let engaged: Record<string, Row[]> | null = null;
    if (input.include_engaged !== false) {
      engaged = {};
      for (const b of wanted) {
        try {
          engaged[b] = mapResults(await demo('engaged_audience_demographics', b));
        } catch (e) {
          if (!isAppError(e)) throw e;
          engaged[b] = [];
          unavailable.push({ section: 'engaged', breakdown: b, error: errInfo(e) });
        }
      }
    }

    let online: { by_hour: Record<string, number>; end_time: string | null } | null = null;
    if (input.include_online_followers !== false) {
      try {
        const body = await graph.get(`/${igId}/insights`, { metric: 'online_followers', period: 'lifetime' });
        const entry = normalizeData(body, ['online_followers']).metrics[0];
        const first = entry?.values?.[0] as { value?: unknown; end_time?: unknown } | undefined;
        if (first && first.value && typeof first.value === 'object') {
          online = { by_hour: hourMap(first.value), end_time: typeof first.end_time === 'string' ? first.end_time : null };
        }
      } catch (e) {
        if (!isAppError(e)) throw e;
        unavailable.push({ section: 'online_followers', error: errInfo(e) });
      }
    }
    const total = Object.values(followers).reduce((a, r) => a + r.length, 0);
    return ok(
      { timeframe, followers, engaged, online_followers: online, unavailable },
      `Audience for ${account.alias} (${timeframe}): ${total} follower rows${unavailable.length ? `, ${unavailable.length} section(s) unavailable` : ''}.`
    );
  }
});

// ---------- instagram_snapshot_insights ----------
const SNAPSHOT_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export const snapshotInsights = defineTool({
  name: 'instagram_snapshot_insights',
  title: 'Snapshot insights',
  description: 'Fetch current counts and last-24h account insights and store them as a local snapshot (the daemon also does this daily). Feeds instagram_get_growth. Allowed under read_only.',
  inputSchema: { account: accountParam },
  annotations: SNAPSHOT_ANNOTATIONS,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const snap = await snapshotNow(ctx, account);
    return ok({ ...snap }, `Snapshot ${snap.snapshot_id} stored for ${account.alias}.`);
  }
});

// ---------- instagram_get_growth ----------
const DELTA_KEYS = ['followers_count', 'media_count', 'reach', 'views', 'accounts_engaged', 'total_interactions'] as const;
type Vals = Record<(typeof DELTA_KEYS)[number], number | null>;

export const getGrowth = defineTool({
  name: 'instagram_get_growth',
  title: 'Get growth',
  description: 'Growth time series from locally stored snapshots (followers, media count, reach, views, engagement) with deltas between consecutive snapshots. Makes no Instagram request.',
  inputSchema: {
    account: accountParam,
    days: z.number().int().min(1).max(365).optional().describe('Window in days (default 30).'),
    since: z.string().optional().describe('ISO 8601 or YYYY-MM-DD; overrides days.'),
    until: z.string().optional().describe('ISO 8601 or YYYY-MM-DD; overrides days.')
  },
  annotations: READ_ONLY_LOCAL,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const days = input.days ?? 30;
    const useRange = input.since !== undefined || input.until !== undefined;
    const until = input.until ? parseTimestamp(input.until, 'until') : ctx.clock.now();
    const since = input.since ? parseTimestamp(input.since, 'since') : new Date((useRange && input.until ? until.getTime() : ctx.clock.nowMs()) - days * DAY_MS);
    if (since.getTime() > until.getTime()) throw new AppError('INVALID_INPUT', 'since must not be after until.');

    const rows = ctx.storage.db
      .prepare(`SELECT taken_at, metrics_json, data FROM insight_snapshots WHERE account = ? AND scope = 'account' AND taken_at >= ? AND taken_at <= ? ORDER BY taken_at ASC, id ASC`)
      .all(account.alias, since.toISOString(), until.toISOString()) as Array<{ taken_at: string; metrics_json: string; data: string | null }>;

    const warnings: string[] = [];
    let prev: Vals | null = null;
    const points = rows.map((r) => {
      const m = JSON.parse(r.metrics_json) as Record<string, unknown>;
      const meta = r.data ? (JSON.parse(r.data) as { snapshot_id?: string }) : {};
      const vals = {} as Vals;
      const deltas = {} as Vals;
      for (const k of DELTA_KEYS) {
        const v = typeof m[k] === 'number' ? (m[k] as number) : null;
        vals[k] = v;
        const p: number | null = prev ? prev[k] : null;
        deltas[k] = prev && v !== null && p !== null ? v - p : null;
      }
      prev = vals;
      return { snapshot_id: meta.snapshot_id ?? null, taken_at: r.taken_at, ...vals, deltas };
    });

    let summary: { first_taken_at: string; last_taken_at: string; followers_delta: number | null; followers_pct: number | null } | null = null;
    if (points.length === 0) {
      warnings.push('NO_SNAPSHOTS: no snapshots in this window; run instagram_snapshot_insights or let the daemon take daily snapshots.');
    } else {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const delta = first.followers_count !== null && last.followers_count !== null ? last.followers_count - first.followers_count : null;
      summary = {
        first_taken_at: first.taken_at,
        last_taken_at: last.taken_at,
        followers_delta: delta,
        followers_pct: delta !== null && first.followers_count ? round((delta / first.followers_count) * 100, 2) : null
      };
    }
    return ok(
      { account: account.alias, points, summary, warnings },
      points.length ? `${points.length} snapshot(s) for ${account.alias}; followers delta ${summary?.followers_delta ?? 'n/a'}.` : `No snapshots for ${account.alias} in this window.`
    );
  }
});
