import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import { listAccounts, type ResolvedAccount } from '../config/index.js';
import { registerJob } from '../safety/registry.js';
import { errorMessage } from '../redact.js';
import { normalizeData, numericValue } from './metrics.js';
import { unix } from './common.js';

export const SNAPSHOT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves'] as const;

export interface SnapshotResult {
  snapshot_id: string;
  account: string;
  taken_at: string;
  followers_count: number | null;
  follows_count: number | null;
  media_count: number | null;
  metrics: Record<(typeof SNAPSHOT_METRICS)[number], number | null>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Take and store one account snapshot (contract 2.6 snapshot_insights). Window is clock-86400..clock. */
export async function snapshotNow(ctx: AppContext, account: ResolvedAccount, source: 'manual' | 'daily' = 'manual'): Promise<SnapshotResult> {
  const graph = ctx.graph(account);
  const igId = await graph.igUserId();
  const now = ctx.clock.now();
  const nowS = unix(now.getTime());

  const profile = await graph.get<Record<string, unknown>>(`/${igId}`, { fields: 'followers_count,follows_count,media_count' });
  const body = await graph.get(`/${igId}/insights`, {
    metric: SNAPSHOT_METRICS.join(','),
    period: 'day',
    metric_type: 'total_value',
    since: nowS - 86400,
    until: nowS
  });
  const { metrics: entries } = normalizeData(body, [...SNAPSHOT_METRICS]);

  const metrics = {} as SnapshotResult['metrics'];
  for (const name of SNAPSHOT_METRICS) metrics[name] = numericValue(entries, name);

  const snapshot_id = `snap_${randomBytes(16).toString('base64url')}`;
  const result: SnapshotResult = {
    snapshot_id,
    account: account.alias,
    taken_at: now.toISOString(),
    followers_count: num(profile.followers_count),
    follows_count: num(profile.follows_count),
    media_count: num(profile.media_count),
    metrics
  };
  const metricsJson = {
    followers_count: result.followers_count, follows_count: result.follows_count, media_count: result.media_count, ...metrics
  };
  ctx.storage.db
    .prepare('INSERT INTO insight_snapshots (account, scope, media_id, taken_at, snapshot_date, metrics_json, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(account.alias, 'account', null, result.taken_at, localDate(now), JSON.stringify(metricsJson), JSON.stringify({ snapshot_id, source }));
  return result;
}

function dailyDone(ctx: AppContext, alias: string, date: string): boolean {
  const row = ctx.storage.db
    .prepare(`SELECT 1 AS x FROM insight_snapshots WHERE account = ? AND scope = 'account' AND snapshot_date = ? AND data LIKE '%"source":"daily"%' LIMIT 1`)
    .get(alias, date);
  return Boolean(row);
}

/** One scheduler pass: for each account, snapshot once per local day once daily_hour_local has passed. */
export async function runDailySnapshots(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  if (now.getHours() < ctx.config.snapshots.daily_hour_local) return;
  const date = localDate(now);
  for (const account of listAccounts(ctx.config)) {
    if (dailyDone(ctx, account.alias, date)) continue;
    try {
      await snapshotNow(ctx, account, 'daily');
    } catch (e) {
      ctx.log.warn(`daily snapshot failed for ${account.alias}: ${errorMessage(e)}`);
    }
  }
}

export function registerSnapshotJob(): void {
  // Polled every 15 minutes; the job itself decides whether today's snapshot is due (hour + dedupe).
  registerJob({ name: 'snapshots', intervalMs: 15 * 60 * 1000, run: runDailySnapshots });
}
