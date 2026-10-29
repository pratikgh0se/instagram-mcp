import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { requireCapability } from '../../graph/capabilities.js';
import { registerPublishActions, registerPublishJobs, localFingerprint } from '../../publish/actions.js';
import { plannedCalls } from '../../publish/plan.js';
import { checkQuota, preparePublish, type PublishInput } from '../../publish/prepare.js';
import { cancelJob, getJob, JOB_STATUSES, listJobs, type JobRow } from '../../publish/scheduler.js';
import { assertPolicyAllows, createApproval, type ApprovalTicket } from '../../safety/index.js';
import { accountParam, cursorParam, decodeCursor, encodeCursor, limitParam } from '../shared.js';
import { defineTool, LOCAL_DESTRUCTIVE, ok, READ_ONLY, READ_ONLY_LOCAL, type ToolDef } from '../types.js';

const idParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must match ^[A-Za-z0-9_-]{1,64}$');

/** Validation steps 2-5 of contract 1.11: account, policy, capability, token (no network). */
async function prologue(ctx: AppContext, alias: string | undefined, action: string, feature?: string) {
  const account = ctx.account(alias);
  assertPolicyAllows(ctx, { name: action });
  if (feature) requireCapability(ctx, account, feature);
  await ctx.auth.getAccessToken(account);
  return account;
}

function ticketData(t: ApprovalTicket): Record<string, unknown> {
  return t as unknown as Record<string, unknown>;
}

// ---------- instagram_preflight_publish ----------
const userTag = z.strictObject({
  username: z.string().min(1).max(64),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional()
});

const mediaItem = z.strictObject({
  url: z.string().min(1).max(4096).optional().describe('Public https URL of the media.'),
  path: z.string().min(1).max(4096).optional().describe('Local file path (needs the media host or, for video on the facebook path, resumable upload).'),
  type: z.enum(['image', 'video']).optional(),
  alt_text: z.string().max(1000).optional().describe('Images only (kind "image").'),
  user_tags: z.array(userTag).max(20).optional()
});

const preflightPublish = defineTool({
  name: 'instagram_preflight_publish',
  title: 'Preflight publish',
  description:
    'Validate and preview publishing an image, reel, story or carousel (public URLs or local files), optionally scheduled with publish_at. Checks media rules and the 24 h publishing quota, then returns an approval_id and the exact planned Graph calls. Nothing is posted until instagram_approve.',
  inputSchema: {
    account: accountParam,
    kind: z.enum(['image', 'reel', 'story', 'carousel']),
    media: z.array(mediaItem).min(1).max(20),
    caption: z.string().max(2200).optional(),
    location_id: z.string().min(1).max(64).optional(),
    collaborators: z.array(z.string().min(1).max(64)).max(3).optional(),
    user_tags: z.array(userTag).max(20).optional().describe('For image/reel/story; equals media[0].user_tags.'),
    cover: z.strictObject({ url: z.string().min(1).max(4096).optional(), path: z.string().min(1).max(4096).optional() }).optional().describe('Reel cover (JPEG, 8 MB max).'),
    thumb_offset_ms: z.number().int().min(0).optional(),
    share_to_feed: z.boolean().optional(),
    audio_name: z.string().min(1).max(200).optional(),
    trial_reel: z.strictObject({ graduation_strategy: z.enum(['MANUAL', 'SS_PERFORMANCE']) }).optional(),
    is_paid_partnership: z.boolean().optional(),
    branded_content_sponsor_ids: z.array(z.string().min(1).max(64)).max(2).optional(),
    is_ai_generated: z.boolean().optional(),
    publish_at: z.string().optional().describe('ISO 8601 instant later than now; schedules the post instead of publishing immediately.')
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = await prologue(ctx, input.account, 'publish', 'publish_url_media');
    const prepared = await preparePublish(ctx, account, input as PublishInput);
    const { params, warnings } = prepared;
    const graph = ctx.graph(account);
    const ig = await graph.igUserId();
    const quota = await checkQuota(graph, ig, warnings);
    const calls = plannedCalls(ig, params, account.login);

    const options: Record<string, unknown> = {};
    for (const key of ['location_id', 'collaborators', 'thumb_offset_ms', 'share_to_feed', 'audio_name', 'trial_reel', 'is_paid_partnership', 'branded_content_sponsor_ids', 'is_ai_generated'] as const) {
      if (params[key] !== undefined) options[key] = params[key];
    }
    if (params.cover) options.cover = { source: params.cover.source };
    params.media.forEach((m, i) => {
      if (m.user_tags) options[`media_${i + 1}_user_tags`] = m.user_tags;
      if (m.alt_text !== undefined) options[`media_${i + 1}_alt_text`] = m.alt_text;
    });
    const preview = {
      kind: params.kind,
      caption: params.caption ?? null,
      media: params.media.map((m, i) => ({
        index: i + 1,
        source: m.source,
        url: m.url,
        path: m.path,
        real_path: m.real_path ?? null,
        type: m.type,
        bytes: prepared.media[i]?.bytes ?? null,
        sha256: m.sha256,
        content_type: prepared.media[i]?.content_type ?? null
      })),
      cover: params.cover
        ? {
            source: params.cover.source,
            url: params.cover.url,
            path: params.cover.path,
            real_path: params.cover.real_path ?? null,
            bytes: params.cover.size,
            sha256: params.cover.sha256,
            content_type: params.cover.content_type ?? null
          }
        : null,
      scheduled: params.publish_at !== undefined,
      publish_at: params.publish_at ?? null,
      container_create_at: params.container_create_at ?? null,
      quota,
      options
    };
    const ticket = await createApproval(ctx, {
      account: account.alias,
      action: 'publish',
      params,
      preview,
      planned_calls: calls,
      warnings,
      state_fingerprint: await localFingerprint(params, false)
    });
    return ok(ticketData(ticket), `Publish ${params.kind}${params.publish_at ? ` scheduled for ${params.publish_at}` : ''} ready for approval (${ticket.approval_id}).`);
  }
});

// ---------- instagram_list_scheduled ----------
function jobView(j: JobRow): Record<string, unknown> {
  return {
    job_id: j.id,
    approval_id: j.approval_id,
    operation_id: j.operation_id,
    account: j.account,
    kind: j.kind,
    publish_at: j.publish_at,
    container_create_at: j.container_at,
    status: j.status,
    container_ids: [...j.state.children, ...(j.state.parent ? [j.state.parent] : [])],
    media_id: j.media_id,
    error: j.error,
    created_at: j.created_at,
    updated_at: j.updated_at
  };
}

const listScheduled = defineTool({
  name: 'instagram_list_scheduled',
  title: 'List scheduled posts',
  description: 'List scheduled publish jobs ordered by publish_at (earliest first). Filter by status and account. Local only.',
  inputSchema: { status: z.enum(JOB_STATUSES as [string, ...string[]]).optional(), account: accountParam, limit: limitParam, cursor: cursorParam },
  annotations: READ_ONLY_LOCAL,
  async handler(ctx, input) {
    const limit = input.limit ?? 25;
    const account = input.account ? ctx.account(input.account).alias : undefined;
    const after = decodeCursor<{ p: string; j: string }>(input.cursor);
    if (input.cursor && (!after || typeof after.p !== 'string' || typeof after.j !== 'string')) throw new AppError('INVALID_INPUT', 'Invalid cursor.');
    const rows = listJobs(ctx, { status: input.status, account, after: after ? { publish_at: after.p, id: after.j } : undefined, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next_cursor = rows.length > limit && last ? encodeCursor({ p: last.publish_at, j: last.id }) : null;
    return ok({ items: page.map(jobView), next_cursor }, `${page.length} scheduled job(s).`);
  }
});

// ---------- instagram_cancel_scheduled ----------
const cancelScheduled = defineTool({
  name: 'instagram_cancel_scheduled',
  title: 'Cancel scheduled post',
  description: 'Cancel a scheduled publish job that has not started (status "scheduled"). Deletes its staged media copies. Local only; no approval needed. Requires confirm: true.',
  inputSchema: { job_id: z.string().min(1).max(128), confirm: z.literal(true) },
  annotations: LOCAL_DESTRUCTIVE,
  async handler(ctx, input) {
    const job = getJob(ctx, input.job_id);
    if (!job) throw new AppError('NOT_FOUND', `No scheduled job with id ${input.job_id}.`);
    if (job.status !== 'scheduled') {
      throw new AppError('INVALID_INPUT', `Only jobs with status "scheduled" can be canceled (this one is "${job.status}").`, { details: { status: job.status } });
    }
    cancelJob(ctx, job);
    return ok({ job_id: job.id, status: 'canceled' }, `Scheduled job ${job.id} canceled.`);
  }
});

// ---------- instagram_preflight_delete_media ----------
interface MediaInfo {
  id?: string; caption?: string; permalink?: string; media_type?: string; media_product_type?: string; timestamp?: string;
  like_count?: number; comments_count?: number; is_comment_enabled?: boolean;
}

const preflightDeleteMedia = defineTool({
  name: 'instagram_preflight_delete_media',
  title: 'Preflight delete media',
  description: 'Preview deleting one of your own posts, reels or stories (a carousel is deleted as a whole). Returns an approval_id; the post is deleted only after instagram_approve. Not available on every login path.',
  inputSchema: { account: accountParam, media_id: idParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = await prologue(ctx, input.account, 'delete_media', 'delete_media');
    const graph = ctx.graph(account);
    const m = await graph.get<MediaInfo>(`/${input.media_id}`, { fields: 'id,caption,permalink,media_type,media_product_type,timestamp,like_count,comments_count' });
    const preview = {
      media_id: input.media_id, permalink: m.permalink ?? null, caption: m.caption ?? null, media_type: m.media_type ?? null,
      media_product_type: m.media_product_type ?? null, timestamp: m.timestamp ?? null, like_count: m.like_count ?? null, comments_count: m.comments_count ?? null
    };
    const ticket = await createApproval(ctx, {
      account: account.alias,
      action: 'delete_media',
      target: input.media_id,
      params: { media_id: input.media_id },
      preview,
      planned_calls: [
        { method: 'GET', path: `/${input.media_id}`, params: { fields: 'id,permalink' } },
        { method: 'DELETE', path: `/${input.media_id}`, params: {} }
      ],
      state_fingerprint: 'exists'
    });
    return ok(ticketData(ticket), `Delete of ${input.media_id} ready for approval (${ticket.approval_id}).`);
  }
});

// ---------- instagram_preflight_set_comments_enabled ----------
const preflightSetComments = defineTool({
  name: 'instagram_preflight_set_comments_enabled',
  title: 'Preflight comments toggle',
  description: 'Preview turning comments on or off for one of your posts. Returns an approval_id; applied only after instagram_approve.',
  inputSchema: { account: accountParam, media_id: idParam, enabled: z.boolean() },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = await prologue(ctx, input.account, 'set_comments_enabled');
    const graph = ctx.graph(account);
    const m = await graph.get<MediaInfo>(`/${input.media_id}`, { fields: 'id,permalink,is_comment_enabled,media_product_type' });
    const current = typeof m.is_comment_enabled === 'boolean' ? m.is_comment_enabled : null;
    const warnings = current === input.enabled ? [`ALREADY_IN_STATE: comments are already ${input.enabled ? 'enabled' : 'disabled'} on this media.`] : [];
    const ticket = await createApproval(ctx, {
      account: account.alias,
      action: 'set_comments_enabled',
      target: input.media_id,
      params: { media_id: input.media_id, enabled: input.enabled },
      preview: { media_id: input.media_id, permalink: m.permalink ?? null, current_comment_enabled: current, requested: input.enabled },
      planned_calls: [
        { method: 'GET', path: `/${input.media_id}`, params: { fields: 'id' } },
        { method: 'POST', path: `/${input.media_id}`, params: { comment_enabled: String(input.enabled) } }
      ],
      warnings,
      state_fingerprint: 'exists'
    });
    return ok(ticketData(ticket), `Comments ${input.enabled ? 'on' : 'off'} for ${input.media_id} ready for approval (${ticket.approval_id}).`);
  }
});

// ---------- instagram_get_publish_status ----------
const getPublishStatus = defineTool({
  name: 'instagram_get_publish_status',
  title: 'Get publish status',
  description: "Status of a media container (creation_id): FINISHED, IN_PROGRESS, ERROR, EXPIRED or PUBLISHED, with Meta's status text.",
  inputSchema: { account: accountParam, creation_id: idParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const res = await graph.get<{ status_code?: string; status?: string }>(`/${input.creation_id}`, { fields: 'status_code,status' });
    const data = { creation_id: input.creation_id, status_code: res.status_code ?? null, status: res.status ?? null };
    return ok(data, `Container ${input.creation_id}: ${data.status_code ?? 'unknown'}.`);
  }
});

export const tools: ToolDef[] = [preflightPublish, listScheduled, cancelScheduled, preflightDeleteMedia, preflightSetComments, getPublishStatus];

/** Register executable actions (publish, delete_media, set_comments_enabled) and jobs (scheduler, staging-cleanup). */
export function register(_ctx: AppContext): void {
  registerPublishActions();
  registerPublishJobs();
}
