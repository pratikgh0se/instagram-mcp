# Security model

This document is the threat model for instagram-mcp and maps each protection to the acceptance requirements in section 6 of [the v1 design spec](superpowers/specs/2026-10-29-instagram-mcp-v1-design.md). The reporting process is in [../SECURITY.md](../SECURITY.md).

## What is being protected

| Asset | Why it matters |
|---|---|
| Instagram access tokens (and Page tokens) | Full control of the account within the granted permissions |
| App secret | Can mint `appsecret_proof`, forge webhook signatures, exchange tokens |
| HTTP bearer, webhook verify token | Gate the MCP endpoint and the webhook handshake |
| The account itself | Public posts, comments, DMs; reputation |
| Local files | Downloads, staged media, SQLite state |

## Trust boundaries and threats

| Threat | Mitigation | Spec 6 |
|---|---|---|
| A prompt-injected or confused agent makes a destructive or public change | Every write is preflight then `instagram_approve` with literal `confirm: true`. The approval is bound to a hash of the exact previewed action, expires (default 600 s), is single use, and re-checks the target. Clients can require human confirmation on `instagram_approve` alone. Policy: `read_only`, `dry_run`, `disabled_actions`. | 2.4 (design) |
| Duplicate posts from retries | Writes are never retried automatically. Ambiguous publishes become `unknown` and are reconciled by a read. Scheduled jobs in `unknown` are never re-published, missed jobs are never posted late. | design 2.4, 2.9 |
| Secret leakage through logs, errors, tool output or storage | Every URL, error, cause and log line passes through redaction (`access_token`, `Bearer`, `appsecret_proof`, `client_secret`, plus any loaded secret value, including `INSTAGRAM_MCP_MASTER_KEY` and `INSTAGRAM_MCP_PASSPHRASE`). Secrets are never written to SQLite or the audit log. Tokens are read from a hidden prompt or stdin, never argv. Secrets are loaded once into an in-memory cache (changed only by this process's own `set`/refresh); unauthenticated webhook requests never reach the secret backend. | 1 |
| Secrets at rest | macOS keychain, AES-256-GCM encrypted file (key from `INSTAGRAM_MCP_MASTER_KEY` or a passphrase), or read-only env. State dir 0700, files 0600 (including the SQLite `-wal`/`-shm` files). The encrypted file requires full 16-byte GCM tags, derives passphrase keys with scrypt N=2^17 r=8 p=1 (files written before the `kdf` field existed keep their old N=2^14 parameters and stay readable), and serializes read-modify-write with an exclusive lock file. A config file that is group- or world-writable, owned by another user, or a symlink is refused. A user-supplied `downloads_dir` is never chmod'ed. | 2 |
| Unauthenticated access to the MCP HTTP endpoint | Loopback bind by default, refuses remote bind without `http.allow_remote`. Mandatory bearer with constant-time compare; refuses to start without one. Host and Origin allowlists (DNS rebinding). 1 MB body limit (oversized requests get 413 with `Connection: close`). After 20 failed attempts in 60 s, 429 (the failure table is pruned). Idle MCP sessions expire after 30 min. Header, request and keep-alive timeouts (15 s, 30 s, 5 s) apply to the MCP, webhook and daemon listeners. `allowed_hosts` entries with a port (`host:port`) match the Host header exactly. | 3 |
| Forged webhooks | `X-Hub-Signature-256` HMAC-SHA256 over the raw body with the app secret, constant-time compare; unsigned or invalid gets 401 and nothing is stored; 503 when no app secret. Method, size and signature-header shape are checked before any secret is read. Events older than 30 days are pruned daily by the daemon. Verify handshake uses a stored token compared in constant time. Events deduplicated. | 4 |
| Media host abused to read local files or enumerate | Serves only `GET`/`HEAD /m/<token>` for staged, unexpired files; 43-character random tokens; no listing; no traversal; loopback bind by default (a non-loopback `media_host.bind` needs `media_host.allow_remote: true`, for Docker); staged files are deleted after a successful publish and expire after 24 h (deletion and expiry sweeps need the daemon; scheduled copies are served until shortly after their publish time). Expose only the tunnel route `/m/`; `media_host.public_base_url` must be https. | 5 |
| SSRF through user-supplied media URLs | HTTPS only, DNS resolved and private, loopback and link-local addresses rejected, no redirects followed on the HEAD check. | 6 |
| Malicious download targets or path tricks | Downloads only from Meta CDN hosts (`*.cdninstagram.com`, `*.fbcdn.net`); filenames sanitized; writes confined to the downloads directory. | 6 |
| Acting on an account that is not yours | Only configured accounts are reachable; an unknown alias or id returns `ACCOUNT_NOT_ALLOWED`. | 7 |
| Vulnerable or tampered dependencies | 2 direct runtime dependencies (`@modelcontextprotocol/sdk`, `zod`; about 93 transitive packages, mostly the SDK's HTTP stack), no native addons, a committed lockfile and `npm ci` in CI. CI runs typecheck, build, smoke, `npm audit --omit=dev --audit-level=high`, gitleaks (CLI from its official image, no token) and `npm pack --dry-run`; every action is pinned to a commit SHA and each job has least-privilege `permissions`. The Docker base image is pinned by tag, not digest. | 8 |
| Cleartext token leakage via env overrides | `INSTAGRAM_MCP_GRAPH_URL_*` and `INSTAGRAM_MCP_RUPLOAD_URL` must be https unless `INSTAGRAM_MCP_TEST_MODE=1`; otherwise startup fails. | 2 |
| Excess permissions | Request only the scopes in [SETUP.md](SETUP.md); the app stays in development mode and serves only accounts you control. | n/a |

## Mapping to spec section 6

| # | Requirement | Where implemented |
|---|---|---|
| 1 | No secret in output, errors, logs, audit rows or SQLite | `src/redact.ts`, secrets backends, CONTRACT 1.14 |
| 2 | State dir 0700, files 0600, group/world-writable, foreign-owned or symlinked config refused | `src/config/load.ts` |
| 3 | HTTP loopback, bearer, Host and Origin checks, body limit | `src/transports/http.ts`, CONTRACT section 4 |
| 4 | Webhook signature on raw body, constant time, unsigned 401 | `src/webhooks/`, CONTRACT section 5 |
| 5 | Media server tokens, expiry, traversal safe, loopback | media host, CONTRACT section 6 |
| 6 | HTTPS only, SSRF guard, Meta CDN downloads, sanitized names | publishing and media tools |
| 7 | Account allowlist on every tool | `src/config/accounts.ts` |
| 8 | CI gates | `.github/workflows/ci.yml` |
| 9 | SECURITY.md with reporting and threat model summary | [../SECURITY.md](../SECURITY.md), this file |

## What you must do yourself

- Treat the machine as the trust boundary. Keychain items are created through the `security` CLI without a per-app ACL, so any process running as your user (including a coding agent with a shell) can read them without a prompt (`security find-generic-password -w -s instagram-mcp`). The stricter option is the encrypted-file backend with a passphrase (`INSTAGRAM_MCP_PASSPHRASE`, supplied only when needed) instead of a stored master key. Disk encryption and a screen lock are your job. The server passes `security` only `PATH` and `HOME`.
- In Docker, supply one persistent `INSTAGRAM_MCP_MASTER_KEY` (secret or 0600 env file); never generate it per run, and avoid `-e` on the command line (visible in `docker inspect`). Set `media_host.bind` to `0.0.0.0` with `media_host.allow_remote: true` inside the container and publish the port on 127.0.0.1 only.
- Use the encrypted-file or env backend carefully: `INSTAGRAM_MCP_MASTER_KEY` in a client config file or service environment file is a secret; keep those files mode 0600.
- Do not expose port 8765 or 8766 directly to the internet. Use a tunnel with narrow routes ([../examples/cloudflared-config.yml](../examples/cloudflared-config.yml)). If you must serve the MCP endpoint remotely, put TLS and an authenticating proxy in front and set `http.allow_remote` and `allowed_hosts` deliberately.
- Secrets are cached in memory per process. After `auth set-token`, `auth refresh` or `auth set-app-secret` from the CLI, restart any running daemon or long-lived server (macOS `launchctl kickstart -k gui/$(id -u)/com.instagram-mcp.daemon`; Linux `systemctl restart instagram-mcp-daemon`) so it picks up the new value.
- Rotate on suspicion: `instagram-mcp http-token rotate`, reset the app secret in the Meta dashboard then `auth set-app-secret`, and generate a new token then `auth set-token`.
- Require human confirmation for `instagram_approve` in your MCP client.

## Residual risks and limits

- A token holder can do anything the granted scopes allow outside this server; the server only constrains itself.
- Approval gates what the agent does through this server. They do not stop a human who approves a bad action.
- Meta's behaviour on some endpoints is unverified (see [TESTING-LIVE.md](TESTING-LIVE.md)); the server fails closed (it surfaces Meta's error) rather than guessing.
- On the Instagram Login path the token is sent as a query parameter (the documented form) unless `token_in_header` is set; redaction keeps it out of logs, but it is in the URL on the wire (TLS protected).
