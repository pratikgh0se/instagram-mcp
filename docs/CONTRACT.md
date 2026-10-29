# instagram-mcp v1 behaviour contract

Status: authoritative for black-box behaviour. Derived from `docs/superpowers/specs/2026-10-29-instagram-mcp-v1-design.md` (spec wins on conflict) and `docs/research/01..04`. Two audiences: builders (implement exactly this) and a code-blind test agent (asserts exactly this, using a fake Meta HTTP server). Where the spec left a detail open, this document fixes it; every such choice is listed in section 8.

Words: MUST/MUST NOT are binding. "Graph request" means an HTTP request the server sends to the Graph base URL (or rupload URL) as seen by the fake server. Paths in this document are written without the version prefix; the wire path is `/{graph_api_version}{path}` (section 1.4).

Table of contents: 1 Global conventions - 2 Tools (42) - 3 CLI - 4 HTTP transport - 5 Webhook receiver - 6 Media host - 7 Unverified upstream facts - 8 Decisions made in this contract.

---

## 1. Global conventions

### 1.1 Launching

| Mode | Command | Notes |
|---|---|---|
| stdio MCP server | `node dist/cli.js serve` (also `node dist/cli.js` with no args) | stdout carries only MCP protocol. stderr is free-form logs (never secrets). |
| Streamable HTTP | `node dist/cli.js serve --http --port N` | MCP endpoint is `POST/GET/DELETE /mcp`. `--port 0` picks an ephemeral port. |
| Daemon | `node dist/cli.js daemon [--http] [--port N]` | Scheduler loop, webhook receiver, optional MCP over HTTP. |
| One-shot scheduler | `node dist/cli.js scheduler run-once` | Section 3. |

Readiness signal for HTTP listeners (`serve --http`, `daemon` when it listens): exactly one line on stderr, JSON, as soon as the socket is bound: `{"event":"listening","host":"127.0.0.1","port":<n>,"transport":"http"}`. Tests MUST read this to learn the real port. A daemon listens iff `--http` is given or `webhooks.enabled` is true. Startup failures exit non-zero with a one-line message on stderr and nothing on stdout.

Exit codes for `serve` and `daemon` startup: 0 normal shutdown (SIGTERM/SIGINT), 1 startup refusal (unreadable or invalid config, world-writable config file, missing HTTP bearer for `--http`, non-loopback bind without `http.allow_remote`, port in use).

### 1.2 Environment variables

| Variable | Meaning |
|---|---|
| `INSTAGRAM_MCP_HOME` | State dir (default `~/.instagram-mcp`). Created 0700 if missing. Holds `state.sqlite`, `staging/`, default `config.json`. |
| `INSTAGRAM_MCP_CONFIG` | Absolute path of config file (default `$INSTAGRAM_MCP_HOME/config.json`). |
| `INSTAGRAM_MCP_TOKEN_<ALIAS>` | Account access token (env secrets backend). `<ALIAS>` = alias uppercased with every `-` and `.` replaced by `_`. Alias grammar: `^[a-z0-9][a-z0-9_-]{0,31}$`. |
| `INSTAGRAM_MCP_APP_SECRET` | App secret. Enables `appsecret_proof` (facebook path) and webhook signature verification. |
| `INSTAGRAM_MCP_HTTP_TOKEN` | Bearer token required by HTTP transport. |
| `INSTAGRAM_MCP_WEBHOOK_VERIFY_TOKEN` | Webhook verify token (decision D4: the spec lists the stored kind but no env name). |
| `INSTAGRAM_MCP_GRAPH_URL_INSTAGRAM` | Replaces scheme+host(+port) of the instagram-path Graph base (section 1.4). |
| `INSTAGRAM_MCP_GRAPH_URL_FACEBOOK` | Same for the facebook path. |
| `INSTAGRAM_MCP_RUPLOAD_URL` | Replaces `https://rupload.facebook.com`. |
| `INSTAGRAM_MCP_POLL_INTERVAL_MS` | Container polling interval (integer >= 1, default 2000). |
| `INSTAGRAM_MCP_TEST_MODE` | `1` enables test affordances: honoring `INSTAGRAM_MCP_NOW`, and loopback http media URLs (section 1.11). Any other value or unset = off. |
| `INSTAGRAM_MCP_NOW` | ISO 8601 instant. Honored only when `INSTAGRAM_MCP_TEST_MODE=1`; otherwise ignored. When honored the process clock is FROZEN at that instant (it does not advance). The clock governs: `expires_at`, approval expiry, `created_at` fields, scheduler decisions, "days" windows, hashtag budget windows, messaging windows. It does NOT govern network timeouts, retry back-off, or polling sleeps (real timers). |

Env overrides (`GRAPH_URL_*`, `RUPLOAD_URL`, `POLL_INTERVAL_MS`) are honored always, not only in test mode. Override values MUST be `http://` or `https://` URLs without path/query; otherwise startup exits 1 (CONFIG_INVALID message on stderr).

The env secrets backend (`secrets.backend: "env"`) is read-only. With it the server MUST NOT call any token exchange/refresh endpoint.

### 1.3 Minimal config

`$INSTAGRAM_MCP_HOME/config.json` (or `INSTAGRAM_MCP_CONFIG`). Unknown top-level keys are rejected (startup exit 1). Fields not shown take the spec defaults.

```json
{
  "graph_api_version": "v26.0",
  "default_account": "main",
  "accounts": [
    { "alias": "main", "login": "instagram", "ig_user_id": "17841400000000001", "page_id": null },
    { "alias": "fb", "login": "facebook", "ig_user_id": "17841400000000002", "page_id": "100000000000001" }
  ],
  "app": { "app_id": "1234567890" },
  "secrets": { "backend": "env" },
  "policy": { "read_only": false, "dry_run": false, "disabled_actions": [], "approval_ttl_seconds": 600, "allow_human_agent_tag": false, "verify_remote_media": false, "confirm_via_elicitation": true },
  "local_media_dirs": ["~/.instagram-mcp/media"],
  "media_host": { "public_base_url": "http://127.0.0.1:18766", "port": 18766 },
  "http": { "host": "127.0.0.1", "port": 8765, "allow_remote": false, "allowed_origins": [] },
  "scheduler": { "container_lead_minutes": 10, "missed_grace_minutes": 60 },
  "webhooks": { "enabled": false, "path": "/webhooks/instagram" },
  "token_in_header": false,
  "downloads_dir": null
}
```

New keys (security review 2026-10-29): `local_media_dirs` (string[], default `["<INSTAGRAM_MCP_HOME>/media"]`, `~` expanded; the only directories local publish media/cover files may come from, see 2.3); `policy.verify_remote_media` (boolean, default `false`; when `false` preflights make NO outbound non-Meta request, see 1.11); `policy.confirm_via_elicitation` (boolean, default `true`; see 1.13.3).

Validation (startup, exit 1): `local_media_dirs` is an array of non-empty strings; `policy.verify_remote_media` and `policy.confirm_via_elicitation` are booleans; `graph_api_version` matches `^v[0-9]+\.[0-9]+$`; aliases unique and match the grammar; `login` is `instagram|facebook`; `login:"facebook"` requires non-null `page_id`; `default_account`, when set, names a configured alias; `policy.disabled_actions` members must be action names from 1.13.1; `policy.approval_ttl_seconds` integer 1..86400; `scheduler.container_lead_minutes` integer 0..1380; `scheduler.missed_grace_minutes` integer >= 0; `media_host.public_base_url` is null or an http(s) URL (trailing `/` trimmed); `http.host` loopback unless `http.allow_remote:true`; `token_in_header` boolean (when true, the instagram path sends the token as `Authorization: Bearer` instead of query). A config file with mode `& 0o002` (world-writable) is refused. Zero accounts is legal: the server starts and every account-resolving tool returns `CONFIG_INVALID`.

### 1.4 Graph URL construction and token placement

Base URL per account:

| login | default base | override env |
|---|---|---|
| `instagram` | `https://graph.instagram.com` | `INSTAGRAM_MCP_GRAPH_URL_INSTAGRAM` |
| `facebook` | `https://graph.facebook.com` | `INSTAGRAM_MCP_GRAPH_URL_FACEBOOK` |

**Override rule (decision D1):** the override REPLACES scheme+host+port only. The version segment is always appended. With override `http://127.0.0.1:9999` and `graph_api_version` `v26.0`, a call to path `/17841400000000001/media` goes to `http://127.0.0.1:9999/v26.0/17841400000000001/media`. Same for rupload: `{INSTAGRAM_MCP_RUPLOAD_URL or https://rupload.facebook.com}/ig-api-upload/{ver}/{container_id}`. A trailing `/` on the override is tolerated and ignored.

Request encoding (all Graph requests):

- GET: all parameters in the query string.
- POST and DELETE: all non-credential parameters in an `application/x-www-form-urlencoded` body; the query string carries only credentials. Tests MUST merge query + form body when asserting parameters.
- Parameters whose Graph type is array/object are sent as a JSON string (e.g. `collaborators=["a","b"]`, `user_tags=[{"username":"a","x":0.5,"y":0.5}]`). `children` is comma-separated container ids. Booleans are the strings `true`/`false`. Integers are decimal strings. Absent optional inputs are omitted (never sent empty).
- Query parameter order is not significant.

Credential placement as observed by the fake server:

| login | Token | appsecret_proof |
|---|---|---|
| `instagram` | query `access_token=<token>` (header `Authorization: Bearer <token>` instead if `token_in_header:true`) | never sent |
| `facebook` | header `Authorization: Bearer <token>`; no `access_token` query param | query `appsecret_proof=<lowercase hex HMAC-SHA256(key=app secret, msg=token)>` on EVERY request iff `INSTAGRAM_MCP_APP_SECRET` is set; omitted otherwise |
| rupload (facebook) | header `Authorization: OAuth <token>` | not sent |

The `/me` check used by `doctor` and `auth status --check`: instagram path `GET /me?fields=user_id,username`; facebook path `GET /{ig_user_id}?fields=id,username`.

Request timeouts: 30 s Graph, 120 s rupload. A timeout counts as a network error.

### 1.5 Result envelopes

Every tool result is an MCP `CallToolResult`.

Success: `isError` absent/false; `structuredContent` = the documented result object; `content` = exactly one `{type:"text"}` item whose text is a single non-empty line (no `\n`) of at most 300 chars.

Error: `isError: true`; `structuredContent = { "error": { "code": <ErrorCode>, "message": <string>, "action"?: <string>, "retryable": <boolean>, "details"?: <object> } }`; `content` = one text item `"<CODE>: <message>"` (single line).

All input validation failures, including schema violations (missing required field, wrong type, unknown property, out-of-range), are returned as the error envelope with code `INVALID_INPUT` and `details.issues = [{path: string, message: string}]`. They MUST NOT surface as JSON-RPC protocol errors. Unknown input properties are rejected (strict objects).

Field naming: contract-defined fields are snake_case. Fields passed through from Meta keep Meta's names and values. Meta fields that were requested but absent from the Meta response are `null` in results (arrays that were requested and absent: `[]` where stated). Locally generated timestamps are `Date.toISOString()` UTC (`2026-10-29T12:00:00.000Z`). Meta-provided timestamps are passed through unmodified. Input timestamps accept ISO 8601 with `Z` or numeric offset, or a date-only `YYYY-MM-DD` (= 00:00:00Z); anything else is `INVALID_INPUT`. When converted to Meta's `since`/`until` they become integer Unix seconds.

Ids that go into URL paths (`media_id`, `comment_id`, `conversation_id`, `creation_id`, `hashtag_id`) MUST match `^[A-Za-z0-9_-]{1,64}$`, else `INVALID_INPUT` (no request is made).

### 1.6 Error codes

All 23 codes. `retryable` is the value in the envelope.

| Code | When | retryable |
|---|---|---|
| `CONFIG_INVALID` | No account resolvable (1.10); zero accounts configured. | false |
| `AUTH_REQUIRED` | Resolved account has no token in the secrets backend (env var unset/empty). `action` names the env var `INSTAGRAM_MCP_TOKEN_<ALIAS>`. | false |
| `AUTH_FAILED` | Meta error 190 (not expired subcodes) or HTTP 401 without a Meta error body. | false |
| `TOKEN_EXPIRED` | Meta error 190 with `error_subcode` 463 or 467. `action` says to re-authenticate. | false |
| `MISSING_PERMISSION` | Meta error 10 or 200-299 (except the special cases in 1.7). | false |
| `ACCOUNT_NOT_ALLOWED` | `account` input is not a configured alias. `details.allowed` lists aliases. | false |
| `CAPABILITY_UNAVAILABLE` | Feature is `no` for the account's login path, or cached `no` after a probe (1.12). `details = {feature, login}`; `action` names the other login path. | false |
| `POLICY_DENIED` | `policy.read_only`, or action in `policy.disabled_actions` (1.13.4). `details = {action, reason: "read_only"|"disabled_action"}`. | false |
| `INVALID_INPUT` | Schema/semantic validation failure, Meta error 100 (non-not-found). | false |
| `NOT_FOUND` | Target absent: Meta 803/110/24, Meta 100+subcode 33, HTTP 404, local lookups (operation, job, empty hashtag search). | false |
| `RATE_LIMITED` | Meta 4/17/32/613/80002 or HTTP 429 after retries exhausted (GET) or on first failure (writes). `details.retry_after_seconds` when known. | true |
| `PUBLISH_QUOTA_EXHAUSTED` | Preflight sees `quota_usage >= quota_total`; or Meta error 9 with subcode 2207042 at publish. | false |
| `MESSAGING_WINDOW_CLOSED` | No user message within 24 h (or 7 d private reply); or Meta error 10 with subcode 2534022. | false |
| `HASHTAG_BUDGET_EXHAUSTED` | 30 distinct hashtags already queried in the trailing 7 days and this one is new. | false |
| `APPROVAL_NOT_FOUND` | `approval_id` unknown. | false |
| `APPROVAL_EXPIRED` | Approval pending past `expires_at`. | false |
| `APPROVAL_ALREADY_USED` | Approve while the same approval is currently `running` (concurrent). | false |
| `STALE_PREVIEW` | Target changed/vanished between preflight and approve (1.13.6). | false |
| `UPSTREAM_REJECTED` | Any other Meta 4xx rejection incl. 9007 / subcode 2207xxx, container `ERROR`/`EXPIRED`. `details.meta` present. | false |
| `UPSTREAM_TRANSIENT` | HTTP 5xx, network error/timeout, Meta codes 1/2 (after retries for GET). | true |
| `OUTCOME_UNKNOWN` | A non-idempotent write may or may not have happened (1.13.8). Always has `details.reconcile` and `action` containing `instagram_get_operation`. | false |
| `MEDIA_HOST_UNAVAILABLE` | Local file needs the media host but `media_host.public_base_url` is null, or the media port cannot be bound. | false |
| `INTERNAL` | Bug/unexpected exception. Message never contains secrets. | false |

### 1.7 Meta error to error-code mapping

Applied to a Meta error body `{"error":{"message","type","code","error_subcode","fbtrace_id"}}` (any HTTP status), first matching row wins. `details.meta = {code, subcode, fbtrace_id, http_status}` is always attached (no token, message redacted).

| # | Condition | Code |
|---|---|---|
| 1 | code 9 and subcode 2207042 | `PUBLISH_QUOTA_EXHAUSTED` |
| 2 | code 10 and subcode 2534022 | `MESSAGING_WINDOW_CLOSED` |
| 3 | code 10 and message contains "enough viewers" (case-insens.) | `UPSTREAM_REJECTED` |
| 4 | code 9007 or subcode begins `2207` | `UPSTREAM_REJECTED` |
| 5 | code 190 and subcode in {463, 467} | `TOKEN_EXPIRED` |
| 6 | code 190 | `AUTH_FAILED` |
| 7 | code 10 or 200 <= code <= 299 | `MISSING_PERMISSION` |
| 8 | code in {4, 17, 32, 613, 80002} | `RATE_LIMITED` |
| 9 | code in {1, 2} | `UPSTREAM_TRANSIENT` |
| 10 | code 803, 110, 24; or code 100 and subcode 33; or HTTP 404 | `NOT_FOUND` |
| 11 | code 100 | `INVALID_INPUT` |
| 12 | any other body with HTTP 4xx | `UPSTREAM_REJECTED` |

Without a Meta error body: HTTP 401 -> `AUTH_FAILED`; 429 -> `RATE_LIMITED`; 404 -> `NOT_FOUND`; other 4xx -> `UPSTREAM_REJECTED`; 5xx, network error, timeout, unparsable body on 2xx -> `UPSTREAM_TRANSIENT`.

### 1.8 Retry behaviour (observable)

- GET only. A GET is retried on: network error/timeout, HTTP 429, HTTP 5xx, or a Meta error body with code in {1, 2, 4, 17, 32, 613, 80002} (any HTTP status). Max 4 attempts total (3 retries), so a persistently failing GET produces exactly 4 identical requests.
- Delay between attempts: full-jitter exponential (`random(0, min(30000, 500 * 2^(attempt-1)))` ms) but never below 1 ms. When the response carries `Retry-After` (integer seconds or HTTP-date) the delay is `max(that, jitter delay)`. If `Retry-After` exceeds 30 s the server does NOT retry and fails immediately with `RATE_LIMITED`, `details.retry_after_seconds` set.
- POST, DELETE and rupload requests are NEVER retried. A write that fails is not repeated; there is exactly one request.
- After the final failed GET the error is mapped per 1.7.
- Response headers `x-business-use-case-usage` and `x-app-usage` of EVERY Graph response are parsed and remembered per account (see `instagram_get_rate_limits`).

### 1.9 Pagination

List tools accept `limit` (integer, default 25, max 100; `instagram_list_comments` max 50; `instagram_get_conversation` max 20; values outside 1..max are `INVALID_INPUT`) and `cursor` (opaque string; clients MUST NOT parse it). Result field `next_cursor` is a string, or `null` when there are no more items. For Graph-backed lists: `limit` is sent as Graph `limit`; a `cursor` is decoded to Meta's `after` value and sent as `after=<that exact Meta cursor string>`; `next_cursor` is non-null iff the Meta response has `paging.next` AND `paging.cursors.after`, and it encodes that `after` value. A tampered/garbled cursor is `INVALID_INPUT`. Local lists (operations, scheduled) page over SQLite in the documented order.

### 1.10 `account` parameter

Tools that take `account` accept an alias string. Resolution:

1. `account` given and exactly equal to a configured alias -> that account.
2. `account` given and not a configured alias (including an `ig_user_id` value) -> `ACCOUNT_NOT_ALLOWED`.
3. `account` omitted: `default_account` if configured; else the only account if exactly one is configured; else `CONFIG_INVALID` (`action`: set `default_account` or pass `account`).

Tools without `account`: `instagram_list_accounts`, `instagram_get_operation`, `instagram_approve`, `instagram_cancel_scheduled`. For `instagram_list_operations` and `instagram_list_scheduled` `account` is a FILTER (unknown alias is `ACCOUNT_NOT_ALLOWED`; omitted = all accounts). Tools never accept `ig_user_id`.

### 1.11 Validation order and common media-URL rules

Order of checks in every tool: (1) schema/strict validation -> `INVALID_INPUT`; (2) account resolution; (3) for preflights and approve: policy -> `POLICY_DENIED`; (4) capability -> `CAPABILITY_UNAVAILABLE`; (5) token present -> `AUTH_REQUIRED`; (6) semantic checks needing no network; (7) Graph/network checks. The first failure wins and no later step's requests are made.

Remote URL rules (publish media/cover, DM media): must be `https://`; no credentials; host must not be a loopback-style name (`localhost`, `*.localhost`, `*.local`, `*.internal`) or an IP literal in a non-public range. IP literals are parsed in every form (dotted, decimal/octal/hex IPv4, IPv6, IPv4-mapped in dotted or hex form such as `[::ffff:7f00:1]`, IPv4-compatible `::/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo `2001::/32`) and blocked when the address (or the embedded IPv4) is loopback, private, link-local, CGNAT `100.64.0.0/10`, `0.0.0.0/8`, multicast, reserved, unique-local, documentation or otherwise non-global. These are SYNTAX rules: **by default (`policy.verify_remote_media: false`) preflights perform no DNS lookup and send no request of any kind to a remote media URL** (publish media/cover and DM media), and add the warning `MEDIA_UNVERIFIED` for every such URL. With `policy.verify_remote_media: true` the host name is resolved ONCE, every returned address must be public (else `INVALID_INPUT`), and the connection (publish media/cover `HEAD`; downloads) is made only to that validated address (no re-resolution, no redirects). Upstream `Content-Type`/`Content-Length` of a failed check are never echoed in errors (generic message only). IP-literal hosts are checked directly (`https://127.0.0.1/a.jpg`, `https://10.0.0.5/a`, `https://169.254.169.254/a`, `https://[::1]/a` are `INVALID_INPUT`). With `INSTAGRAM_MCP_TEST_MODE=1` ONLY, `http://127.0.0.1:<port>/...` and `http://localhost:<port>/...` are additionally accepted. Download fetches (`instagram_download_media`) are limited to hosts matching `*.cdninstagram.com` or `*.fbcdn.net` (and in test mode also `127.0.0.1`/`localhost`), redirects are not followed, otherwise `INVALID_INPUT`.

### 1.12 Capability matrix

`feature -> {instagram, facebook}`, values `yes | no | probe`:

| Feature | instagram | facebook | Used by |
|---|---|---|---|
| `publish_url_media` | yes | yes | all publishing |
| `publish_local_video_resumable` | no | yes | local video file publish (instagram path falls back to media host) |
| `delete_media` | probe | yes | `instagram_preflight_delete_media` |
| `business_discovery` | no | yes | `instagram_lookup_account`, `instagram_compare_accounts` (others' side) |
| `hashtag_search` | no | yes | `instagram_search_hashtag`, `instagram_get_hashtag_media` |
| `branded_content` | probe | yes | publish with `is_paid_partnership` / `branded_content_sponsor_ids` |
| `story_insights_webhook` | no | yes | informational |
| `messaging` | yes | probe | DM tools, `private_reply` op, messaging profile (facebook path: Messenger Platform endpoints on the Page, see 2.5) |
| `collab_invites` | probe | yes | collab invite tools |

`no` -> `CAPABILITY_UNAVAILABLE` before any Graph request (at preflight for preflight tools). `probe` -> attempt; if the Graph call fails with a mapped `MISSING_PERMISSION`, or Meta code 3, or Meta code 100 whose message matches `/unsupported|not supported|does not support/i`, then record `no` for (account, feature) in SQLite (`capability_cache`) and return `CAPABILITY_UNAVAILABLE` (from a preflight, or as the failed approve error). A cached `no` makes later calls return `CAPABILITY_UNAVAILABLE` with zero Graph requests, including across process restarts with the same `INSTAGRAM_MCP_HOME`. A successful probe is not cached.

### 1.13 Preflight / approve protocol

#### 1.13.1 Actions

Action names (also used in `policy.disabled_actions`, `instagram_list_operations.action`, and the `action` field of results):

| Action | Preflight tool |
|---|---|
| `publish` | `instagram_preflight_publish` |
| `delete_media` | `instagram_preflight_delete_media` |
| `set_comments_enabled` | `instagram_preflight_set_comments_enabled` |
| `comment_actions` | `instagram_preflight_comment_actions` |
| `reply_mention` | `instagram_preflight_reply_mention` |
| `send_message` | `instagram_preflight_send_message` |
| `set_messaging_profile` | `instagram_preflight_set_messaging_profile` |
| `respond_collab_invite` | `instagram_preflight_respond_collab_invite` |

#### 1.13.2 Preflight result

Every `instagram_preflight_*` tool is read-only toward Instagram (GET only; a `HEAD` to user media URLs for publish only when `policy.verify_remote_media` is true) and returns:

```
{ approval_id: string,            // ^appr_[A-Za-z0-9_-]{22,}$
  expires_at: string,             // ISO, clock + policy.approval_ttl_seconds
  action: <action name>,
  account: <alias>,
  preview: object,                // per tool
  planned_calls: [ { method: "GET"|"POST"|"DELETE", path: string, params: object } ],
  warnings: string[],
  summary: string,                // server-written plain-language summary of the stored preview (same text shown at approve confirmation, 1.13.3)
  dry_run: boolean }              // = policy.dry_run
```

`summary` is generated by the server from the stored preview only (never from agent-supplied prose). Format: first line `Action: <action> | Account: <alias>`; then for `publish`: kind and scheduled time, caption (first 200 chars), and one line per media item and the cover with `LOCAL FILE <path> -> real path <real_path> (<bytes> bytes, sha256 <first 12 hex>...)` or `URL <url>`; for `send_message`: recipient, text (first 200 chars), media URL, quick replies (title and payload), reply_to_mid, reaction (action, emoji, target message id), tag; for other actions: `key: value` lines of the preview.

`planned_calls` is the exact ordered list of Graph requests that approve will send (reads and writes, including the stale-check reads and the post-publish permalink read), with `path` excluding the version prefix, `params` containing every non-credential parameter exactly as it would be sent (strings; objects stay JSON strings as in 1.4), and runtime-dependent values written as placeholders `{container_id}`, `{child_N_container_id}` (N 1-based), `{media_id}`. Local media files appear as the string `<media-host-url:N>` (N = 1-based index in `media`; `<media-host-url:cover>` for a cover). Poll GETs appear once (real polls repeat). No token/secret ever appears. Scheduled publishes list the calls the scheduler will later send. Preflight requests are made at preflight time; approve makes only the `planned_calls` (plus the repeats noted).

Warnings are strings starting with a stable code and `: `: `QUOTA_NEAR_LIMIT` (usage >= 90%), `MEDIA_UNVERIFIED` (remote media could not be verified), `DURATION_UNKNOWN`, `ALREADY_IN_STATE`, `COMMENT_HIDDEN`, `HUMAN_AGENT_TAG`, `TITLE_TRUNCATED`, `TIMEFRAME_OVERRIDES_RANGE`. Other warnings are free text.

#### 1.13.3 Approve

Tool `instagram_approve`, input `{approval_id: string, confirm: true}` (`confirm` must be literal `true`, else `INVALID_INPUT`).

**Human confirmation (elicitation).** If the connected MCP client advertises the `elicitation` capability AND `policy.confirm_via_elicitation` is true (default), then for a `pending` approval that passed the policy, capability and hash checks, and when `policy.dry_run` is false, `instagram_approve` first sends an MCP elicitation request whose message is the approval's `summary` text (1.13.2, built from the stored preview) followed by `Approve and execute this action?`, with a required boolean field `approve`. Only `action:"accept"` with `approve:true` continues. `decline`, `cancel`, `approve:false` or a failed elicitation request -> plain error `POLICY_DENIED` with `details.reason` = `"declined_by_user"` (decline/cancel/false) or `"elicitation_failed"` (request failed); nothing is executed and the approval STAYS `pending` (it can be approved later until it expires). Clients without the `elicitation` capability, `policy.confirm_via_elicitation:false` and `dry_run` behave exactly as before (no prompt). Replays of finished approvals never prompt.

Result:

```
{ approval_id, operation_id,        // ^op_[A-Za-z0-9_-]{22,}$
  action,
  status: "succeeded" | "failed" | "unknown" | "dry_run",
  result?: object,                  // when succeeded
  error?: { code, message, action?, retryable, details? },   // when failed/unknown
  items?: [ { index, op, status: "succeeded"|"failed"|"unknown", result?, error? } ],  // comment_actions only
  planned_calls?: [...],            // dry_run only
  replayed?: true }                 // when returned from the stored outcome
```

`isError` is false for `succeeded` and `dry_run`; true for `failed` and `unknown`. For `failed`/`unknown` the structuredContent is the object above (so `structuredContent.error.code` is always present on errors) and `content` text is `"<CODE>: <message>"`. Errors that occur before an operation exists (`APPROVAL_NOT_FOUND`, `APPROVAL_EXPIRED`, `APPROVAL_ALREADY_USED`, `STALE_PREVIEW` before any write, `POLICY_DENIED`, `INVALID_INPUT`) use the plain error envelope (no `operation_id`/`status`).

#### 1.13.4 Policy

- `policy.read_only: true`: every preflight tool returns `POLICY_DENIED` (no Graph request, no approval row). `instagram_approve` also returns `POLICY_DENIED` for any pending approval. Local tools (`mark_handled`, `cancel_scheduled`, `download_media`, `backup_account`, `snapshot_insights`) are not affected.
- `policy.disabled_actions` containing the action: that action's preflight (and approve of an existing approval for it) returns `POLICY_DENIED`.
- `policy.dry_run: true`: preflights behave normally (they are read-only); `instagram_approve` sends NO Graph/rupload request at all (no stale re-reads, no staging, no polling) and returns `{approval_id, operation_id, action, status:"dry_run", planned_calls}` (copy of the preflight list), `isError` false. An operation row with status `dry_run` is recorded. The approval is consumed (repeat approve replays).

#### 1.13.5 State machine

Approval status: `pending -> running -> {succeeded|failed|unknown|dry_run}`; `pending -> expired`; `pending -> stale`.

| Approve on... | Outcome |
|---|---|
| unknown id | `APPROVAL_NOT_FOUND` |
| `pending`, `now >= expires_at` | row set `expired`; `APPROVAL_EXPIRED` (repeat -> same) |
| `pending`, valid | compare-and-set to `running`, execute |
| `running` (concurrent call) | `APPROVAL_ALREADY_USED` |
| finished (`succeeded|failed|unknown|dry_run`) | stored outcome returned, `replayed: true`, ZERO Graph requests, same `operation_id` |
| `stale` | the stored `STALE_PREVIEW` error returned again, zero requests |

#### 1.13.6 Stale checks

Approve re-reads the target (these GETs are in `planned_calls`) and returns `STALE_PREVIEW` (approval becomes `stale`, nothing written) when the target is gone (Graph answers `NOT_FOUND`). For `publish` with local files (media AND cover), approve re-resolves each path (it must still be inside `local_media_dirs` and still resolve to the same `real_path`) and re-hashes each file; missing, moved, re-pointed or changed (size or sha256 differs from preflight) -> `STALE_PREVIEW`. For `comment_actions` a vanished comment fails only that item with `STALE_PREVIEW` and the batch continues. No other staleness checks exist.

#### 1.13.7 Operation ledger

Every approve that passes `pending -> running` creates an operation (`op_...`). Scheduler-driven publishes create their own operation (origin `scheduler`). `instagram_get_operation` and `instagram_list_operations` read them (2.1).

#### 1.13.8 Ambiguous outcomes

Operation status `unknown` + error `OUTCOME_UNKNOWN` is produced when a NON-idempotent write ends with a network error, timeout, or HTTP 5xx. Currently the only write with a defined reconcile path is `media_publish`; for every other write an ambiguous failure also yields `unknown` with `details.reconcile = {operation_id}` and no automatic reconcile. HTTP 4xx and Meta error bodies on writes are definite failures (`failed`), including 429.

### 1.14 Redaction

No output of any kind (tool results, error messages, `details`, `planned_calls`, CLI stdout/stderr, logs, SQLite, `audit_log`) may contain: any `INSTAGRAM_MCP_TOKEN_*` value, `INSTAGRAM_MCP_APP_SECRET`, `INSTAGRAM_MCP_HTTP_TOKEN`, `INSTAGRAM_MCP_WEBHOOK_VERIFY_TOKEN`, any computed `appsecret_proof`, or the substrings `access_token=<value>`, `appsecret_proof=<value>`, `client_secret=<value>`, `Bearer <value>`. If a fake server echoes a token or proof inside an error message/body/header, the server MUST replace every occurrence (case-sensitive exact value) with `[REDACTED]` before surfacing it. Redaction also applies to a token value that appears URL-encoded. The `staged media token` in `/m/<token>` URLs is not a secret but also never appears in any tool output.

### 1.15 Tool annotations

`tools/list` MUST return exactly the 42 tools of section 2, each with a non-empty `description`, an `inputSchema`, and annotations: `readOnlyHint` true for all reads, all preflights and local read-only tools; false for `instagram_approve`, `instagram_download_media`, `instagram_backup_account`, `instagram_cancel_scheduled`, `instagram_mark_handled`, `instagram_snapshot_insights`. `destructiveHint: true` only on `instagram_approve` and `instagram_cancel_scheduled`. `openWorldHint: true` on every tool that can issue a Graph/CDN request (all except `instagram_list_accounts`, `instagram_list_operations`, `instagram_list_scheduled`, `instagram_cancel_scheduled`, `instagram_mark_handled`, `instagram_get_growth`).

---

## 2. Tools

Conventions for this section. `{IG}` = the account's `ig_user_id`. "Requests" lists Graph requests per login path; where only one line is given it is identical for both paths (the path differs only in base URL/credentials, 1.4). "A" = takes optional `account`. Result fields typed `string|null` are present with `null` when unknown. A list result is `{items: [...], next_cursor: string|null}` plus the extras shown.

### 2.1 Account, auth, ops (6)

#### instagram_list_accounts
Purpose: configured accounts and resolved capabilities. No input fields. No Graph requests. Capabilities: none.
Result: `{ accounts: [ { alias, login: "instagram"|"facebook", ig_user_id, page_id: string|null, default: boolean, token: { present: boolean, source: "env", expires_at: null, scopes: null }, capabilities: { <feature>: "yes"|"no"|"probe" } } ] }`. `capabilities` has the nine feature keys of 1.12; a `probe` feature with a cached `no` shows `"no"`. `default` is true for the account that resolution 1.10 step 3 would choose (when one exists). Errors: none expected (`INTERNAL`). Never contains token values.

#### instagram_get_profile (A)
Request: `GET /{IG}?fields=id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url` plus `,account_type` on the instagram path only.
Result: `{ id, username, name, biography, website, followers_count, follows_count, media_count, profile_picture_url, account_type }` (`account_type` is `null` on the facebook path). Errors: auth/mapping per 1.7.

#### instagram_get_rate_limits (A)
Request: `GET /{IG}/content_publishing_limit?fields=quota_usage,config`. Meta shape: `{"data":[{"quota_usage":N,"config":{"quota_total":50,"quota_duration":86400}}]}` (first element used).
Result:
```
{ publishing: { quota_usage: number, quota_total: number, quota_duration_seconds: number, remaining: number } | null,
  usage: { business_use_case: object|null, app: object|null, observed_at: string|null },
  hashtag_budget: { used: number, limit: 30, remaining: number, window_days: 7 } | null }
```
`usage.business_use_case` = the first array element for key `{IG}` of the most recent parsed `x-business-use-case-usage` header for this account (including the response to this very call), else `null`; `usage.app` = parsed `x-app-usage` JSON object, else `null`; `observed_at` = clock when last seen. `hashtag_budget` is `null` on the instagram path; on the facebook path it is computed from SQLite (distinct hashtags queried in the trailing 7 days). `publishing` is `null` only if Meta returns no data entry.

#### instagram_get_operation
Input: `id` (string, required; an `op_...` or `appr_...` id), `reconcile` (boolean, default true). No `account`.
Result: `{ approval_id, operation_id: string|null, action, account, origin: "approve"|"scheduler"|null, status: "pending"|"expired"|"running"|"succeeded"|"failed"|"unknown"|"dry_run", created_at, finished_at: string|null, preview?: object, result?: object, error?: object, items?: array, reconciliation?: { checked_at, container_status: string|null, resolved: boolean } }`. For a never-approved approval id: `status` `pending` (or `expired` when past `expires_at`), `operation_id` null. A `stale` approval reports `status:"failed"` with error `STALE_PREVIEW`. Unknown id -> `NOT_FOUND`. Operation id given -> the approval's data is joined in.
Reconciliation (only when `reconcile` true, status `unknown`, action `publish`, and the stored error has `details.reconcile.creation_id`): one attempt per call:
1. `GET /{creation_id}?fields=status_code`.
2. `PUBLISHED` -> additionally `GET /{IG}/media?fields=id,permalink,timestamp&limit=1`; operation becomes `succeeded` with `result = {creation_id, media_id, permalink, reconciled: true}` where `media_id`/`permalink` come from the first item iff its `timestamp` >= operation start minus 120 s, else both `null`. Persisted: subsequent calls return `succeeded` with zero requests.
3. `ERROR` or `EXPIRED` -> operation becomes `failed` with error `UPSTREAM_REJECTED` (details.container_status).
4. `FINISHED`, `IN_PROGRESS`, container `NOT_FOUND`, or any request failure -> stays `unknown`; `reconciliation.resolved=false`.
A scheduler-originated unknown publish is reconciled the same way and also updates the scheduled job (`published`/`failed`).

#### instagram_list_operations
Input: `action` (action name), `status` (one of the statuses above except pending/expired), `account` (filter), `since`, `until` (ISO, on `created_at`), `limit`, `cursor`. No Graph requests.
Result: list of `{ operation_id, approval_id, action, account, origin, status, created_at, finished_at, summary: string }`, newest `created_at` first (ties by `operation_id` descending). Only operations (approved executions, including dry_run and scheduler-originated) appear; pending/expired approvals do not.

#### instagram_approve
Contract in 1.13.3-1.13.8. Input `{approval_id, confirm}`. Requests: the `planned_calls` of the approval. Errors: 1.13.5 table plus any mapped Graph error recorded inside `error` of a `failed` result.

### 2.2 Media and archive (5)

Media object fields (Meta names) used below:
`MEDIA_LIST_FIELDS = id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url,is_comment_enabled`.

#### instagram_list_media (A)
Input: `media_product_type` (`FEED|REELS|STORY|AD`, optional, client-side filter), `since`, `until` (ISO), `limit`, `cursor`.
Request: `GET /{IG}/media?fields=<MEDIA_LIST_FIELDS>&limit=<limit>[&since=<unix>][&until=<unix>][&after=<meta cursor>]`.
Result: list of media objects with exactly the `MEDIA_LIST_FIELDS` keys (missing -> null). The product-type filter is applied after fetching each page, so a page can hold fewer than `limit` items while `next_cursor` is non-null. Side effect: each returned id is upserted into `media_index`.

#### instagram_get_media (A)
Input: `media_id` (required).
Request: `GET /{media_id}?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url,is_comment_enabled,is_shared_to_feed,shortcode,alt_text,username,children{id,media_type,media_url,thumbnail_url}`.
Result: `MEDIA_LIST_FIELDS` keys plus `is_shared_to_feed, shortcode, alt_text, username` and `children: [ {id, media_type, media_url, thumbnail_url} ]` (`[]` when none). Errors: `NOT_FOUND` for unknown id.

#### instagram_list_stories (A)
Input: `limit`, `cursor`. Request: `GET /{IG}/stories?fields=id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url&limit=<limit>[&after=...]`. Result: list of objects with those keys.

#### instagram_download_media (A)
Purpose: save own media locally. Local write only; not an approval action; allowed under `read_only`.
Input: `media_id` (required), `include_children` (bool, default true), `include_thumbnail` (bool, default true).
Requests: `GET /{media_id}?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,media_url,thumbnail_url,username,children{id,media_type,media_url,thumbnail_url}`; then one plain `GET` per file to the media's CDN URL (host rule 1.11; no credentials sent). No other Graph requests.
Files (root = `downloads_dir` or `$INSTAGRAM_MCP_HOME/downloads`; `<date>` = UTC `YYYY-MM-DD` of `timestamp`; `<username>` = `username` field, falling back to the account alias; both sanitized to `[A-Za-z0-9._-]`, other chars -> `_`):
- single media: `<root>/<username>/<date>_<id>.<ext>`
- carousel children: `<date>_<id>_<n>.<ext>` (n = 1-based child index, `<id>` = parent id)
- thumbnail (VIDEO `thumbnail_url`): `<date>_<id>_thumb.jpg` (children thumbnails: `<date>_<id>_<n>_thumb.jpg`)
- sidecar: `<root>/<username>/<id>.json`, JSON object `{id, caption, permalink, timestamp, media_type, media_product_type, like_count, comments_count, username, children:[{id,media_type}], files:[relative file names]}`.
`<ext>` from the response `Content-Type` (`image/jpeg`->`jpg`, `image/png`->`png`, `video/mp4`->`mp4`, `video/quicktime`->`mov`), else from the URL path extension, else `bin`. An existing file is not re-downloaded (`skipped: true`). Directories created 0700 as needed, files 0600. Writes are confined to the root; a path that would escape is `INVALID_INPUT`. If `media_url` is null (copyright/download-disabled) the file is omitted and a warning added.
Result: `{ media_id, username, files: [ {path: string (absolute), kind: "media"|"child"|"thumbnail", bytes: number, skipped: boolean} ], sidecar_path: string, warnings: string[] }`.
Errors: `NOT_FOUND`, `INVALID_INPUT` (non-CDN host), `UPSTREAM_TRANSIENT` (download failed).

#### instagram_backup_account (A)
Purpose: incremental backup of all own media.
Input: `max_items` (integer 1..10000, default 500).
Requests: `GET /{IG}?fields=username`; then `GET /{IG}/media?fields=id,timestamp&limit=100[&after=...]` following `paging.next` until exhausted or `max_items` reached; for each media id not already marked downloaded in `media_index`: exactly the requests and files of `instagram_download_media` (defaults); finally `GET /{IG}/insights?metric=reach,views,accounts_engaged,total_interactions&period=day&metric_type=total_value&since=<now-86400>&until=<now>` written to `<root>/<username>/insights-latest.json` (`{taken_at, metrics:{name:value}}`). Downloaded ids are marked in `media_index` after success so a re-run (or a run after a mid-way failure) skips them.
Result: `{ username, total_seen, downloaded, skipped, failed, insights_file: string|null, errors: [{media_id, error:{code,message}}] }`. A per-media failure does not abort the run. An insights failure sets `insights_file: null` and adds a warning in `errors` with `media_id: null`.

### 2.3 Publishing (6)

#### instagram_preflight_publish (A)
Action `publish`. Capabilities: `publish_url_media`; `publish_local_video_resumable` (facebook local video); `branded_content` when `is_paid_partnership` or `branded_content_sponsor_ids` is set.

Input:

| Field | Type | Req | Constraints |
|---|---|---|---|
| `kind` | `image|reel|story|carousel` | yes | |
| `media` | array of `{url?, path?, type?, alt_text?, user_tags?}` | yes | exactly one of `url`/`path` per item; image/reel/story: exactly 1 item; carousel: 2..20 items; `type` `image|video` |
| `caption` | string | no | <= 2200 chars, <= 30 hashtags, <= 20 `@`-mentions |
| `location_id` | string | no | |
| `collaborators` | string[] | no | <= 3 usernames |
| `user_tags` | `[{username, x?, y?}]` | no | x,y in [0,1]; see rules |
| `cover` | `{url?|path?}` | no | reel only; JPEG <= 8 MB |
| `thumb_offset_ms` | integer >= 0 | no | reel only |
| `share_to_feed` | boolean | no | reel only |
| `audio_name` | string | no | reel only |
| `trial_reel` | `{graduation_strategy: "MANUAL"|"SS_PERFORMANCE"}` | no | reel only |
| `is_paid_partnership` | boolean | no | not story |
| `branded_content_sponsor_ids` | string[] | no | <= 2; not story |
| `is_ai_generated` | boolean | no | not story |
| `publish_at` | ISO string | no | must be later than the clock, else `INVALID_INPUT`; makes it a scheduled job |

Applicability (violations are `INVALID_INPUT` with `details.fields`): `caption`, `location_id`, `collaborators` are not allowed for `story`; `alt_text` only for `kind:"image"`; `cover`, `thumb_offset_ms`, `share_to_feed`, `audio_name`, `trial_reel` only for `reel`; `is_paid_partnership`, `branded_content_sponsor_ids`, `is_ai_generated` not for `story`; top-level `user_tags` is for image/reel/story and equals `media[0].user_tags` (giving both is `INVALID_INPUT`); for `carousel` only per-item `media[i].user_tags` are allowed. For images, each tag requires both x and y. Media type per item: from `type`, else inferred from extension (`.jpg/.jpeg` image; `.mp4/.mov` video) or remote `Content-Type`; undeterminable -> `INVALID_INPUT` asking for `type`. Per kind: `image` needs an image, `reel` a video, `carousel` items may be image or video, `story` either.

Local-file allowlist (applies to every local `media[i].path` and to `cover.path`): the path (`~` expanded, made absolute) is resolved with realpath (symlinks followed); the result must be inside one of the (realpath'd) `local_media_dirs` and be a regular file. Otherwise `INVALID_INPUT` with `details.reason = "path_not_allowed"` and `details.allowed_dirs` (the error is identical whether or not the file exists, outside the allowed directories). A symlink inside an allowed directory that points outside is `path_not_allowed`; one that points to another file inside an allowed directory is accepted. A path lexically inside an allowed directory that does not exist is `INVALID_INPUT` `details.reason = "file_not_found"`; a directory or other non-regular file is `details.reason = "not_a_file"`. Staging reads the file by its `real_path` without following a final symlink.

Local-file validation (reads the file; no network): exists/readable; size limits image 8 MB, reel video 300 MB, story video 100 MB, carousel video 300 MB; images must start with JPEG magic `FF D8 FF` (PNG etc. -> `INVALID_INPUT` "JPEG only"); videos must have an `ftyp` box at bytes 4..8 (MP4/MOV) else `INVALID_INPUT`; feed image (`kind:"image"`) aspect ratio from the JPEG SOF header must be within 4:5..1.91:1 else `INVALID_INPUT` (not checked for story/carousel images); video duration parsed from `moov/mvhd` when readable: reel 3 s..15 min, story 3..60 s, violation -> `INVALID_INPUT`, not parsable -> warning `DURATION_UNKNOWN`. Local file on the media-host route with `public_base_url` null -> `MEDIA_HOST_UNAVAILABLE`. Local video routes: facebook path -> resumable upload (no host); instagram path -> media host. Local images always use the media host.
Remote-URL validation: rules in 1.11 (violation -> `INVALID_INPUT`). Default (`policy.verify_remote_media:false`): nothing else is checked locally, no DNS and no request is made, each remote media/cover URL adds a `MEDIA_UNVERIFIED` warning, and a remote media item whose type cannot be inferred from `type` or the URL extension is `INVALID_INPUT` asking for `type` (there is no `Content-Type` to consult). With `policy.verify_remote_media:true`: `HEAD <url>` (no redirects followed, pinned to the validated address, 1.11). 2xx: `Content-Type` must match the expected type (`image/jpeg` for images, `video/*` for video) else `INVALID_INPUT`; `Content-Length` over the limit -> `INVALID_INPUT` (generic messages, upstream values not echoed). HEAD failing/non-2xx/3xx, or a host name that does not resolve -> warning `MEDIA_UNVERIFIED`, not an error.

Preflight requests, in order: (only with `policy.verify_remote_media:true`) HEAD per remote media/cover; `GET /{IG}/content_publishing_limit?fields=quota_usage,config` -> `quota_usage >= quota_total` -> `PUBLISH_QUOTA_EXHAUSTED` (no approval created); usage >= 90% -> warning `QUOTA_NEAR_LIMIT`. Unreadable quota fields -> no error, no warning.

Result: standard preflight result (1.13.2). `preview = { kind, caption: string|null, media: [ {index (1-based, matching `<media-host-url:N>`), source: "url"|"local", url: string|null, path: string|null, real_path: string|null, type: "image"|"video", bytes: number|null, sha256: string|null, content_type: string|null} ], cover: {source: "url"|"local", url: string|null, path: string|null, real_path: string|null, bytes: number|null, sha256: string|null, content_type: string|null} | null, scheduled: boolean, publish_at: string|null, container_create_at: string|null, quota: {used, total}|null, options: object }`. For every LOCAL file (media item or cover): `path` is as given (expanded), `real_path` the resolved path, `bytes`, `sha256` and `content_type` are set; for URL items `real_path` and `sha256` are `null` (and `bytes`/`content_type` are `null` unless `verify_remote_media` learned them). `cover` is `null` when no cover was given. The approval binding covers `real_path` and `sha256` of every local file (they are part of the stored params). `container_create_at = publish_at - container_lead_minutes` (clamped to not before the clock).

Local side effects of preflight: none (no staging, no files). The approval stores real_path, size and sha256 of local files.

**Approve sequence (immediate publish).** Media-host URL for a local file: `{public_base_url}/m/{token}`, token = 43 url-safe chars (`^[A-Za-z0-9_-]{43}$`), staged and the host started before the first container request (section 6). All POSTs go to `/{IG}/media` or `/{IG}/media_publish`.

| Kind | Sequence |
|---|---|
| image | (1) `POST /{IG}/media` with `image_url`, `caption`, `alt_text`, `user_tags`, `location_id`, `collaborators`, `is_ai_generated`, `is_paid_partnership`, `branded_content_sponsor_ids` (only those provided; no `media_type`) -> `{id}`; (2) poll; (3) publish; (4) permalink read |
| reel | (1) `POST /{IG}/media` with `media_type=REELS`, `video_url` (or resumable, below), `caption`, `cover_url`, `thumb_offset` (ms), `share_to_feed`, `audio_name`, `trial_params={"graduation_strategy":"..."}`, `collaborators`, `location_id`, `user_tags`, `is_ai_generated`, partnership params; (2) poll; (3) publish; (4) permalink |
| story | (1) `POST /{IG}/media` with `media_type=STORIES` and `image_url` or `video_url`, `user_tags`; (2) poll; (3) publish; (4) permalink |
| carousel | For each child in order: `POST /{IG}/media` with `is_carousel_item=true` and `image_url` (images) or `media_type=VIDEO`+`video_url` (videos), plus the child's `user_tags` -> then poll that child until `FINISHED`. Then parent: `POST /{IG}/media` with `media_type=CAROUSEL`, `children=<id1>,<id2>,...`, `caption`, `location_id`, `collaborators`, `is_ai_generated`, partnership params (no caption/location on children) -> poll parent -> publish -> permalink. For 2 children the request order is exactly: POST child1, GET child1, POST child2, GET child2, POST parent, GET parent, POST media_publish, GET media. |

Resumable (facebook path, local video; also carousel video child): step (1) POST `/{IG}/media` with the same params but `upload_type=resumable` and no `video_url`, response `{id, uri?}`; the file bytes come from a staged copy (copied and hashed at approve; the hash must equal the approved sha256, else `STALE_PREVIEW`), never from the original path; then `POST {RUPLOAD}/ig-api-upload/{ver}/{container_id}` with headers `Authorization: OAuth <token>`, `offset: 0`, `file_size: <bytes>`, body = raw file bytes, `Content-Type: application/octet-stream`; success `{"success":true,...}`; failure -> approve `failed` `UPSTREAM_REJECTED`/`UPSTREAM_TRANSIENT` per mapping; nothing published. Then poll as usual.

Poll: `GET /{container_id}?fields=status_code`. First poll is immediate; subsequent polls wait `INSTAGRAM_MCP_POLL_INTERVAL_MS` (constant). Max polls per container = `min(300, ceil(300000 / interval))`. Statuses: `FINISHED` -> proceed; `IN_PROGRESS` and any unknown value -> keep polling; `ERROR` -> one extra `GET /{container_id}?fields=status,status_code`, then fail `UPSTREAM_REJECTED` with `details = {creation_id, status_code:"ERROR", status}`; `EXPIRED` -> fail `UPSTREAM_REJECTED` `details.status_code="EXPIRED"`; `PUBLISHED` before publish -> `unknown` / `OUTCOME_UNKNOWN`; poll limit exhausted -> `failed` `UPSTREAM_TRANSIENT` `details = {creation_id, last_status_code, timed_out:true}` and `media_publish` is NOT sent.
Publish: `POST /{IG}/media_publish` body `creation_id=<id>` -> `{id: media_id}`. Permalink read: `GET /{media_id}?fields=id,permalink` (failure here is ignored: `permalink: null`, still `succeeded`).
Result (`succeeded`): `{ kind, media_id, permalink: string|null, creation_id, child_creation_ids?: string[] }`.

Failure mapping at approve: definite Meta rejection on any step -> `failed` with mapped error (`UPSTREAM_REJECTED`, `PUBLISH_QUOTA_EXHAUSTED`, `RATE_LIMITED`, ...), `details.meta`, plus `details.creation_id` when a container exists; staged media stays until its 24 h expiry. **`media_publish` ending in a network error/timeout/HTTP 5xx -> operation `unknown`, error `OUTCOME_UNKNOWN`, `retryable:false`, `action` text mentions `instagram_get_operation`, `details.reconcile = {creation_id, operation_id}`; media_publish is not retried.** Container-creation POSTs and the rupload POST are not publishing: a network error/5xx on them is a definite `failed` with `UPSTREAM_TRANSIENT` (a stray container is harmless and never published). Reconciliation: see `instagram_get_operation`.

On success, and on any terminal failure (`failed`), staged files of this publish are deleted (their `/m/<token>` URLs then return 404); only an `unknown` outcome keeps them until their expiry. Every publish approve (and every scheduled-job creation) also first runs staging cleanup of expired files (not only the daemon).

**Scheduled (`publish_at` given).** Approve makes NO Graph request; it copies local files into `staging/` (stable copies), inserts a `scheduled_posts` row and returns `status:"succeeded"`, `result = { scheduled: true, job_id: "sched_...", publish_at, container_create_at }`. The scheduler (daemon loop or `scheduler run-once`, 3.1) later performs the same sequence as above under a new operation (origin `scheduler`). Job statuses: `scheduled` (nothing created), `containers_created`, `published`, `missed`, `failed`, `unknown`, `canceled`. Scheduler rules at clock `T`: job with `T > publish_at + missed_grace` and not yet published -> `missed`, no requests, never posted late; `status scheduled` and `T >= publish_at - container_lead` -> stage media, create containers and poll (to `containers_created`; if polling exhausts, the job stays `containers_created` with `container_ids` recorded and polling resumes on the next pass; see D13); `status containers_created` and `T >= publish_at` -> poll the not-yet-`FINISHED` container(s) per the poll rule, then `media_publish` + permalink read -> `published`; container `ERROR/EXPIRED`, definite Meta rejection -> `failed` (error stored); ambiguous `media_publish` -> `unknown`, never retried by the scheduler. A job due at `T >= publish_at` goes through all steps in a single pass.

**Claims and the no-republish rule (D33, D34).** Before processing a job a scheduler pass claims it with a compare-and-set (`claim_owner`, `claim_expires` in the job's stored data, real wall-clock TTL 120 s, renewed every 20 s while the pass works, released afterwards); a pass that cannot claim a job reports it `action:"skipped"` and does nothing to it, so two runners (daemon and `scheduler run-once`) never process the same job. `scheduler run-once` also renews its daemon lease while it works. Immediately BEFORE the `media_publish` request the job records `publish_attempted_at`. A job that has `publish_attempted_at` and no recorded result (e.g. the process died during or after `media_publish`) is never published again: the scheduler reads `GET /{creation_id}?fields=status_code` once per pass; `PUBLISHED` -> job `published` (operation `succeeded`, result `{creation_id, media_id|null, permalink|null, reconciled:true}`); any other status -> job `unknown` with `OUTCOME_UNKNOWN` (operation `unknown`, `details.reconcile.creation_id` set, resolvable via `instagram_get_operation`); if that read itself fails the job is left unchanged for the next pass. `media_publish` is never sent for such a job. A scheduled job ending `failed` also deletes its staged copies.

#### instagram_list_scheduled
Input: `status` (job status), `account` (filter), `limit`, `cursor`. No Graph requests. Result: list of `{ job_id, approval_id, operation_id: string|null (scheduler operation once started), account, kind, publish_at, container_create_at, status, container_ids: string[], media_id: string|null, error: object|null, created_at, updated_at }` ordered `publish_at` ascending (ties by `job_id`).

#### instagram_cancel_scheduled
Input: `job_id` (required), `confirm` (must be `true`, else `INVALID_INPUT`). Local only; no approval; allowed under `read_only`. Only status `scheduled` can be canceled -> job becomes `canceled`, staged copies deleted, result `{ job_id, status: "canceled" }`. Any other status -> `INVALID_INPUT` `details.status`. Unknown job -> `NOT_FOUND`.

#### instagram_preflight_delete_media (A)
Action `delete_media`. Capability `delete_media` (instagram: probe). Input: `media_id`.
Preflight requests: `GET /{media_id}?fields=id,caption,permalink,media_type,media_product_type,timestamp,like_count,comments_count`. `NOT_FOUND` if absent.
`preview = { media_id, permalink, caption, media_type, media_product_type, timestamp, like_count, comments_count }`.
Approve requests: `GET /{media_id}?fields=id,permalink` (stale check), `DELETE /{media_id}`. Result `{ media_id, deleted: true }`. On the instagram path a probe failure (1.12) yields `failed` `CAPABILITY_UNAVAILABLE` and caches `no`.

#### instagram_preflight_set_comments_enabled (A)
Action `set_comments_enabled`. Input: `media_id`, `enabled` (boolean). Preflight: `GET /{media_id}?fields=id,permalink,is_comment_enabled,media_product_type`; warning `ALREADY_IN_STATE` if equal. `preview = { media_id, permalink, current_comment_enabled: boolean|null, requested: boolean }`. Approve: `GET /{media_id}?fields=id` (stale), `POST /{media_id}` body `comment_enabled=<true|false>`. Result `{ media_id, comment_enabled: boolean }`.

#### instagram_get_publish_status (A)
Input: `creation_id`. Request: `GET /{creation_id}?fields=status_code,status`. Result `{ creation_id, status_code: "EXPIRED"|"ERROR"|"FINISHED"|"IN_PROGRESS"|"PUBLISHED"|string, status: string|null }`.

### 2.4 Comments, mentions, inbox (7)

`COMMENT_FIELDS = id,text,username,timestamp,like_count,hidden`.

#### instagram_list_comments (A)
Input: `media_id`, `include_replies` (bool, default false), `limit` (1..50), `cursor`.
Request: `GET /{media_id}/comments?fields=<COMMENT_FIELDS>[,replies{id,text,username,timestamp,like_count,hidden}]&limit=<limit>[&after=...]` (replies sub-field only when `include_replies`).
Result: list of `{ id, text, username, timestamp, like_count, hidden, replies }`; `replies` is `null` when not requested, `[]` or an array of `{id,text,username,timestamp,like_count,hidden}` when requested (Meta nests them under `replies.data`).

#### instagram_get_comment (A)
Input: `comment_id`. Request: `GET /{comment_id}?fields=id,text,username,timestamp,like_count,hidden,parent_id,media{id,media_product_type},replies{id,text,username,timestamp,like_count,hidden}`.
Result: `{ id, text, username, timestamp, like_count, hidden, parent_id, media_id: string|null, replies: [...] }` (`media_id` from `media.id`; `replies` `[]` when none).

#### instagram_get_inbox (A)
Purpose: unified triage feed. Input: `days` (integer 1..30, default 7), `since` (ISO; overrides `days`), `include_handled` (bool, default false), `unanswered_only` (bool, default false), `limit`, `cursor`.
Window start `W = since` or `clock - days`. Requests, in this order (all sequential, one page each, no pagination of Meta lists):
1. `GET /{IG}?fields=username` (own username).
2. `GET /{IG}/media?fields=id,permalink,timestamp,comments_count,caption&since=<unix(W)>&limit=25`.
3. For each media returned (in order) with `comments_count > 0`: `GET /{media_id}/comments?fields=id,text,username,timestamp,hidden,replies{id,text,username,timestamp}&limit=50`.
4. `GET /{IG}/tags?fields=id,caption,media_type,permalink,timestamp,username&limit=25`. A failure of step 4 with `MISSING_PERMISSION`, `NOT_FOUND` or `INVALID_INPUT` is non-fatal (recorded in `sources.tags`); any other failure of steps 1-4 fails the call with the mapped error.
Then local `webhook_events` rows for this account with event time >= `W` are merged.
Item shape: `{ item_id, type: "comment"|"mention"|"tag"|"message"|"reaction"|"postback"|"other", source: "api"|"webhook", via_webhook: boolean, media_id: string|null, comment_id: string|null, username: string|null, text: string|null, timestamp: string|null, permalink: string|null, unanswered: boolean|null, handled: boolean }`.
`item_id` forms: `comment:<comment_id>`, `tag:<media_id>`, `webhook:<event_id>`. Comments: only top-level comments with `timestamp >= W`; `unanswered = true` iff none of its replies has `username` equal to the own username (step 1); `unanswered` is `null` for non-comment types. A webhook comment/mention event whose comment id equals an API item is merged into it (`via_webhook: true`), otherwise it appears as its own item (`source:"webhook"`, `unanswered: null`). Webhook mapping: field `comments`->`comment`, `mentions`->`mention`, `messages`->`message`, `message_reactions`->`reaction`, `messaging_postbacks`->`postback`, else `other`. Items marked handled are dropped unless `include_handled` (then `handled: true`); `unanswered_only` keeps only `unanswered === true`. Order: `timestamp` descending (null last), ties by `item_id`. Pagination: offset-based over the freshly computed merged list (`cursor` opaque).
Result: `{ items, next_cursor, window: { since: string }, sources: { comments: {ok: boolean, media_scanned: number}, tags: {ok: boolean, error?: {code,message}}, webhooks: {count: number} }, warnings: string[] }`.

#### instagram_mark_handled (A)
Local bookkeeping, no Graph request, allowed under `read_only`. Input: `item_ids` (string[1..100], any strings), `handled` (bool, default true). Result: `{ updated: number, handled: string[] }` (`handled` = the input ids that are marked handled for this account after the call; empty when unmarking). Effect visible through `instagram_get_inbox`.

#### instagram_preflight_comment_actions (A)
Action `comment_actions`. Input: `ops` (array 1..50) of `{ op: "reply"|"comment"|"hide"|"unhide"|"delete"|"private_reply", comment_id?, media_id?, message? }`.
Per-op required fields (extra fields are invalid): `reply`: `comment_id`, `message`; `comment`: `media_id`, `message`; `hide`/`unhide`/`delete`: `comment_id`; `private_reply`: `comment_id`, `message`. `message` 1..2200 chars (`private_reply`: <= 1000 bytes UTF-8). Any invalid op fails the whole preflight with `INVALID_INPUT`, `details.items = [{index, message}]`. Capability `messaging` is required if any op is `private_reply` (else `CAPABILITY_UNAVAILABLE`).
Preflight requests (distinct ids once, in order of first appearance, all comments first, then media): `GET /{comment_id}?fields=id,text,username,hidden,parent_id,media{id}`; `GET /{media_id}?fields=id,permalink,is_comment_enabled`. A `NOT_FOUND` for any target fails the preflight with `NOT_FOUND`, `details.target`. A `private_reply` op whose comment `timestamp` is older than 7 days (clock) -> `MESSAGING_WINDOW_CLOSED`, `details.items`. Warnings: `COMMENT_HIDDEN` for `reply`/`private_reply` on a hidden comment; `ALREADY_IN_STATE` for hide on a hidden comment / unhide on a visible one.
`preview = { total, ops: [ { index, op, comment_id: string|null, media_id: string|null, message: string|null, target: { text, username, hidden }|null } ] }`.
Approve: ops executed sequentially in input order; a failure never stops the batch. For each op: (a) for ops with `comment_id`: `GET /{comment_id}?fields=id,hidden` (stale check; `NOT_FOUND` -> item `failed` with `STALE_PREVIEW`, no write); (b) the write:

| op | request |
|---|---|
| `reply` | `POST /{comment_id}/replies` body `message` -> `{id}` |
| `comment` | `POST /{media_id}/comments` body `message` -> `{id}` |
| `hide` | `POST /{comment_id}` body `hide=true` |
| `unhide` | `POST /{comment_id}` body `hide=false` |
| `delete` | `DELETE /{comment_id}` |
| `private_reply` | `POST /{IG}/messages` (facebook path: `/{page_id}/messages`, see the 2.5 path rule) body `recipient={"comment_id":"<id>"}`, `message={"text":"<message>"}` -> `{recipient_id, message_id}` |

Item `result` = Meta's success payload fields (`{id}`, `{success:true}`, `{recipient_id,message_id}`). A network error/5xx on an item write -> item `unknown` with `OUTCOME_UNKNOWN`, `details.reconcile = {operation_id, index}`. Overall `status`: any `unknown` item -> `unknown`; else any `failed` -> `failed` (top-level `error` = error of the first failed item); else `succeeded`. Top-level `result = { total, succeeded, failed, unknown }` (present for every overall status); `items` is always present. `isError` follows the overall status (1.13.3).

#### instagram_list_mentions (A)
Input: `mode` (`tags|mentioned_media|mentioned_comment`, default `tags`), `media_id` (required for `mentioned_media`), `comment_id` (required for `mentioned_comment`), `media_type` (`IMAGE|VIDEO|CAROUSEL_ALBUM`, tags only), `posted_after`, `posted_before` (ISO, tags only), `limit`, `cursor` (tags only). Fields irrelevant to the mode -> `INVALID_INPUT`.
Requests:
- `tags`: `GET /{IG}/tags?fields=id,caption,media_type,media_url,permalink,timestamp,username,comments_count,like_count&limit=<limit>[&after=...][&media_type=...][&posted_after=<ISO as given>][&posted_before=<ISO as given>]`
- `mentioned_media`: `GET /{IG}?fields=mentioned_media.media_id(<media_id>){id,caption,media_type,media_url,permalink,timestamp,username,comments_count,like_count}`
- `mentioned_comment`: `GET /{IG}?fields=mentioned_comment.comment_id(<comment_id>){id,text,timestamp,like_count,media{id,permalink}}`
Result `{ mode, items: [object...], next_cursor }`. Lookup modes return exactly one item (`next_cursor: null`) taken from the `mentioned_media`/`mentioned_comment` object in the response; absent -> `NOT_FOUND`.

#### instagram_preflight_reply_mention (A)
Action `reply_mention`. Input: `media_id` (required), `comment_id` (optional; present = reply to a comment mention), `message` (1..2200).
Preflight request: with `comment_id`: `GET /{IG}?fields=mentioned_comment.comment_id(<comment_id>){id,text,timestamp}`; without: `GET /{IG}?fields=mentioned_media.media_id(<media_id>){id,caption,username,permalink}`; the expected sub-object missing -> `NOT_FOUND`. `preview = { media_id, comment_id: string|null, message, target: object }`.
Approve: the same GET again (stale; missing -> `STALE_PREVIEW`), then `POST /{IG}/mentions` body `media_id`, `message`, and `comment_id` when given. Result `{ id }`.

### 2.5 Direct messages (4)

All require capability `messaging` (instagram yes, facebook probe).

Path rule: on the facebook login path every DM endpoint written below as `/{IG}/conversations`, `/{IG}/messages` or `/{IG}/messenger_profile` is sent to `/{page_id}/...` instead (Messenger Platform for Instagram, Page token), and `/{page_id}/messenger_profile` requests additionally carry `platform=instagram`. Everything else (fields, params, window rules) is identical. On the instagram path `{IG}` is the account's `ig_user_id`.

#### instagram_list_conversations (A)
Input: `user_id` (IGSID filter, optional), `limit`, `cursor`.
Request: `GET /{IG}/conversations?platform=instagram&fields=id,updated_time,participants,messages.limit(20){id,created_time,from,message}&limit=<limit>[&user_id=<user_id>][&after=...]`. Meta shape: `participants:{data:[{id,username}]}`, `messages:{data:[{id,created_time,from:{id,username},message}]}`.
Result: list of `{ id, updated_time, participants: [{id, username}], last_message: {id, created_time, from_id, text}|null, last_user_message_at: string|null, window_open: boolean }`. `last_message` = first element of `messages.data`; `last_user_message_at` = newest `created_time` among messages whose `from.id != {IG}`; `window_open` = that time exists and `clock - time < 24 h`.

#### instagram_get_conversation (A)
Input: `conversation_id`, `limit` (1..20, default 20; no cursor).
Request: `GET /{conversation_id}?fields=participants,messages.limit(<limit>){id,created_time,from,to,message}`.
Result: `{ id, participants: [{id,username}], messages: [ {id, created_time, from: {id,username}|null, to: [{id,username}], text: string|null} ], last_user_message_at, window_open }` (message order as returned by Meta, newest first).

#### instagram_preflight_send_message (A)
Action `send_message`. Input: exactly one of `recipient_id` (IGSID) or `conversation_id`; exactly one content: `text` (<= 1000 bytes UTF-8), `media` `{url, type: "image"|"video"|"audio"}` (URL rules 1.11, no HEAD), `reaction` `{message_id, action: "react"|"unreact", emoji?: string (default "love")}`; optional `quick_replies` (`[{title, payload}]`, 1..13, only with `text`; title > 20 chars -> warning `TITLE_TRUNCATED`), `reply_to_mid` (text/media only), `human_agent` (bool, default false).
Window check requests: with `conversation_id`: `GET /{conversation_id}?fields=participants,messages.limit(20){id,created_time,from,message}` (recipient = the participant whose id != `{IG}`); with `recipient_id`: `GET /{IG}/conversations?platform=instagram&user_id=<recipient_id>&fields=id,messages.limit(20){id,created_time,from,message}` (first conversation used; none -> treated as no user message). Window rules: newest message from the recipient within 24 h -> open. Otherwise `MESSAGING_WINDOW_CLOSED` (with `action`), unless `human_agent:true` AND `policy.allow_human_agent_tag:true` AND the newest recipient message is within 7 days -> allowed, warning `HUMAN_AGENT_TAG`, and the send carries the tag. (`reaction` also needs an open window.)
`preview = { recipient_id, conversation_id: string|null, kind: "text"|"media"|"reaction", text: string|null, media: {url, type: "image"|"video"|"audio"}|null, quick_replies: [{title, payload}]|null (titles as sent, after any truncation), reply_to_mid: string|null, reaction: {message_id, action: "react"|"unreact", emoji: string|null}|null, tag: "HUMAN_AGENT"|null, window: { open: boolean, last_user_message_at: string|null, human_agent: boolean } }`. Every field that will be sent appears in the preview. A `media.url` adds the warning `MEDIA_UNVERIFIED` unless `policy.verify_remote_media` is true (in which case the host is also resolved and must be public).
Approve: single request `POST /{IG}/messages` with body fields (JSON strings): `recipient={"id":"<IGSID>"}` and
- text: `message={"text":"<text>"}`; with quick replies `message={"text":..., "quick_replies":[{"content_type":"text","title":..,"payload":..}]}`; with `reply_to_mid`: `message` also has `"reply_to":{"mid":"<mid>"}`.
- media: `message={"attachment":{"type":"<type>","payload":{"url":"<url>"}}}`.
- reaction: `sender_action=react|unreact` and `payload={"message_id":"<mid>","reaction":"<emoji>"}` (`unreact`: `payload={"message_id":"<mid>"}`); no `message` field.
- human agent: additionally `messaging_type=MESSAGE_TAG`, `tag=HUMAN_AGENT`.
Result `{ recipient_id, message_id: string|null }` (from Meta `recipient_id`, `message_id`). No stale re-read.

#### instagram_preflight_set_messaging_profile (A)
Action `set_messaging_profile`. Input (at least one of the three): `ice_breakers` (`[{question, payload}]`, 1..4, question 1..80 chars), `persistent_menu` (`[{locale?: string (default "default"), call_to_actions: [{type: "postback"|"web_url", title (<=30), payload? | url?}] (1..5)}]`; postback needs `payload`, web_url needs https `url`), `clear` (subset of `["ice_breakers","persistent_menu"]`). A field both set and cleared -> `INVALID_INPUT`.
Preflight request: `GET /{IG}/messenger_profile?platform=instagram&fields=ice_breakers,persistent_menu`. `preview = { current: {ice_breakers, persistent_menu}, requested: {ice_breakers, persistent_menu}, clear: string[] }` (absent -> null/`[]`).
Approve: (if any set) one `POST /{IG}/messenger_profile` body `platform=instagram` plus `ice_breakers=[{"call_to_actions":[{"question":..,"payload":..}],"locale":"default"}]` and/or `persistent_menu=[{"locale":..,"call_to_actions":[...]}]`; then (if `clear`) one `DELETE /{IG}/messenger_profile` body `platform=instagram`, `fields=["ice_breakers"]` / `["persistent_menu"]` / both, restricted to the cleared ones. Result `{ applied: string[], cleared: string[] }`.

### 2.6 Insights and reports (8)

Normalized metric entry (all insight tools): from each Meta `data[]` entry -> `{ name, period: string|null, title: string|null, description: string|null, value: number|object|null, breakdowns: array|null, values: array|null }` where `value` = `total_value.value` if present else `values[0].value` if `values` non-empty else `null`; `breakdowns` = `total_value.breakdowns` or null; `values` = the raw Meta `values` array or null. A requested metric absent from Meta's `data` is listed in `missing_metrics` (not an error). Meta returning an empty `data` is not an error.

Deprecated -> replacement (rejected with `INVALID_INPUT`, no request, message names the replacement, `details = {metric, replacement}`): `impressions`, `video_views`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `profile_views` -> `views`; `website_clicks`, `phone_call_clicks` -> `profile_links_taps`; `reached_audience_demographics` -> `engaged_audience_demographics`. Any other unlisted metric name -> `INVALID_INPUT` (`details.valid` lists the valid names for that tool). This applies to both account and media tools.

Account-level valid metrics (`GET /{IG}/insights`):

| Metric | period | metric_type | allowed `breakdown` |
|---|---|---|---|
| `accounts_engaged` | day | total_value | none |
| `comments` | day | total_value | `media_product_type` |
| `engaged_audience_demographics` | lifetime | total_value | `age,city,country,gender` (required) |
| `follower_demographics` | lifetime | total_value | `age,city,country,gender` (required) |
| `follows_and_unfollows` | day | total_value | `follow_type` |
| `likes` | day | total_value | `media_product_type` |
| `profile_links_taps` | day | total_value | `contact_button_type` |
| `reach` | day | total_value, time_series | `media_product_type`, `follow_type` |
| `replies` | day | total_value | none |
| `reposts` | day | total_value | none |
| `saves` | day | total_value | `media_product_type` |
| `shares` | day | total_value | `media_product_type` |
| `total_interactions` | day | total_value | `media_product_type` |
| `views` | day | total_value | `follow_type`, `media_product_type` |
| `follower_count` | day | time_series | none |
| `online_followers` | lifetime | (not sent) | none |

(`follower_count` and `online_followers` are marked unverified, section 7; `follower_type` is NOT accepted as a `views` breakdown.)

#### instagram_get_account_insights (A)
Input: `metrics` (string[1..16], default `["reach","views","accounts_engaged","total_interactions"]`), `period` (`day|lifetime`, optional; derived from the metrics, an explicit value that disagrees -> `INVALID_INPUT`), `metric_type` (`total_value|time_series`, default `total_value`, except `follower_count` -> `time_series`), `breakdown` (string), `timeframe` (`last_14_days|last_30_days|last_90_days|prev_month|this_month|this_week`, only for the two demographics metrics, default `this_month`), `since`, `until` (ISO).
Rules: all metrics must share one `period`; `time_series` only for metrics that support it; `breakdown` only with `total_value`, only values allowed for every requested metric, and required for the demographics metrics; `timeframe` with non-demographic metrics -> `INVALID_INPUT`; `timeframe` together with `since`/`until` -> since/until are dropped and warning `TIMEFRAME_OVERRIDES_RANGE`.
Request: `GET /{IG}/insights?metric=<comma list in input order>&period=<p>[&metric_type=<mt>][&breakdown=<b>][&timeframe=<t>][&since=<unix>][&until=<unix>]` (`metric_type` omitted when the only metric is `online_followers`; `since`/`until` omitted when not given).
Result `{ metrics: [normalized entries], missing_metrics: string[], request: { period, metric_type: string|null, breakdown: string|null, timeframe: string|null, since: string|null, until: string|null }, warnings: string[] }`.

Media-level valid metrics (`GET /{media_id}/insights?metric=...`):

| media_product_type | valid metrics (all logins) | additionally valid only on login `facebook` |
|---|---|---|
| `FEED` (also carousel parents, decision D16) | `comments, follows, likes, profile_activity, profile_visits, reach, reposts, saved, shares, total_interactions, views` | `total_comments, total_likes, total_views, facebook_views` |
| `REELS` | `comments, crossposted_views, ig_reels_avg_watch_time, ig_reels_video_view_total_time, likes, reach, reels_skip_rate, reposts, saved, shares, total_interactions, views` | `total_comments, total_likes, total_views, facebook_views` |
| `STORY` | `follows, navigation, profile_activity, profile_visits, reach, replies, reposts, shares, total_interactions, views` | `total_views, facebook_views, link_clicks` |

Note media-level uses `saved` (account-level uses `saves`). `AD` -> `INVALID_INPUT`.

#### instagram_get_media_insights (A)
Input: `media_id`, `metrics` (string[], optional), `breakdown` (optional: valid only when every metric is `navigation` (value `story_navigation_action_type`) or `profile_activity` (value `action_type`), else `INVALID_INPUT`).
Requests: (1) `GET /{media_id}?fields=id,media_product_type,media_type,timestamp`; (2) `GET /{media_id}/insights?metric=<list>[&breakdown=<b>]`. Metrics given: validated against the media's table (a facebook-only metric on an instagram account, a metric of another product type, or a deprecated name -> `INVALID_INPUT`, request (2) not sent). Omitted -> defaults, exactly in this order: FEED `reach,views,likes,comments,shares,saved,total_interactions`; REELS `reach,views,likes,comments,shares,saved,reposts,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time`; STORY `reach,views,replies,shares,follows,profile_visits,total_interactions`. A STORY older than 24 h (clock) -> warning only (Meta decides).
Result `{ media_id, media_product_type, metrics: [normalized], missing_metrics, warnings }`.

#### instagram_get_audience (A)
Input: `breakdowns` (subset of `age,gender,city,country`, default all four, requested in the order `age,gender,city,country`), `timeframe` (same set as above, default `this_month`), `include_engaged` (bool, default true), `include_online_followers` (bool, default true).
Requests in order: for each breakdown `b`: `GET /{IG}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=<b>&timeframe=<t>`; then if `include_engaged`, for each `b`: same with `metric=engaged_audience_demographics`; then if `include_online_followers`: `GET /{IG}/insights?metric=online_followers&period=lifetime`. A Meta error on a `follower_demographics` request fails the call (mapped); errors on engaged/online requests are tolerated and listed in `unavailable`.
Mapping: Meta `total_value.breakdowns[0].results[] = {dimension_values:[...], value}` -> `{key: dimension_values.join(","), value}`; empty `data`/no results -> `[]`.
Result `{ timeframe, followers: { age: [{key,value}], gender: [...], city: [...], country: [...] } (only requested breakdowns), engaged: same shape | null (null when not requested), online_followers: { by_hour: {"0": n, ... "23": n}, end_time: string|null } | null, unavailable: [ {section: "engaged"|"online_followers", breakdown?: string, error: {code, message}} ] }`. `by_hour` is `values[0].value` of the response; absent -> `online_followers: null`.

#### instagram_snapshot_insights (A)
Stores a snapshot (also done daily by the daemon). Input: none besides `account`.
Requests: (1) `GET /{IG}?fields=followers_count,follows_count,media_count`; (2) `GET /{IG}/insights?metric=reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves&period=day&metric_type=total_value&since=<unix(clock)-86400>&until=<unix(clock)>`.
Result `{ snapshot_id: "snap_...", account, taken_at, followers_count, follows_count, media_count, metrics: { reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves } }` (each `number|null`). Side effect: one `insight_snapshots` row (multiple per day allowed), readable via `instagram_get_growth`.

#### instagram_get_growth (A)
Local only. Input: `days` (integer 1..365, default 30), `since`, `until` (ISO; override `days`). Window uses snapshot `taken_at`.
Result `{ account, points: [ { snapshot_id, taken_at, followers_count, media_count, reach, views, accounts_engaged, total_interactions, deltas: { followers_count, media_count, reach, views, accounts_engaged, total_interactions } (each number|null) } ], summary: { first_taken_at, last_taken_at, followers_delta: number|null, followers_pct: number|null }|null, warnings: string[] }`. Points ascending by `taken_at`; `deltas` = value minus previous point's value (`null` for the first point or when either is null); `followers_pct = followers_delta / first.followers_count * 100` rounded to 2 decimals (null if first is 0/null). No snapshots -> `points: []`, `summary: null`, warning `NO_SNAPSHOTS: ...`.

#### instagram_performance_report (A)
Input: `period` (`7d|30d|90d|custom`, default `30d`), `since`, `until` (required iff `custom`, else `INVALID_INPUT`), `rank_by` (default `total_interactions`; one of `reach,views,saved,shares,total_interactions`).
Let `end = clock` (custom: `until`), `start = end - N days` (custom: `since`), `prev = [start - (end-start), start)`.
Requests in order: (1) `GET /{IG}?fields=followers_count,media_count`; (2) `GET /{IG}/insights?metric=reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves&period=day&metric_type=total_value&since=<unix(start)>&until=<unix(end)>`; (3) same with the `prev` bounds; (4) `GET /{IG}/media?fields=id,media_type,media_product_type,permalink,timestamp,like_count,comments_count,caption&since=<unix(prev start)>&until=<unix(end)>&limit=100`, following `paging.next` (max 5 pages); (5) for up to the 25 most recent media with `timestamp` within [start,end): `GET /{media_id}/insights?metric=reach,views,saved,shares,total_interactions`; a failure of a single media-insights request is non-fatal (warning, that post has `metrics: {}`).
Result:
```
{ period: {label, start, end, days}, previous_period: {start, end},
  followers: {current: number|null},
  totals: { <reach|views|accounts_engaged|total_interactions|likes|comments|shares|saves>: { value, previous, delta, delta_pct } },
  engagement_rate: { value: number|null, formula: "total_interactions / reach" },
  top_posts: [post...], bottom_posts: [post...],
  format_breakdown: [ { format: "reel"|"feed"|"carousel"|"story", posts, avg_reach: number|null, avg_total_interactions: number|null } ],
  cadence: { posts, posts_per_week, by_weekday: {Mon,Tue,Wed,Thu,Fri,Sat,Sun: count} },
  warnings: string[], markdown: string }
```
`totals.*.value` come from the normalized `value` of the current-period entry, `previous` from the prev-period entry. `delta = value - previous` (null if either null); `delta_pct = delta/previous*100` rounded 2 decimals (null if previous 0/null). `engagement_rate.value = totals.total_interactions.value / totals.reach.value` rounded 4 decimals, null if reach 0/null. `post = {id, permalink, media_product_type, timestamp, score, metrics}` where `score` = the `rank_by` insight value, else `like_count + comments_count` when insights are missing; `top_posts` = up to 5 highest scores (descending), `bottom_posts` = up to 5 lowest (ascending), posts in [start,end) only. Format mapping: `REELS`->reel, `FEED` with `CAROUSEL_ALBUM`->carousel, `FEED`->feed, `STORY`->story. `cadence.posts_per_week = posts / (days/7)` rounded 2 decimals. `markdown` is a non-empty string containing the period label and one line per total. Tests may assert shapes, request lists and the formulas above.

#### instagram_best_time_to_post (A)
Input: `days` (integer 7..365, default 90). Requests: (1) `GET /{IG}/insights?metric=online_followers&period=lifetime` (non-fatal on Meta error/empty); (2) `GET /{IG}/media?fields=id,media_product_type,timestamp,like_count,comments_count&since=<unix(clock - days)>&limit=100`, following `paging.next` (max 5 pages).
Result `{ data_used: ("online_followers"|"post_history")[], online_followers_available: boolean, best_slots: [ {weekday: "Mon"|..., hour_utc: 0..23, score: number, basis: "online_followers"|"post_history"} ] (<= 5, descending score), by_weekday: {Mon..Sun: {posts, avg_engagement}}, by_hour_utc: {"0".."23": {posts, avg_engagement}}, caveats: string[] }`. Engagement of a post = `like_count + comments_count`. If `online_followers` is present, slots are built from its hourly values (`basis: "online_followers"`, `weekday` = the weekday with the highest average engagement in history, or `Mon` if no history); else from `post_history`: average engagement per (weekday, hour_utc) with >= 1 post. Hours are UTC. No data at all -> `best_slots: []`, `data_used: []`.

#### instagram_media_kit (A)
Input: none besides `account`. Requests in order: (1) `GET /{IG}?fields=id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url`; (2-5) for `b` in `age,gender,city,country`: `GET /{IG}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=<b>&timeframe=this_month` (errors tolerated -> that breakdown `[]` + warning); (6) `GET /{IG}/media?fields=id,media_type,media_product_type,permalink,timestamp,like_count,comments_count&since=<unix(clock - 90d)>&limit=100` following `paging.next` (max 5 pages); (7) for up to 30 most recent of those media: `GET /{media_id}/insights?metric=reach,views,saved,shares,total_interactions` (errors tolerated).
Result `{ profile: {id, username, name, biography, website, followers_count, follows_count, media_count, profile_picture_url}, audience: {age, gender, city, country: [{key,value}]}, formats: { reel|feed|carousel: { d30: {posts, avg_reach, avg_views, avg_engagement}, d90: {...} } }, top_posts: [ up to 5 {id, permalink, media_product_type, timestamp, score} ], warnings: string[], markdown: string }`. `avg_engagement` = mean of `like_count + comments_count`; `avg_reach`/`avg_views` = mean of the insight values among posts that have them (null if none). Windows are `[clock-30d, clock]` and `[clock-90d, clock]`. Stories are not included.

### 2.7 Discovery and partnerships (6)

#### instagram_lookup_account (A)
Capability `business_discovery` (instagram: `CAPABILITY_UNAVAILABLE`). Input: `username` (leading `@` stripped; `^[A-Za-z0-9._]{1,30}$`), `media_limit` (1..50, default 10).
Request: `GET /{IG}?fields=business_discovery.username(<u>){username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,media.limit(<n>){id,media_type,media_product_type,permalink,timestamp,like_count,comments_count,view_count}}`. If Meta answers code 100 whose message matches `/nonexisting field|does not exist|unsupported/i`, exactly one retry request is made with the minimal confirmed set `business_discovery.username(<u>){followers_count,media_count,media.limit(<n>){id,comments_count,like_count,view_count}}` and the result has `fallback_fields: true`. A not-found user (Meta 110/24, or no `business_discovery` object) -> `NOT_FOUND`.
Result `{ username, name, biography, website, profile_picture_url, followers_count, follows_count, media_count, recent_media: [ {id, media_type, media_product_type, permalink, timestamp, like_count, comments_count, view_count} ], fallback_fields: boolean }` (missing -> null; `username` falls back to the input).

#### instagram_compare_accounts (A)
Capability `business_discovery`. Input: `usernames` (string[1..10], same grammar, duplicates removed preserving order), `media_limit` (1..50, default 25).
Requests in order: (1) own: `GET /{IG}?fields=username,followers_count,media_count`; (2) own: `GET /{IG}/media?fields=id,media_type,media_product_type,timestamp,like_count,comments_count&limit=<media_limit>`; (3..) for each username sequentially: the same business_discovery GET as `instagram_lookup_account` with `media.limit(<media_limit>)` (including the one-time field fallback). A per-username failure does not abort: that entry has `error`.
Result `{ own: M, others: [ M | {username, error:{code,message}} ], generated_at }`, `M = { username, followers_count, media_count, posts_sampled, posts_per_week: number|null, avg_likes: number|null, avg_comments: number|null, format_mix: { IMAGE: n, VIDEO: n, CAROUSEL_ALBUM: n } }`. `posts_per_week = (posts_sampled - 1) / ((max_ts - min_ts) in weeks)` rounded 2 decimals, null if < 2 posts or zero span. Averages rounded 2 decimals over sampled posts having the field.

#### instagram_search_hashtag (A)
Capability `hashtag_search`. Input: `query` (hashtag without `#`, `^[A-Za-z0-9_]{1,100}$`, lowercased for budget keys).
Budget (SQLite `hashtag_budget`, per account): rolling 7 days (604800 s of the clock). If the hashtag was already recorded within the window, it consumes nothing and the request still proceeds; if it is new and 30 distinct hashtags are already recorded in the window -> `HASHTAG_BUDGET_EXHAUSTED` with no request. A hashtag is recorded only after a successful lookup that returned an id.
Request: `GET /ig_hashtag_search?user_id={IG}&q=<query>`; `data[0].id`; empty `data` -> `NOT_FOUND`.
Result `{ hashtag_id, name: <query lowercased>, budget: { used, limit: 30, remaining } }`.

#### instagram_get_hashtag_media (A)
Capability `hashtag_search`. Input: `hashtag_id`, `type` (`top|recent`, default `top`), `limit`, `cursor`.
Request: `GET /{hashtag_id}/top_media` or `/recent_media` with `?user_id={IG}&fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&limit=<limit>[&after=...]`.
Result: list of `{id, caption, media_type, permalink, timestamp, like_count, comments_count}`. No budget effect.

#### instagram_list_collab_invites (A)
Capability `collab_invites` (instagram: probe). Input `limit`, `cursor`. Request `GET /{IG}/collaboration_invites?fields=media_id,media_owner_username,caption,media_url&limit=<limit>[&after=...]`. Result: list of `{media_id, media_owner_username, caption, media_url}`.

#### instagram_preflight_respond_collab_invite (A)
Action `respond_collab_invite`. Capability `collab_invites`. Input: `media_id`, `accept` (boolean).
Preflight request: `GET /{IG}/collaboration_invites?fields=media_id,media_owner_username,caption,media_url&limit=100` (first page only); the invite with matching `media_id` must be present, else `NOT_FOUND`. `preview = { media_id, media_owner_username, caption, accept }`.
Approve: the same GET (stale; absent -> `STALE_PREVIEW`), then `POST /{IG}/collaboration_invites` body `media_id`, `accept=true|false`. Result `{ media_id, accepted: boolean }`.

Tool count: 6 + 5 + 6 + 7 + 4 + 8 + 6 = 42.

---

## 3. CLI contract (testable commands)

All commands: `node dist/cli.js <command>`. Output on stdout is a single JSON document (one line) unless stated; diagnostics go to stderr; secrets never printed.

### 3.1 `scheduler run-once`
Processes due scheduled jobs once at the process clock `T` (honors `INSTAGRAM_MCP_NOW` + `INSTAGRAM_MCP_TEST_MODE=1`) using the rules in 2.3, then exits. While running it starts the media host on demand (section 6) and keeps it up until all jobs of this pass are done. Jobs are processed in `publish_at` ascending order.
stdout: `{"ok":true,"now":"<ISO>","jobs":[{"job_id":"sched_...","account":"...","status_before":"...","status_after":"...","action":"containers_created"|"published"|"missed"|"failed"|"unknown"|"skipped","operation_id":"op_..."|null,"error":{"code":"...","message":"..."}|null}]}` (`skipped` = nothing due). Only jobs in status `scheduled` or `containers_created` are listed. Exit codes: 0 (even when individual jobs failed/unknown/missed), 1 internal error or unreadable config, 3 another process holds the daemon lease for this `INSTAGRAM_MCP_HOME` (nothing processed). Graph requests per job are exactly those of 2.3 (scheduled publish). A job in status `unknown` is never touched.

### 3.2 `auth status`
Env backend, no network by default. stdout: `{"backend":"env","accounts":[{"alias","login","ig_user_id","token":{"present":boolean,"source":"env","env_var":"INSTAGRAM_MCP_TOKEN_<ALIAS>","expires_at":null,"scopes":null},"valid":null}],"app_secret":{"present":boolean},"http_bearer":{"present":boolean},"webhook_verify_token":{"present":boolean}}`. Exit 0 if every account has a token, else 1. With `--check`: additionally performs the `/me` request (1.4) per account (one GET each, in config order) and sets `valid` true (2xx) or false (any error); exit 0 only if all accounts have tokens and are valid.

### 3.3 `doctor`
Flag `--json` prints `{"ok":boolean,"checks":[{"id","status":"pass"|"warn"|"fail","message","action"?}]}`; without it, human text with the same information. Exit codes: 0 no `fail`; 1 at least one `fail`; 2 config unreadable/invalid/world-writable (then only the `config` check is reported).

| Check id | pass | warn | fail |
|---|---|---|---|
| `config` | parses and validates | | invalid (exit 2) |
| `secrets_backend` | backend usable | | unusable |
| `tokens` | every account has a token | | any account missing a token |
| `token_validity` | `/me` request (1.4) 2xx per account | | any `/me` error (mapped code in message) |
| `capabilities` | always `pass` (lists the static matrix, no probes) | | |
| `quota` | `content_publishing_limit` 2xx | request failed | |
| `media_host` | `public_base_url` set | unset | |
| `daemon` | lease held by a live daemon | no daemon | |
| `webhooks` | enabled and verify token + app secret present | disabled or secret missing | |

Requests made by `doctor`: per account (config order) `/me` then `GET /{IG}/content_publishing_limit?fields=quota_usage,config`. Skipped (not run) for accounts without a token.

### 3.4 `version`
Prints the package version (e.g. `1.0.0-rc.1`) and a newline to stdout, exit 0. `--version` is an alias.

---

## 4. HTTP transport contract (`serve --http`, and `daemon --http`)

- Binds `http.host` (default `127.0.0.1`) at `--port` (else `http.port`). Non-loopback host without `http.allow_remote: true` -> startup exit 1.
- Startup refuses (exit 1, stderr message, no listening line) when `INSTAGRAM_MCP_HTTP_TOKEN` is unset/empty.
- MCP endpoint `/mcp` (standard MCP Streamable HTTP; tests use the official client transport). Any other path -> 404 (except the daemon webhook path, section 5).
- Request check order: (1) body larger than 1 MB -> 413; (2) `Host` header must be one of `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` or the host part of an entry in `http.allowed_origins`, else 403; (3) if an `Origin` header is present it must exactly equal an entry of `http.allowed_origins`, else 403 (absent `Origin` is fine); (4) `Authorization: Bearer <token>` must equal `INSTAGRAM_MCP_HTTP_TOKEN` (constant-time) else 401 with header `WWW-Authenticate: Bearer` and JSON body `{"error":{"code":"AUTH_REQUIRED"|"AUTH_FAILED","message":"..."}}` (`AUTH_REQUIRED` when the header is absent/not Bearer, `AUTH_FAILED` when wrong). So a bad Host or Origin yields 403 even with a valid bearer or none.
- After 20 rejected (401) requests within 60 s, further requests that fail authentication get 429 with `Retry-After: 60` instead of 401 (requests with a valid bearer are unaffected).
- With a valid bearer the tools behave exactly as over stdio. The bearer and the token never appear in any response.

---

## 5. Webhook receiver contract (daemon)

Enabled when `webhooks.enabled: true`. Served by `node dist/cli.js daemon [--port N]` on the daemon listener (D6: shares the HTTP listener with `/mcp`; when `--http` is absent the listener serves ONLY the webhook path). The webhook path (default `/webhooks/instagram`, config `webhooks.path`) is exempt from the bearer and Host/Origin checks of section 4 and uses its own checks:

| Request | Behaviour |
|---|---|
| `GET <path>?hub.mode=subscribe&hub.verify_token=<T>&hub.challenge=<C>` | `T` equals `INSTAGRAM_MCP_WEBHOOK_VERIFY_TOKEN` (constant-time) -> `200`, `Content-Type: text/plain`, body exactly `<C>`. Wrong token or `hub.mode != subscribe` -> `403`. Missing `hub.challenge` -> `400`. |
| `POST <path>` with header `X-Hub-Signature-256: sha256=<hex>` | `<hex>` = HMAC-SHA256(key = `INSTAGRAM_MCP_APP_SECRET`, message = raw request body bytes), compared constant-time. The receiver validates cheaply first: a POST without a well-formed `X-Hub-Signature-256` header (`sha256=` plus 64 hex chars) gets `401` even when no app secret is configured. Wrong signature -> `401` (nothing stored). A POST carrying a well-formed signature header when no app secret is configured -> `503` (D38). Body > 1 MB -> `413`. Valid signature but body not JSON -> `400`. Otherwise `200`, `Content-Type: text/plain`, body `EVENT_RECEIVED`, sent before any slow work. |
| other methods/paths | `404` (wrong method on the path: `405`) |

Event storage (valid POST): for each `entry[i].changes[j]` an event with `field = changes[j].field`, payload `changes[j].value`; for each `entry[i].messaging[k]` an event with field `messages` if it has `message`, `message_reactions` if it has `reaction`, `messaging_postbacks` if it has `postback`, `messaging_seen` if it has `read`, else `unknown`. `event_id` = sha256 hex of the canonical JSON of the event item; an identical event received again is deduplicated (stored once). The event's account is the configured account whose `ig_user_id` equals `entry[i].id` (events for unknown ids are stored with no account and never shown). Event time = `entry[i].time` (Unix seconds) -> ISO, else the clock at receipt.

Visibility: stored events appear in `instagram_get_inbox` (2.4) as items with `source:"webhook"` (or merged into API items by comment id): `comments` events map `value.id`->`comment_id`, `value.text`->`text`, `value.from.username`->`username`, `value.media.id`->`media_id`; `mentions` events map `value.comment_id`->`comment_id`, `value.media_id`->`media_id`; `messages` events map `message.text`->`text`, username is null (item id `webhook:<event_id>`). The daemon makes no Graph calls for webhooks and does not call any subscribe endpoint.

---

## 6. Media host contract

The media host is started on demand by whichever process publishes (stdio server, HTTP server, daemon, `scheduler run-once`): a plain HTTP server bound to `127.0.0.1:<media_host.port>`, started before the first container-creation request of a publish that needs it and left running for the lifetime of the process. Failure to bind -> approve `failed` `MEDIA_HOST_UNAVAILABLE`.

| Request | Response |
|---|---|
| `GET /m/<token>` for a staged, unexpired file | `200`, `Content-Type` by file type (`image/jpeg`, `video/mp4`, `video/quicktime`), `Content-Length`, `Accept-Ranges: bytes`, `Cache-Control: no-store`, body = the file bytes (same bytes as the source at staging time) |
| `GET /m/<token>` with `Range: bytes=a-b` (single range) | `206`, `Content-Range`, partial body; invalid range `416` |
| `HEAD /m/<token>` | same headers as GET, no body |
| `GET /m/<unknown-or-expired-or-deleted-token>` | `404` (no body details) |
| any other path (including `/`, `/m/`, `/m/../x`, `/m/<token>/x`, URL-encoded traversal) | `404` |
| any other method on `/m/<token>` | `405` |
| `GET /m/__health?nonce=<32 hex>` | `204` with header `x-instagram-mcp-media-host-proof: <hex HMAC-SHA256(secret, nonce)>`; without a valid nonce `404` |

Port ownership (D35): the owner keeps a random 32-byte secret in `<INSTAGRAM_MCP_HOME>/media-host.key` (mode 0600, created on first use). When the port is already bound, a second process accepts the listener as "same home" only if it answers the `/m/__health?nonce=<random>` probe with the matching HMAC proof; otherwise `MEDIA_HOST_UNAVAILABLE`. No response other than the health probe carries any marker header.

Token: 43 url-safe characters (`[A-Za-z0-9_-]`), cryptographically random, one per staged file. Public URL = `{public_base_url}/m/{token}`. Staged file expiry: 24 h after container creation. A staged file is deleted (404 afterwards) after the publish that used it succeeded. The server never lists staged files and never serves any path outside `staging/`. Staged file names on disk are the tokens; files are mode 0600.

---

## 7. Unverified upstream facts (live E2E must confirm)

| # | Fact (source: research) | Server behaviour either way |
|---|---|---|
| U1 | `Authorization: Bearer` accepted on `graph.instagram.com` (04) | Default sends `access_token` query on the instagram path; config `token_in_header: true` switches. Nothing else changes. |
| U2 | `appsecret_proof` accepted/required on `graph.instagram.com` (04) | Never sent on the instagram path. If Meta rejects calls without it, they surface as `AUTH_FAILED`/`MISSING_PERMISSION`. |
| U3 | `DELETE /{media_id}` works on the instagram path (01, 03) | Capability `probe`: failure of the kinds in 1.12 caches `no` and returns `CAPABILITY_UNAVAILABLE`. DELETE is always the method (never POST). |
| U4 | Carousel of 20 children accepted (01) | Preflight allows up to 20; a Meta rejection at approve surfaces `UPSTREAM_REJECTED`. |
| U5 | Publish quota is 50 vs 100 (01) | Never hard-coded: read from `content_publishing_limit` (`quota_total`) at runtime. |
| U6 | The `comment_enabled` parameter name on `POST /{media_id}` (02) | Sent as `comment_enabled`; a Meta 100 error surfaces `INVALID_INPUT`/`UPSTREAM_REJECTED` and the operation `failed`. |
| U7 | Webhooks/DMs in development mode (02, 04) | Inbox works from polling when no webhook events exist; DM tools surface Meta errors via 1.7. |
| U8 | `online_followers` shape/availability, `follower_count` existence (03) | Requested as `period=lifetime` without `metric_type`; absent/erroring -> `null`/`unavailable`, never a hard error in `get_audience`, `best_time_to_post`. `follower_count` Meta rejection surfaces mapped. |
| U9 | rupload for instagram-login accounts (01) | Never attempted; local video uses the media host there. |
| U10 | Branded content / paid partnership params on the instagram path (01, 03) | Capability `probe`; failure caches `no`; `CAPABILITY_UNAVAILABLE`. |
| U11 | Business discovery field set (03) | Full field list first, one fallback to the confirmed minimal set; `fallback_fields` tells which. |
| U12 | Human-agent tag parameters (02) | Sent as `messaging_type=MESSAGE_TAG`, `tag=HUMAN_AGENT` only when config allows; rejection surfaces mapped. |
| U13 | `/stories` and `/tags` on the instagram path (01, 02) | Always attempted (stories); tags failures are tolerated in the inbox only. |
| U14 | `views` breakdown names (03) | Only `follow_type`, `media_product_type` accepted; `follower_type` is rejected locally. |
| U15 | Demographic `timeframe` values still valid (03) | Default `this_month`; Meta rejection surfaces `INVALID_INPUT`. |
| U16 | Container child readiness / image containers need polling (01) | Always poll each container to `FINISHED`. |
| U17 | `account_type` field on `/{IG}` of the instagram path (03) | Requested only on the instagram path; `null` on facebook. |
| U18 | Messaging on the facebook path (02) | Capability `probe`: requests go to `/{page_id}/...` (2.5 path rule); a permission/unsupported failure caches `no`. |
| U19 | Meta error codes for publish quota (9/2207042) and messaging window (10/2534022) | Mapped by 1.7 rows 1-2; any other code falls to the generic rows. |
| U20 | Header name `X-Hub-Signature-256` (02) | Required exactly; absence is `401`. |
| U21 | Nested field syntax `messages.limit(20){...}` and `participants` on conversations (02) | Used as specified; Meta 100 errors surface mapped. |
| U22 | Collab invite field names (`media_id, media_owner_username, caption, media_url`) (03) | Used as specified; null when absent. |
| U23 | Delete-comment token owner (02) | Always attempts `DELETE /{comment_id}`; Meta rejection -> item `failed`. |
| U24 | Hashtag media field set (03) | Used as specified; missing -> null. |
| U25 | Comments edge pagination via `after` (02) | Uses `limit` and `after` generically (1.9). |
| U26 | Reels max duration 15 min vs 20 min (01) | Local check at 15 min; unparsable duration -> warning only. |
| U27 | Webhook subscribe endpoint path (02) | The server never subscribes; the user configures subscriptions in the app dashboard. |

---

## 8. Decisions made in this contract

Choices where the spec/research was silent or ambiguous. The orchestrator should review these.

| # | Decision |
|---|---|
| D1 | Graph URL override replaces scheme+host+port only; `/{graph_api_version}` is always appended; same for rupload (`/ig-api-upload/{ver}/{id}`). Overrides are honored without test mode. |
| D2 | POST/DELETE parameters go in a form body, credentials stay in query/header; array/object params are JSON strings; `children` comma-joined. |
| D3 | `INSTAGRAM_MCP_NOW` freezes the clock (does not advance), only with `INSTAGRAM_MCP_TEST_MODE=1`; real timers drive retries/polling. Approval-expiry tests use `approval_ttl_seconds=1` with the real clock. |
| D4 | Added env `INSTAGRAM_MCP_WEBHOOK_VERIFY_TOKEN`; added config keys `token_in_header` (top-level) and `http.host`; webhooks share the daemon HTTP listener (no new port) and the MCP endpoint is `/mcp`. |
| D5 | Readiness signal for HTTP listeners is one JSON line on stderr (`{"event":"listening",...}`); `--port 0` allowed. |
| D6 | Webhook path is exempt from bearer and Host/Origin checks (it is signature/verify-token protected); only the daemon serves it. |
| D7 | Schema/validation failures are returned as `INVALID_INPUT` tool errors (never JSON-RPC errors); unknown properties rejected. |
| D8 | Account resolution: unknown alias (including an `ig_user_id`) -> `ACCOUNT_NOT_ALLOWED`; ambiguity/no accounts -> `CONFIG_INVALID`; invalid config file -> process refuses to start (exit 1). Missing token -> `AUTH_REQUIRED`. |
| D9 | Meta error mapping table (1.7) incl. extra rows: 9/2207042 -> `PUBLISH_QUOTA_EXHAUSTED`, 10/2534022 -> `MESSAGING_WINDOW_CLOSED`, 110/24/100+33 -> `NOT_FOUND`, "not enough viewers" -> `UPSTREAM_REJECTED`, codes 1/2 -> `UPSTREAM_TRANSIENT`; 190 with subcode 463/467 -> `TOKEN_EXPIRED`. |
| D10 | Retry: `Retry-After` > 30 s is not waited for (immediate `RATE_LIMITED`); Meta transient codes are retried on GET regardless of HTTP status. |
| D11 | Capability matrix feature names and values (1.12): `messaging` is `probe` on the facebook path (orchestrator override: Page-scoped Messenger Platform endpoints); `delete_media`, `branded_content`, `collab_invites` are `probe` on instagram; stories/tags/comments toggle are `yes` and fail naturally if Meta disagrees. Probe-failure criteria in 1.12. |
| D12 | Approve semantics: second sequential approve replays the stored outcome (`replayed:true`, zero requests); `APPROVAL_ALREADY_USED` only for a concurrent in-flight approve; stale approvals replay `STALE_PREVIEW`. `isError` true for `failed`/`unknown`, and the structuredContent then carries both the approve fields and `error`. `planned_calls` is the exact approve request list (reads included). `policy.read_only` also blocks approve of pending approvals. `dry_run` approve sends zero requests. Stale checks are existence-only (plus file re-hash for local media). Batch overall status: any unknown -> unknown, else any failed -> failed (first item's error), else succeeded. |
| D13 | Scheduling: approve of a `publish_at` preflight makes no Graph requests and returns a succeeded schedule result; the scheduler creates its own operation (origin `scheduler`); job statuses `scheduled/containers_created/published/missed/failed/unknown/canceled`; a job that is due goes through all steps in one `run-once` pass; if polling exhausts the job stays `containers_created` and is re-polled on the next pass; `publish_at` must be after the clock; only `scheduled` jobs can be canceled. `scheduler run-once` stdout is the JSON in 3.1. |
| D14 | Publish details: every container (incl. images, carousel children) is polled, first poll immediate then constant `INSTAGRAM_MCP_POLL_INTERVAL_MS`, max `min(300, ceil(300000/interval))` polls; carousel order is child-create/poll per child then parent; post-publish `GET /{media_id}?fields=id,permalink` is part of the sequence and its failure is ignored; poll timeout -> `failed UPSTREAM_TRANSIENT`; `ERROR` triggers one extra `fields=status,status_code` read; container/rupload creation network errors are definite failures (only `media_publish` ambiguity -> `unknown`). Quota read at preflight with `fields=quota_usage,config`. |
| D15 | Local media validation rules (JPEG magic, `ftyp`, mvhd duration, aspect for feed images only) and remote rules (HTTPS-only, SSRF, single `HEAD`, no redirects, non-verifiable -> warning). In test mode loopback http URLs are additionally allowed. Applicability matrix of publish options per kind (rules in 2.3); per-media `alt_text` only for kind `image`; top-level `user_tags` equals `media[0].user_tags`. |
| D16 | Carousel parents use the FEED metric set for media insights; `AD` rejected; facebook-only media metrics (`total_*`, `facebook_views`, `link_clicks`) rejected as `INVALID_INPUT` on instagram accounts. |
| D17 | Insights: single-request multi-metric calls require one shared period; `follower_type` is not a valid `views` breakdown; demographics default `timeframe=this_month`, `breakdown` required; `since`/`until` omitted unless given; deprecated->replacement map extended with `profile_views`/`clips_replays_count` -> `views`, `website_clicks`/`phone_call_clicks` -> `profile_links_taps`, `reached_audience_demographics` -> `engaged_audience_demographics`; normalized metric entry shape (2.6). |
| D18 | Report-type tools (`performance_report`, `best_time_to_post`, `media_kit`, `get_growth`, `compare_accounts`): the exact request sequences and the formulas in 2.6/2.7 are normative; heuristics beyond those (e.g. slot weekday choice) are best-effort and tests assert shapes only. Snapshot window = `clock-86400..clock`. |
| D19 | Inbox: fixed request plan (own username, 25 recent media since window, per-media comments with `comments_count>0`, tags), `unanswered` = no reply from own username, offset pagination over the merged list, tags failure non-fatal; webhook event field mapping and merge-by-comment-id. |
| D20 | Pagination: `list_comments` max 50, `get_conversation` max 20; `list_media` product-type filter is client-side per page; cursors encode Meta's `after` and are opaque; `list_stories` and others pass `limit`/`after` through. |
| D21 | `download_media` file naming for children/thumbnails, sidecar `<id>.json` contents, ext derivation, skip-if-exists; downloads root = `downloads_dir`, default `$INSTAGRAM_MCP_HOME/downloads`. `backup_account` request plan, `max_items` default 500, `media_index` skip semantics, `insights-latest.json`. |
| D22 | Hashtag budget: counted per account over a rolling 7 days of the clock; already-recorded hashtags cost nothing; recorded only on success; `get_hashtag_media` has no budget effect. |
| D23 | DMs: window computed from the last 20 messages; human-agent send = `messaging_type=MESSAGE_TAG` + `tag=HUMAN_AGENT` only when `policy.allow_human_agent_tag`; private reply older than 7 days -> `MESSAGING_WINDOW_CLOSED` at preflight; messaging profile `clear` via `DELETE /messenger_profile`. |
| D24 | CLI: `auth status` JSON schema and `--check`; `doctor` check ids/statuses/exit codes (0/1/2) and its requests; `scheduler run-once` exit 3 on lease conflict; `version` prints the bare version. |
| D25 | HTTP: check order (413 -> Host 403 -> Origin 403 -> bearer 401), `WWW-Authenticate: Bearer`, 401 rate limit (20/60 s -> 429), Host allowlist includes `localhost`/`[::1]` and hosts of `allowed_origins`. |
| D26 | Webhook: events dedup by sha256 of event item, `503` when no app secret, field derivation for `messaging[]` items, visibility via inbox; handshake returns challenge as plain text (not coerced to int). |
| D27 | Media host: `GET` and `HEAD` and single-range `206` supported; `405` for other methods; 24 h expiry counted from container creation; deletion after successful publish; token = 43 base64url chars. |
| D28 | Operation/approval/job/snapshot id prefixes `op_`, `appr_`, `sched_`, `snap_` with >= 22 url-safe chars; `get_operation` accepts either an operation or approval id, reconciles unknown publishes via `GET /{creation_id}?fields=status_code` and (if `PUBLISHED`) a one-item recent-media read; `FINISHED`/`IN_PROGRESS` leave the operation `unknown`; `ERROR`/`EXPIRED` mark it `failed`. |
| D29 | Local-only tools allowed under `read_only`: `mark_handled`, `cancel_scheduled`, `download_media`, `backup_account`, `snapshot_insights`. `cancel_scheduled` requires `confirm: true`. |
| D30 | Annotations: `destructiveHint` only on `approve` and `cancel_scheduled`; `readOnlyHint:false` on the six local-write tools listed in 1.15. |
| D31 | (security review 2026-10-29) Local publish media and covers must resolve (realpath) inside `local_media_dirs` (default `<home>/media`) and be regular files, else `INVALID_INPUT` `details.reason:"path_not_allowed"`; the preview shows `path`, `real_path`, `bytes`, `sha256`, `content_type` for every local file including the cover (`preview.cover`); the binding covers `real_path` and `sha256`; approve re-resolves and re-hashes media and cover. |
| D32 | (security review 2026-10-29) Preflights make no outbound non-Meta request and no DNS lookup by default (`policy.verify_remote_media:false`); remote media/cover/DM URLs get syntax checks plus warning `MEDIA_UNVERIFIED`. With it true: one DNS resolution, all addresses must be public, connection pinned to the validated address. The SSRF classifier covers all IPv4/IPv6 encodings (mapped, compatible, NAT64, 6to4, Teredo) and is shared with downloads. Failed-check upstream headers are never echoed. |
| D33 | (security review 2026-10-29) `instagram_approve` asks for human confirmation via MCP elicitation when the client supports it and `policy.confirm_via_elicitation` (default true) is set; decline/cancel -> `POLICY_DENIED` `details.reason:"declined_by_user"` and the approval stays pending. Every preflight result carries a server-written `summary` of the stored preview. |
| D34 | (security review 2026-10-29) Scheduler: per-job CAS claim (`claim_owner`/`claim_expires`), `scheduler run-once` renews its lease; `publish_attempted_at` is persisted before `media_publish`; a job with it set and no result is reconciled via container `status_code` (`PUBLISHED` -> `published`, else `unknown`) and `media_publish` is never sent again. |
| D35 | (security review 2026-10-29) Media-host port ownership uses a challenge-response probe (`/m/__health?nonce=`, HMAC with `<home>/media-host.key`); no marker header on normal responses. |
| D36 | (security review 2026-10-29) Immediate resumable (facebook local video) upload reads a staged copy whose hash matched the approval; staged copies are deleted on any terminal failure (kept only for `unknown`); staging cleanup also runs at the start of each publish approve. |
| D37 | (security review 2026-10-29) DM preview lists every sent field (text, media, quick replies, reply_to_mid, reaction, tag). Approval params are stored with only exact registered secret values redacted (no generic pattern redaction) and the binding hash is computed over exactly the stored params, so captions such as `Bearer abcdefghij` approve normally. |
| D38 | (security review 2026-10-29) Webhook POST validation order: well-formed `X-Hub-Signature-256` header first (else `401`, regardless of app-secret configuration), then app-secret presence (`503`), then HMAC check (`401`), body size (`413`), JSON (`400`). Amends D26. |
