import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { ResolvedAccount } from '../../config/index.js';
import { AppError } from '../../errors.js';
import { requireCapability, withProbe } from '../../graph/capabilities.js';
import type { GraphClient } from '../../graph/client.js';
import { createApproval, type PlannedCall } from '../../safety/approvals.js';
import { registerAction } from '../../safety/registry.js';
import { DAY_MS, conversationIdParam, dmBase, gatePreflight, isRecord, ownId, str, tsMs, withTarget } from '../../engagement/common.js';
import { assertRemoteMediaUrl } from '../../engagement/url.js';
import { verifyRemoteMedia } from '../../publish/validate.js';
import { accountParam, cursorParam } from '../shared.js';
import { defineTool, ok, READ_ONLY, type ToolDef } from '../types.js';

const WINDOW_MS = 24 * 3_600_000;
const HUMAN_AGENT_MS = 7 * DAY_MS;

type Rec = Record<string, unknown>;
const dataOf = (v: unknown): Rec[] => (isRecord(v) && Array.isArray(v.data) ? (v.data as Rec[]) : []);
const person = (p: Rec): { id: string | null; username: string | null } => ({ id: str(p.id), username: str(p.username) });

/** Newest created_time among messages not sent by `own`, as ISO string as given by Meta. */
function lastUserMessage(messages: Rec[], own: string): string | null {
  let best: { ms: number; raw: string } | null = null;
  for (const m of messages) {
    const from = isRecord(m.from) ? str(m.from.id) : null;
    if (from === own) continue;
    const raw = str(m.created_time);
    const ms = tsMs(raw);
    if (raw && !Number.isNaN(ms) && (!best || ms > best.ms)) best = { ms, raw };
  }
  return best?.raw ?? null;
}

const windowOpen = (ctx: AppContext, at: string | null): boolean => at !== null && ctx.clock.nowMs() - tsMs(at) < WINDOW_MS;

// ---------- instagram_list_conversations ----------
const listConversations = defineTool({
  name: 'instagram_list_conversations',
  title: 'List conversations',
  description: 'Recent DM conversations with participants, last message, last user message time and whether the 24 h messaging window is open.',
  inputSchema: { account: accountParam, user_id: z.string().min(1).max(128).optional().describe('Filter by Instagram-scoped user id (IGSID).'), limit: z.number().int().min(1).max(100).optional(), cursor: cursorParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    requireCapability(ctx, account, 'messaging');
    await ctx.auth.getAccessToken(account);
    const graph = ctx.graph(account);
    const base = await dmBase(account, graph);
    const own = await ownId(account, graph);
    const query: Record<string, string> = {
      platform: 'instagram', fields: 'id,updated_time,participants,messages.limit(20){id,created_time,from,message}'
    };
    if (input.user_id) query.user_id = input.user_id;
    const page = await withProbe(ctx, account, 'messaging', () => graph.list<Rec>(`/${base}/conversations`, query, { limit: input.limit ?? 25, cursor: input.cursor }));
    const items = page.data.map((c) => {
      const msgs = dataOf(c.messages);
      const first = msgs[0];
      const last = lastUserMessage(msgs, own);
      return {
        id: str(c.id), updated_time: str(c.updated_time),
        participants: dataOf(c.participants).map(person),
        last_message: first ? { id: str(first.id), created_time: str(first.created_time), from_id: isRecord(first.from) ? str(first.from.id) : null, text: str(first.message) } : null,
        last_user_message_at: last, window_open: windowOpen(ctx, last)
      };
    });
    return ok({ items, next_cursor: page.next_cursor }, `${items.length} conversation(s).`);
  }
});

// ---------- instagram_get_conversation ----------
const getConversation = defineTool({
  name: 'instagram_get_conversation',
  title: 'Get conversation',
  description: 'Messages of one conversation (newest first, max 20) with participants and the 24 h window state.',
  inputSchema: { account: accountParam, conversation_id: conversationIdParam(), limit: z.number().int().min(1).max(20).optional().describe('Default 20, max 20.') },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    requireCapability(ctx, account, 'messaging');
    await ctx.auth.getAccessToken(account);
    const graph = ctx.graph(account);
    const own = await ownId(account, graph);
    const limit = input.limit ?? 20;
    const c = await withProbe(ctx, account, 'messaging', () =>
      graph.get<Rec>(`/${input.conversation_id}`, { fields: `participants,messages.limit(${limit}){id,created_time,from,to,message}` }));
    const msgs = dataOf(c.messages);
    const last = lastUserMessage(msgs, own);
    const data = {
      id: str(c.id) ?? input.conversation_id,
      participants: dataOf(c.participants).map(person),
      messages: msgs.map((m) => ({
        id: str(m.id), created_time: str(m.created_time), from: isRecord(m.from) ? person(m.from) : null,
        to: dataOf(m.to).map(person), text: str(m.message)
      })),
      last_user_message_at: last, window_open: windowOpen(ctx, last)
    };
    return ok(data, `${data.messages.length} message(s) in ${data.id}.`);
  }
});

// ---------- send_message ----------
interface SendParams {
  recipient_id: string;
  conversation_id: string | null;
  kind: 'text' | 'media' | 'reaction';
  text?: string;
  media?: { url: string; type: 'image' | 'video' | 'audio' };
  reaction?: { message_id: string; action: 'react' | 'unreact'; emoji: string };
  quick_replies?: Array<{ title: string; payload: string }>;
  reply_to_mid?: string;
  human_tag: boolean;
}

function sendBody(p: SendParams): Record<string, string> {
  const body: Record<string, string> = { recipient: JSON.stringify({ id: p.recipient_id }) };
  if (p.kind === 'text') {
    const message: Rec = { text: p.text };
    if (p.quick_replies) message.quick_replies = p.quick_replies.map((q) => ({ content_type: 'text', title: q.title, payload: q.payload }));
    if (p.reply_to_mid) message.reply_to = { mid: p.reply_to_mid };
    body.message = JSON.stringify(message);
  } else if (p.kind === 'media') {
    const message: Rec = { attachment: { type: p.media!.type, payload: { url: p.media!.url } } };
    if (p.reply_to_mid) message.reply_to = { mid: p.reply_to_mid };
    body.message = JSON.stringify(message);
  } else {
    const r = p.reaction!;
    body.sender_action = r.action;
    body.payload = JSON.stringify(r.action === 'react' ? { message_id: r.message_id, reaction: r.emoji } : { message_id: r.message_id });
  }
  if (p.human_tag) { body.messaging_type = 'MESSAGE_TAG'; body.tag = 'HUMAN_AGENT'; }
  return body;
}

async function recentMessages(ctx: AppContext, account: ResolvedAccount, graph: GraphClient, input: { recipient_id?: string; conversation_id?: string }, own: string)
  : Promise<{ recipient: string; conversation_id: string | null; lastUserAt: string | null }> {
  return withProbe(ctx, account, 'messaging', async () => {
    if (input.conversation_id) {
      let c: Rec;
      try {
        c = await graph.get<Rec>(`/${input.conversation_id}`, { fields: 'participants,messages.limit(20){id,created_time,from,message}' });
      } catch (e) { return withTarget(e, { type: 'conversation', id: input.conversation_id }); }
      const other = dataOf(c.participants).map(person).find((p) => p.id && p.id !== own);
      if (!other?.id) throw new AppError('NOT_FOUND', 'The conversation has no participant other than your account.', { details: { target: { type: 'conversation', id: input.conversation_id } } });
      return { recipient: other.id, conversation_id: input.conversation_id, lastUserAt: lastUserMessage(dataOf(c.messages), own) };
    }
    const base = await dmBase(account, graph);
    const res = await graph.get<Rec>(`/${base}/conversations`, {
      platform: 'instagram', user_id: input.recipient_id, fields: 'id,messages.limit(20){id,created_time,from,message}'
    });
    const first = dataOf(res)[0];
    return { recipient: input.recipient_id!, conversation_id: first ? str(first.id) : null, lastUserAt: first ? lastUserMessage(dataOf(first.messages), own) : null };
  });
}

const sendInput = {
  account: accountParam,
  recipient_id: z.string().min(1).max(128).optional().describe('Instagram-scoped user id (IGSID). Exactly one of recipient_id / conversation_id.'),
  conversation_id: conversationIdParam().optional(),
  text: z.string().optional().describe('Message text, at most 1000 bytes UTF-8.'),
  media: z.object({ url: z.string().min(1), type: z.enum(['image', 'video', 'audio']) }).strict().optional(),
  reaction: z.object({ message_id: z.string().min(1).max(512), action: z.enum(['react', 'unreact']), emoji: z.string().min(1).max(32).optional() }).strict().optional(),
  quick_replies: z.array(z.object({ title: z.string().min(1), payload: z.string().min(1).max(1000) }).strict()).min(1).max(13).optional(),
  reply_to_mid: z.string().min(1).max(512).optional(),
  human_agent: z.boolean().optional().describe('Allow the HUMAN_AGENT tag (7 day window) when policy.allow_human_agent_tag is true.')
};

const preflightSendMessage = defineTool({
  name: 'instagram_preflight_send_message',
  title: 'Preflight send message',
  description:
    'Plan a DM (text, media URL, or reaction; optional quick replies) to an IGSID or conversation. Checks the 24 h messaging window from the last 20 messages (HUMAN_AGENT tag only if policy allows and within 7 days) and returns an approval_id for instagram_approve.',
  inputSchema: sendInput,
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const bad = (message: string, path = ''): never => {
      throw new AppError('INVALID_INPUT', `Invalid input: ${message}`, { details: { issues: [{ path, message }] } });
    };
    if ((input.recipient_id === undefined) === (input.conversation_id === undefined)) bad('provide exactly one of recipient_id or conversation_id');
    const contents = [input.text, input.media, input.reaction].filter((v) => v !== undefined).length;
    if (contents !== 1) bad('provide exactly one of text, media or reaction');
    if (input.text !== undefined && (input.text.length === 0 || Buffer.byteLength(input.text, 'utf8') > 1000)) bad('text must be 1..1000 bytes (UTF-8)', 'text');
    if (input.quick_replies && input.text === undefined) bad('quick_replies are only allowed with text', 'quick_replies');
    if (input.reply_to_mid && input.reaction) bad('reply_to_mid is only allowed with text or media', 'reply_to_mid');
    const account = ctx.account(input.account);
    await gatePreflight(ctx, account, 'send_message');
    if (input.media) await assertRemoteMediaUrl(input.media.url, 'media.url', process.env.INSTAGRAM_MCP_TEST_MODE === '1', verifyRemoteMedia(ctx));

    const warnings: string[] = [];
    let quick = input.quick_replies;
    if (quick) {
      quick = quick.map((q, i) => {
        if (q.title.length <= 20) return q;
        warnings.push(`TITLE_TRUNCATED: quick reply #${i} title truncated to 20 characters.`);
        return { ...q, title: q.title.slice(0, 20) };
      });
    }

    const graph = ctx.graph(account);
    const own = await ownId(account, graph);
    const state = await recentMessages(ctx, account, graph, input, own);
    const open = windowOpen(ctx, state.lastUserAt);
    let humanTag = false;
    if (!open) {
      const last = state.lastUserAt ? tsMs(state.lastUserAt) : NaN;
      const within7 = !Number.isNaN(last) && ctx.clock.nowMs() - last < HUMAN_AGENT_MS;
      if (input.human_agent === true && ctx.config.policy.allow_human_agent_tag && within7) {
        humanTag = true;
        warnings.push('HUMAN_AGENT_TAG: message is sent with the HUMAN_AGENT tag (allowed up to 7 days after the last user message).');
      } else {
        throw new AppError('MESSAGING_WINDOW_CLOSED',
          state.lastUserAt ? `The last message from the user was at ${state.lastUserAt}, outside the 24 h messaging window.` : 'No message from the user was found; the 24 h messaging window is closed.', {
            action: input.human_agent === true && !ctx.config.policy.allow_human_agent_tag
              ? 'Set policy.allow_human_agent_tag to true in the config to use the HUMAN_AGENT tag (7 day window), or wait for the user to message you.'
              : 'Wait for the user to message you again (or use human_agent with policy.allow_human_agent_tag within 7 days).',
            details: { last_user_message_at: state.lastUserAt }
          });
      }
    }

    const params: SendParams = {
      recipient_id: state.recipient,
      conversation_id: state.conversation_id,
      kind: input.text !== undefined ? 'text' : input.media ? 'media' : 'reaction',
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.media ? { media: input.media } : {}),
      ...(input.reaction ? { reaction: { message_id: input.reaction.message_id, action: input.reaction.action, emoji: input.reaction.emoji ?? 'love' } } : {}),
      ...(quick ? { quick_replies: quick } : {}),
      ...(input.reply_to_mid ? { reply_to_mid: input.reply_to_mid } : {}),
      human_tag: humanTag
    };
    if (input.media && !verifyRemoteMedia(ctx)) warnings.push('MEDIA_UNVERIFIED: the media URL was not checked locally (policy.verify_remote_media is off); Instagram will fetch it when the message is sent.');
    const base = await dmBase(account, graph);
    const planned: PlannedCall[] = [{ method: 'POST', path: `/${base}/messages`, params: sendBody(params) }];
    const preview = {
      recipient_id: params.recipient_id, conversation_id: params.conversation_id, kind: params.kind,
      text: params.text ?? null,
      media: params.media ? { url: params.media.url, type: params.media.type } : null,
      quick_replies: params.quick_replies ? params.quick_replies.map((q) => ({ title: q.title, payload: q.payload })) : null,
      reply_to_mid: params.reply_to_mid ?? null,
      reaction: params.reaction ? { message_id: params.reaction.message_id, action: params.reaction.action, emoji: params.reaction.action === 'react' ? params.reaction.emoji : null } : null,
      tag: humanTag ? 'HUMAN_AGENT' : null,
      window: { open, last_user_message_at: state.lastUserAt, human_agent: humanTag }
    };
    const ticket = await createApproval(ctx, {
      account: account.alias, action: 'send_message', target: params.recipient_id, params, preview, planned_calls: planned, warnings, state_fingerprint: 'n/a'
    });
    return ok(ticket as unknown as Record<string, unknown>, `Approval ${ticket.approval_id} ready to send a ${params.kind} to ${params.recipient_id}.`);
  }
});

// ---------- messaging profile ----------
const CLEARABLE = ['ice_breakers', 'persistent_menu'] as const;

const menuAction = z.object({
  type: z.enum(['postback', 'web_url']),
  title: z.string().min(1).max(30),
  payload: z.string().min(1).max(1000).optional(),
  url: z.string().min(1).optional()
}).strict();

const profileInput = {
  account: accountParam,
  ice_breakers: z.array(z.object({ question: z.string().min(1).max(80), payload: z.string().min(1).max(1000) }).strict()).min(1).max(4).optional(),
  persistent_menu: z.array(z.object({ locale: z.string().min(1).max(32).optional(), call_to_actions: z.array(menuAction).min(1).max(5) }).strict()).min(1).optional(),
  clear: z.array(z.enum(CLEARABLE)).min(1).optional().describe('Remove ice_breakers and/or persistent_menu.')
};

interface ProfileParams {
  ice_breakers?: Array<{ question: string; payload: string }>;
  persistent_menu?: Array<{ locale: string; call_to_actions: Array<Record<string, unknown>> }>;
  clear: string[];
}

function profilePosts(base: string, p: ProfileParams): PlannedCall[] {
  const calls: PlannedCall[] = [];
  if (p.ice_breakers || p.persistent_menu) {
    const params: Record<string, string> = { platform: 'instagram' };
    if (p.ice_breakers) params.ice_breakers = JSON.stringify([{ call_to_actions: p.ice_breakers.map((q) => ({ question: q.question, payload: q.payload })), locale: 'default' }]);
    if (p.persistent_menu) params.persistent_menu = JSON.stringify(p.persistent_menu);
    calls.push({ method: 'POST', path: `/${base}/messenger_profile`, params });
  }
  if (p.clear.length) calls.push({ method: 'DELETE', path: `/${base}/messenger_profile`, params: { platform: 'instagram', fields: JSON.stringify(p.clear) } });
  return calls;
}

const preflightSetMessagingProfile = defineTool({
  name: 'instagram_preflight_set_messaging_profile',
  title: 'Preflight set messaging profile',
  description: 'Plan changes to the DM profile: ice breakers (max 4), persistent menu, and/or clearing either. Shows the current profile and returns an approval_id for instagram_approve.',
  inputSchema: profileInput,
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const bad = (message: string, path = ''): never => {
      throw new AppError('INVALID_INPUT', `Invalid input: ${message}`, { details: { issues: [{ path, message }] } });
    };
    const clear = [...new Set(input.clear ?? [])] as string[];
    if (!input.ice_breakers && !input.persistent_menu && clear.length === 0) bad('provide at least one of ice_breakers, persistent_menu or clear');
    for (const f of CLEARABLE) if (clear.includes(f) && input[f] !== undefined) bad(`${f} cannot be both set and cleared`, f);
    const menu = (input.persistent_menu ?? []).map((m, mi) => ({
      locale: m.locale ?? 'default',
      call_to_actions: m.call_to_actions.map((a, ai) => {
        const path = `persistent_menu.${mi}.call_to_actions.${ai}`;
        if (a.type === 'postback') {
          if (!a.payload) bad('postback requires payload', path);
          if (a.url) bad('postback must not have url', path);
          return { type: a.type, title: a.title, payload: a.payload! };
        }
        if (!a.url) bad('web_url requires url', path);
        if (a.payload) bad('web_url must not have payload', path);
        if (!/^https:\/\//i.test(a.url!)) bad('web_url url must be https', path);
        return { type: a.type, title: a.title, url: a.url! };
      })
    }));

    const account = ctx.account(input.account);
    await gatePreflight(ctx, account, 'set_messaging_profile');
    const graph = ctx.graph(account);
    const base = await dmBase(account, graph);
    const res = await withProbe(ctx, account, 'messaging', () =>
      graph.get<Rec>(`/${base}/messenger_profile`, { platform: 'instagram', fields: 'ice_breakers,persistent_menu' }));
    const current = dataOf(res)[0] ?? {};
    const params: ProfileParams = {
      ...(input.ice_breakers ? { ice_breakers: input.ice_breakers } : {}),
      ...(input.persistent_menu ? { persistent_menu: menu } : {}),
      clear
    };
    const preview = {
      current: { ice_breakers: current.ice_breakers ?? null, persistent_menu: current.persistent_menu ?? null },
      requested: { ice_breakers: input.ice_breakers ?? null, persistent_menu: input.persistent_menu ? menu : null },
      clear
    };
    const ticket = await createApproval(ctx, {
      account: account.alias, action: 'set_messaging_profile', target: base, params, preview, planned_calls: profilePosts(base, params), state_fingerprint: 'n/a'
    });
    return ok(ticket as unknown as Record<string, unknown>, `Approval ${ticket.approval_id} ready to update the messaging profile.`);
  }
});

export const tools: ToolDef[] = [listConversations, getConversation, preflightSendMessage, preflightSetMessagingProfile];

export function register(_ctx: AppContext): void {
  registerAction<SendParams>({
    name: 'send_message',
    capability: 'messaging',
    async execute(actx, params) {
      const graph = actx.graph();
      const base = await dmBase(actx.actionAccount, graph);
      const r = await withProbe(actx, actx.actionAccount, 'messaging', () => graph.post<Rec>(`/${base}/messages`, sendBody(params)));
      return { recipient_id: str(r.recipient_id), message_id: str(r.message_id) };
    }
  });

  registerAction<ProfileParams>({
    name: 'set_messaging_profile',
    capability: 'messaging',
    async execute(actx, params) {
      const graph = actx.graph();
      const base = await dmBase(actx.actionAccount, graph);
      const applied: string[] = [];
      const cleared: string[] = [];
      for (const call of profilePosts(base, params)) {
        const body = (call.params ?? {}) as Record<string, string>;
        await withProbe(actx, actx.actionAccount, 'messaging', () => (call.method === 'POST' ? graph.post(call.path, body) : graph.delete(call.path, body)));
        if (call.method === 'POST') applied.push(...(['ice_breakers', 'persistent_menu'] as const).filter((k) => params[k] !== undefined));
        else cleared.push(...params.clear);
      }
      return { applied, cleared };
    }
  });
}
