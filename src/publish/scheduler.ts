import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import { AppError, isAppError } from '../errors.js';
import { cleanupStaging, deleteStagedByOwner, refreshStagedExpiry, stageFile } from '../media-host/index.js';
import { errorMessage, redactDeep } from '../redact.js';
import { isShuttingDown, makeActionContext, newOperationId, startHeartbeat, trackInflight, type ErrorObject } from '../safety/index.js';
import { ensureContainers, isPollTimeout, publishContainer, resolveStaged, emptyState, type Runtime } from './execute.js';
import type { ContainerState, PublishParams, StagedTokens } from './types.js';

export type JobStatus = 'scheduled' | 'containers_created' | 'published' | 'missed' | 'failed' | 'unknown' | 'canceled';
export const JOB_STATUSES: readonly JobStatus[] = ['scheduled', 'containers_created', 'published', 'missed', 'failed', 'unknown', 'canceled'];

export interface JobRow {
  id: string;
  account: string;
  approval_id: string | null;
  operation_id: string | null;
  status: JobStatus;
  kind: string;
  publish_at: string;
  container_at: string;
  params: PublishParams;
  staged: StagedTokens;
  state: ContainerState;
  creation_id: string | null;
  media_id: string | null;
  permalink: string | null;
  error: ErrorObject | null;
  /** Per-job claim (CAS in scheduled_posts.data); wall-clock expiry. */
  claim_owner: string | null;
  claim_expires: string | null;
  /** Set right before media_publish is called; a job with this set is never published again. */
  publish_attempted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- storage over scheduled_posts ----------

function toJob(r: Record<string, unknown>): JobRow {
  const payload = JSON.parse(r.payload_json as string) as { params: PublishParams; staged: StagedTokens };
  const data = r.data ? (JSON.parse(r.data as string) as { error?: ErrorObject; claim_owner?: string; claim_expires?: string; publish_attempted_at?: string }) : {};
  return {
    id: r.id as string,
    account: r.account as string,
    approval_id: (r.approval_id as string | null) ?? null,
    operation_id: (r.operation_id as string | null) ?? null,
    status: r.status as JobStatus,
    kind: (r.kind as string) ?? payload.params.kind,
    publish_at: r.publish_at as string,
    container_at: (r.container_at as string | null) ?? (r.publish_at as string),
    params: payload.params,
    staged: payload.staged,
    state: r.creation_ids_json ? (JSON.parse(r.creation_ids_json as string) as ContainerState) : emptyState(),
    creation_id: (r.creation_id as string | null) ?? null,
    media_id: (r.media_id as string | null) ?? null,
    permalink: (r.permalink as string | null) ?? null,
    error: data.error ?? null,
    claim_owner: data.claim_owner ?? null,
    claim_expires: data.claim_expires ?? null,
    publish_attempted_at: data.publish_attempted_at ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string
  };
}

export function getJob(ctx: AppContext, id: string): JobRow | undefined {
  const r = ctx.storage.db.prepare('SELECT * FROM scheduled_posts WHERE id=?').get(id);
  return r ? toJob(r as Record<string, unknown>) : undefined;
}

export function getJobByOperation(ctx: AppContext, operationId: string): JobRow | undefined {
  const r = ctx.storage.db.prepare('SELECT * FROM scheduled_posts WHERE operation_id=?').get(operationId);
  return r ? toJob(r as Record<string, unknown>) : undefined;
}

export function listJobs(ctx: AppContext, f: { status?: string; account?: string; after?: { publish_at: string; id: string }; limit: number }): JobRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  if (f.account) { where.push('account = ?'); args.push(f.account); }
  if (f.after) { where.push('(publish_at > ? OR (publish_at = ? AND id > ?))'); args.push(f.after.publish_at, f.after.publish_at, f.after.id); }
  const sql = `SELECT * FROM scheduled_posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY publish_at ASC, id ASC LIMIT ?`;
  return ctx.storage.db.prepare(sql).all(...args, f.limit).map((r) => toJob(r as Record<string, unknown>));
}

interface JobPatch {
  status?: JobStatus;
  operation_id?: string;
  state?: ContainerState;
  media_id?: string | null;
  permalink?: string | null;
  error?: ErrorObject | null;
  attempts?: boolean;
}

export function updateJob(ctx: AppContext, id: string, patch: JobPatch): void {
  const sets: string[] = ['updated_at = ?'];
  const args: Array<string | number | null> = [ctx.clock.nowIso()];
  if (patch.status) { sets.push('status = ?'); args.push(patch.status); }
  if (patch.operation_id) { sets.push('operation_id = ?'); args.push(patch.operation_id); }
  if (patch.state) {
    sets.push('creation_ids_json = ?', 'creation_id = ?');
    args.push(JSON.stringify(patch.state), patch.state.parent ?? null);
  }
  if (patch.media_id !== undefined) { sets.push('media_id = ?'); args.push(patch.media_id); }
  if (patch.permalink !== undefined) { sets.push('permalink = ?'); args.push(patch.permalink); }
  if (patch.error !== undefined) {
    sets.push('error_code = ?', 'error_message = ?', "data = json_patch(coalesce(data,'{}'), ?)");
    args.push(patch.error?.code ?? null, patch.error?.message ?? null, JSON.stringify({ error: patch.error ? redactDeep(patch.error) : null }));
  }
  if (patch.attempts) sets.push('attempts = attempts + 1');
  ctx.storage.db.prepare(`UPDATE scheduled_posts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
}

/** Merge-patch the job's `data` JSON (null deletes a key). */
function patchData(ctx: AppContext, id: string, patch: Record<string, unknown>): void {
  ctx.storage.db.prepare("UPDATE scheduled_posts SET data = json_patch(coalesce(data,'{}'), ?) WHERE id = ?").run(JSON.stringify(patch), id);
}

// Claims use REAL wall time (like the daemon lease) so a frozen test clock cannot keep a dead claim alive.
const CLAIM_TTL_MS = 120_000;
const CLAIM_RENEW_MS = 20_000;
const wall = (ms = 0): string => new Date(Date.now() + ms).toISOString();

/** Compare-and-set claim: true only for the single caller that wins. */
export function claimJob(ctx: AppContext, id: string, owner: string): boolean {
  const r = ctx.storage.db
    .prepare(
      `UPDATE scheduled_posts SET data = json_patch(coalesce(data,'{}'), ?)
       WHERE id = ? AND status IN ('scheduled','containers_created')
         AND (json_extract(coalesce(data,'{}'), '$.claim_owner') IS NULL OR json_extract(coalesce(data,'{}'), '$.claim_expires') <= ?)`
    )
    .run(JSON.stringify({ claim_owner: owner, claim_expires: wall(CLAIM_TTL_MS) }), id, wall());
  return Number(r.changes) > 0;
}

function renewClaim(ctx: AppContext, id: string, owner: string): boolean {
  const r = ctx.storage.db
    .prepare("UPDATE scheduled_posts SET data = json_patch(coalesce(data,'{}'), ?) WHERE id = ? AND json_extract(coalesce(data,'{}'), '$.claim_owner') = ?")
    .run(JSON.stringify({ claim_expires: wall(CLAIM_TTL_MS) }), id, owner);
  return Number(r.changes) > 0;
}

function releaseClaim(ctx: AppContext, id: string, owner: string): void {
  try {
    ctx.storage.db
      .prepare("UPDATE scheduled_posts SET data = json_patch(coalesce(data,'{}'), ?) WHERE id = ? AND json_extract(coalesce(data,'{}'), '$.claim_owner') = ?")
      .run(JSON.stringify({ claim_owner: null, claim_expires: null }), id, owner);
  } catch { /* db closed */ }
}

export const newJobId = (): string => `sched_${randomBytes(16).toString('base64url')}`;

// ---------- scheduling (approve of a publish_at preflight) ----------

/** Stage stable copies of local files and insert the job row. No Graph request. */
export async function createScheduledJob(
  ctx: AppContext, accountAlias: string, approvalId: string, p: PublishParams
): Promise<{ scheduled: true; job_id: string; publish_at: string; container_create_at: string }> {
  try { cleanupStaging(ctx); } catch { /* opportunistic */ }
  const jobId = newJobId();
  const graceMs = ctx.config.scheduler.missed_grace_minutes * 60_000;
  const expiresAt = new Date(Date.parse(p.publish_at!) + graceMs + 24 * 3_600_000).toISOString();
  const staged: StagedTokens = { media: [], cover: null };
  try {
    for (const m of p.media) {
      if (m.source === 'local') {
        const s = await stageFile(ctx, { sourcePath: m.real_path ?? m.path!, contentType: m.content_type ?? 'application/octet-stream', account: accountAlias, ownerId: jobId, expiresAt, expectedSha256: m.sha256 ?? undefined });
        staged.media.push(s.token);
      } else staged.media.push(null);
    }
    if (p.cover?.source === 'local') {
      staged.cover = (await stageFile(ctx, { sourcePath: p.cover.real_path ?? p.cover.path!, contentType: 'image/jpeg', account: accountAlias, ownerId: jobId, expiresAt, expectedSha256: p.cover.sha256 ?? undefined })).token;
    }
  } catch (error) {
    deleteStagedByOwner(ctx, jobId);
    throw error;
  }
  const now = ctx.clock.nowIso();
  const containerAt = p.container_create_at ?? p.publish_at!;
  ctx.storage.db
    .prepare(
      `INSERT INTO scheduled_posts (id, account, approval_id, status, kind, publish_at, container_at, payload_json, creation_ids_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(jobId, accountAlias, approvalId, 'scheduled', p.kind, p.publish_at!, containerAt, JSON.stringify({ params: p, staged }), JSON.stringify(emptyState()), now, now);
  return { scheduled: true, job_id: jobId, publish_at: p.publish_at!, container_create_at: containerAt };
}

export function cancelJob(ctx: AppContext, job: JobRow): void {
  updateJob(ctx, job.id, { status: 'canceled' });
  deleteStagedByOwner(ctx, job.id);
}

// ---------- the scheduler pass ----------

export interface SchedulerJobResult {
  job_id: string;
  account: string;
  status_before: JobStatus;
  status_after: JobStatus;
  action: 'containers_created' | 'published' | 'missed' | 'failed' | 'unknown' | 'skipped';
  operation_id: string | null;
  error: { code: string; message: string } | null;
}

const allFinished = (job: JobRow): boolean =>
  Boolean(job.state.parent) && job.state.finished.includes(job.state.parent!) && job.state.children.every((c) => job.state.finished.includes(c));

function errorObject(error: unknown): ErrorObject {
  const app = isAppError(error) ? error : new AppError('INTERNAL', `Unexpected error: ${errorMessage(error)}`);
  return redactDeep(new AppError(app.code, errorMessage(app), { action: app.action, retryable: app.retryable, details: app.details }).toJSON());
}

function finishOperation(ctx: AppContext, job: JobRow, opId: string, status: 'succeeded' | 'failed' | 'unknown', outcome: unknown, code: string | null): void {
  const now = ctx.clock.nowIso();
  ctx.storage.operations.finish(opId, status, outcome, code, now);
  ctx.storage.audit.add({
    ts: now, account: job.account, actor: 'scheduler', action: 'publish', target: job.id, approval_id: job.approval_id, operation_id: opId,
    status, error_code: code, summary: `scheduled publish ${status} (${job.id})`
  });
}

async function reconcileAttempted(ctx: AppContext, job: JobRow, row: (s: JobStatus, a: SchedulerJobResult['action'], e?: ErrorObject | null) => SchedulerJobResult): Promise<SchedulerJobResult> {
  const creationId = job.state.parent ?? job.creation_id;
  const opId = job.operation_id ?? (() => {
    const id = newOperationId();
    ctx.storage.operations.create({ operation_id: id, approval_id: job.approval_id, account: job.account, action: 'publish', target: null, origin: 'scheduler', now: ctx.clock.nowIso() });
    updateJob(ctx, job.id, { operation_id: id });
    return id;
  })();
  const stopHeartbeat = startHeartbeat(ctx, opId);
  try {
    return await reconcileAttemptedInner(ctx, job, opId, creationId, row);
  } finally {
    stopHeartbeat();
  }
}

async function reconcileAttemptedInner(ctx: AppContext, job: JobRow, opId: string, creationId: string | null | undefined, row: (s: JobStatus, a: SchedulerJobResult['action'], e?: ErrorObject | null) => SchedulerJobResult): Promise<SchedulerJobResult> {
  let status: string | null = null;
  if (creationId) {
    try {
      const graph = ctx.graph(ctx.account(job.account));
      status = (await graph.get<{ status_code?: string }>(`/${creationId}`, { fields: 'status_code' })).status_code ?? null;
    } catch {
      return row(job.status, 'skipped'); // cannot tell right now; try again next pass, never re-publish
    }
  }
  if (status === 'PUBLISHED') {
    let mediaId: string | null = null;
    let permalink: string | null = null;
    try {
      const graph = ctx.graph(ctx.account(job.account));
      const ig = await graph.igUserId();
      const recent = await graph.get<{ data?: Array<{ id?: string; permalink?: string; timestamp?: string }> }>(`/${ig}/media`, { fields: 'id,permalink,timestamp', limit: 1 });
      const item = recent.data?.[0];
      if (item?.timestamp !== undefined && Date.parse(item.timestamp) >= Date.parse(job.publish_attempted_at!) - 120_000) {
        mediaId = item.id ?? null;
        permalink = item.permalink ?? null;
      }
    } catch { /* best effort */ }
    updateJob(ctx, job.id, { status: 'published', media_id: mediaId, permalink });
    finishOperation(ctx, job, opId, 'succeeded', { creation_id: creationId, media_id: mediaId, permalink, reconciled: true }, null);
    deleteStagedByOwner(ctx, job.id);
    return row('published', 'published');
  }
  const reconcile = { ...(ctx.storage.operations.get(opId)?.reconcile ?? {}), ...(creationId ? { creation_id: creationId } : {}), operation_id: opId };
  ctx.storage.operations.setReconcile(opId, reconcile, ctx.clock.nowIso());
  const obj = errorObject(new AppError('OUTCOME_UNKNOWN', 'A previous media_publish attempt for this job has no recorded result; the scheduler will not publish it again.', {
    details: { reconcile, container_status: status },
    action: `Call instagram_get_operation with id ${opId} to reconcile; the scheduler never retries this publish.`
  }));
  updateJob(ctx, job.id, { status: 'unknown', error: obj });
  finishOperation(ctx, job, opId, 'unknown', { error: obj }, 'OUTCOME_UNKNOWN');
  return row('unknown', 'unknown', obj);
}

async function processJob(ctx: AppContext, job: JobRow): Promise<SchedulerJobResult> {
  const before = job.status;
  const row = (status_after: JobStatus, action: SchedulerJobResult['action'], error?: ErrorObject | null): SchedulerJobResult => ({
    job_id: job.id, account: job.account, status_before: before, status_after, action,
    operation_id: getJob(ctx, job.id)?.operation_id ?? job.operation_id,
    error: error ? { code: error.code, message: error.message } : null
  });

  if (job.publish_attempted_at) return reconcileAttempted(ctx, job, row);

  const now = ctx.clock.nowMs();
  const publishAt = Date.parse(job.publish_at);
  const graceMs = ctx.config.scheduler.missed_grace_minutes * 60_000;

  if (now > publishAt + graceMs) {
    updateJob(ctx, job.id, { status: 'missed' });
    if (job.operation_id) {
      finishOperation(ctx, job, job.operation_id, 'failed', { error: { code: 'UPSTREAM_REJECTED', message: 'Scheduled publish missed its grace window; it was not posted late.', retryable: false } }, 'UPSTREAM_REJECTED');
    }
    deleteStagedByOwner(ctx, job.id);
    return row('missed', 'missed');
  }
  if (before === 'scheduled' && now < Date.parse(job.container_at)) return row(before, 'skipped');
  if (before === 'containers_created' && allFinished(job) && now < publishAt) return row(before, 'skipped');

  let opId = job.operation_id;
  if (!opId) {
    opId = newOperationId();
    ctx.storage.operations.create({ operation_id: opId, approval_id: job.approval_id, account: job.account, action: 'publish', target: null, origin: 'scheduler', now: ctx.clock.nowIso() });
    updateJob(ctx, job.id, { operation_id: opId });
  }
  updateJob(ctx, job.id, { attempts: true });
  const operationId = opId;
  const stopHeartbeat = startHeartbeat(ctx, operationId);

  try {
    const actx = makeActionContext(ctx, job.account, job.approval_id ?? '', operationId);
    const graph = ctx.graph(actx.actionAccount);
    const rt: Runtime = { ctx, account: actx.actionAccount, graph, ig: await graph.igUserId() };
    const hooks = {
      persist: (s: ContainerState) => updateJob(ctx, job.id, { state: s }),
      setReconcile: (d: Record<string, unknown>) => actx.setReconcile(d)
    };
    const state = job.state;
    if (!state.parent) {
      if (before === 'scheduled') refreshStagedExpiry(ctx, [...job.staged.media, job.staged.cover].filter((t): t is string => Boolean(t)));
      const resolved = await resolveStaged(rt, job.params, job.staged);
      try {
        await ensureContainers(rt, job.params, resolved, state, hooks);
      } catch (error) {
        if (!isPollTimeout(error)) throw error;
        updateJob(ctx, job.id, { status: 'containers_created', state });
        return row('containers_created', 'containers_created');
      }
    } else {
      try {
        await ensureContainers(rt, job.params, { urls: [], files: [], cover: undefined }, state, hooks);
      } catch (error) {
        if (!isPollTimeout(error)) throw error;
        return row('containers_created', 'containers_created');
      }
    }
    updateJob(ctx, job.id, { status: 'containers_created', state });
    if (now < publishAt) return row('containers_created', 'containers_created');

    // Persist the attempt BEFORE the risky call: a crash after this point is reconciled, never re-published.
    patchData(ctx, job.id, { publish_attempted_at: wall() });
    const result = await publishContainer(rt, job.params, state, hooks);
    updateJob(ctx, job.id, { status: 'published', media_id: result.media_id, permalink: result.permalink });
    finishOperation(ctx, job, operationId, 'succeeded', result, null);
    deleteStagedByOwner(ctx, job.id);
    return row('published', 'published');
  } catch (error) {
    let err = isAppError(error) ? error : new AppError('INTERNAL', `Unexpected error: ${errorMessage(error)}`);
    if (err.code === 'UPSTREAM_TRANSIENT' && err.details?.ambiguous) err = new AppError('OUTCOME_UNKNOWN', err.message, { details: err.details });
    if (err.code === 'OUTCOME_UNKNOWN') {
      const stored = ctx.storage.operations.get(operationId)?.reconcile ?? {};
      const reconcile = { ...stored, ...((err.details?.reconcile as Record<string, unknown> | undefined) ?? {}), operation_id: operationId };
      ctx.storage.operations.setReconcile(operationId, reconcile, ctx.clock.nowIso());
      const obj = errorObject(new AppError('OUTCOME_UNKNOWN', err.message, {
        details: { ...(err.details ?? {}), reconcile },
        action: `Call instagram_get_operation with id ${operationId} to reconcile; the scheduler never retries this publish.`
      }));
      updateJob(ctx, job.id, { status: 'unknown', error: obj });
      finishOperation(ctx, job, operationId, 'unknown', { error: obj }, 'OUTCOME_UNKNOWN');
      return row('unknown', 'unknown', obj);
    }
    const obj = errorObject(err);
    updateJob(ctx, job.id, { status: 'failed', error: obj });
    finishOperation(ctx, job, operationId, 'failed', { error: obj }, obj.code);
    deleteStagedByOwner(ctx, job.id);
    return row('failed', 'failed', obj);
  } finally {
    stopHeartbeat();
  }
}

let running = false;

/** One full scheduler pass over jobs in status scheduled/containers_created, `publish_at` ascending. */
export function runSchedulerOnce(ctx: AppContext): Promise<{ now: string; jobs: SchedulerJobResult[] }> {
  // Tracked so a shutdown drain waits for the pass (contract 1.13.10).
  return trackInflight(schedulerPass(ctx));
}

async function schedulerPass(ctx: AppContext): Promise<{ now: string; jobs: SchedulerJobResult[] }> {
  const now = ctx.clock.nowIso();
  if (running || isShuttingDown()) return { now, jobs: [] };
  running = true;
  try {
    const due = ctx.storage.db
      .prepare(`SELECT * FROM scheduled_posts WHERE status IN ('scheduled','containers_created') ORDER BY publish_at ASC, id ASC`)
      .all()
      .map((r) => toJob(r as Record<string, unknown>));
    const jobs: SchedulerJobResult[] = [];
    const owner = `${process.pid}:${randomBytes(8).toString('hex')}`;
    for (const listed of due) {
      if (isShuttingDown()) break;
      const skip = (): SchedulerJobResult => ({
        job_id: listed.id, account: listed.account, status_before: listed.status, status_after: listed.status, action: 'skipped', operation_id: listed.operation_id, error: null
      });
      if (!claimJob(ctx, listed.id, owner)) {
        jobs.push(skip());
        continue;
      }
      const timer = setInterval(() => { renewClaim(ctx, listed.id, owner); }, CLAIM_RENEW_MS);
      timer.unref();
      const job = getJob(ctx, listed.id) ?? listed;
      try {
        if (job.status !== 'scheduled' && job.status !== 'containers_created') {
          jobs.push(skip());
          continue;
        }
        jobs.push(await processJob(ctx, job));
      } catch (error) {
        ctx.log.error(`scheduler: job ${job.id} crashed: ${errorMessage(error)}`);
        jobs.push({
          job_id: job.id, account: job.account, status_before: job.status, status_after: job.status, action: 'skipped', operation_id: job.operation_id,
          error: { code: 'INTERNAL', message: errorMessage(error) }
        });
      } finally {
        clearInterval(timer);
        releaseClaim(ctx, listed.id, owner);
      }
    }
    return { now, jobs };
  } finally {
    running = false;
  }
}
