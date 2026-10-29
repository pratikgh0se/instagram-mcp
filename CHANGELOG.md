# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

## [0.1.0]

### Added
- Initial Instagram MCP server.
