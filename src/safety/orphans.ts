import type { AppContext } from '../context.js';
import { heartbeatMs, orphanAfterMs } from '../config/index.js';
import { AppError } from '../errors.js';
import type { OperationRow } from '../storage/index.js';

/** Orphaned-operation handling (contract 1.13.9). All timestamps here are real wall-clock time, never the test clock. */

/**
 * Refresh the heartbeat of `operationId` now and then every INSTAGRAM_MCP_HEARTBEAT_MS until the returned stop() is called.
 */
export function startHeartbeat(ctx: AppContext, operationId: string): () => void {
  const beat = (): void => {
    try { ctx.storage.operations.heartbeat(operationId); } catch { /* db closed during shutdown */ }
  };
  beat();
  const timer = setInterval(beat, heartbeatMs());
  timer.unref();
  return () => clearInterval(timer);
}

const ORPHAN_MESSAGE = 'The process running this operation stopped before it finished.';

interface JobClaim { id: string; status: string; claim_owner?: string | null; claim_expires?: string | null }

function linkedJob(ctx: AppContext, operationId: string): JobClaim | undefined {
  const r = ctx.storage.db
    .prepare(`SELECT id, status, json_extract(coalesce(data,'{}'), '$.claim_owner') AS claim_owner, json_extract(coalesce(data,'{}'), '$.claim_expires') AS claim_expires FROM scheduled_posts WHERE operation_id=?`)
    .get(operationId) as JobClaim | undefined;
  return r ?? undefined;
}

/**
 * Scheduler operations stay `running` between passes (the job waits for its container or publish time), so a stale heartbeat
 * alone proves nothing: such an operation is orphaned only when its job still carries an expired claim (a pass died mid-job).
 */
function schedulerOpIsDead(ctx: AppContext, op: OperationRow): boolean {
  const job = linkedJob(ctx, op.operation_id);
  if (!job) return true;
  if (job.status !== 'scheduled' && job.status !== 'containers_created') return true;
  return Boolean(job.claim_owner) && typeof job.claim_expires === 'string' && job.claim_expires <= new Date().toISOString();
}

/** Container id (single media, or the carousel parent) a scheduler job recorded before its operation was orphaned. */
function jobCreationId(ctx: AppContext, operationId: string): string | undefined {
  const r = ctx.storage.db
    .prepare(`SELECT creation_id, json_extract(coalesce(creation_ids_json,'{}'), '$.parent') AS parent FROM scheduled_posts WHERE operation_id=?`)
    .get(operationId) as { creation_id?: string | null; parent?: string | null } | undefined;
  const id = r?.parent || r?.creation_id;
  return typeof id === 'string' && id ? id : undefined;
}

function buildOutcome(ctx: AppContext, op: OperationRow, approvalParams: unknown): { outcome: Record<string, unknown>; error: ReturnType<AppError['toJSON']> } {
  const stored = op.reconcile ?? {};
  const creationId = typeof stored.creation_id === 'string'
    ? stored.creation_id
    : op.origin === 'scheduler' && op.action === 'publish' ? jobCreationId(ctx, op.operation_id) : undefined;
  const reconcile: Record<string, unknown> = { ...stored, operation_id: op.operation_id, ...(creationId ? { creation_id: creationId } : {}) };
  let action = `Call instagram_get_operation with id ${op.operation_id} to check what happened before retrying.`;
  if (op.action === 'publish' && !creationId) action += ' No container id was recorded: also check instagram_list_media for the post before publishing again.';
  const error = new AppError('OUTCOME_UNKNOWN', ORPHAN_MESSAGE, { retryable: false, action, details: { reconcile } }).toJSON();
  const outcome: Record<string, unknown> = { error };
  const saved = op.data?.items;
  const ops = (approvalParams as { ops?: unknown[] } | null)?.ops;
  if (Array.isArray(saved) && Array.isArray(ops)) {
    // Batch: finished items keep their stored results; unfinished items become unknown.
    const items = [...saved];
    for (let index = saved.length; index < ops.length; index++) {
      items.push({
        index, op: (ops[index] as { op?: string } | undefined)?.op, status: 'unknown',
        error: new AppError('OUTCOME_UNKNOWN', ORPHAN_MESSAGE, { retryable: false, action, details: { reconcile: { operation_id: op.operation_id, index } } }).toJSON()
      });
    }
    outcome.items = items;
    outcome.total = items.length;
  }
  return { outcome, error };
}

/**
 * Mark every orphaned `running` operation (or only the one of `onlyApprovalId`) as `unknown`. Zero Graph requests.
 * Each transition is a compare-and-set on status + stale heartbeat, so a live process that refreshed in time is never touched.
 * Returns the number of operations transitioned.
 */
export function sweepOrphans(ctx: AppContext, onlyApprovalId?: string): number {
  const store = ctx.storage;
  const cutoff = Date.now() - orphanAfterMs();
  let count = 0;
  for (const op of store.operations.running()) {
    if (onlyApprovalId && op.approval_id !== onlyApprovalId) continue;
    const last = Date.parse(op.heartbeat_at ?? op.created_at);
    if (Number.isFinite(last) && last > cutoff) continue;
    if (op.origin === 'scheduler' && !schedulerOpIsDead(ctx, op)) continue;
    const approval = op.approval_id ? store.approvals.get(op.approval_id) : undefined;
    const { outcome, error } = buildOutcome(ctx, op, approval?.params);
    const now = ctx.clock.nowIso();
    const moved = store.tx(() => {
      if (!store.operations.markOrphaned(op.operation_id, op.heartbeat_at, outcome, 'OUTCOME_UNKNOWN', now)) return false;
      store.operations.setReconcile(op.operation_id, (error.details as { reconcile: Record<string, unknown> }).reconcile, now);
      if (op.origin === 'scheduler') {
        const job = linkedJob(ctx, op.operation_id);
        if (job && (job.status === 'scheduled' || job.status === 'containers_created')) {
          store.db
            .prepare("UPDATE scheduled_posts SET status='unknown', error_code=?, error_message=?, updated_at=?, data=json_patch(coalesce(data,'{}'), ?) WHERE id=?")
            .run('OUTCOME_UNKNOWN', ORPHAN_MESSAGE, now, JSON.stringify({ error, claim_owner: null, claim_expires: null }), job.id);
        }
      } else if (op.approval_id) {
        store.approvals.markOrphaned(op.approval_id, outcome, 'OUTCOME_UNKNOWN', now);
      }
      store.audit.add({
        ts: now, account: op.account, actor: ctx.mode === 'daemon' ? 'daemon' : 'mcp', action: op.action, target: op.target,
        approval_id: op.approval_id, operation_id: op.operation_id, status: 'unknown', error_code: 'OUTCOME_UNKNOWN',
        summary: `${op.action} orphaned: the executing process stopped`
      });
      return true;
    });
    if (moved) count++;
  }
  return count;
}
