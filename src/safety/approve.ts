import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import { AppError, isAppError, type ErrorCode } from '../errors.js';
import { requireCapability } from '../graph/capabilities.js';
import { errorMessage, redactDeep } from '../redact.js';
import type { ApprovalRow, OperationRow } from '../storage/index.js';
import { bindingHash, makeActionContext, type PlannedCall } from './approvals.js';
import { currentElicitor } from './elicit.js';
import { assertPolicyAllows } from './policy.js';
import { summarizeApproval } from './summary.js';
import { getAction } from './registry.js';

export interface ErrorObject {
  code: ErrorCode;
  message: string;
  action?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ApproveResult {
  approval_id: string;
  operation_id: string;
  action: string;
  status: 'succeeded' | 'failed' | 'unknown' | 'dry_run';
  result?: unknown;
  error?: ErrorObject;
  /** Batch actions (comment_actions): per-item outcomes. */
  items?: unknown[];
  planned_calls?: PlannedCall[];
  /** Present (true) when this call returned a previously stored outcome without executing. */
  replayed?: true;
}

export const newOperationId = (): string => `op_${randomBytes(16).toString('base64url')}`;

function itemsStatus(items: unknown[]): 'succeeded' | 'failed' | 'unknown' {
  if (items.length === 0) return 'succeeded';
  const statuses = items.map((i) => String((i as { status?: unknown })?.status ?? 'succeeded'));
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('failed')) return 'failed';
  return 'succeeded';
}

/** Build the public result from stored approval/outcome data. */
function resultFromStored(row: ApprovalRow, replayed: boolean): ApproveResult {
  const out = (row.outcome ?? {}) as Record<string, unknown>;
  const base: ApproveResult = {
    approval_id: row.approval_id, operation_id: row.operation_id ?? '', action: row.action,
    status: row.status as ApproveResult['status']
  };
  if (row.status === 'dry_run') base.planned_calls = (out.planned_calls as PlannedCall[]) ?? (row.planned_calls as PlannedCall[]);
  else if (out.error) {
    base.error = out.error as ErrorObject;
    const { items, error: _error, ...rest } = out;
    if (Array.isArray(items)) base.items = items;
    if (Object.keys(rest).length > 0) base.result = rest;
  } else {
    const { items, ...rest } = out;
    if (Array.isArray(items)) base.items = items;
    if (Object.keys(rest).length > 0 || !Array.isArray(items)) base.result = rest;
  }
  if (replayed) base.replayed = true;
  return base;
}

/** instagram_approve: execute a pending approval exactly once (spec 2.4, contract 1.13). */
export async function approveApproval(ctx: AppContext, approvalId: string): Promise<ApproveResult> {
  const store = ctx.storage;
  const row = store.approvals.get(approvalId);
  if (!row) {
    throw new AppError('APPROVAL_NOT_FOUND', `No approval with id ${approvalId}.`, { action: 'Run the matching instagram_preflight_* tool again.' });
  }
  if (['succeeded', 'failed', 'unknown', 'dry_run'].includes(row.status)) return resultFromStored(row, true);
  if (row.status === 'stale') {
    const e = (row.outcome as { error?: ErrorObject } | null)?.error;
    throw new AppError('STALE_PREVIEW', e?.message ?? 'The target changed since the preflight.', { action: e?.action });
  }
  if (row.status === 'running') {
    throw new AppError('APPROVAL_ALREADY_USED', 'This approval is already being executed.', {
      action: row.operation_id ? `Check progress with instagram_get_operation (id ${row.operation_id}).` : undefined
    });
  }
  if (row.status === 'expired' || row.expires_at <= ctx.clock.nowIso()) {
    store.approvals.markExpired(approvalId, ctx.clock.nowIso());
    throw new AppError('APPROVAL_EXPIRED', 'This approval has expired.', { action: 'Run the matching instagram_preflight_* tool again.' });
  }

  const spec = getAction(row.action);
  if (!spec) throw new AppError('INTERNAL', `No executor registered for action "${row.action}".`);
  assertPolicyAllows(ctx, spec);
  const account = ctx.account(row.account);
  if (spec.capability) requireCapability(ctx, account, spec.capability);
  if (row.params_hash !== bindingHash({ account: row.account, action: row.action, target: row.target, params: row.params })) {
    throw new AppError('INTERNAL', 'Approval parameters do not match their stored hash; refusing to execute.');
  }

  const dryRun = ctx.config.policy.dry_run;

  // Human confirmation (MCP elicitation) when the client supports it. Decline/cancel leaves the approval pending.
  const elicitor = currentElicitor();
  if (!dryRun && elicitor && ctx.config.policy.confirm_via_elicitation) {
    const message = `${summarizeApproval({ action: row.action, account: row.account, target: row.target, preview: row.preview })}\n\nApprove and execute this action?`;
    let decision: 'accept' | 'decline' | 'cancel' = 'decline';
    let failed = false;
    try {
      decision = await elicitor.ask(message);
    } catch {
      failed = true;
    }
    if (decision !== 'accept') {
      throw new AppError('POLICY_DENIED', failed ? 'The confirmation request to the user failed; nothing was executed.' : 'The user declined the confirmation; nothing was executed.', {
        action: 'Ask the user to confirm, then call instagram_approve again (the approval stays pending until it expires).',
        details: { reason: failed ? 'elicitation_failed' : 'declined_by_user' }
      });
    }
  }

  // Stale check first (read-only): a vanished/changed target never consumes the approval's write step.
  if (!dryRun && spec.recheck) {
    const actx = makeActionContext(ctx, row.account, approvalId, '');
    let stale: AppError | undefined;
    try {
      const current = await spec.recheck(actx, row.params);
      if (row.state_fingerprint && current !== row.state_fingerprint) {
        stale = new AppError('STALE_PREVIEW', 'The target changed since the preflight; nothing was sent.');
      }
    } catch (error) {
      if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'STALE_PREVIEW')) {
        stale = new AppError('STALE_PREVIEW', `The target no longer exists or changed since the preflight (${error.message}); nothing was sent.`);
      } else throw error;
    }
    if (stale) {
      const err = new AppError('STALE_PREVIEW', stale.message, { action: 'Run the matching instagram_preflight_* tool again to review the new state.' });
      store.approvals.markStale(approvalId, { error: err.toJSON() }, ctx.clock.nowIso());
      throw err;
    }
  }

  // Compare-and-set pending -> running: exactly one caller wins.
  const nowIso = ctx.clock.nowIso();
  if (!store.approvals.claim(approvalId, nowIso)) {
    const again = store.approvals.get(approvalId)!;
    if (['succeeded', 'failed', 'unknown', 'dry_run'].includes(again.status)) return resultFromStored(again, true);
    throw new AppError('APPROVAL_ALREADY_USED', 'This approval was already used.');
  }
  const operationId = newOperationId();
  store.operations.create({ operation_id: operationId, approval_id: approvalId, account: row.account, action: row.action, target: row.target, now: nowIso });
  store.approvals.setOperation(approvalId, operationId);

  if (dryRun) {
    const outcome = { planned_calls: row.planned_calls };
    finalize(ctx, row, operationId, 'dry_run', outcome, null);
    return resultFromStored(store.approvals.get(approvalId)!, false);
  }

  const actx = makeActionContext(ctx, row.account, approvalId, operationId);
  try {
    const raw = redactDeep((await spec.execute(actx, row.params)) ?? {});
    const items = Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items) : undefined;
    const status = items ? itemsStatus(items) : 'succeeded';
    if (status === 'succeeded') {
      finalize(ctx, row, operationId, 'succeeded', raw, null);
    } else {
      // Batch rule (contract D12): top-level error is the first item error of the deciding status.
      const first = (items ?? []).find((i) => (i as { status?: string }).status === status) as { error?: ErrorObject } | undefined;
      const fe = first?.error;
      const error = fe
        ? new AppError(fe.code, fe.message, { action: fe.action, retryable: fe.retryable, details: fe.details })
        : new AppError(status === 'unknown' ? 'OUTCOME_UNKNOWN' : 'UPSTREAM_REJECTED', status === 'unknown' ? 'Some items have an unknown outcome.' : 'Some items failed.', {
            details: status === 'unknown' ? { reconcile: { operation_id: operationId } } : undefined,
            action: status === 'unknown' ? `Call instagram_get_operation with id ${operationId}.` : undefined
          });
      finalize(ctx, row, operationId, status, { ...(raw as object), error: error.toJSON() }, error.code);
    }
    return resultFromStored(store.approvals.get(approvalId)!, false);
  } catch (error) {
    return recordFailure(ctx, row, operationId, error);
  }
}

function finalize(ctx: AppContext, row: ApprovalRow, operationId: string, status: 'succeeded' | 'failed' | 'unknown' | 'dry_run', outcome: unknown, errorCode: string | null): void {
  const now = ctx.clock.nowIso();
  ctx.storage.tx(() => {
    ctx.storage.approvals.finish(row.approval_id, status, outcome, errorCode, now);
    ctx.storage.operations.finish(operationId, status, outcome, errorCode, now);
  });
  ctx.storage.audit.add({
    ts: now, account: row.account, actor: ctx.mode === 'daemon' ? 'daemon' : 'mcp', action: row.action, target: row.target,
    approval_id: row.approval_id, operation_id: operationId, status, error_code: errorCode,
    summary: `${row.action} ${status}${row.target ? ` (${row.target})` : ''}`
  });
}

function recordFailure(ctx: AppContext, row: ApprovalRow, operationId: string, error: unknown): ApproveResult {
  let err: AppError = isAppError(error) ? error : new AppError('INTERNAL', `Unexpected error: ${errorMessage(error)}`);

  // A write whose network/5xx failure is ambiguous may have been applied: never report it as a plain failure.
  // Executors for non-publishing steps (e.g. container creation) can rethrow without `details.ambiguous`.
  if (err.code === 'UPSTREAM_TRANSIENT' && err.details?.ambiguous) {
    err = new AppError('OUTCOME_UNKNOWN', `The write may or may not have been applied (${err.message}).`, { details: { ...err.details } });
  }
  let status: 'failed' | 'unknown' = 'failed';
  if (err.code === 'OUTCOME_UNKNOWN') {
    status = 'unknown';
    const stored = ctx.storage.operations.get(operationId)?.reconcile ?? {};
    const reconcile = { ...stored, ...((err.details?.reconcile as Record<string, unknown> | undefined) ?? {}), operation_id: operationId };
    ctx.storage.operations.setReconcile(operationId, reconcile, ctx.clock.nowIso());
    err = new AppError('OUTCOME_UNKNOWN', err.message, {
      details: { ...(err.details ?? {}), reconcile },
      action: err.action ?? `Call instagram_get_operation with id ${operationId} to reconcile before retrying; do not re-run the preflight blindly.`
    });
  }
  const safe = new AppError(err.code, errorMessage(err), { action: err.action, retryable: err.retryable, details: redactDeep(err.details) });
  const errorObj = safe.toJSON();
  finalize(ctx, row, operationId, status, { error: errorObj }, safe.code);
  return { approval_id: row.approval_id, operation_id: operationId, action: row.action, status, error: errorObj };
}

export interface ReconcileOutcome {
  operation: OperationRow;
  reconciliation?: { checked_at: string; container_status: string | null; resolved: boolean };
}

/** Resolve an `unknown` operation through its action's reconcile hook. One attempt per call; safe to repeat. */
export async function reconcileOperation(ctx: AppContext, operation: OperationRow): Promise<ReconcileOutcome> {
  if (operation.status !== 'unknown') return { operation };
  const spec = getAction(operation.action);
  const approval = operation.approval_id ? ctx.storage.approvals.get(operation.approval_id) : undefined;
  if (!spec?.reconcile || !approval) return { operation };
  const checkedAt = ctx.clock.nowIso();
  try {
    const actx = makeActionContext(ctx, operation.account, approval.approval_id, operation.operation_id);
    const res = redactDeep(await spec.reconcile(actx, operation, approval.params));
    const containerStatus = res.container_status ?? null;
    if (res.status === 'unknown') return { operation, reconciliation: { checked_at: checkedAt, container_status: containerStatus, resolved: false } };
    const failure = new AppError('UPSTREAM_REJECTED', res.note ?? 'Reconciled: the operation did not happen.', { details: { container_status: containerStatus } });
    const outcome = res.status === 'succeeded' ? (res.result ?? {}) : { error: failure.toJSON() };
    const code = res.status === 'failed' ? 'UPSTREAM_REJECTED' : null;
    ctx.storage.tx(() => {
      ctx.storage.operations.finish(operation.operation_id, res.status as 'succeeded' | 'failed', outcome, code, checkedAt, { reconciled: true });
      ctx.storage.approvals.finish(approval.approval_id, res.status as 'succeeded' | 'failed', outcome, code, checkedAt);
    });
    ctx.storage.audit.add({
      ts: checkedAt, account: operation.account, action: operation.action, target: operation.target, approval_id: approval.approval_id,
      operation_id: operation.operation_id, status: `reconciled_${res.status}`, summary: res.note ?? `${operation.action} reconciled as ${res.status}`
    });
    return {
      operation: ctx.storage.operations.get(operation.operation_id) ?? operation,
      reconciliation: { checked_at: checkedAt, container_status: containerStatus, resolved: true }
    };
  } catch (error) {
    ctx.log.warn(`reconcile failed for ${operation.operation_id}: ${errorMessage(error)}`);
    return { operation, reconciliation: { checked_at: checkedAt, container_status: null, resolved: false } };
  }
}
