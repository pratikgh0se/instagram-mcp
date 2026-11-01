import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ACTION_NAMES, listAccounts } from '../../config/index.js';
import { AppError } from '../../errors.js';
import { resolveMatrix } from '../../graph/capabilities.js';
import { envTokenName } from '../../secrets/index.js';
import { reconcileOperation, approveApproval } from '../../safety/approve.js';
import { sweepOrphans } from '../../safety/orphans.js';
import type { ApprovalRow, OperationRow } from '../../storage/index.js';
import { invalidCursor } from '../../errors.js';
import { accountParam, cursorParam, decodeCursor, encodeCursor, limitParam, parseTimestamp } from '../shared.js';
import { defineTool, ok, READ_ONLY, READ_ONLY_LOCAL, REMOTE_DESTRUCTIVE, type ToolDef } from '../types.js';

const HASHTAG_LIMIT = 30;
const HASHTAG_WINDOW_DAYS = 7;

// ---------- instagram_list_accounts ----------
const listAccountsTool = defineTool({
  name: 'instagram_list_accounts',
  title: 'List accounts',
  description:
    'List configured Instagram accounts with login path, default flag, token presence/expiry and the resolved capability matrix (yes/no/probe per feature). Makes no Instagram request.',
  inputSchema: {},
  annotations: READ_ONLY_LOCAL,
  async handler(ctx) {
    const accounts = [];
    for (const a of listAccounts(ctx.config)) {
      const fromEnv = Boolean(process.env[envTokenName(a.alias)]?.trim());
      const present = fromEnv || Boolean(await ctx.secrets.get(a.alias, 'access_token'));
      const meta = ctx.auth.meta(a.alias);
      accounts.push({
        alias: a.alias,
        login: a.login,
        ig_user_id: a.ig_user_id,
        page_id: a.page_id,
        default: a.is_default,
        token: { present, source: fromEnv ? 'env' : ctx.secrets.backend, expires_at: meta?.expires_at ?? null, scopes: meta?.scopes ?? null },
        capabilities: resolveMatrix(ctx, a)
      });
    }
    return ok({ accounts }, `${accounts.length} account(s) configured.`);
  }
});

// ---------- instagram_get_profile ----------
const PROFILE_FIELDS = 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url';

const getProfile = defineTool({
  name: 'instagram_get_profile',
  title: 'Get profile',
  description: 'Profile of the connected account: username, name, bio, website, counts, profile picture URL and account type. On the facebook login path account_type is always null and warnings says so (the Graph API does not provide it there).',
  inputSchema: { account: accountParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const fields = account.login === 'instagram' ? `${PROFILE_FIELDS},account_type` : PROFILE_FIELDS;
    const p = await graph.get<Record<string, unknown>>(`/${igId}`, { fields });
    const pick = (k: string): unknown => p[k] ?? null;
    const data = {
      id: pick('id'), username: pick('username'), name: pick('name'), biography: pick('biography'), website: pick('website'),
      followers_count: pick('followers_count'), follows_count: pick('follows_count'), media_count: pick('media_count'),
      profile_picture_url: pick('profile_picture_url'), account_type: account.login === 'instagram' ? pick('account_type') : null
    };
    const warnings = account.login === 'instagram' ? [] : ['ACCOUNT_TYPE_UNAVAILABLE: account_type is not provided by the Graph API on the facebook login path'];
    return ok({ ...data, warnings }, `@${String(data.username ?? account.alias)}: ${data.followers_count ?? '?'} followers, ${data.media_count ?? '?'} posts.`);
  }
});

// ---------- instagram_get_rate_limits ----------
function businessUsageFor(raw: unknown, igId: string): object | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = (raw as Record<string, unknown>)[igId];
  if (Array.isArray(entry)) return (entry[0] as object | undefined) ?? null;
  return null;
}

const getRateLimits = defineTool({
  name: 'instagram_get_rate_limits',
  title: 'Get rate limits',
  description:
    'Publishing quota (content_publishing_limit), the most recent business-use-case and app usage reported by Meta response headers, and the remaining hashtag-search budget (facebook login path only).',
  inputSchema: { account: accountParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const res = await graph.get<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }> }>(
      `/${igId}/content_publishing_limit`,
      { fields: 'quota_usage,config' }
    );
    const first = res.data?.[0];
    const publishing = first
      ? {
          quota_usage: first.quota_usage ?? 0,
          quota_total: first.config?.quota_total ?? 0,
          quota_duration_seconds: first.config?.quota_duration ?? 0,
          remaining: Math.max(0, (first.config?.quota_total ?? 0) - (first.quota_usage ?? 0))
        }
      : null;

    const usageRows = ctx.storage.rateUsage.list(account.alias);
    const biz = usageRows.find((r) => r.source === 'business');
    const app = usageRows.find((r) => r.source === 'app');
    const observed = [biz?.updated_at, app?.updated_at].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
    const usage = {
      business_use_case: businessUsageFor(biz?.data, String(igId === 'me' ? (account.ig_user_id ?? igId) : igId)),
      app: app && typeof app.data === 'object' ? (app.data as object) : null,
      observed_at: observed
    };

    let hashtag_budget: { used: number; limit: number; remaining: number; window_days: number } | null = null;
    if (account.login === 'facebook') {
      const since = new Date(ctx.clock.nowMs() - HASHTAG_WINDOW_DAYS * 86_400_000).toISOString();
      const used = ctx.storage.hashtagBudget.usedSince(account.alias, since).length;
      hashtag_budget = { used, limit: HASHTAG_LIMIT, remaining: Math.max(0, HASHTAG_LIMIT - used), window_days: HASHTAG_WINDOW_DAYS };
    }
    const summary = publishing
      ? `Publishing quota: ${publishing.quota_usage}/${publishing.quota_total} used.`
      : 'No publishing quota data returned.';
    return ok({ publishing, usage, hashtag_budget }, summary);
  }
});

// ---------- instagram_get_operation ----------
type ErrObj = { code?: string; message?: string };

function operationView(ctx: AppContext, approval: ApprovalRow | undefined, op: OperationRow | undefined): Record<string, unknown> {
  const now = ctx.clock.nowIso();
  const base = (op ?? approval)!;
  let status: string;
  let outcome: unknown;
  if (op) {
    status = op.status;
    outcome = op.outcome;
  } else {
    status = approval!.status === 'stale' ? 'failed' : approval!.status;
    if (status === 'pending' && approval!.expires_at <= now) status = 'expired';
    outcome = approval!.outcome;
  }
  const out: Record<string, unknown> = {
    approval_id: approval?.approval_id ?? op?.approval_id ?? null,
    operation_id: op?.operation_id ?? approval?.operation_id ?? null,
    action: base.action,
    account: base.account,
    origin: op ? op.origin : null,
    status,
    created_at: base.created_at,
    finished_at: status === 'pending' || status === 'running' ? null : op ? op.finished_at : (approval?.finished_at ?? null)
  };
  if (approval?.preview !== undefined && approval.preview !== null) out.preview = approval.preview;
  const o = (outcome ?? {}) as Record<string, unknown>;
  if (status === 'dry_run') out.result = { planned_calls: (o.planned_calls as unknown) ?? approval?.planned_calls ?? [] };
  else if (o.error) out.error = o.error;
  else if (status === 'succeeded') {
    const { items, ...rest } = o;
    if (Array.isArray(items)) out.items = items;
    if (Object.keys(rest).length > 0 || !Array.isArray(items)) out.result = rest;
  }
  if (Array.isArray(o.items) && o.error) out.items = o.items;
  return out;
}

const getOperation = defineTool({
  name: 'instagram_get_operation',
  title: 'Get operation',
  description:
    'Look up one operation or approval by id (op_... or appr_...): status, preview, result or error. For unknown publish outcomes it reconciles against Instagram (one attempt per call) unless reconcile is false.',
  inputSchema: {
    id: z.string().min(1).max(128).describe('An op_... or appr_... id.'),
    reconcile: z.boolean().optional().describe('Try to resolve an unknown outcome (default true).')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    sweepOrphans(ctx);
    const store = ctx.storage;
    let op = store.operations.get(input.id);
    let approval = op?.approval_id ? store.approvals.get(op.approval_id) : store.approvals.get(input.id);
    if (!op && approval?.operation_id) op = store.operations.get(approval.operation_id);
    if (!op && !approval) throw new AppError('NOT_FOUND', `No operation or approval with id ${input.id}.`);

    let reconciliation: unknown;
    if (op && op.status === 'unknown' && input.reconcile !== false) {
      const r = await reconcileOperation(ctx, op);
      op = r.operation;
      reconciliation = r.reconciliation;
      if (op.approval_id) approval = store.approvals.get(op.approval_id) ?? approval;
    }
    const view = operationView(ctx, approval, op);
    if (reconciliation) view.reconciliation = reconciliation;
    const err = view.error as ErrObj | undefined;
    return ok(view, `${String(view.action)} ${String(view.status)}${err?.code ? ` (${err.code})` : ''}.`);
  }
});

// ---------- instagram_list_operations ----------
const listOperations = defineTool({
  name: 'instagram_list_operations',
  title: 'List operations',
  description: 'Recent operations (approved executions, including dry runs and scheduler-originated), newest first. Filter by action, status, account and created_at range.',
  inputSchema: {
    action: z.enum(ACTION_NAMES).optional(),
    status: z.enum(['running', 'succeeded', 'failed', 'unknown', 'dry_run']).optional(),
    account: accountParam,
    since: z.string().optional().describe('ISO 8601 or YYYY-MM-DD; inclusive, on created_at.'),
    until: z.string().optional().describe('ISO 8601 or YYYY-MM-DD; inclusive, on created_at.'),
    limit: limitParam,
    cursor: cursorParam
  },
  annotations: READ_ONLY_LOCAL,
  async handler(ctx, input) {
    sweepOrphans(ctx);
    const limit = input.limit ?? 25;
    const account = input.account ? ctx.account(input.account).alias : undefined;
    const before = decodeCursor<{ c: string; o: string }>(input.cursor);
    if (input.cursor && (!before || typeof before.c !== 'string' || typeof before.o !== 'string')) {
      throw invalidCursor();
    }
    const rows = ctx.storage.operations.list({
      account, action: input.action, status: input.status,
      since: input.since ? parseTimestamp(input.since, 'since').toISOString() : undefined,
      until: input.until ? parseTimestamp(input.until, 'until').toISOString() : undefined,
      before: before ? { created_at: before.c, operation_id: before.o } : undefined,
      limit: limit + 1
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const items = page.map((o) => ({
      operation_id: o.operation_id, approval_id: o.approval_id, action: o.action, account: o.account, origin: o.origin,
      status: o.status, created_at: o.created_at, finished_at: o.finished_at,
      summary: `${o.action} ${o.status}${o.target ? ` (${o.target})` : ''}${o.error_code ? ` [${o.error_code}]` : ''}`
    }));
    const next_cursor = rows.length > limit && last ? encodeCursor({ c: last.created_at, o: last.operation_id }) : null;
    return ok({ items, next_cursor }, `${items.length} operation(s).`);
  }
});

// ---------- instagram_approve ----------
const approve = defineTool({
  name: 'instagram_approve',
  title: 'Approve and execute',
  description:
    'Execute a pending approval created by an instagram_preflight_* tool. This is the only tool that changes Instagram. Requires confirm: true. Single-use; repeating it returns the stored outcome without re-executing.',
  inputSchema: { approval_id: z.string().min(1).max(128), confirm: z.literal(true) },
  annotations: REMOTE_DESTRUCTIVE,
  async handler(ctx, input) {
    const r = await approveApproval(ctx, input.approval_id);
    const data = r as unknown as Record<string, unknown>;
    if (r.status === 'failed' || r.status === 'unknown') {
      return { data, isError: true, summary: `${r.error?.code ?? 'UPSTREAM_REJECTED'}: ${r.error?.message ?? 'The operation did not complete.'}` };
    }
    return ok(data, `${r.action} ${r.status}${r.replayed ? ' (stored outcome)' : ''}.`);
  }
});

export const tools: ToolDef[] = [listAccountsTool, getProfile, getRateLimits, getOperation, listOperations, approve];

/** Account/ops owns no executable actions or jobs. */
export function register(_ctx: AppContext): void {}
