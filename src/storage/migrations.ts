// Versioned, append-only migrations. Version 1 creates every table the v1 design needs. Later versions are
// strictly additive (ADD COLUMN) so an existing state.sqlite keeps working.
// All timestamps are ISO-8601 UTC TEXT (lexicographically sortable).
export interface Migration { version: number; sql: string }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE approvals (
  approval_id        TEXT PRIMARY KEY,
  account            TEXT NOT NULL,
  action             TEXT NOT NULL,
  target             TEXT,
  params_json        TEXT NOT NULL,
  params_hash        TEXT NOT NULL,
  preview_json       TEXT,
  planned_calls_json TEXT,
  warnings_json      TEXT,
  state_fingerprint  TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending|running|succeeded|failed|unknown|dry_run|expired|stale
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  operation_id       TEXT,
  outcome_json       TEXT,   -- result on success, error object on failure/unknown
  error_code         TEXT,
  data               TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, expires_at);
CREATE INDEX idx_approvals_account ON approvals(account, created_at);

CREATE TABLE operations (
  operation_id   TEXT PRIMARY KEY,
  approval_id    TEXT,
  account        TEXT NOT NULL,
  action         TEXT NOT NULL,
  target         TEXT,
  status         TEXT NOT NULL,        -- running|succeeded|failed|unknown|dry_run
  origin         TEXT NOT NULL DEFAULT 'approve',   -- approve|scheduler
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  finished_at    TEXT,
  outcome_json   TEXT,
  reconcile_json TEXT,                 -- e.g. {"creation_id": "..."} for unknown outcomes
  error_code     TEXT,
  reconciled_at  TEXT,
  data           TEXT
);
CREATE INDEX idx_operations_approval ON operations(approval_id);
CREATE INDEX idx_operations_account ON operations(account, created_at);
CREATE INDEX idx_operations_status ON operations(status);

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  account      TEXT,
  actor        TEXT NOT NULL DEFAULT 'mcp',   -- mcp|daemon|cli
  action       TEXT NOT NULL,
  target       TEXT,
  approval_id  TEXT,
  operation_id TEXT,
  status       TEXT NOT NULL,
  error_code   TEXT,
  summary      TEXT,
  data         TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_action ON audit_log(action, status);

CREATE TABLE scheduled_posts (
  id               TEXT PRIMARY KEY,
  account          TEXT NOT NULL,
  approval_id      TEXT,
  operation_id     TEXT,
  status           TEXT NOT NULL,  -- scheduled|creating|ready|publishing|published|missed|failed|unknown|cancelled
  kind             TEXT,
  publish_at       TEXT NOT NULL,
  container_at     TEXT,           -- publish_at - container_lead
  payload_json     TEXT NOT NULL,  -- the approved publish payload
  creation_ids_json TEXT,          -- container ids (children + parent)
  creation_id      TEXT,           -- container passed to media_publish
  media_id         TEXT,
  permalink        TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT,
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  data             TEXT
);
CREATE INDEX idx_scheduled_due ON scheduled_posts(status, publish_at);
CREATE INDEX idx_scheduled_account ON scheduled_posts(account, publish_at);

CREATE TABLE staged_media (
  token        TEXT PRIMARY KEY,   -- random url-safe token = file name in staging/
  account      TEXT,
  source_path  TEXT,
  path         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  deleted_at   TEXT,
  owner_id     TEXT,               -- approval/scheduled-post id that uses it
  data         TEXT
);
CREATE INDEX idx_staged_expires ON staged_media(expires_at);

CREATE TABLE insight_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account      TEXT NOT NULL,
  scope        TEXT NOT NULL,       -- account|media|audience
  media_id     TEXT,
  taken_at     TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,      -- local date YYYY-MM-DD (daily dedupe)
  metrics_json TEXT NOT NULL,
  data         TEXT
);
CREATE INDEX idx_snapshots_account ON insight_snapshots(account, scope, taken_at);
CREATE INDEX idx_snapshots_media ON insight_snapshots(account, media_id, taken_at);

CREATE TABLE media_index (
  account        TEXT NOT NULL,
  media_id       TEXT NOT NULL,
  media_type     TEXT,
  product_type   TEXT,
  permalink      TEXT,
  caption        TEXT,
  posted_at      TEXT,
  like_count     INTEGER,
  comments_count INTEGER,
  downloaded_at  TEXT,
  local_path     TEXT,
  updated_at     TEXT NOT NULL,
  data           TEXT,
  PRIMARY KEY (account, media_id)
);
CREATE INDEX idx_media_posted ON media_index(account, posted_at);

CREATE TABLE webhook_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key    TEXT NOT NULL UNIQUE,  -- dedupe key
  received_at  TEXT NOT NULL,
  object       TEXT,
  field        TEXT,
  ig_id        TEXT,                  -- entry.id (the account the event belongs to)
  account      TEXT,
  payload_json TEXT NOT NULL,
  processed_at TEXT,
  data         TEXT
);
CREATE INDEX idx_webhook_received ON webhook_events(received_at);
CREATE INDEX idx_webhook_field ON webhook_events(account, field, received_at);

CREATE TABLE inbox_state (
  account    TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- cursor|handled
  key        TEXT NOT NULL,           -- cursor name or item id
  value      TEXT,
  updated_at TEXT NOT NULL,
  data       TEXT,
  PRIMARY KEY (account, kind, key)
);

CREATE TABLE hashtag_budget (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account    TEXT NOT NULL,
  hashtag    TEXT NOT NULL,
  hashtag_id TEXT,
  queried_at TEXT NOT NULL,
  data       TEXT
);
CREATE INDEX idx_hashtag_budget ON hashtag_budget(account, queried_at);

CREATE TABLE capability_cache (
  account    TEXT NOT NULL,
  feature    TEXT NOT NULL,
  status     TEXT NOT NULL,           -- yes|no
  reason     TEXT,
  checked_at TEXT NOT NULL,
  data       TEXT,
  PRIMARY KEY (account, feature)
);

CREATE TABLE rate_usage (
  account    TEXT NOT NULL,
  source     TEXT NOT NULL,           -- app|business|publish_limit
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, source)
);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE locks (
  name       TEXT PRIMARY KEY,         -- e.g. 'daemon'
  owner      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  data       TEXT
);
`
  },
  {
    // Orphan detection (contract 1.13.9): wall-clock heartbeat of the process executing a `running` operation.
    version: 2,
    sql: `ALTER TABLE operations ADD COLUMN heartbeat_at TEXT;`
  }
];
