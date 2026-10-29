import type { Db } from './db.js';
import { redact, redactDeep } from '../redact.js';

type SqlValue = string | number | null;
const n = (v: unknown): SqlValue => (v === undefined || v === null ? null : (v as SqlValue));
const j = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(redactDeep(v)));
const p = <T = unknown>(s: unknown): T | null => (typeof s === 'string' ? (JSON.parse(s) as T) : null);

// ---------- approvals ----------
export type ApprovalStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'dry_run' | 'expired' | 'stale';

export interface ApprovalRow {
  approval_id: string;
  account: string;
  action: string;
  target: string | null;
  params: unknown;
  params_hash: string;
  preview: unknown;
  planned_calls: unknown[];
  warnings: string[];
  state_fingerprint: string | null;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  finished_at: string | null;
  operation_id: string | null;
  outcome: unknown;
  error_code: string | null;
}

function toApproval(r: Record<string, unknown>): ApprovalRow {
  return {
    approval_id: r.approval_id as string,
    account: r.account as string,
    action: r.action as string,
    target: (r.target as string | null) ?? null,
    params: p(r.params_json),
    params_hash: r.params_hash as string,
    preview: p(r.preview_json),
    planned_calls: p<unknown[]>(r.planned_calls_json) ?? [],
    warnings: p<string[]>(r.warnings_json) ?? [],
    state_fingerprint: (r.state_fingerprint as string | null) ?? null,
    status: r.status as ApprovalStatus,
    created_at: r.created_at as string,
    expires_at: r.expires_at as string,
    started_at: (r.started_at as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null,
    operation_id: (r.operation_id as string | null) ?? null,
    outcome: p(r.outcome_json),
    error_code: (r.error_code as string | null) ?? null
  };
}

export class ApprovalsRepo {
  constructor(private readonly db: Db) {}

  insert(a: {
    approval_id: string; account: string; action: string; target?: string | null; params: unknown; params_hash: string;
    preview?: unknown; planned_calls?: unknown[]; warnings?: string[]; state_fingerprint?: string | null;
    created_at: string; expires_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO approvals (approval_id, account, action, target, params_json, params_hash, preview_json, planned_calls_json,
           warnings_json, state_fingerprint, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
      )
      .run(a.approval_id, a.account, a.action, n(a.target), j(a.params) ?? 'null', a.params_hash, j(a.preview), j(a.planned_calls ?? []),
        j(a.warnings ?? []), n(a.state_fingerprint), a.created_at, a.expires_at);
  }

  get(id: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE approval_id = ?').get(id);
    return r ? toApproval(r as Record<string, unknown>) : undefined;
  }

  /** Compare-and-set pending -> running. Returns true only for the single winner. */
  claim(id: string, now: string): boolean {
    const res = this.db
      .prepare(`UPDATE approvals SET status='running', started_at=? WHERE approval_id=? AND status='pending' AND expires_at > ?`)
      .run(now, id, now);
    return Number(res.changes) === 1;
  }

  markExpired(id: string, now: string): void {
    this.db.prepare(`UPDATE approvals SET status='expired', finished_at=? WHERE approval_id=? AND status='pending'`).run(now, id);
  }

  setOperation(id: string, operationId: string): void {
    this.db.prepare('UPDATE approvals SET operation_id=? WHERE approval_id=?').run(operationId, id);
  }

  /** pending -> stale (target vanished/changed before execution); outcome holds the STALE_PREVIEW error. */
  markStale(id: string, outcome: unknown, now: string): void {
    this.db.prepare(`UPDATE approvals SET status='stale', outcome_json=?, error_code='STALE_PREVIEW', finished_at=? WHERE approval_id=? AND status='pending'`)
      .run(j(outcome), now, id);
  }

  finish(id: string, status: 'succeeded' | 'failed' | 'unknown' | 'dry_run', outcome: unknown, errorCode: string | null, now: string): void {
    this.db
      .prepare(`UPDATE approvals SET status=?, outcome_json=?, error_code=?, finished_at=? WHERE approval_id=?`)
      .run(status, j(outcome), n(errorCode), now, id);
  }

  list(filter: { account?: string; status?: string; action?: string; limit?: number } = {}): ApprovalRow[] {
    const { where, args } = buildWhere({ account: filter.account, status: filter.status, action: filter.action });
    const rows = this.db.prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ?`).all(...args, filter.limit ?? 50);
    return rows.map((r) => toApproval(r as Record<string, unknown>));
  }
}

function buildWhere(cols: Record<string, string | undefined>, extra: string[] = [], extraArgs: SqlValue[] = []): { where: string; args: SqlValue[] } {
  const parts: string[] = [];
  const args: SqlValue[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v) { parts.push(`${k} = ?`); args.push(v); }
  }
  parts.push(...extra);
  args.push(...extraArgs);
  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

// ---------- operations ----------
export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'unknown' | 'dry_run';

export interface OperationRow {
  operation_id: string;
  approval_id: string | null;
  account: string;
  action: string;
  target: string | null;
  origin: string;
  status: OperationStatus;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  outcome: unknown;
  reconcile: Record<string, unknown> | null;
  error_code: string | null;
  reconciled_at: string | null;
  rowid?: number;
}

function toOperation(r: Record<string, unknown>): OperationRow {
  return {
    operation_id: r.operation_id as string,
    approval_id: (r.approval_id as string | null) ?? null,
    account: r.account as string,
    action: r.action as string,
    target: (r.target as string | null) ?? null,
    origin: (r.origin as string) ?? 'approve',
    status: r.status as OperationStatus,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    finished_at: (r.finished_at as string | null) ?? null,
    outcome: p(r.outcome_json),
    reconcile: p<Record<string, unknown>>(r.reconcile_json),
    error_code: (r.error_code as string | null) ?? null,
    reconciled_at: (r.reconciled_at as string | null) ?? null,
    rowid: r.rowid as number | undefined
  };
}

export class OperationsRepo {
  constructor(private readonly db: Db) {}

  create(o: { operation_id: string; approval_id?: string | null; account: string; action: string; target?: string | null; origin?: string; now: string }): void {
    this.db
      .prepare(`INSERT INTO operations (operation_id, approval_id, account, action, target, origin, status, created_at, updated_at) VALUES (?,?,?,?,?,?,'running',?,?)`)
      .run(o.operation_id, n(o.approval_id), o.account, o.action, n(o.target), o.origin ?? 'approve', o.now, o.now);
  }

  /** Get by operation id, falling back to approval id. */
  get(id: string): OperationRow | undefined {
    const r =
      this.db.prepare('SELECT rowid, * FROM operations WHERE operation_id = ?').get(id) ??
      this.db.prepare('SELECT rowid, * FROM operations WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1').get(id);
    return r ? toOperation(r as Record<string, unknown>) : undefined;
  }

  setReconcile(id: string, reconcile: Record<string, unknown>, now: string): void {
    const cur = this.get(id);
    const merged = { ...(cur?.reconcile ?? {}), ...reconcile };
    this.db.prepare('UPDATE operations SET reconcile_json=?, updated_at=? WHERE operation_id=?').run(j(merged), now, id);
  }

  finish(id: string, status: OperationStatus, outcome: unknown, errorCode: string | null, now: string, opts: { reconciled?: boolean } = {}): void {
    this.db
      .prepare(`UPDATE operations SET status=?, outcome_json=?, error_code=?, updated_at=?, finished_at=?, reconciled_at=COALESCE(?, reconciled_at) WHERE operation_id=?`)
      .run(status, j(outcome), n(errorCode), now, status === 'running' ? null : now, opts.reconciled ? now : null, id);
  }

  /** Newest created_at first, ties by operation_id descending. Keyset cursor = last row's (created_at, operation_id). */
  list(f: { account?: string; action?: string; status?: string; since?: string; until?: string; before?: { created_at: string; operation_id: string }; limit: number }): OperationRow[] {
    const extra: string[] = [];
    const extraArgs: SqlValue[] = [];
    if (f.since) { extra.push('created_at >= ?'); extraArgs.push(f.since); }
    if (f.until) { extra.push('created_at <= ?'); extraArgs.push(f.until); }
    if (f.before) {
      extra.push('(created_at < ? OR (created_at = ? AND operation_id < ?))');
      extraArgs.push(f.before.created_at, f.before.created_at, f.before.operation_id);
    }
    const { where, args } = buildWhere({ account: f.account, action: f.action, status: f.status }, extra, extraArgs);
    return this.db.prepare(`SELECT rowid, * FROM operations ${where} ORDER BY created_at DESC, operation_id DESC LIMIT ?`).all(...args, f.limit)
      .map((r) => toOperation(r as Record<string, unknown>));
  }
}

// ---------- audit ----------
export interface AuditRow {
  id: number; ts: string; account: string | null; actor: string; action: string; target: string | null;
  approval_id: string | null; operation_id: string | null; status: string; error_code: string | null; summary: string | null; data: unknown;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  add(a: { ts: string; account?: string | null; actor?: string; action: string; target?: string | null; approval_id?: string | null;
    operation_id?: string | null; status: string; error_code?: string | null; summary?: string | null; data?: unknown }): void {
    this.db
      .prepare(`INSERT INTO audit_log (ts, account, actor, action, target, approval_id, operation_id, status, error_code, summary, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(a.ts, n(a.account), a.actor ?? 'mcp', a.action, n(a.target), n(a.approval_id), n(a.operation_id), a.status, n(a.error_code),
        a.summary ? redact(a.summary) : null, j(a.data));
  }

  list(f: { account?: string; action?: string; status?: string; since?: string; until?: string; beforeId?: number; limit: number }): AuditRow[] {
    const extra: string[] = [];
    const extraArgs: SqlValue[] = [];
    if (f.since) { extra.push('ts >= ?'); extraArgs.push(f.since); }
    if (f.until) { extra.push('ts <= ?'); extraArgs.push(f.until); }
    if (f.beforeId) { extra.push('id < ?'); extraArgs.push(f.beforeId); }
    const { where, args } = buildWhere({ account: f.account, action: f.action, status: f.status }, extra, extraArgs);
    return this.db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...args, f.limit).map((r) => {
      const row = r as Record<string, unknown>;
      return { ...(row as unknown as AuditRow), data: p(row.data) };
    });
  }
}

// ---------- kv ----------
export class KvRepo {
  constructor(private readonly db: Db) {}
  get<T = unknown>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }
  set(key: string, value: unknown, now: string): void {
    this.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, JSON.stringify(redactDeep(value)), now);
  }
  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}

// ---------- capability cache ----------
export interface CapabilityCacheRow { account: string; feature: string; status: 'yes' | 'no'; reason: string | null; checked_at: string }

export class CapabilityCacheRepo {
  constructor(private readonly db: Db) {}
  get(account: string, feature: string): CapabilityCacheRow | undefined {
    return this.db.prepare('SELECT account, feature, status, reason, checked_at FROM capability_cache WHERE account=? AND feature=?')
      .get(account, feature) as CapabilityCacheRow | undefined;
  }
  list(account: string): CapabilityCacheRow[] {
    return this.db.prepare('SELECT account, feature, status, reason, checked_at FROM capability_cache WHERE account=?').all(account) as unknown as CapabilityCacheRow[];
  }
  set(account: string, feature: string, status: 'yes' | 'no', reason: string | null, now: string): void {
    this.db.prepare(`INSERT INTO capability_cache (account, feature, status, reason, checked_at) VALUES (?,?,?,?,?)
      ON CONFLICT(account, feature) DO UPDATE SET status=excluded.status, reason=excluded.reason, checked_at=excluded.checked_at`)
      .run(account, feature, status, n(reason), now);
  }
  clear(account: string, feature?: string): void {
    if (feature) this.db.prepare('DELETE FROM capability_cache WHERE account=? AND feature=?').run(account, feature);
    else this.db.prepare('DELETE FROM capability_cache WHERE account=?').run(account);
  }
}

// ---------- rate usage ----------
export interface RateUsageRow { account: string; source: string; data: unknown; updated_at: string }

export class RateUsageRepo {
  constructor(private readonly db: Db) {}
  upsert(account: string, source: string, data: unknown, now: string): void {
    this.db.prepare(`INSERT INTO rate_usage (account, source, data, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(account, source) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
      .run(account, source, JSON.stringify(data), now);
  }
  list(account: string): RateUsageRow[] {
    return (this.db.prepare('SELECT account, source, data, updated_at FROM rate_usage WHERE account=?').all(account) as Array<Record<string, string>>)
      .map((r) => ({ account: r.account!, source: r.source!, data: JSON.parse(r.data!), updated_at: r.updated_at! }));
  }
}

// ---------- hashtag budget ----------
export class HashtagBudgetRepo {
  constructor(private readonly db: Db) {}
  /** Distinct hashtags queried by the account in the trailing window. */
  usedSince(account: string, sinceIso: string): string[] {
    return (this.db.prepare('SELECT DISTINCT hashtag FROM hashtag_budget WHERE account=? AND queried_at >= ?').all(account, sinceIso) as Array<{ hashtag: string }>)
      .map((r) => r.hashtag);
  }
  record(account: string, hashtag: string, hashtagId: string | null, now: string): void {
    this.db.prepare('INSERT INTO hashtag_budget (account, hashtag, hashtag_id, queried_at) VALUES (?,?,?,?)').run(account, hashtag.toLowerCase(), n(hashtagId), now);
  }
}

export interface Repos {
  approvals: ApprovalsRepo;
  operations: OperationsRepo;
  audit: AuditRepo;
  kv: KvRepo;
  capabilityCache: CapabilityCacheRepo;
  rateUsage: RateUsageRepo;
  hashtagBudget: HashtagBudgetRepo;
}

export function createRepos(db: Db): Repos {
  return {
    approvals: new ApprovalsRepo(db),
    operations: new OperationsRepo(db),
    audit: new AuditRepo(db),
    kv: new KvRepo(db),
    capabilityCache: new CapabilityCacheRepo(db),
    rateUsage: new RateUsageRepo(db),
    hashtagBudget: new HashtagBudgetRepo(db)
  };
}
