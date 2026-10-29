import type { AppContext } from '../context.js';
import type { ResolvedAccount } from '../config/index.js';
import type { GraphClient } from '../graph/client.js';
import type { OperationRow } from '../storage/index.js';

/** Context passed to an action's recheck/execute/reconcile. */
export interface ActionContext extends AppContext {
  actionAccount: ResolvedAccount;
  /** Graph client for the approval's account. */
  graph(): GraphClient;
  approval_id: string;
  operation_id: string;
  /** Persist reconciliation hints (e.g. { creation_id }) as soon as they exist, before the risky call. */
  setReconcile(data: Record<string, unknown>): void;
}

export interface ActionSpec<P = any> {
  /** Action name used in approvals/operations, e.g. "publish", "delete_media". */
  name: string;
  /** Key matched against config policy.disabled_actions (defaults to name). */
  policyKey?: string;
  /** Capability feature required (see graph/capabilities.ts); checked at preflight and approve. */
  capability?: string;
  /** Return a fingerprint of the target's current state; approve returns STALE_PREVIEW if it changed since preflight. */
  recheck?(ctx: ActionContext, params: P): Promise<string | undefined>;
  /** Perform the write. Return the result; return { items: [...] } for batches. Throw AppError OUTCOME_UNKNOWN when ambiguous. */
  execute(ctx: ActionContext, params: P): Promise<unknown>;
  /** Resolve an `unknown` operation by asking Meta what actually happened. */
  reconcile?(ctx: ActionContext, operation: OperationRow, params: P): Promise<ReconcileResult>;
}

export interface ReconcileResult {
  status: 'succeeded' | 'failed' | 'unknown';
  result?: unknown;
  note?: string;
  /** Upstream container status observed during reconciliation (reported by instagram_get_operation). */
  container_status?: string | null;
}

const actions = new Map<string, ActionSpec>();

/** Register (or replace) an executable action. Domains call this from their `register(ctx)` hook. */
export function registerAction<P = any>(spec: ActionSpec<P>): void {
  actions.set(spec.name, spec as ActionSpec);
}

export function getAction(name: string): ActionSpec | undefined {
  return actions.get(name);
}

export function listActions(): ActionSpec[] {
  return [...actions.values()];
}

// ---- background jobs (run by the daemon, a later unit) ----
export interface JobSpec {
  name: string;
  intervalMs: number;
  run(ctx: AppContext): Promise<void>;
}

const jobs = new Map<string, JobSpec>();

export function registerJob(spec: JobSpec): void {
  jobs.set(spec.name, spec);
}

export function listJobs(): JobSpec[] {
  return [...jobs.values()];
}
