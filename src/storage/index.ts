import { createRepos, type Repos } from './repos.js';
import { openDatabase, transaction, type Db } from './db.js';

export * from './repos.js';
export { openDatabase, transaction, type Db } from './db.js';

export interface Storage extends Repos {
  /** Raw handle for domain-specific tables (scheduled_posts, staged_media, insight_snapshots, ...). */
  db: Db;
  tx<T>(fn: () => T): T;
}

export function openStorage(file: string): Storage {
  const db = openDatabase(file);
  return { db, tx: (fn) => transaction(db, fn), ...createRepos(db) };
}
