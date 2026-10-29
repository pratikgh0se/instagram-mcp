import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError, isAppError } from '../errors.js';
import { requireCapability, withProbe } from '../graph/capabilities.js';
import { redactDeep } from '../redact.js';
import { createApproval, type PlannedCall } from '../safety/approvals.js';
import { registerAction, type ActionContext } from '../safety/registry.js';
import { accountParam } from '../tools/shared.js';
import { defineTool, ok, READ_ONLY } from '../tools/types.js';
import { DAY_MS, dmBase, gatePreflight, ID_RE, isRecord, str, tsMs, withTarget } from './common.js';

const OPS = ['reply', 'comment', 'hide', 'unhide', 'delete', 'private_reply'] as const;
type Op = (typeof OPS)[number];

export interface BatchOp { op: Op; comment_id?: string; media_id?: string; message?: string }

const REQUIRED: Record<Op, { need: Array<'comment_id' | 'media_id' | 'message'>; allowed: string[] }> = {
  reply: { need: ['comment_id', 'message'], allowed: ['op', 'comment_id', 'message'] },
  comment: { need: ['media_id', 'message'], allowed: ['op', 'media_id', 'message'] },
  hide: { need: ['comment_id'], allowed: ['op', 'comment_id'] },
  unhide: { need: ['comment_id'], allowed: ['op', 'comment_id'] },
  delete: { need: ['comment_id'], allowed: ['op', 'comment_id'] },
  private_reply: { need: ['comment_id', 'message'], allowed: ['op', 'comment_id', 'message'] }
};

const opSchema = z.object({
  op: z.enum(OPS),
  comment_id: z.string().optional(),
  media_id: z.string().optional(),
  message: z.string().optional()
}).strict();

function validateOps(ops: BatchOp[]): void {
  const problems: Array<{ index: number; message: string }> = [];
  ops.forEach((o, index) => {
    const rule = REQUIRED[o.op];
    const issues: string[] = [];
    for (const f of rule.need) if (o[f] === undefined) issues.push(`${f} is required for ${o.op}`);
    for (const f of Object.keys(o)) if (!rule.allowed.includes(f)) issues.push(`${f} is not allowed for ${o.op}`);
    for (const f of ['comment_id', 'media_id'] as const) if (o[f] !== undefined && !ID_RE.test(o[f]!)) issues.push(`${f} must match ^[A-Za-z0-9_-]{1,64}$`);
    if (o.message !== undefined) {
      if (o.message.length < 1 || o.message.length > 2200) issues.push('message must be 1..2200 characters');
      else if (o.op === 'private_reply' && Buffer.byteLength(o.message, 'utf8') > 1000) issues.push('private_reply message must be at most 1000 bytes (UTF-8)');
    }
    if (issues.length) problems.push({ index, message: issues.join('; ') });
  });
  if (problems.length) {
    throw new AppError('INVALID_INPUT', `Invalid ops: ${problems.map((p) => `#${p.index}: ${p.message}`).join(' | ')}`, {
      details: { items: problems }, action: 'Fix the listed ops and call the tool again.'
    });
  }
}

function writeCall(o: BatchOp, base: string, igId: string): PlannedCall {
  switch (o.op) {
    case 'reply': return { method: 'POST', path: `/${o.comment_id}/replies`, params: { message: o.message } };
    case 'comment': return { method: 'POST', path: `/${o.media_id}/comments`, params: { message: o.message } };
    case 'hide': return { method: 'POST', path: `/${o.comment_id}`, params: { hide: 'true' } };
    case 'unhide': return { method: 'POST', path: `/${o.comment_id}`, params: { hide: 'false' } };
    case 'delete': return { method: 'DELETE', path: `/${o.comment_id}`, params: {} };
    case 'private_reply':
      void igId;
      return { method: 'POST', path: `/${base}/messages`, params: { recipient: JSON.stringify({ comment_id: o.comment_id }), message: JSON.stringify({ text: o.message }) } };
  }
}

const toErr = (e: unknown): AppError => (isAppError(e) ? e : new AppError('INTERNAL', 'Unexpected error while executing the item.'));

export function registerCommentActions(): void {
  registerAction<{ ops: BatchOp[] }>({
    name: 'comment_actions',
    async execute(actx: ActionContext, params) {
      const graph = actx.graph();
      const account = actx.actionAccount;
      const igId = await graph.igUserId();
      const items: Array<Record<string, unknown>> = [];
      for (let index = 0; index < params.ops.length; index++) {
        const o = params.ops[index]!;
        const item: Record<string, unknown> = { index, op: o.op };
        try {
          if (o.comment_id) {
            try {
              await graph.get(`/${o.comment_id}`, { fields: 'id,hidden' });
            } catch (e) {
              if (isAppError(e) && e.code === 'NOT_FOUND') {
                throw new AppError('STALE_PREVIEW', `Comment ${o.comment_id} no longer exists; nothing was sent for this item.`, {
                  action: 'Run instagram_preflight_comment_actions again.'
                });
              }
              throw e;
            }
          }
          const call = writeCall(o, o.op === 'private_reply' ? await dmBase(account, graph) : igId, igId);
          const send = async (): Promise<Record<string, unknown>> => {
            const body = (call.params ?? {}) as Record<string, string>;
            const r = call.method === 'DELETE' ? await graph.delete(call.path, body) : await graph.post(call.path, body);
            return isRecord(r) ? r : {};
          };
          item.result = redactDeep(o.op === 'private_reply' ? await withProbe(actx, account, 'messaging', send) : await send());
          item.status = 'succeeded';
        } catch (e) {
          const err = toErr(e);
          if (err.code === 'UPSTREAM_TRANSIENT' && err.details?.ambiguous) {
            const unk = new AppError('OUTCOME_UNKNOWN', `The write may or may not have been applied (${err.message}).`, {
              details: { reconcile: { operation_id: actx.operation_id, index } },
              action: `Check the comment in Instagram, or call instagram_get_operation with id ${actx.operation_id}, before retrying.`
            });
            item.status = 'unknown';
            item.error = redactDeep(unk.toJSON());
          } else {
            item.status = 'failed';
            item.error = redactDeep(err.toJSON());
          }
        }
        items.push(item);
      }
      const count = (s: string): number => items.filter((i) => i.status === s).length;
      return { items, total: items.length, succeeded: count('succeeded'), failed: count('failed'), unknown: count('unknown') };
    }
  });
}

export const preflightCommentActions = defineTool({
  name: 'instagram_preflight_comment_actions',
  title: 'Preflight comment actions',
  description:
    'Plan a batch (1..50) of comment operations: reply, comment, hide, unhide, delete, private_reply. Reads each target, returns a preview, the exact planned calls and an approval_id; nothing is written until instagram_approve. Per-item outcomes are reported on approve; one failing item never stops the batch. private_reply needs the messaging capability and a comment younger than 7 days.',
  inputSchema: { account: accountParam, ops: z.array(opSchema).min(1).max(50).describe('Operations, executed in order.') },
  annotations: READ_ONLY,
  async handler(ctx: AppContext, input) {
    const ops = input.ops as BatchOp[];
    validateOps(ops);
    const account = ctx.account(input.account);
    const hasPrivate = ops.some((o) => o.op === 'private_reply');
    await gatePreflight(ctx, account, 'comment_actions', hasPrivate ? ['messaging'] : []);
    if (hasPrivate) requireCapability(ctx, account, 'messaging');
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const base = hasPrivate ? await dmBase(account, graph) : igId;

    const commentIds: string[] = [];
    const mediaIds: string[] = [];
    for (const o of ops) {
      if (o.comment_id && !commentIds.includes(o.comment_id)) commentIds.push(o.comment_id);
      if (o.media_id && !mediaIds.includes(o.media_id)) mediaIds.push(o.media_id);
    }
    // `timestamp` is only requested when a private_reply needs the 7-day check.
    const commentFields = `id,text,username,hidden,parent_id,media{id}${hasPrivate ? ',timestamp' : ''}`;
    const comments = new Map<string, Record<string, unknown>>();
    for (const id of commentIds) {
      try {
        comments.set(id, await graph.get<Record<string, unknown>>(`/${id}`, { fields: commentFields }));
      } catch (e) { withTarget(e, { type: 'comment', id }); }
    }
    const medias = new Map<string, Record<string, unknown>>();
    for (const id of mediaIds) {
      try {
        medias.set(id, await graph.get<Record<string, unknown>>(`/${id}`, { fields: 'id,permalink,is_comment_enabled' }));
      } catch (e) { withTarget(e, { type: 'media', id }); }
    }

    const warnings: string[] = [];
    const expired: Array<{ index: number; message: string }> = [];
    ops.forEach((o, index) => {
      const c = o.comment_id ? comments.get(o.comment_id) : undefined;
      const hidden = c?.hidden === true;
      if (c && (o.op === 'reply' || o.op === 'private_reply') && hidden) warnings.push(`COMMENT_HIDDEN: comment ${o.comment_id} (op #${index}) is hidden.`);
      if (c && o.op === 'hide' && hidden) warnings.push(`ALREADY_IN_STATE: comment ${o.comment_id} (op #${index}) is already hidden.`);
      if (c && o.op === 'unhide' && !hidden) warnings.push(`ALREADY_IN_STATE: comment ${o.comment_id} (op #${index}) is already visible.`);
      if (o.op === 'comment' && medias.get(o.media_id!)?.is_comment_enabled === false) warnings.push(`COMMENTS_DISABLED: media ${o.media_id} (op #${index}) has comments turned off.`);
      if (o.op === 'private_reply' && c) {
        const t = tsMs(c.timestamp);
        if (!Number.isNaN(t) && ctx.clock.nowMs() - t > 7 * DAY_MS) expired.push({ index, message: `Comment ${o.comment_id} is older than 7 days; private replies are not allowed.` });
      }
    });
    if (expired.length) {
      throw new AppError('MESSAGING_WINDOW_CLOSED', `Private reply window (7 days) closed for ${expired.length} op(s).`, {
        details: { items: expired }, action: 'Private replies are only possible within 7 days of the comment. Use a public reply instead.'
      });
    }

    const planned: PlannedCall[] = [];
    ops.forEach((o) => {
      if (o.comment_id) planned.push({ method: 'GET', path: `/${o.comment_id}`, params: { fields: 'id,hidden' } });
      planned.push(writeCall(o, base, igId));
    });
    const preview = {
      total: ops.length,
      ops: ops.map((o, index) => {
        const c = o.comment_id ? comments.get(o.comment_id) : undefined;
        return {
          index, op: o.op, comment_id: o.comment_id ?? null, media_id: o.media_id ?? null, message: o.message ?? null,
          target: c ? { text: str(c.text), username: str(c.username), hidden: c.hidden === true } : null
        };
      })
    };
    const ticket = await createApproval(ctx, {
      account: account.alias, action: 'comment_actions', target: `batch:${ops.length}`, params: { ops }, preview,
      planned_calls: planned, warnings, state_fingerprint: 'n/a'
    });
    return ok(ticket as unknown as Record<string, unknown>, `Approval ${ticket.approval_id} ready for ${ops.length} comment op(s).`);
  }
});
