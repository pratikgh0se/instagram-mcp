import { z } from 'zod';
import type { AppContext } from '../../context.js';
import {
  businessDiscovery, computeMetrics, HASHTAG_LIMIT, hashtagBudget, normalizeUsername, type AccountMetrics
} from '../../discovery/index.js';
import { AppError, isAppError } from '../../errors.js';
import { requireCapability, withProbe } from '../../graph/capabilities.js';
import { assertPolicyAllows, createApproval, registerAction, type ActionContext } from '../../safety/index.js';
import { accountParam, cursorParam, limitParam } from '../shared.js';
import { defineTool, ok, READ_ONLY, type ToolDef } from '../types.js';

const idParam = (name: string) =>
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, `${name} must match ^[A-Za-z0-9_-]{1,64}$`);

// ---------- instagram_lookup_account ----------
const lookupAccount = defineTool({
  name: 'instagram_lookup_account',
  title: 'Look up public account',
  description:
    'Business discovery: public profile stats and recent media of another Instagram business/creator account by username. Facebook login path only (instagram login path returns CAPABILITY_UNAVAILABLE).',
  inputSchema: {
    account: accountParam,
    username: z.string().min(1).max(40).describe('Username to look up (leading @ allowed).'),
    media_limit: z.number().int().min(1).max(50).optional().describe('Recent media to include (default 10).')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const username = normalizeUsername(input.username);
    const account = ctx.account(input.account);
    requireCapability(ctx, account, 'business_discovery');
    const r = await businessDiscovery(ctx, account, username, input.media_limit ?? 10);
    return ok({ ...r }, `@${r.username}: ${r.followers_count ?? '?'} followers, ${r.recent_media.length} recent post(s).`);
  }
});

// ---------- instagram_compare_accounts ----------
const compareAccounts = defineTool({
  name: 'instagram_compare_accounts',
  title: 'Compare accounts',
  description:
    'Compare your account with up to 10 other public business/creator accounts: followers, posting cadence, average likes/comments and format mix over a recent sample. Facebook login path only.',
  inputSchema: {
    account: accountParam,
    usernames: z.array(z.string().min(1).max(40)).min(1).max(10),
    media_limit: z.number().int().min(1).max(50).optional().describe('Posts sampled per account (default 25).')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const names = [...new Set(input.usernames.map((u, i) => normalizeUsername(u, `usernames[${i}]`)))];
    const account = ctx.account(input.account);
    requireCapability(ctx, account, 'business_discovery');
    const limit = input.media_limit ?? 25;
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();

    const me = await graph.get<{ username?: string; followers_count?: number; media_count?: number }>(`/${igId}`, { fields: 'username,followers_count,media_count' });
    const own = await graph.get<{ data?: Array<Record<string, unknown>> }>(`/${igId}/media`, {
      fields: 'id,media_type,media_product_type,timestamp,like_count,comments_count', limit
    });
    const ownM = computeMetrics(me.username ?? account.alias, me.followers_count ?? null, me.media_count ?? null, own.data ?? []);

    const others: Array<AccountMetrics | { username: string; error: { code: string; message: string } }> = [];
    for (const name of names) {
      try {
        const r = await businessDiscovery(ctx, account, name, limit);
        others.push(computeMetrics(r.username, r.followers_count, r.media_count, r.recent_media));
      } catch (error) {
        const e = isAppError(error) ? error : new AppError('INTERNAL', (error as Error).message);
        others.push({ username: name, error: { code: e.code, message: e.message } });
      }
    }
    const okCount = others.filter((o) => !('error' in o)).length;
    return ok({ own: ownM, others, generated_at: ctx.clock.nowIso() }, `Compared @${ownM.username} with ${okCount}/${names.length} account(s).`);
  }
});

// ---------- instagram_search_hashtag ----------
const searchHashtag = defineTool({
  name: 'instagram_search_hashtag',
  title: 'Search hashtag',
  description:
    'Resolve a hashtag to its id. Meta allows 30 distinct hashtags per account per rolling 7 days; repeats within the window are free, a 31st new hashtag returns HASHTAG_BUDGET_EXHAUSTED. Facebook login path only.',
  inputSchema: {
    account: accountParam,
    query: z.string().min(1).max(110).describe('Hashtag without the leading #.')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    if (!/^[A-Za-z0-9_]{1,100}$/.test(input.query)) {
      throw new AppError('INVALID_INPUT', 'query must match ^[A-Za-z0-9_]{1,100}$ (no leading #).', {
        details: { issues: [{ path: 'query', message: 'invalid hashtag' }] }
      });
    }
    const name = input.query.toLowerCase();
    const account = ctx.account(input.account);
    requireCapability(ctx, account, 'hashtag_search');
    const state = hashtagBudget(ctx, account, name);
    if (!state.alreadyRecorded && state.used.length >= HASHTAG_LIMIT) {
      throw new AppError('HASHTAG_BUDGET_EXHAUSTED', `${HASHTAG_LIMIT} distinct hashtags were already searched in the last 7 days; "${name}" would be a new one.`, {
        action: 'Search only hashtags you already used this week, or wait for the 7-day window to roll over (see instagram_get_rate_limits).',
        details: { used: state.used.length, limit: HASHTAG_LIMIT }
      });
    }
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const res = await withProbe(ctx, account, 'hashtag_search', () => graph.get<{ data?: Array<{ id?: string }> }>('/ig_hashtag_search', { user_id: igId, q: input.query }));
    const id = res.data?.[0]?.id;
    if (!id) throw new AppError('NOT_FOUND', `No hashtag found for "${name}".`);
    let used = state.used.length;
    if (!state.alreadyRecorded) {
      ctx.storage.hashtagBudget.record(account.alias, name, id, ctx.clock.nowIso());
      used += 1;
    }
    return ok(
      { hashtag_id: id, name, budget: { used, limit: HASHTAG_LIMIT, remaining: Math.max(0, HASHTAG_LIMIT - used) } },
      `#${name} is ${id}; ${Math.max(0, HASHTAG_LIMIT - used)}/${HASHTAG_LIMIT} hashtag searches left this week.`
    );
  }
});

// ---------- instagram_get_hashtag_media ----------
const HASHTAG_MEDIA_KEYS = ['id', 'caption', 'media_type', 'permalink', 'timestamp', 'like_count', 'comments_count'];

const getHashtagMedia = defineTool({
  name: 'instagram_get_hashtag_media',
  title: 'Get hashtag media',
  description: 'Top or recent public media for a hashtag id from instagram_search_hashtag. Does not use the hashtag search budget. Facebook login path only.',
  inputSchema: {
    account: accountParam,
    hashtag_id: idParam('hashtag_id'),
    type: z.enum(['top', 'recent']).optional().describe('top (default) or recent.'),
    limit: limitParam,
    cursor: cursorParam
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    requireCapability(ctx, account, 'hashtag_search');
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const edge = (input.type ?? 'top') === 'top' ? 'top_media' : 'recent_media';
    const page = await withProbe(ctx, account, 'hashtag_search', () => graph.list<Record<string, unknown>>(
      `/${input.hashtag_id}/${edge}`,
      { user_id: igId, fields: HASHTAG_MEDIA_KEYS.join(',') },
      { limit: input.limit ?? 25, cursor: input.cursor }
    ));
    const items = page.data.map((m) => Object.fromEntries(HASHTAG_MEDIA_KEYS.map((k) => [k, m[k] ?? null])));
    return ok({ items, next_cursor: page.next_cursor }, `${items.length} ${edge === 'top_media' ? 'top' : 'recent'} post(s).`);
  }
});

// ---------- collaboration invites ----------
const INVITE_KEYS = ['media_id', 'media_owner_username', 'caption', 'media_url'];
const INVITE_FIELDS = INVITE_KEYS.join(',');

const shapeInvite = (m: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(INVITE_KEYS.map((k) => [k, m[k] ?? null]));

const listCollabInvites = defineTool({
  name: 'instagram_list_collab_invites',
  title: 'List collaboration invites',
  description: 'Pending collaboration (collab post) invites for the account. May be unavailable on the instagram login path (CAPABILITY_UNAVAILABLE once Meta rejects it).',
  inputSchema: { account: accountParam, limit: limitParam, cursor: cursorParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    requireCapability(ctx, account, 'collab_invites');
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const page = await withProbe(ctx, account, 'collab_invites', () =>
      graph.list<Record<string, unknown>>(`/${igId}/collaboration_invites`, { fields: INVITE_FIELDS }, { limit: input.limit ?? 25, cursor: input.cursor })
    );
    const items = page.data.map(shapeInvite);
    return ok({ items, next_cursor: page.next_cursor }, `${items.length} collaboration invite(s).`);
  }
});

interface RespondParams { media_id: string; accept: boolean }

async function fetchInvites(ctx: { graph(): ReturnType<ActionContext['graph']>; actionAccount: ActionContext['actionAccount'] } & AppContext): Promise<Array<Record<string, unknown>>> {
  const graph = ctx.graph();
  const igId = await graph.igUserId();
  const res = await withProbe(ctx, ctx.actionAccount, 'collab_invites', () =>
    graph.get<{ data?: Array<Record<string, unknown>> }>(`/${igId}/collaboration_invites`, { fields: INVITE_FIELDS, limit: 100 })
  );
  return res.data ?? [];
}

export function register(_ctx: AppContext): void {
  registerAction<RespondParams>({
    name: 'respond_collab_invite',
    capability: 'collab_invites',
    async recheck(actx, params) {
      const invites = await fetchInvites(actx);
      if (!invites.some((i) => i.media_id === params.media_id)) {
        throw new AppError('NOT_FOUND', `Collaboration invite for media ${params.media_id} is no longer pending.`);
      }
      return 'present';
    },
    async execute(actx, params) {
      const graph = actx.graph();
      const igId = await graph.igUserId();
      await withProbe(actx, actx.actionAccount, 'collab_invites', () =>
        graph.post(`/${igId}/collaboration_invites`, { media_id: params.media_id, accept: params.accept ? 'true' : 'false' })
      );
      return { media_id: params.media_id, accepted: params.accept };
    }
  });
}

const preflightRespondCollabInvite = defineTool({
  name: 'instagram_preflight_respond_collab_invite',
  title: 'Preflight: respond to collab invite',
  description:
    'Preview accepting or declining a pending collaboration invite (reads the invite list only). Returns an approval_id; nothing changes until instagram_approve is called with it.',
  inputSchema: { account: accountParam, media_id: idParam('media_id'), accept: z.boolean() },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    assertPolicyAllows(ctx, { name: 'respond_collab_invite' });
    requireCapability(ctx, account, 'collab_invites');
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const res = await withProbe(ctx, account, 'collab_invites', () =>
      graph.get<{ data?: Array<Record<string, unknown>> }>(`/${igId}/collaboration_invites`, { fields: INVITE_FIELDS, limit: 100 })
    );
    const invite = (res.data ?? []).find((i) => i.media_id === input.media_id);
    if (!invite) {
      throw new AppError('NOT_FOUND', `No pending collaboration invite for media ${input.media_id} on the first page of invites.`, {
        action: 'List invites with instagram_list_collab_invites.'
      });
    }
    const preview = {
      media_id: input.media_id,
      media_owner_username: invite.media_owner_username ?? null,
      caption: invite.caption ?? null,
      accept: input.accept
    };
    const path = `/${igId}/collaboration_invites`;
    const ticket = await createApproval(ctx, {
      account: account.alias,
      action: 'respond_collab_invite',
      target: input.media_id,
      params: { media_id: input.media_id, accept: input.accept },
      preview,
      state_fingerprint: 'present',
      planned_calls: [
        { method: 'GET', path, params: { fields: INVITE_FIELDS, limit: '100' } },
        { method: 'POST', path, params: { media_id: input.media_id, accept: input.accept ? 'true' : 'false' } }
      ]
    });
    return ok(ticket as unknown as Record<string, unknown>, `Approval ${ticket.approval_id} ready: ${input.accept ? 'accept' : 'decline'} collab invite for media ${input.media_id}.`);
  }
});

/** Tools for the "discovery" domain (business discovery, hashtags, collab invites). */
export const tools: ToolDef[] = [
  lookupAccount, compareAccounts, searchHashtag, getHashtagMedia, listCollabInvites, preflightRespondCollabInvite
];
