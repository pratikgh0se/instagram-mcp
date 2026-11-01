# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Unified login mode (`--login unified`): Meta's "API setup with Unified login", a non-expiring system-user token on graph.facebook.com with no Page. Per-account app secrets (`auth set-app-secret --account`, `INSTAGRAM_MCP_APP_SECRET_<ALIAS>`).

- DM sender fallback (contract U41): when Meta withholds message senders, conversation results carry `senders: "webhooks"` or `"unavailable"` and the 24 h window comes from stored webhook events; DM preflight warns `WINDOW_UNVERIFIED` when it cannot be confirmed.
- Webhook attribution by signing secret and per-account deduplication when one Instagram account is configured under two aliases or apps (database migration 3).
- Rejected webhook signatures are logged at warn level.

### Changed
- Docs: Unified Login live-verified 2026-11-01 (app Live, Standard Access): publishing, local files, scheduling, delete, comment writes, DMs to an Instagram Tester, messaging profile. Real webhook events do not reach a unified app (Test event only; contract U42).
- Docs: Unified Login live-verified 2026-11-02: hiding/unhiding another account's comment, private reply to another account's comment, and finding and replying to a comment @mention. Real webhooks and hashtag search on Unified are waived for v1 pending Meta App Review (U42).
- Setup guide recommends Unified Login for new apps; Meta no longer offers the dashboard Instagram-login token to apps. Instagram Login steps are kept under a legacy heading.

### Fixed
- Resumable local video publishing no longer starts the media host.
- `instagram_get_operation` `finished_at` is `null` while an operation is `pending` or `running` and comes only from the operation when one exists (a running scheduler operation no longer shows the scheduling approval's finish time); an orphaned scheduler publish carries the container id its job recorded in `details.reconcile.creation_id` so it reconciles (contract 1.13.9, 2.1).

## [1.0.0] - 2026-11-01

### Added
- `doctor` gains an `app_credentials` check (contract 3.3): WARN when a facebook-path account has no app id (`app.app_id`) or the app secret is missing, because `auth set-token` then cannot exchange the token.
- `auth set-token` on the facebook path: when the long-lived exchange is not done, `exchanged` is `false` and `notes` has a `SHORT_LIVED:` entry (the stored token expires in about 1 hour); the token is still stored (contract 3.5).
- CLI: `capabilities reset [--account <alias>] [--feature <name>]` clears cached `no` capability results (contract 3.7); `auth set-token` also clears them; `doctor` WARNs on a cached `no`.
- CLI: `webhooks page-subscription` and `webhooks subscribe-page [--fields <list>] [--unsubscribe]` (contract 3.6) check and set the app's subscription to the linked Facebook Page (`/{page_id}/subscribed_apps`, facebook path only); the default field is `feed` (subscribing `messages` needs `pages_messaging`); `doctor` gains a `page_subscription` check when webhooks are enabled (contract 3.3, U33).
- Orphaned operations (contract 1.13.9): the process executing an operation (approve or scheduler pass) stores a wall-clock `heartbeat_at` (new nullable `operations.heartbeat_at` column, additive migration 2). A `running` operation whose heartbeat is older than `INSTAGRAM_MCP_ORPHAN_AFTER_MS` is marked `unknown` with `OUTCOME_UNKNOWN` (approval `unknown`, linked scheduled job `unknown`, batch items kept or marked unknown) at `serve`/`daemon` startup and at the start of `instagram_get_operation`, `instagram_list_operations` and `instagram_approve`; publish operations reconcile through the stored `creation_id`. New env `INSTAGRAM_MCP_HEARTBEAT_MS` and `INSTAGRAM_MCP_ORPHAN_AFTER_MS`; an orphan age not greater than the heartbeat interval is a startup error.
- Shutdown drain (contract 1.13.10): stdio `serve` (stdin end, SIGTERM, SIGINT), `serve --http` and `daemon` stop accepting new calls and wait for in-flight approves (and scheduler passes) up to `INSTAGRAM_MCP_DRAIN_MS` (default 300000); a second signal exits immediately. Shutdown with nothing in flight is unchanged.
- Progress notifications (contract 1.13.11): `instagram_approve` sends `notifications/progress` (strictly increasing `progress`, `total` when known, short labels, at least every 10 s) when the request carries `_meta.progressToken`. README notes how to configure clients with request timeouts.
- CLI: `app set --app-id <id>` and `accounts add --app-id <id>` write `app.app_id`.
- `INSTAGRAM_MCP_HTTP_HOST` environment override for the HTTP bind host (`allow_remote` rules still apply).

### Fixed
- `instagram_preflight_delete_media`: Meta can answer a carousel `DELETE` with HTTP 400 / code -1 / subcode 2207072 "Fatal" although the media was deleted. A failed `DELETE` (except `CAPABILITY_UNAVAILABLE`, `AUTH_FAILED`, `TOKEN_EXPIRED`, `RATE_LIMITED`) is now verified with one `GET /{media_id}?fields=id`: not found gives `succeeded` with `verified_after_error`, media still there gives `failed`, anything else gives `unknown` (`OUTCOME_UNKNOWN`) (contract 2.x, U35).
- A Meta "object does not exist" (code 100, subcode 33) on a lookup no longer caches a `no` capability (a mistyped conversation id turned every DM tool into `CAPABILITY_UNAVAILABLE`); URL-rule and cursor violations report `details.issues` (contract 1.5, 1.12).
- `webhooks subscribe-page`: a `MISSING_PERMISSION` now says to regenerate the token with `pages_manage_metadata`, re-run `auth set-token` and restart the daemon (contract 3.6).
- Docs: the daemon's 30-day webhook event retention is documented (contract 5).
- Webhooks: DM (`messaging`) entries send `entry.time` in Unix milliseconds; it was read as seconds, giving far-future `received_at` values that broke inbox ordering and retention pruning. Values >= 10^12 are now read as milliseconds, and unusable values fall back to the clock at receipt (contract 5, U34).
- `conversation_id` accepts Meta's ~130-character ids (limit 256).
- `instagram_get_media` (and download, delete preview, comments toggle preview) now work on Stories: on Meta's "(#10) Comments cannot be made on story media." the call is retried once without comment fields, which come back `null`.
- Meta code 10 is no longer always `MISSING_PERMISSION`: "story media" maps to `UPSTREAM_REJECTED`, "User is not mentioned in the caption" maps to `INVALID_INPUT` with an action explaining that photo tags cannot be replied to.
- `auth set-token` always resolves and prints `username` on the facebook path (previously `null` when `ig_user_id` was already configured).
- `instagram_get_profile` adds a `warnings` entry explaining that `account_type` is unavailable on the facebook login path.
- Docs: SETUP.md updated from the live facebook-login run (wizard steps, permissions, Explorer host, Page ID); CONTRACT.md records observed facts U28 to U31 (owner can hide own comment, empty conversations in dev mode).
- Startup now refuses a non-loopback `http.host` without `http.allow_remote` and a non-http(s) `media_host.public_base_url`, regardless of transport.
- A successful capability probe is no longer cached; only failures cache `no`.
- `appsecret_proof` values and the app secret are registered with the redactor, and malformed upstream error bodies are scrubbed.
- `instagram_get_profile` returns `account_type: null` on the Facebook path.
- Publish preview media items match the contract exactly (no extra `route` field).
- `doctor` checks each account's `/me` and quota request before moving on to the next account.
- HTTP `Origin` must exactly equal an `allowed_origins` entry.
- Plain-http Graph endpoints send `Connection: close` (avoids ~500 ms keep-alive stalls that starved the container poll loop).

### Documentation
- DM sending corrected (U36, 2026-11-01): it fails with `MESSAGING_WINDOW_CLOSED` in Development mode but works to an Instagram Tester once the app is Live at Standard Access; people with no role still need Advanced Access per Meta (untested). README, AGENTS, SETUP updated.
- SETUP rewritten for a new user (2026-11-01): developer account registration, per-path app creation, Roles and Instagram Tester procedure, permission-per-feature table, access levels and App Review, Go Live steps, webhook prerequisites, Development-mode capability table, setup-phase troubleshooting and a contents list. The Instagram Login path is documented from Meta's pages and noted as not live-tested.
- New `docs/legal/` privacy policy and data deletion templates, with free GitHub Pages hosting steps (needed to go Live).
- README quick start now includes `auth set-app-secret` and the facebook app id; known limitations updated (DM read and webhooks confirmed live).
- Media host docs: Cloudflare quick tunnel (no domain) and named tunnel. Examples: launchd plist uses the output of `command -v node`; Claude Desktop config uses the absolute node path. AGENTS.md: install notes.

### Changed
- Instagram-path `auth set-token`: a failed short-to-long exchange (dashboard tokens are already long-lived) now stores the token as-is with a one-line note.
- Media host: if the port is already served by another instance sharing the same `INSTAGRAM_MCP_HOME` (identified by a marker header derived from the staging path), that instance is used instead of failing with `MEDIA_HOST_UNAVAILABLE`.

## [1.0.0-rc.1] - 2026-10-29

Release candidate. The version stays at rc until the live end-to-end run in [docs/TESTING-LIVE.md](docs/TESTING-LIVE.md) passes against a real test account.

### Added
- Rewrite as a v1 server built only on Meta's official Instagram Platform API (Graph API v26.0). Two login paths per account: Instagram Login and Facebook Login for Business, with a capability matrix that returns `CAPABILITY_UNAVAILABLE` (naming the other path) or probes and caches unsupported features.
- 42 MCP tools in seven areas: account and ops, media and archive, publishing, comments and inbox, direct messages, insights and reports, discovery and partnerships. Reference: [docs/TOOLS.md](docs/TOOLS.md). Behaviour contract: [docs/CONTRACT.md](docs/CONTRACT.md).
- Preflight, approve, execute write protocol: every Instagram-side write is previewed by an `instagram_preflight_*` tool and executed only by `instagram_approve`, bound to a hash of the exact previewed action, with expiry, single use, stale-state checks, audit rows and an operation ledger.
- Policy controls: `read_only`, `dry_run`, `disabled_actions`, approval TTL.
- Publishing of image, reel, story and carousel posts, with local-file support through an on-demand media host (Cloudflare Tunnel documented) and resumable upload on the Facebook path; scheduling with a daemon-driven scheduler and `scheduler run-once`; ambiguous publishes are reconciled, never retried.
- Daemon (`instagram-mcp daemon`): scheduler loop, webhook receiver, daily insight snapshots, token refresh, staging cleanup, optional Streamable HTTP MCP endpoint. launchd and systemd examples and a Dockerfile.
- Streamable HTTP transport with mandatory bearer token, loopback bind by default, Host and Origin checks, body limit and 401 rate limiting.
- Webhook receiver with verify-token handshake and `X-Hub-Signature-256` verification; inbox falls back to polling.
- Insights, growth snapshots, performance report, best time to post and media kit tools; account benchmarking, business discovery and hashtag search on the Facebook path.
- Secrets backends: macOS keychain, AES-256-GCM encrypted file, read-only environment.
- CLI: `serve`, `daemon`, `scheduler run-once`, `auth set-token|set-app-secret|status|refresh|logout`, `accounts add|list|remove`, `http-token rotate`, `webhooks set-verify-token`, `doctor`, `version`.
- Documentation: README, SETUP guide, live test checklist, security model, AGENTS playbook, MCP registry manifest (`server.json`), generated tool reference.

### Changed
- The v0.1 server (see the 2026-08-19 design in `docs/superpowers/`) is superseded. The design and plan are kept for history.
- The changelog moved from `docs/CHANGELOG.md` to the repository root.

### Security
- Tokens, app secrets, bearer tokens and `appsecret_proof` are redacted from every URL, error, log line and tool output, and never stored in SQLite (the encrypted-file backend stores ciphertext only).
- State directory mode 0700, files 0600; the server refuses to load a world-writable config file.
- Outbound fetches of user-supplied URLs are HTTPS-only with an SSRF guard; downloads are restricted to Meta CDN hosts and confined to the downloads directory.
- Account allowlist enforced on every tool.
- CI runs typecheck, build, smoke check, `npm audit --omit=dev --audit-level=high`, gitleaks and `npm pack --dry-run`.
- Security-review hardening (2026-10-29):
  - Local publish media must resolve inside `local_media_dirs` (default `<home>/media`); previews show path, real path, size and sha256, and approve re-hashes.
  - Preflights make no outbound non-Meta request or DNS lookup by default (`policy.verify_remote_media: false`).
  - `instagram_approve` asks for confirmation through MCP elicitation when supported (`policy.confirm_via_elicitation`); preflight results carry a server-written summary.
  - Scheduler per-job claims and a no-republish rule with reconciliation of attempted publishes.
  - SSRF classifier covering all IPv4/IPv6 encodings with pinned DNS, shared with downloads; downloads use exclusive no-follow temp files.
  - Media host port ownership via an HMAC challenge probe; `media_host.bind` and `allow_remote` settings.
  - In-memory secret cache (restart a running daemon after `auth set-token`/`auth refresh`).
  - Encrypted-file backend hardening and strict config file permission, owner and symlink checks.
  - https-only endpoint overrides, HTTP request timeouts and session expiry.
  - Webhook receiver validates the signature header cheaply first (401 before 503).
  - CI actions pinned by commit SHA.

## [0.1.0]

### Added
- Initial Instagram MCP server.
