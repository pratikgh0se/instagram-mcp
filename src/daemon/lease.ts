import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/index.js';

export const DAEMON_LOCK = 'daemon';
export const LEASE_TTL_MS = 60_000;
export const LEASE_RENEW_MS = 15_000;

/*
 * The daemon lease lives in the `locks` table. It always uses REAL wall time (never the frozen test clock),
 * so a stale lease expires even when INSTAGRAM_MCP_NOW pins the process clock.
 */

export interface LeaseHandle {
  owner: string;
  /** Extend the lease. Returns false when the lease was lost (taken over after expiry). */
  renew(): boolean;
  release(): void;
}

export interface LeaseHolder {
  owner: string;
  expires_at: string;
  pid: number | null;
}

/** The live holder of the daemon lease, or undefined when none/expired. */
export function currentLeaseHolder(db: Db, name = DAEMON_LOCK): LeaseHolder | undefined {
  const row = db.prepare('SELECT owner, expires_at, data FROM locks WHERE name = ?').get(name) as { owner: string; expires_at: string; data: string | null } | undefined;
  if (!row || row.expires_at <= new Date().toISOString()) return undefined;
  let pid: number | null = null;
  try { pid = (JSON.parse(row.data ?? 'null') as { pid?: number } | null)?.pid ?? null; } catch { /* ignore */ }
  return { owner: row.owner, expires_at: row.expires_at, pid };
}

/** Take the lease if it is free or stale. Returns a handle, or undefined when a live holder exists. */
export function acquireLease(db: Db, name = DAEMON_LOCK, ttlMs = LEASE_TTL_MS): LeaseHandle | undefined {
  const owner = `${process.pid}:${randomUUID()}`;
  const data = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  const expiry = (): string => new Date(Date.now() + ttlMs).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT expires_at FROM locks WHERE name = ?').get(name) as { expires_at: string } | undefined;
    if (row && row.expires_at > new Date().toISOString()) {
      db.exec('ROLLBACK');
      return undefined;
    }
    db.prepare(
      'INSERT INTO locks (name, owner, expires_at, data) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at, data=excluded.data'
    ).run(name, owner, expiry(), data);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    throw error;
  }
  return {
    owner,
    renew: () => {
      const r = db.prepare('UPDATE locks SET expires_at = ? WHERE name = ? AND owner = ?').run(expiry(), name, owner);
      return Number(r.changes) > 0;
    },
    release: () => {
      try { db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').run(name, owner); } catch { /* db already closed */ }
    }
  };
}
