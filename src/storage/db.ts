import { createRequire } from 'node:module';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.js';
import { ensurePrivateDir } from '../config/load.js';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = DatabaseSync;

let warningFilterInstalled = false;
function suppressSqliteWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export function openDatabase(file: string): Db {
  suppressSqliteWarning();
  let DatabaseSyncCtor: typeof DatabaseSync;
  try {
    DatabaseSyncCtor = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  } catch (cause) {
    throw new AppError('INTERNAL', 'node:sqlite is unavailable; Node >= 22.13 is required.', { cause });
  }
  ensurePrivateDir(dirname(file));
  // Create the db and its WAL sidecars at 0600 up front so they never exist with umask-derived modes.
  for (const suffix of ['', '-wal', '-shm']) {
    try { closeSync(openSync(file + suffix, 'a', 0o600)); } catch { /* best effort */ }
  }
  const db = new DatabaseSyncCtor(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db);
  for (const suffix of ['', '-wal', '-shm']) {
    try { chmodSync(file + suffix, 0o600); } catch { /* sidecar may not exist yet */ }
  }
  return db;
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new AppError('INTERNAL', `Database migration ${m.version} failed.`, { cause });
    }
  }
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
