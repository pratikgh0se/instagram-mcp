import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { createApproval } from '../../safety/approvals.js';
import { registerAction } from '../../safety/registry.js';
import { gatePreflight, idParam, isRecord, num, str, withTarget } from '../../engagement/common.js';
import { preflightCommentActions, registerCommentActions } from '../../engagement/comment-actions.js';
import { buildInbox, setHandled, handledSet } from '../../engagement/inbox.js';
import { accountParam, cursorParam, parseTimestamp } from '../shared.js';
import { defineTool, LOCAL_WRITE, ok, READ_ONLY, type ToolDef } from '../types.js';

const COMMENT_FIELDS = 'id,text,username,timestamp,like_count,hidden';
const REPLY_FIELDS = 'id,text,username,timestamp,like_count,hidden';

const pickReply = (r: Record<string, unknown>) => ({
  id: str(r.id), text: str(r.text), username: str(r.username), timestamp: str(r.timestamp), like_count: num(r.like_count), hidden: typeof r.hidden === 'boolean' ? r.hidden : null
});
const repliesOf = (c: Record<string, unknown>): Array<Record<string, unknown>> =>
  isRecord(c.replies) && Array.isArray(c.replies.data) ? (c.replies.data as Array<Record<string, unknown>>) : [];

// ---------- instagram_list_comments ----------
const listComments = defineTool({
  name: 'instagram_list_comments',
  title: 'List comments',
  description: 'Top-level comments on one of your media (id, text, username, timestamp, like_count, hidden), optionally with their replies. Paginated (limit max 50).',
  inputSchema: {
    account: accountParam,
    media_id: idParam('media_id'),
    include_replies: z.boolean().optional().describe('Also fetch replies (default false).'),
    limit: z.number().int().min(1).max(50).optional().describe('Page size (default 25, max 50).'),
    cursor: cursorParam
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const withReplies = input.include_replies === true;
    const fields = withReplies ? `${COMMENT_FIELDS},replies{${REPLY_FIELDS}}` : COMMENT_FIELDS;
    const page = await graph.list<Record<string, unknown>>(`/${input.media_id}/comments`, { fields }, { limit: input.limit ?? 25, cursor: input.cursor });
    const items = page.data.map((c) => ({ ...pickReply(c), replies: withReplies ? repliesOf(c).map(pickReply) : null }));
    return ok({ items, next_cursor: page.next_cursor }, `${items.length} comment(s) on ${input.media_id}.`);
  }
});

// ---------- instagram_get_comment ----------
const getComment = defineTool({
  name: 'instagram_get_comment',
  title: 'Get comment',
  description: 'One comment with its parent id, media id and replies.',
  inputSchema: { account: accountParam, comment_id: idParam('comment_id') },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const graph = ctx.graph(ctx.account(input.account));
    const c = await graph.get<Record<string, unknown>>(`/${input.comment_id}`, {
      fields: 'id,text,username,timestamp,like_count,hidden,parent_id,media{id,media_product_type},replies{id,text,username,timestamp,like_count,hidden}'
    });
    const data = { ...pickReply(c), parent_id: str(c.parent_id), media_id: isRecord(c.media) ? str(c.media.id) : null, replies: repliesOf(c).map(pickReply) };
    return ok(data, `Comment ${data.id} by @${data.username ?? '?'}.`);
  }
});

// ---------- instagram_get_inbox ----------
const getInbox = defineTool({
  name: 'instagram_get_inbox',
  title: 'Get inbox',
  description:
    'Unified triage feed: recent top-level comments on your latest media, tags, and stored webhook events, with unanswered (no reply from you) and handled flags. Window = since or last `days` days. Offset-paginated over the merged list.',
  inputSchema: {
    account: accountParam,
    days: z.number().int().min(1).max(30).optional().describe('Window in days (default 7).'),
    since: z.string().optional().describe('ISO 8601 start of the window; overrides days.'),
    include_handled: z.boolean().optional(),
    unanswered_only: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25, max 100).'),
    cursor: cursorParam
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const since = input.since ? parseTimestamp(input.since, 'since') : undefined;
    const account = ctx.account(input.account);
    await ctx.auth.getAccessToken(account);
    const data = await buildInbox(ctx, account, {
      days: input.days ?? 7, since, include_handled: input.include_handled === true, unanswered_only: input.unanswered_only === true,
      limit: input.limit ?? 25, cursor: input.cursor
    });
    return ok(data, `${(data.items as unknown[]).length} inbox item(s).`);
  }
});

// ---------- instagram_mark_handled ----------
const markHandled = defineTool({
  name: 'instagram_mark_handled',
  title: 'Mark inbox items handled',
  description: 'Local bookkeeping: mark (or unmark) inbox item ids as handled so instagram_get_inbox hides them. No Instagram request.',
  inputSchema: {
    account: accountParam,
    item_ids: z.array(z.string().min(1).max(256)).min(1).max(100),
    handled: z.boolean().optional().describe('Default true; false unmarks.')
  },
  annotations: LOCAL_WRITE,
  async handler(ctx: AppContext, input) {
    const account = ctx.account(input.account);
    const ids = [...new Set(input.item_ids)];
    const handled = input.handled !== false;
    setHandled(ctx, account.alias, ids, handled);
    const now = handledSet(ctx, account.alias);
    const marked = ids.filter((i) => now.has(i));
    return ok({ updated: ids.length, handled: handled ? marked : [] }, `${handled ? 'Marked' : 'Unmarked'} ${ids.length} item(s).`);
  }
});

// ---------- instagram_list_mentions ----------
const TAG_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp,username,comments_count,like_count';
const MEDIA_LOOKUP_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp,username,comments_count,like_count';

const nullFill = (obj: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));

const listMentions = defineTool({
  name: 'instagram_list_mentions',
  title: 'List mentions',
  description:
    'Media you are tagged in (mode tags, paginated), or look up a specific mentioning media (mentioned_media + media_id) or comment (mentioned_comment + comment_id).',
  inputSchema: {
    account: accountParam,
    mode: z.enum(['tags', 'mentioned_media', 'mentioned_comment']).optional().describe('Default tags.'),
    media_id: idParam('media_id').optional(),
    comment_id: idParam('comment_id').optional(),
    media_type: z.enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']).optional().describe('tags only'),
    posted_after: z.string().optional().describe('tags only, ISO 8601'),
    posted_before: z.string().optional().describe('tags only, ISO 8601'),
    limit: z.number().int().min(1).max(100).optional().describe('tags only'),
    cursor: cursorParam
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const mode = input.mode ?? 'tags';
    const bad: Array<{ path: string; message: string }> = [];
    const forbid = (names: Array<keyof typeof input>, why: string): void => {
      for (const n of names) if (input[n] !== undefined) bad.push({ path: String(n), message: why });
    };
    if (mode === 'tags') forbid(['media_id', 'comment_id'], 'not applicable to mode tags');
    else forbid(['media_type', 'posted_after', 'posted_before', 'limit', 'cursor'], `not applicable to mode ${mode}`);
    if (mode === 'mentioned_media') { forbid(['comment_id'], 'not applicable to mode mentioned_media'); if (!input.media_id) bad.push({ path: 'media_id', message: 'required for mentioned_media' }); }
    if (mode === 'mentioned_comment') { forbid(['media_id'], 'not applicable to mode mentioned_comment'); if (!input.comment_id) bad.push({ path: 'comment_id', message: 'required for mentioned_comment' }); }
    if (bad.length) {
      throw new AppError('INVALID_INPUT', `Invalid input: ${bad.map((b) => `${b.path}: ${b.message}`).join('; ')}`, { details: { issues: bad } });
    }
    if (input.posted_after) parseTimestamp(input.posted_after, 'posted_after');
    if (input.posted_before) parseTimestamp(input.posted_before, 'posted_before');

    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();

    if (mode === 'tags') {
      const query: Record<string, string> = { fields: TAG_FIELDS };
      if (input.media_type) query.media_type = input.media_type;
      if (input.posted_after) query.posted_after = input.posted_after;
      if (input.posted_before) query.posted_before = input.posted_before;
      const page = await graph.list<Record<string, unknown>>(`/${igId}/tags`, query, { limit: input.limit ?? 25, cursor: input.cursor });
      const items = page.data.map((t) => nullFill(t, TAG_FIELDS.split(',')));
      return ok({ mode, items, next_cursor: page.next_cursor }, `${items.length} tagged media.`);
    }
    if (mode === 'mentioned_media') {
      const res = await graph.get<Record<string, unknown>>(`/${igId}`, { fields: `mentioned_media.media_id(${input.media_id}){${MEDIA_LOOKUP_FIELDS}}` });
      const m = res.mentioned_media;
      if (!isRecord(m)) throw new AppError('NOT_FOUND', `No mentioned media ${input.media_id}.`, { details: { target: { type: 'media', id: input.media_id } } });
      return ok({ mode, items: [m], next_cursor: null }, `Mentioned media ${input.media_id}.`);
    }
    const res = await graph.get<Record<string, unknown>>(`/${igId}`, { fields: `mentioned_comment.comment_id(${input.comment_id}){id,text,timestamp,like_count,media{id,permalink}}` });
    const c = res.mentioned_comment;
    if (!isRecord(c)) throw new AppError('NOT_FOUND', `No mentioned comment ${input.comment_id}.`, { details: { target: { type: 'comment', id: input.comment_id } } });
    return ok({ mode, items: [c], next_cursor: null }, `Mentioned comment ${input.comment_id}.`);
  }
});

// ---------- instagram_preflight_reply_mention ----------
interface ReplyMentionParams { media_id: string; comment_id?: string; message: string }

function mentionLookup(p: { media_id: string; comment_id?: string }): { fields: string; key: 'mentioned_comment' | 'mentioned_media'; id: string } {
  return p.comment_id
    ? { fields: `mentioned_comment.comment_id(${p.comment_id}){id,text,timestamp}`, key: 'mentioned_comment', id: p.comment_id }
    : { fields: `mentioned_media.media_id(${p.media_id}){id,caption,username,permalink}`, key: 'mentioned_media', id: p.media_id };
}

async function fetchMention(actx: { graph(): import('../../graph/client.js').GraphClient }, p: { media_id: string; comment_id?: string }): Promise<Record<string, unknown>> {
  const graph = actx.graph();
  const igId = await graph.igUserId();
  const look = mentionLookup(p);
  const res = await graph.get<Record<string, unknown>>(`/${igId}`, { fields: look.fields });
  const obj = res[look.key];
  if (!isRecord(obj)) throw new AppError('NOT_FOUND', `Mention ${look.id} was not found.`, { details: { target: { type: look.key, id: look.id } } });
  return obj;
}

const preflightReplyMention = defineTool({
  name: 'instagram_preflight_reply_mention',
  title: 'Preflight reply to mention',
  description: 'Plan a reply to a media mention (media_id) or a comment mention (media_id + comment_id) via POST /{ig}/mentions. Returns an approval_id for instagram_approve.',
  inputSchema: { account: accountParam, media_id: idParam('media_id'), comment_id: idParam('comment_id').optional(), message: z.string().min(1).max(2200) },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    await gatePreflight(ctx, account, 'reply_mention');
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const params: ReplyMentionParams = { media_id: input.media_id, ...(input.comment_id ? { comment_id: input.comment_id } : {}), message: input.message };
    const target = await fetchMention({ graph: () => graph }, params);
    const look = mentionLookup(params);
    const post: Record<string, string> = { media_id: input.media_id, message: input.message };
    if (input.comment_id) post.comment_id = input.comment_id;
    const ticket = await createApproval(ctx, {
      account: account.alias, action: 'reply_mention', target: look.id, params,
      preview: { media_id: input.media_id, comment_id: input.comment_id ?? null, message: input.message, target },
      planned_calls: [{ method: 'GET', path: `/${igId}`, params: { fields: look.fields } }, { method: 'POST', path: `/${igId}/mentions`, params: post }],
      state_fingerprint: 'exists'
    });
    return ok(ticket as unknown as Record<string, unknown>, `Approval ${ticket.approval_id} ready to reply to mention ${look.id}.`);
  }
});

export const tools: ToolDef[] = [
  listComments, getComment, getInbox, markHandled, preflightCommentActions, listMentions, preflightReplyMention
];

export function register(_ctx: AppContext): void {
  registerCommentActions();
  registerAction<ReplyMentionParams>({
    name: 'reply_mention',
    async recheck(actx, params) {
      try { await fetchMention(actx, params); } catch (e) { withTarget(e, { type: 'mention' }); }
      return 'exists';
    },
    async execute(actx, params) {
      const graph = actx.graph();
      const igId = await graph.igUserId();
      const body: Record<string, string> = { media_id: params.media_id, message: params.message };
      if (params.comment_id) body.comment_id = params.comment_id;
      const r = await graph.post<Record<string, unknown>>(`/${igId}/mentions`, body);
      return { id: str(r.id) };
    }
  });
}
