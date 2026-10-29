import { z } from 'zod';
import { AppError, isAppError } from '../../errors.js';
import { normalizeData, numericValue, type MetricEntry } from '../../insights/metrics.js';
import {
  DAY_MS, WEEKDAYS, WEEK_ORDER, engagementOf, errInfo, fetchMediaPages, formatOf, mean, round, unix,
  type Format, type MediaItem, type Weekday
} from '../../insights/common.js';
import { accountParam, parseTimestamp } from '../shared.js';
import { defineTool, ok, READ_ONLY } from '../types.js';
import type { GraphClient } from '../../graph/client.js';

const TOTAL_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves'] as const;
const POST_METRICS = 'reach,views,saved,shares,total_interactions';

async function postInsights(graph: GraphClient, id: string): Promise<Record<string, number>> {
  const body = await graph.get(`/${id}/insights`, { metric: POST_METRICS });
  const out: Record<string, number> = {};
  for (const e of normalizeData(body, []).metrics) if (typeof e.value === 'number') out[e.name] = e.value;
  return out;
}

const weekdayOf = (ms: number): Weekday => WEEKDAYS[new Date(ms).getUTCDay()]!;

// ---------- instagram_performance_report ----------
const RANK_BY = ['reach', 'views', 'saved', 'shares', 'total_interactions'] as const;

interface Post {
  id: string; permalink: string | null; media_product_type: string | null; timestamp: string | null;
  score: number; metrics: Record<string, number>;
}

function fmt(n: number | null): string {
  return n === null ? 'n/a' : String(n);
}

export const performanceReport = defineTool({
  name: 'instagram_performance_report',
  title: 'Performance report',
  description:
    'Performance report for 7d, 30d, 90d or a custom range: totals vs the previous period, engagement rate (total_interactions / reach), top and bottom posts, format breakdown, posting cadence. Returns JSON plus a markdown summary. Single failed post-insight requests only add warnings.',
  inputSchema: {
    account: accountParam,
    period: z.enum(['7d', '30d', '90d', 'custom']).optional().describe('Default 30d.'),
    since: z.string().optional().describe('Required for custom.'),
    until: z.string().optional().describe('Required for custom.'),
    rank_by: z.enum(RANK_BY).optional().describe('Default total_interactions.')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const label = input.period ?? '30d';
    const rankBy = input.rank_by ?? 'total_interactions';
    let endMs: number;
    let startMs: number;
    if (label === 'custom') {
      if (!input.since || !input.until) throw new AppError('INVALID_INPUT', 'period "custom" requires both since and until.', { details: { issues: [{ path: 'since', message: 'required for custom' }] } });
      startMs = parseTimestamp(input.since, 'since').getTime();
      endMs = parseTimestamp(input.until, 'until').getTime();
      if (startMs >= endMs) throw new AppError('INVALID_INPUT', 'since must be before until.');
    } else {
      if (input.since || input.until) throw new AppError('INVALID_INPUT', 'since/until are only valid with period "custom".');
      endMs = ctx.clock.nowMs();
      startMs = endMs - Number.parseInt(label, 10) * DAY_MS;
    }
    const spanMs = endMs - startMs;
    const prevStartMs = startMs - spanMs;
    const days = round(spanMs / DAY_MS, 2);
    const warnings: string[] = [];

    const graph = ctx.graph(account);
    const igId = await graph.igUserId();

    // (1) profile counts
    const profile = await graph.get<Record<string, unknown>>(`/${igId}`, { fields: 'followers_count,media_count' });
    const followers = typeof profile.followers_count === 'number' ? profile.followers_count : null;

    // (2)(3) totals, current and previous period
    const totalsQuery = (s: number, e: number): Record<string, string | number> => ({
      metric: TOTAL_METRICS.join(','), period: 'day', metric_type: 'total_value', since: unix(s), until: unix(e)
    });
    const cur = normalizeData(await graph.get(`/${igId}/insights`, totalsQuery(startMs, endMs)), [...TOTAL_METRICS]);
    let prevEntries: MetricEntry[] = [];
    try {
      prevEntries = normalizeData(await graph.get(`/${igId}/insights`, totalsQuery(prevStartMs, startMs)), [...TOTAL_METRICS]).metrics;
    } catch (e) {
      if (!isAppError(e)) throw e;
      warnings.push(`PREVIOUS_PERIOD_UNAVAILABLE: ${errInfo(e).code}: ${errInfo(e).message}`);
    }
    if (cur.missing.length) warnings.push(`MISSING_METRICS: ${cur.missing.join(', ')} not returned for the current period.`);

    const totals: Record<string, { value: number | null; previous: number | null; delta: number | null; delta_pct: number | null }> = {};
    for (const name of TOTAL_METRICS) {
      const value = numericValue(cur.metrics, name);
      const previous = numericValue(prevEntries, name);
      const delta = value !== null && previous !== null ? value - previous : null;
      totals[name] = { value, previous, delta, delta_pct: delta !== null && previous ? round((delta / previous) * 100, 2) : null };
    }
    const ti = totals.total_interactions!.value;
    const reach = totals.reach!.value;
    const engagementRate = ti !== null && reach ? round(ti / reach, 4) : null;

    // (4) media in [prev start, end]
    const media = await fetchMediaPages(graph, igId, {
      fields: 'id,media_type,media_product_type,permalink,timestamp,like_count,comments_count,caption',
      since: unix(prevStartMs), until: unix(endMs), limit: 100
    });
    const inWindow = media.filter((m) => !Number.isNaN(m.ts) && m.ts >= startMs && m.ts < endMs).sort((a, b) => b.ts - a.ts);

    // (5) per-post insights for the 25 most recent
    const insightsById = new Map<string, Record<string, number>>();
    for (const m of inWindow.slice(0, 25)) {
      try {
        insightsById.set(m.id, await postInsights(graph, m.id));
      } catch (e) {
        if (!isAppError(e)) throw e;
        warnings.push(`POST_INSIGHTS_UNAVAILABLE: ${m.id}: ${errInfo(e).code}`);
      }
    }
    if (inWindow.length > 25) warnings.push(`POST_INSIGHTS_LIMITED: insights fetched for the 25 most recent of ${inWindow.length} posts; older posts are scored by likes + comments.`);

    const posts: Post[] = inWindow.map((m) => {
      const metrics = insightsById.get(m.id) ?? {};
      return {
        id: m.id, permalink: m.permalink, media_product_type: m.media_product_type, timestamp: m.timestamp,
        score: metrics[rankBy] ?? engagementOf(m), metrics
      };
    });
    const top = [...posts].sort((a, b) => b.score - a.score).slice(0, 5);
    const bottom = [...posts].sort((a, b) => a.score - b.score).slice(0, 5);

    const byFormat = new Map<Format, MediaItem[]>();
    for (const m of inWindow) {
      const f = formatOf(m);
      if (f) byFormat.set(f, [...(byFormat.get(f) ?? []), m]);
    }
    const format_breakdown = (['reel', 'feed', 'carousel', 'story'] as const)
      .filter((f) => byFormat.has(f))
      .map((f) => {
        const items = byFormat.get(f)!;
        const vals = (k: string): number[] => items.map((m) => insightsById.get(m.id)?.[k]).filter((v): v is number => typeof v === 'number');
        return { format: f, posts: items.length, avg_reach: mean(vals('reach')), avg_total_interactions: mean(vals('total_interactions')) };
      });

    const by_weekday = Object.fromEntries(WEEK_ORDER.map((d) => [d, 0])) as Record<Weekday, number>;
    for (const m of inWindow) by_weekday[weekdayOf(m.ts)]++;
    const cadence = { posts: inWindow.length, posts_per_week: round(inWindow.length / (days / 7), 2), by_weekday };

    const period = { label, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), days };
    const previous_period = { start: new Date(prevStartMs).toISOString(), end: new Date(startMs).toISOString() };

    const md: string[] = [
      `# Performance report: ${account.alias} (${label})`,
      '',
      `Period ${period.start} to ${period.end} (${days} days) vs previous ${previous_period.start} to ${previous_period.end}.`,
      `Followers: ${fmt(followers)}`,
      '',
      '## Totals',
      ...TOTAL_METRICS.map((n) => {
        const t = totals[n]!;
        return `- ${n}: ${fmt(t.value)} (previous ${fmt(t.previous)}, delta ${fmt(t.delta)}${t.delta_pct !== null ? `, ${t.delta_pct}%` : ''})`;
      }),
      `- engagement rate (total_interactions / reach): ${fmt(engagementRate)}`,
      '',
      `## Top posts by ${rankBy}`,
      ...(top.length ? top.map((p) => `- ${p.permalink ?? p.id}: ${p.score}`) : ['- none']),
      '',
      '## Bottom posts',
      ...(bottom.length ? bottom.map((p) => `- ${p.permalink ?? p.id}: ${p.score}`) : ['- none']),
      '',
      '## Formats',
      ...(format_breakdown.length
        ? format_breakdown.map((f) => `- ${f.format}: ${f.posts} posts, avg reach ${fmt(f.avg_reach)}, avg interactions ${fmt(f.avg_total_interactions)}`)
        : ['- no posts in period']),
      '',
      `## Cadence`,
      `- ${cadence.posts} posts, ${cadence.posts_per_week} per week`,
      ...(warnings.length ? ['', '## Warnings', ...warnings.map((w) => `- ${w}`)] : [])
    ];

    return ok(
      {
        period, previous_period, followers: { current: followers }, totals,
        engagement_rate: { value: engagementRate, formula: 'total_interactions / reach' },
        top_posts: top, bottom_posts: bottom, format_breakdown, cadence, warnings, markdown: md.join('\n')
      },
      `${label} report for ${account.alias}: reach ${fmt(reach)}, interactions ${fmt(ti)}, ${inWindow.length} posts.`
    );
  }
});

// ---------- instagram_best_time_to_post ----------
export const bestTimeToPost = defineTool({
  name: 'instagram_best_time_to_post',
  title: 'Best time to post',
  description:
    'Best posting slots (UTC) from online_followers when Meta provides it and from your own post history (likes + comments by weekday and hour). States which data was used; missing online_followers is not an error.',
  inputSchema: {
    account: accountParam,
    days: z.number().int().min(7).max(365).optional().describe('History window in days (default 90).')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const days = input.days ?? 90;
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const caveats: string[] = ['All hours are UTC.'];

    let byHourOnline: Record<string, number> | null = null;
    try {
      const entry = normalizeData(await graph.get(`/${igId}/insights`, { metric: 'online_followers', period: 'lifetime' }), ['online_followers']).metrics[0];
      const v = (entry?.values?.[0] as { value?: unknown } | undefined)?.value;
      if (v && typeof v === 'object') {
        const m: Record<string, number> = {};
        for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number' && /^\d+$/.test(k) && Number(k) < 24) m[k] = n;
        if (Object.keys(m).length) byHourOnline = m;
      }
      if (!byHourOnline) caveats.push('online_followers returned no data; slots are based on post history only.');
    } catch (e) {
      if (!isAppError(e)) throw e;
      caveats.push(`online_followers unavailable (${errInfo(e).code}); slots are based on post history only.`);
    }

    const media = (await fetchMediaPages(graph, igId, {
      fields: 'id,media_product_type,timestamp,like_count,comments_count', since: unix(ctx.clock.nowMs() - days * DAY_MS), limit: 100
    })).filter((m) => !Number.isNaN(m.ts));

    const wd = Object.fromEntries(WEEK_ORDER.map((d) => [d, { posts: 0, sum: 0 }])) as Record<Weekday, { posts: number; sum: number }>;
    const hr: Record<string, { posts: number; sum: number }> = {};
    for (let h = 0; h < 24; h++) hr[String(h)] = { posts: 0, sum: 0 };
    const slot = new Map<string, { weekday: Weekday; hour: number; posts: number; sum: number }>();
    for (const m of media) {
      const e = engagementOf(m);
      const d = weekdayOf(m.ts);
      const h = new Date(m.ts).getUTCHours();
      wd[d].posts++; wd[d].sum += e;
      hr[String(h)]!.posts++; hr[String(h)]!.sum += e;
      const key = `${d}-${h}`;
      const s = slot.get(key) ?? { weekday: d, hour: h, posts: 0, sum: 0 };
      s.posts++; s.sum += e;
      slot.set(key, s);
    }
    const avg = (x: { posts: number; sum: number }): { posts: number; avg_engagement: number } => ({ posts: x.posts, avg_engagement: x.posts ? round(x.sum / x.posts, 2) : 0 });
    const by_weekday = Object.fromEntries(WEEK_ORDER.map((d) => [d, avg(wd[d])]));
    const by_hour_utc = Object.fromEntries(Object.entries(hr).map(([h, x]) => [h, avg(x)]));

    type Slot = { weekday: Weekday; hour_utc: number; score: number; basis: 'online_followers' | 'post_history' };
    let best_slots: Slot[] = [];
    const data_used: Array<'online_followers' | 'post_history'> = [];
    if (byHourOnline) {
      data_used.push('online_followers');
      let bestDay: Weekday = 'Mon';
      let bestAvg = -1;
      for (const d of WEEK_ORDER) {
        const a = wd[d].posts ? wd[d].sum / wd[d].posts : -1;
        if (a > bestAvg) { bestAvg = a; bestDay = d; }
      }
      if (media.length) data_used.push('post_history');
      best_slots = Object.entries(byHourOnline)
        .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))
        .slice(0, 5)
        .map(([h, v]) => ({ weekday: bestDay, hour_utc: Number(h), score: v, basis: 'online_followers' as const }));
    } else if (slot.size) {
      data_used.push('post_history');
      best_slots = [...slot.values()]
        .map((s) => ({ weekday: s.weekday, hour_utc: s.hour, score: round(s.sum / s.posts, 2), basis: 'post_history' as const }))
        .sort((a, b) => b.score - a.score || a.hour_utc - b.hour_utc)
        .slice(0, 5);
      if (media.length < 10) caveats.push(`Only ${media.length} post(s) in history; treat slots as weak evidence.`);
    } else {
      caveats.push('No online_followers data and no posts in the window; no recommendation possible.');
    }
    return ok(
      { data_used, online_followers_available: byHourOnline !== null, best_slots, by_weekday, by_hour_utc, caveats },
      best_slots.length
        ? `Best slot: ${best_slots[0]!.weekday} ${best_slots[0]!.hour_utc}:00 UTC (${best_slots[0]!.basis}); data used: ${data_used.join(', ')}.`
        : 'No data available to recommend posting times.'
    );
  }
});

// ---------- instagram_media_kit ----------
type Row = { key: string; value: number };

function demoRows(body: unknown): Row[] {
  const data = (body as { data?: Array<{ total_value?: { breakdowns?: Array<{ results?: Array<{ dimension_values?: unknown[]; value?: unknown }> }> } }> } | null)?.data;
  const results = data?.[0]?.total_value?.breakdowns?.[0]?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({ key: (r.dimension_values ?? []).join(','), value: typeof r.value === 'number' ? r.value : 0 }));
}

interface FormatStats { posts: number; avg_reach: number | null; avg_views: number | null; avg_engagement: number | null }

export const mediaKit = defineTool({
  name: 'instagram_media_kit',
  title: 'Media kit',
  description:
    'Partnership media kit: profile, follower demographics, average reach/views/engagement per format over 30 and 90 days, top posts. Returns JSON plus markdown. Demographic or insight failures only add warnings.',
  inputSchema: { account: accountParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const warnings: string[] = [];
    const nowMs = ctx.clock.nowMs();

    const p = await graph.get<Record<string, unknown>>(`/${igId}`, {
      fields: 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url'
    });
    const pick = (k: string): unknown => p[k] ?? null;
    const profile = {
      id: pick('id'), username: pick('username'), name: pick('name'), biography: pick('biography'), website: pick('website'),
      followers_count: pick('followers_count'), follows_count: pick('follows_count'), media_count: pick('media_count'),
      profile_picture_url: pick('profile_picture_url')
    };

    const audience: Record<string, Row[]> = {};
    for (const b of ['age', 'gender', 'city', 'country']) {
      try {
        audience[b] = demoRows(await graph.get(`/${igId}/insights`, { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: b, timeframe: 'this_month' }));
      } catch (e) {
        if (!isAppError(e)) throw e;
        audience[b] = [];
        warnings.push(`AUDIENCE_${b.toUpperCase()}_UNAVAILABLE: ${errInfo(e).code}: ${errInfo(e).message}`);
      }
    }

    const media = (await fetchMediaPages(graph, igId, {
      fields: 'id,media_type,media_product_type,permalink,timestamp,like_count,comments_count', since: unix(nowMs - 90 * DAY_MS), limit: 100
    }))
      .filter((m) => !Number.isNaN(m.ts) && m.ts >= nowMs - 90 * DAY_MS && m.ts <= nowMs && formatOf(m) !== 'story')
      .sort((a, b) => b.ts - a.ts);

    const insightsById = new Map<string, Record<string, number>>();
    for (const m of media.slice(0, 30)) {
      try {
        insightsById.set(m.id, await postInsights(graph, m.id));
      } catch (e) {
        if (!isAppError(e)) throw e;
        warnings.push(`POST_INSIGHTS_UNAVAILABLE: ${m.id}: ${errInfo(e).code}`);
      }
    }
    if (media.length > 30) warnings.push(`POST_INSIGHTS_LIMITED: insights fetched for the 30 most recent of ${media.length} posts; avg_reach/avg_views use those only.`);

    const stats = (items: MediaItem[]): FormatStats => {
      const vals = (k: string): number[] => items.map((m) => insightsById.get(m.id)?.[k]).filter((v): v is number => typeof v === 'number');
      return { posts: items.length, avg_reach: mean(vals('reach')), avg_views: mean(vals('views')), avg_engagement: mean(items.map(engagementOf)) };
    };
    const formats = {} as Record<'reel' | 'feed' | 'carousel', { d30: FormatStats; d90: FormatStats }>;
    for (const f of ['reel', 'feed', 'carousel'] as const) {
      const all = media.filter((m) => formatOf(m) === f);
      formats[f] = { d30: stats(all.filter((m) => m.ts >= nowMs - 30 * DAY_MS)), d90: stats(all) };
    }

    const top_posts = media
      .map((m) => ({ id: m.id, permalink: m.permalink, media_product_type: m.media_product_type, timestamp: m.timestamp, score: insightsById.get(m.id)?.total_interactions ?? engagementOf(m) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const demoLine = (b: string): string => {
      const top = [...(audience[b] ?? [])].sort((x, y) => y.value - x.value).slice(0, 3);
      return `- ${b}: ${top.length ? top.map((r) => `${r.key} (${r.value})`).join(', ') : 'n/a'}`;
    };
    const md = [
      `# Media kit: @${String(profile.username ?? account.alias)}`,
      '',
      ...(profile.name ? [`${String(profile.name)}`] : []),
      ...(profile.biography ? [String(profile.biography)] : []),
      '',
      `Followers: ${fmt(profile.followers_count as number | null)} | Following: ${fmt(profile.follows_count as number | null)} | Posts: ${fmt(profile.media_count as number | null)}`,
      '',
      '## Audience (top 3 per breakdown)',
      ...['age', 'gender', 'city', 'country'].map(demoLine),
      '',
      '## Formats (avg reach / views / engagement)',
      ...(['reel', 'feed', 'carousel'] as const).flatMap((f) => (['d30', 'd90'] as const).map((w) => {
        const s = formats[f][w];
        return `- ${f} ${w === 'd30' ? '30d' : '90d'}: ${s.posts} posts, reach ${fmt(s.avg_reach)}, views ${fmt(s.avg_views)}, engagement ${fmt(s.avg_engagement)}`;
      })),
      '',
      '## Top posts',
      ...(top_posts.length ? top_posts.map((t) => `- ${t.permalink ?? t.id}: ${t.score}`) : ['- none']),
      ...(warnings.length ? ['', '## Warnings', ...warnings.map((w) => `- ${w}`)] : [])
    ].join('\n');

    return ok(
      { profile, audience, formats, top_posts, warnings, markdown: md },
      `Media kit for @${String(profile.username ?? account.alias)}: ${fmt(profile.followers_count as number | null)} followers, ${media.length} posts in 90d.`
    );
  }
});
