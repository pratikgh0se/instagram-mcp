# instagram-mcp v1 — design spec

Status: approved direction (Pratik, 2026-10-29: "Approved. Option A" = official Meta API only).
Supersedes: `2026-08-19-instagram-mcp-design.md` (v0.1 kept for history).
Research inputs: `docs/research/01..07` (accessed 2026-10-29, Graph API v26.0). When this spec and research disagree, this spec wins; when research flags a fact as unverified, the code must tolerate either answer and the live E2E suite confirms it.

## 1. Goal

A self-hosted, secure, open-source (MIT) MCP server that lets an AI agent run an Instagram creator's content cycle end to end — plan, publish, schedule, engage, measure, report — using **only Meta's official Instagram Platform API**. No scraping, private API, password login, browser automation, or third-party data relays.

Non-goals (not possible on the official API; document them in README "What this cannot do"): follow/unfollow, listing followers or following, liking posts/comments, saving posts, in-app archiving, pinning, editing captions after publish, reading other users' private content, downloading non-business accounts' media, partnership *ads* (Marketing API), Creator Marketplace (brand-side, App Review).

## 2. Architecture

```
MCP client (Claude, etc.)
  │ stdio  or  Streamable HTTP (127.0.0.1, bearer auth)
  ▼
instagram-mcp process ──────────────────────────────────────────────┐
  tools/<domain>   → services/<domain> → GraphClient(path-aware)   │
  safety: policy → preflight → approval ledger → execute → audit   │
  storage: node:sqlite in $INSTAGRAM_MCP_HOME                       │
  secrets: TokenStore (keychain | encrypted-file | env)             │
  media host: on-demand file server for local uploads               │
  ─────────────────────────────────────────────────────────────────┘
instagram-mcp daemon (optional, long-running; launchd/systemd/docker)
  scheduler loop · webhook receiver · daily insight snapshots · token refresh
```

Language/runtime: TypeScript ESM, Node ≥ 22.13 (dev machine has 26.x), `@modelcontextprotocol/sdk` 1.x, `zod`, `node:sqlite`. Keep runtime dependencies minimal; no native addons. Build with `tsc`.

### 2.1 Login paths and capability matrix

Each configured account declares `login: "instagram" | "facebook"`.

| | `instagram` (Instagram Login) | `facebook` (Facebook Login for Business) |
|---|---|---|
| Base URL | `https://graph.instagram.com/{ver}` | `https://graph.facebook.com/{ver}` |
| Needs FB Page | no | yes (`page_id` in config) |
| Token | IG User token, 60 d, refreshable | long-lived user → Page token |
| Publish URL media | yes | yes |
| Local video upload (resumable `rupload.facebook.com`) | no → use media host | yes |
| Delete media | unverified → capability `probe` | yes (`instagram_manage_contents`) |
| Business discovery, hashtag search | no | yes |
| Branded content / paid partnership flags | unverified | yes |
| story_insights webhook | no | yes |

Implement as a static `capabilities.ts` table `{feature → {instagram: yes|no|probe, facebook: yes|no|probe}}`. A tool whose feature is `no` for the account returns `CAPABILITY_UNAVAILABLE` with an `action` naming the other path. `probe` means: attempt the call; if Meta returns an unsupported/permission error, cache `no` in SQLite for that account and return `CAPABILITY_UNAVAILABLE`. `instagram_list_accounts` exposes the resolved matrix.

### 2.2 Graph client

- One client, base URL per path, version from config (default `v26.0`), overridable per path by env (`INSTAGRAM_MCP_GRAPH_URL_INSTAGRAM`, `INSTAGRAM_MCP_GRAPH_URL_FACEBOOK`, `INSTAGRAM_MCP_RUPLOAD_URL`) so tests can point at a fake server.
- Token placement: `Authorization: Bearer` header on `facebook`; `access_token` query param on `instagram` (documented form) unless config `token_in_header: true`. Every URL, error, cause and log line passes through `redact()` which strips `access_token=…`, `Bearer …`, `appsecret_proof=…`, `client_secret=…`, and any currently-loaded token/secret value.
- `appsecret_proof` (HMAC-SHA256 of token with app secret) on `facebook` when app secret configured.
- Retries: GET only, on network error / 429 / 5xx / Meta transient codes (1, 2, 4, 17, 32, 613, 80002…); full-jitter exponential backoff (base 500 ms, cap 30 s, max 4 attempts); honor `Retry-After` seconds or HTTP-date; never 0 ms. Writes are never retried automatically.
- Parse `x-business-use-case-usage` / `x-app-usage` headers into an in-memory + SQLite usage record exposed by `instagram_get_rate_limits`.
- Error mapping (Meta `error.code`/`error_subcode`/HTTP): 190 → `TOKEN_EXPIRED`/`AUTH_FAILED`; 10/200-299 → `MISSING_PERMISSION`; 4/17/32/613/80002 → `RATE_LIMITED`; 9007/2207xxx publish errors → `UPSTREAM_REJECTED` with Meta message; 100 invalid param → `INVALID_INPUT`; 803/not found → `NOT_FOUND`; 5xx/network → `UPSTREAM_TRANSIENT`. Keep `meta: {code, subcode, fbtrace_id}` in error details (never the token).

### 2.3 Error model

`AppError { code, message, action?, retryable, details? }`. Tool failures return `isError: true`, `structuredContent: { error: {...} }`, and a one-line text. Successes return `structuredContent` plus a short human summary in text.

Codes: `CONFIG_INVALID, AUTH_REQUIRED, AUTH_FAILED, TOKEN_EXPIRED, MISSING_PERMISSION, ACCOUNT_NOT_ALLOWED, CAPABILITY_UNAVAILABLE, POLICY_DENIED, INVALID_INPUT, NOT_FOUND, RATE_LIMITED, PUBLISH_QUOTA_EXHAUSTED, MESSAGING_WINDOW_CLOSED, HASHTAG_BUDGET_EXHAUSTED, APPROVAL_NOT_FOUND, APPROVAL_EXPIRED, APPROVAL_ALREADY_USED, STALE_PREVIEW, UPSTREAM_REJECTED, UPSTREAM_TRANSIENT, OUTCOME_UNKNOWN, MEDIA_HOST_UNAVAILABLE, INTERNAL`.

`OUTCOME_UNKNOWN` always carries `details.reconcile` (e.g. `{creation_id, operation_id}`) and `action` pointing at `instagram_get_operation`.

### 2.4 Write safety (preflight → approve → execute)

Every Instagram-side write and every local destructive change goes through two tools:

1. `instagram_preflight_<action>(…)` — read-only. Validates input, policy, capability, quota, messaging window, media specs; fetches current target state; returns `{ approval_id, expires_at, action, account, preview, warnings[], dry_run }`. Stores an approval row bound to `sha256(canonical_json({account, action, target, params}))`, status `pending`, TTL `approval_ttl_seconds` (default 600).
2. `instagram_approve({ approval_id, confirm: true })` — the only tool that changes Instagram. Atomically transitions `pending → running` (compare-and-set; reuse → `APPROVAL_ALREADY_USED`; expired → `APPROVAL_EXPIRED`), re-reads target state where meaningful (comment still exists, media still exists) → `STALE_PREVIEW` if changed, executes, records outcome `succeeded | failed | unknown`, writes an audit row. Repeating `approve` on a finished approval returns the stored outcome without re-executing.

Clients gate humans by permission rules on `instagram_approve` alone. Batch: `instagram_preflight_comment_actions` produces one approval covering many comment ops; execution reports per-item outcomes and stops nothing on a single failure.

Policy (config `policy`): `read_only` (all preflights → `POLICY_DENIED`), `dry_run` (approve validates and returns the planned Graph calls without sending), `disabled_actions: [...]` (e.g. `["delete_media","send_message"]`), `allowed_accounts` = configured accounts only.

Publishing never double-posts: idempotency key = approval_id; ambiguous `media_publish` failure → outcome `unknown`, store `creation_id`; `instagram_get_operation` reconciles by checking container `status_code == PUBLISHED` and/or recent media; scheduler never re-publishes an `unknown` job.

### 2.5 Storage

`$INSTAGRAM_MCP_HOME` (default `~/.instagram-mcp`, dir 0700, files 0600). `state.sqlite` (node:sqlite, WAL, versioned migrations) tables: `approvals`, `operations` (ledger + reconciliation), `audit_log`, `scheduled_posts`, `staged_media`, `insight_snapshots`, `media_index`, `webhook_events`, `inbox_state` (last-seen cursors, handled comment ids), `hashtag_budget`, `capability_cache`, `rate_usage`, `kv`. `downloads/` default download root. `staging/` for media host files.

### 2.6 Secrets

`TokenStore` backends, chosen by config `secrets.backend` (default `keychain` on macOS, `encrypted-file` elsewhere):
- `keychain`: macOS `security` CLI (`add-generic-password -U`, `find-generic-password -w`), service `instagram-mcp`, account `<alias>:<kind>`. Pass secrets via stdin/argv-safe method — never in logs.
- `encrypted-file`: AES-256-GCM, key from `INSTAGRAM_MCP_MASTER_KEY` (base64 32 bytes) or scrypt-derived from passphrase env; file 0600.
- `env`: read-only, `INSTAGRAM_MCP_TOKEN_<ALIAS>` (uppercased alias), `INSTAGRAM_MCP_APP_SECRET`, `INSTAGRAM_MCP_HTTP_TOKEN`. For CI, Docker and the contract test suite.

Stored kinds: `access_token` (+ `expires_at`, `scopes`), `app_secret`, `http_bearer`, `webhook_verify_token`.
Token refresh (instagram path): single-flight per account; refresh when token age ≥ 24 h and expiry < 15 days; daemon checks daily; tools check lazily. facebook path: long-lived Page tokens don't expire; `auth status` reports.

### 2.7 Transports

- `stdio` (default for `instagram-mcp` / `instagram-mcp serve`).
- Streamable HTTP (`serve --http`): binds `127.0.0.1:${port}` (default 8765); refuses non-loopback bind unless `http.allow_remote: true`; requires `Authorization: Bearer <http_bearer>` (constant-time compare) — refuses to start if no bearer stored; validates `Host`/`Origin` against allowlist (DNS-rebinding protection); 1 MB body limit; 401 responses rate-limited.

### 2.8 Media host (local files → public URL)

Instagram fetches media from a public URL. For a local path the server:
1. copies the file into `staging/` under a random 32-byte url-safe token name, records it in `staged_media` with expiry (24 h),
2. ensures the media server is listening on `media_host.port` (default 8766, loopback) — started on demand by whichever process is publishing (stdio server or daemon), serving only `GET /m/<token>` for unexpired staged files with correct `Content-Type`, no listing, no traversal,
3. builds `media_host.public_base_url + /m/<token>`; the user's tunnel (Cloudflare Tunnel recommended, documented) maps that hostname to the port.
If `public_base_url` is unset → `MEDIA_HOST_UNAVAILABLE` with setup action. On `facebook` path, local **video** uses resumable upload instead (no host needed). Staged files are deleted after successful publish or expiry.

Preflight validation of media: local files — size, extension/magic bytes (JPEG for images; MP4/MOV for video), image dimensions/aspect via header parsing (no native deps); remote URLs — HTTPS only, SSRF guard (resolve DNS, reject private/loopback/link-local), `HEAD`/ranged GET for content-type and length. Specs per research 01 (image JPEG ≤ 8 MB, aspect 4:5–1.91:1; reels 3 s–15 min; story video ≤ 60 s ≤ 100 MB; carousel 2–20 items, no reels inside). Unknown/unprovable properties produce `warnings`, not errors.

### 2.9 Daemon

`instagram-mcp daemon` runs: scheduler loop (every 30 s), webhook receiver (if enabled), daily insight snapshot per account (configurable hour), daily token refresh check, staging cleanup. It also serves Streamable HTTP when `--http`. One daemon per `$INSTAGRAM_MCP_HOME` (lock row in SQLite with lease). Ships with launchd plist + systemd unit + Dockerfile examples.

Scheduler semantics: a job stores the approved publish payload. At `publish_at − container_lead` (default 10 min, max 23 h) it creates container(s) and polls; at `publish_at` it calls `media_publish`. Missed by more than `missed_grace` (default 60 min) → status `missed`, never auto-posted late. Ambiguous publish → `unknown`, never retried. `instagram-mcp scheduler run-once` processes due jobs once (used by tests and cron users).

### 2.10 Webhooks

Daemon route `POST /webhooks/instagram` (+ `GET` verification handshake using stored `webhook_verify_token`, echo `hub.challenge`). Verify `X-Hub-Signature-256` (HMAC-SHA256 of raw body with app secret, `timingSafeEqual`); reject unsigned/invalid with 401; dedupe; store in `webhook_events`; respond 200 fast. Fields: comments, mentions, messages, message_reactions, messaging_postbacks, story_insights. Public HTTPS via tunnel. When webhooks are off or unavailable (dev-mode / Advanced Access limits), the inbox falls back to polling.

## 3. Tool catalog (v1)

All tools take optional `account` (alias; default = the only/default account). Names `instagram_<verb>_<noun>`. Annotations: `readOnlyHint` on reads and preflights, `destructiveHint` on `instagram_approve` and local-destructive tools, `openWorldHint: true` on tools that call Meta. List tools: `limit` (≤ 100) + opaque `cursor` in, `next_cursor` out.

**Account, auth, ops**
- `instagram_list_accounts` — configured accounts, login path, resolved capabilities, token expiry, scopes, default flag.
- `instagram_get_profile` — username, name, bio, website, profile picture URL, followers/follows/media counts, account type.
- `instagram_get_rate_limits` — publishing quota (`content_publishing_limit`), last BUC/app usage, hashtag budget left.
- `instagram_get_operation` — one operation/approval with outcome; reconciles `unknown` publishes.
- `instagram_list_operations` — recent operations/audit log, filter by action/status/date.
- `instagram_approve` — execute an approved preflight (see 2.4).

**Media and archive**
- `instagram_list_media` — own posts (filter: media_product_type, since/until).
- `instagram_get_media` — one media incl. carousel children, permalink, counts, `is_comment_enabled`.
- `instagram_list_stories` — currently live stories.
- `instagram_download_media` — download own media (and children, thumbnails) to `downloads/<username>/<date>_<id>.<ext>` + `<id>.json` sidecar (caption, permalink, timestamps, counts). Only Meta CDN hosts (`*.cdninstagram.com`, `*.fbcdn.net`) are fetched. Local write only; not an approval action.
- `instagram_backup_account` — incremental backup of all own media + sidecars + latest insights into downloads dir; returns counts; resumable via `media_index`.

**Publishing**
- `instagram_preflight_publish` — `kind: image|reel|story|carousel`, `media` (array of `{url|path, type?: image|video, alt_text?, user_tags?}`), `caption`, `location_id`, `collaborators[]` (≤ 3 usernames), `user_tags`, `cover` (url|path) / `thumb_offset_ms`, `share_to_feed`, `audio_name`, `trial_reel` (`graduation_strategy`), `is_paid_partnership`, `branded_content_sponsor_ids`, `is_ai_generated`, `publish_at?` (ISO 8601; future → scheduled job). Checks quota, capability, media specs; preview lists the exact Graph calls.
- `instagram_list_scheduled` — scheduled jobs and statuses.
- `instagram_cancel_scheduled` — cancel a not-yet-started job (local, reversible enough: requires `confirm: true`, no approval).
- `instagram_preflight_delete_media` — capability-gated; preview shows permalink, caption, counts.
- `instagram_preflight_set_comments_enabled` — toggle `comment_enabled` on own media.
- `instagram_get_publish_status` — container `status_code` for a creation id.

**Comments, mentions, inbox**
- `instagram_list_comments` — for a media; `include_replies`; fields: id, text, username, timestamp, like_count, hidden, replies.
- `instagram_get_comment`
- `instagram_get_inbox` — unified triage feed: new comments on recent media (window `days`, default 7), mentions/tags, webhook events; flags `unanswered` (no owner reply) and `handled` (marked locally); `since` cursor.
- `instagram_mark_handled` — local bookkeeping for inbox items (no Meta call).
- `instagram_preflight_comment_actions` — batch of `{op: reply|comment|hide|unhide|delete|private_reply, comment_id|media_id, message?}` (≤ 50).
- `instagram_list_mentions` — media where the account is tagged (`/tags`) + mentioned comments/media lookups by id.
- `instagram_preflight_reply_mention` — reply to a mention (`/mentions`).

**Direct messages**
- `instagram_list_conversations` — recent conversations with participant, last message time, `window_open` (24 h).
- `instagram_get_conversation` — messages in a conversation.
- `instagram_preflight_send_message` — to a conversation/IGSID: text (≤ 1000 bytes), media URL, reaction, quick replies; checks 24 h window (`MESSAGING_WINDOW_CLOSED` unless `human_agent` tag allowed by config).
- `instagram_preflight_set_messaging_profile` — ice breakers (≤ 4), persistent menu.

**Insights and reports**
- `instagram_get_account_insights` — metrics (validated against the current list in research 03), period, breakdown, metric_type, since/until; rejects deprecated metrics (`impressions`, `video_views`, `plays`, `profile_views`…) with an `INVALID_INPUT` naming the replacement (`views`).
- `instagram_get_media_insights` — auto-selects the valid metric set for the media's product type; optional explicit list.
- `instagram_get_audience` — follower and engaged-audience demographics (age, gender, city, country) and online followers if available (tolerate absence).
- `instagram_snapshot_insights` — store a snapshot now (daemon does daily); returns snapshot id.
- `instagram_get_growth` — time series from stored snapshots (followers, reach, views, engagement) with deltas.
- `instagram_performance_report` — period (`7d|30d|90d|custom`) report: totals vs previous period, engagement rate, top/bottom posts by metric, format breakdown (reel/feed/story/carousel), posting cadence; output JSON + `markdown`.
- `instagram_best_time_to_post` — from online_followers (if available) and own historical post performance by weekday/hour; states which data it used.
- `instagram_media_kit` — partnership stats: profile, followers, demographics, avg reach/views/engagement per format over 30/90 d, top posts; JSON + markdown.

**Discovery and partnerships** (facebook path for discovery)
- `instagram_lookup_account` — business discovery for a public business/creator username: profile counts + recent media with counts.
- `instagram_compare_accounts` — benchmark own account vs up to 10 usernames (followers, posting frequency, avg likes/comments per post, format mix).
- `instagram_search_hashtag` — resolve hashtag id (tracks 30-per-7-days budget in SQLite; `HASHTAG_BUDGET_EXHAUSTED`).
- `instagram_get_hashtag_media` — `top` or `recent` media for a hashtag id.
- `instagram_list_collab_invites` — pending collaboration invites.
- `instagram_preflight_respond_collab_invite` — accept/decline.

## 4. CLI

`instagram-mcp [serve] [--http] [--port]` · `daemon [--http]` · `auth set-token --account <alias>` (prompt/stdin; exchanges short-lived → long-lived on instagram path when app secret present; facebook path: user token → long-lived → Page token via `page_id`) · `auth status` · `auth refresh` · `auth logout` · `accounts add|list|remove` (writes config) · `http-token rotate` · `webhooks set-verify-token` · `scheduler run-once` · `doctor` (config, secrets backend, token validity/expiry/scopes via `/me` + debug where possible, capability probe, quota, media host reachability, daemon status, webhook config; prints fix-it actions) · `version`.

## 5. Config

`$INSTAGRAM_MCP_HOME/config.json` (path override `INSTAGRAM_MCP_CONFIG`), validated with zod, secrets never inside:

```json
{
  "graph_api_version": "v26.0",
  "default_account": "test",
  "accounts": [
    { "alias": "test", "login": "instagram", "ig_user_id": "1784…", "page_id": null }
  ],
  "app": { "app_id": "…" },
  "secrets": { "backend": "keychain" },
  "policy": { "read_only": false, "dry_run": false, "disabled_actions": [], "approval_ttl_seconds": 600, "allow_human_agent_tag": false },
  "media_host": { "public_base_url": null, "port": 8766 },
  "http": { "port": 8765, "allow_remote": false, "allowed_origins": [] },
  "scheduler": { "container_lead_minutes": 10, "missed_grace_minutes": 60 },
  "webhooks": { "enabled": false, "path": "/webhooks/instagram" },
  "snapshots": { "daily_hour_local": 6 },
  "downloads_dir": null
}
```

Test hooks (env): `INSTAGRAM_MCP_HOME`, `INSTAGRAM_MCP_CONFIG`, graph URL overrides (2.2), `INSTAGRAM_MCP_POLL_INTERVAL_MS` (container polling base, default 2000), `INSTAGRAM_MCP_NOW` (ISO clock override for scheduler tests; ignored unless `INSTAGRAM_MCP_TEST_MODE=1`).

## 6. Security requirements (acceptance)

1. No token, app secret, bearer or appsecret_proof ever appears in tool output, errors, logs, audit rows, or SQLite (except the encrypted-file backend's ciphertext).
2. State dir 0700, files 0600; refuse to run if config is world-writable.
3. HTTP transport: loopback default, mandatory bearer, Host/Origin checks, body limit.
4. Webhooks: signature verified on raw body with constant-time compare; unsigned → 401.
5. Media server: unguessable tokens, staged files only, expiry, traversal-safe, loopback bind.
6. Outbound fetches of user-supplied URLs: HTTPS only, SSRF guard; downloads only from Meta CDN hosts; filenames sanitized; writes confined to downloads dir.
7. Account allowlist enforced on every tool; `ig_user_id` arguments must belong to a configured account.
8. CI: typecheck, build, unit smoke, `npm audit --omit=dev --audit-level=high`, gitleaks, `npm pack --dry-run`.
9. SECURITY.md with reporting process and threat model summary.

## 7. Testing

- Per Pratik's rule: behaviour tests are written by a code-blind agent from `docs/CONTRACT.md` in a **separate repo** `~/CodeBase/instagram-mcp-contract-tests`. Dev agents and the orchestrator do not read those tests; only results flow back. The main repo keeps no behaviour tests (only a tool-registry smoke check and typecheck); the old `test/` dir is removed.
- Contract tests are black-box: spawn the built server over stdio (and HTTP) with env-backend tokens and graph URLs pointed at a fake Meta server the test repo owns; assert tool outputs, error codes and the exact Graph requests received.
- Live E2E (`npm run e2e:live` in the test repo): drives the real server against Pratik's test account, guarded by `INSTAGRAM_E2E_ACCOUNT` + `INSTAGRAM_E2E_I_UNDERSTAND=yes`; walks every tool, cleans up what it creates, writes a pass/fail report including the "unverified" items from research (delete on instagram path, header tokens, carousel 20, quota value, comment_enabled param, dev-mode webhooks/DMs, online_followers).

## 8. Docs and release

README (pitch, feature table, what it cannot do, quick start, security model, client config snippets for Claude Desktop/Code), `docs/SETUP.md` (step-by-step Meta setup for both login paths, tunnel, daemon), `docs/TOOLS.md` (generated from registry), `docs/CONTRACT.md`, `docs/SECURITY-MODEL.md`, `SECURITY.md`, `CHANGELOG.md` (Keep a Changelog), `LICENSE` (MIT, © 2026 Pratik Ghose), `AGENTS.md`, `Dockerfile`, `server.json` (MCP registry), examples (launchd, systemd, cloudflared). Version `1.0.0-rc.1` until live E2E passes. Making the repo public / publishing is Pratik's call after live tests.
