import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { withProbe } from '../graph/capabilities.js';
import { cleanupStaging } from '../media-host/index.js';
import { registerAction, registerJob, type ActionContext } from '../safety/index.js';
import { publishNow, type Runtime } from './execute.js';
import { openNoFollow, recheckLocalMedia } from './localmedia.js';
import { createScheduledJob, getJobByOperation, runSchedulerOnce, updateJob } from './scheduler.js';
import type { PublishParams } from './types.js';

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of openNoFollow(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function localFiles(p: PublishParams): Array<{ path: string; real: string; size: number | null; sha256: string | null }> {
  const files = p.media.filter((m) => m.source === 'local').map((m) => ({ path: m.path!, real: m.real_path ?? m.path!, size: m.size, sha256: m.sha256 }));
  if (p.cover?.source === 'local') files.push({ path: p.cover.path!, real: p.cover.real_path ?? p.cover.path!, size: p.cover.size, sha256: p.cover.sha256 });
  return files;
}

/** Fingerprint of the local files as they are now ("none" without local files). Missing file -> STALE_PREVIEW. */
export async function localFingerprint(p: PublishParams, current = true, ctx?: AppContext): Promise<string> {
  const files = localFiles(p);
  if (files.length === 0) return 'none';
  const parts: string[] = [];
  for (const f of files) {
    if (!current) {
      parts.push(`${f.size}:${f.sha256}`);
      continue;
    }
    try {
      if (ctx) await recheckLocalMedia(ctx, f.path, f.real);
      const st = await fsp.stat(f.real);
      parts.push(`${st.size}:${await sha256File(f.real)}`);
    } catch (error) {
      if (error instanceof AppError && error.code === 'STALE_PREVIEW') throw error;
      throw new AppError('STALE_PREVIEW', `A local media file is missing, unreadable, moved or no longer inside an allowed media directory (${f.path}); nothing was sent.`, { action: 'Run instagram_preflight_publish again.' });
    }
  }
  return `local:${parts.join(',')}`;
}

const runtime = async (actx: ActionContext): Promise<Runtime> => {
  const graph = actx.graph();
  return { ctx: actx, account: actx.actionAccount, graph, ig: await graph.igUserId() };
};

export function registerPublishActions(): void {
  registerAction<PublishParams>({
    name: 'publish',
    capability: 'publish_url_media',
    recheck: (actx, params) => localFingerprint(params, true, actx),
    async execute(actx, params) {
      if (params.publish_at) return createScheduledJob(actx, actx.actionAccount.alias, actx.approval_id, params);
      const rt = await runtime(actx);
      return publishNow(rt, params, actx.approval_id, { persist: () => undefined, setReconcile: (d) => actx.setReconcile(d) });
    },
    async reconcile(actx, operation) {
      const creationId = operation.reconcile?.creation_id;
      if (typeof creationId !== 'string') return { status: 'unknown', container_status: null };
      const graph = actx.graph();
      const ig = await graph.igUserId();
      const { status_code } = await graph.get<{ status_code?: string }>(`/${creationId}`, { fields: 'status_code' });
      const settleJob = (patch: Parameters<typeof updateJob>[2]): void => {
        const job = getJobByOperation(actx, operation.operation_id);
        if (job) updateJob(actx, job.id, patch);
      };
      if (status_code === 'PUBLISHED') {
        const recent = await graph.get<{ data?: Array<{ id?: string; permalink?: string; timestamp?: string }> }>(`/${ig}/media`, { fields: 'id,permalink,timestamp', limit: 1 });
        const item = recent.data?.[0];
        const startedMs = Date.parse(operation.created_at) - 120_000;
        const matches = item?.timestamp !== undefined && Date.parse(item.timestamp) >= startedMs;
        const result = { creation_id: creationId, media_id: matches ? (item?.id ?? null) : null, permalink: matches ? (item?.permalink ?? null) : null, reconciled: true };
        settleJob({ status: 'published', media_id: result.media_id, permalink: result.permalink });
        return { status: 'succeeded', result, container_status: status_code };
      }
      if (status_code === 'ERROR' || status_code === 'EXPIRED') {
        const error = { code: 'UPSTREAM_REJECTED', message: `Reconciled: the container is ${status_code}; nothing was published.`, retryable: false, details: { container_status: status_code } } as const;
        settleJob({ status: 'failed', error });
        return { status: 'failed', note: error.message, container_status: status_code };
      }
      return { status: 'unknown', container_status: status_code ?? null };
    }
  });

  registerAction<{ media_id: string }>({
    name: 'delete_media',
    capability: 'delete_media',
    async recheck(actx, params) {
      await actx.graph().get(`/${params.media_id}`, { fields: 'id,permalink' });
      return 'exists';
    },
    async execute(actx, params) {
      await withProbe(actx, actx.actionAccount, 'delete_media', () => actx.graph().delete(`/${params.media_id}`));
      return { media_id: params.media_id, deleted: true };
    }
  });

  registerAction<{ media_id: string; enabled: boolean }>({
    name: 'set_comments_enabled',
    async recheck(actx, params) {
      await actx.graph().get(`/${params.media_id}`, { fields: 'id' });
      return 'exists';
    },
    async execute(actx, params) {
      await actx.graph().post(`/${params.media_id}`, { comment_enabled: params.enabled });
      return { media_id: params.media_id, comment_enabled: params.enabled };
    }
  });
}

export function registerPublishJobs(): void {
  registerJob({ name: 'scheduler', intervalMs: 30_000, run: (ctx: AppContext) => runSchedulerOnce(ctx) });
  registerJob({
    name: 'staging-cleanup',
    intervalMs: 10 * 60_000,
    run: async (ctx: AppContext) => {
      cleanupStaging(ctx);
    }
  });
}
