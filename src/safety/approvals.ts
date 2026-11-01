import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { requireCapability } from '../graph/capabilities.js';
import { redactDeep, redactExactDeep } from '../redact.js';
import { assertPolicyAllows, isDryRun } from './policy.js';
import { getAction, type ActionContext } from './registry.js';
import { summarizeApproval } from './summary.js';

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function bindingHash(input: { account: string; action: string; target?: string | null; params: unknown }): string {
  return sha256(canonicalJson({ account: input.account, action: input.action, target: input.target ?? null, params: input.params }));
}

export interface PlannedCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** Parameters WITHOUT any token. */
  params?: Record<string, unknown>;
  note?: string;
}

export interface CreateApprovalInput {
  account: string;
  action: string;
  target?: string | null;
  params: unknown;
  preview: unknown;
  planned_calls?: PlannedCall[];
  warnings?: string[];
  /** Skip the registered action's recheck() at preflight and use this fingerprint instead. */
  state_fingerprint?: string;
  ttl_seconds?: number;
}

export interface ApprovalTicket {
  approval_id: string;
  expires_at: string;
  action: string;
  account: string;
  preview: unknown;
  planned_calls: PlannedCall[];
  warnings: string[];
  /** Server-written plain-language summary of the preview (also the elicitation message at approve). */
  summary: string;
  dry_run: boolean;
}

/**
 * Preflight helper: applies policy + capability checks, snapshots target state, stores a pending approval bound to
 * sha256(canonical_json({account, action, target, params})) with a TTL, and returns the ticket a preflight tool returns.
 * The action must be registered (registerAction) so instagram_approve can execute it.
 */
export async function createApproval(ctx: AppContext, input: CreateApprovalInput): Promise<ApprovalTicket> {
  const spec = getAction(input.action);
  if (!spec) throw new AppError('INTERNAL', `No executor registered for action "${input.action}".`);
  assertPolicyAllows(ctx, spec);
  const account = ctx.account(input.account);
  if (spec.capability) requireCapability(ctx, account, spec.capability);

  const approvalId = `appr_${randomBytes(16).toString('base64url')}`;
  let fingerprint = input.state_fingerprint;
  if (fingerprint === undefined && spec.recheck) {
    fingerprint = await spec.recheck(makeActionContext(ctx, account.alias, approvalId, ''), input.params);
  }
  const now = ctx.clock.now();
  const ttl = input.ttl_seconds ?? ctx.config.policy.approval_ttl_seconds;
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  // Binding hash covers exactly the stored params representation (exact registered secrets removed; nothing else changed).
  const params = redactExactDeep(input.params);
  const preview = redactDeep(input.preview);
  const planned = redactDeep(input.planned_calls ?? []);
  const warnings = input.warnings ?? [];

  ctx.storage.approvals.insert({
    approval_id: approvalId,
    account: account.alias,
    action: input.action,
    target: input.target ?? null,
    params,
    params_hash: bindingHash({ account: account.alias, action: input.action, target: input.target, params }),
    preview,
    planned_calls: planned,
    warnings,
    state_fingerprint: fingerprint ?? null,
    created_at: now.toISOString(),
    expires_at: expiresAt
  });

  return {
    approval_id: approvalId,
    expires_at: expiresAt,
    action: input.action,
    account: account.alias,
    preview,
    planned_calls: planned,
    warnings,
    summary: summarizeApproval({ action: input.action, account: account.alias, target: input.target, preview }),
    dry_run: isDryRun(ctx)
  };
}

/** Build the context handed to an action's recheck/execute/reconcile. */
export function makeActionContext(ctx: AppContext, accountAlias: string, approvalId: string, operationId: string): ActionContext {
  const account = ctx.account(accountAlias);
  return Object.assign(Object.create(ctx) as AppContext, {
    actionAccount: account,
    graph: () => ctx.graph(account),
    approval_id: approvalId,
    operation_id: operationId,
    setReconcile: (data: Record<string, unknown>) => {
      if (operationId) ctx.storage.operations.setReconcile(operationId, data, ctx.clock.nowIso());
    },
    saveItems: (items: unknown[]) => {
      if (operationId) ctx.storage.operations.setItems(operationId, items);
    }
  }) as ActionContext;
}
