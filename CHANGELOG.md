# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- CLI: `app set --app-id <id>` and `accounts add --app-id <id>` write `app.app_id`.
- `INSTAGRAM_MCP_HTTP_HOST` environment override for the HTTP bind host (`allow_remote` rules still apply).

### Changed
- Instagram-path `auth set-token`: a failed short-to-long exchange (dashboard tokens are already long-lived) now stores the token as-is with a one-line note.
- Media host: if the port is already served by another instance sharing the same `INSTAGRAM_MCP_HOME` (identified by a marker header derived from the staging path), that instance is used instead of failing with `MEDIA_HOST_UNAVAILABLE`.

### Fixed
- Startup now refuses a non-loopback `http.host` without `http.allow_remote` and a non-http(s) `media_host.public_base_url`, regardless of transport.
- A successful capability probe is no longer cached; only failures cache `no`.
- `appsecret_proof` values and the app secret are registered with the redactor, and malformed upstream error bodies are scrubbed.
- `instagram_get_profile` returns `account_type: null` on the Facebook path.
- Publish preview media items match the contract exactly (no extra `route` field).
- `doctor` checks each account's `/me` and quota request before moving on to the next account.
- HTTP `Origin` must exactly equal an `allowed_origins` entry.
- Plain-http Graph endpoints send `Connection: close` (avoids ~500 ms keep-alive stalls that starved the container poll loop).

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
