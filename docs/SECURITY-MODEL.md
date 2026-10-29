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
| Secret leakage through logs, errors, tool output or storage | Every URL, error, cause and log line passes through redaction (`access_token`, `Bearer`, `appsecret_proof`, `client_secret`, plus any loaded secret value). Secrets are never written to SQLite or the audit log. Tokens are read from a hidden prompt or stdin, never argv. | 1 |
| Secrets at rest | macOS keychain, AES-256-GCM encrypted file (key from `INSTAGRAM_MCP_MASTER_KEY` or a passphrase), or read-only env. State dir 0700, files 0600. A world-writable config file is refused. | 2 |
| Unauthenticated access to the MCP HTTP endpoint | Loopback bind by default, refuses remote bind without `http.allow_remote`. Mandatory bearer with constant-time compare; refuses to start without one. Host and Origin allowlists (DNS rebinding). 1 MB body limit. After 20 failed attempts in 60 s, 429. | 3 |
| Forged webhooks | `X-Hub-Signature-256` HMAC-SHA256 over the raw body with the app secret, constant-time compare; unsigned or invalid gets 401 and nothing is stored; 503 when no app secret. Verify handshake uses a stored token compared in constant time. Events deduplicated. | 4 |
| Media host abused to read local files or enumerate | Serves only `GET`/`HEAD /m/<token>` for staged, unexpired files; 43-character random tokens; no listing; no traversal; loopback bind; files deleted after a successful publish and expire after 24 h. Only the tunnel route `/m/` is exposed. | 5 |
| SSRF through user-supplied media URLs | HTTPS only, DNS resolved and private, loopback and link-local addresses rejected, no redirects followed on the HEAD check. | 6 |
| Malicious download targets or path tricks | Downloads only from Meta CDN hosts (`*.cdninstagram.com`, `*.fbcdn.net`); filenames sanitized; writes confined to the downloads directory. | 6 |
| Acting on an account that is not yours | Only configured accounts are reachable; an unknown alias or id returns `ACCOUNT_NOT_ALLOWED`. | 7 |
| Vulnerable or tampered dependencies | Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), no native addons. CI runs typecheck, build, smoke, `npm audit --omit=dev --audit-level=high`, gitleaks and `npm pack --dry-run`. | 8 |
| Excess permissions | Request only the scopes in [SETUP.md](SETUP.md); the app stays in development mode and serves only accounts you control. | n/a |

## Mapping to spec section 6

| # | Requirement | Where implemented |
|---|---|---|
| 1 | No secret in output, errors, logs, audit rows or SQLite | `src/redact.ts`, secrets backends, CONTRACT 1.14 |
| 2 | State dir 0700, files 0600, world-writable config refused | `src/config/load.ts` |
| 3 | HTTP loopback, bearer, Host and Origin checks, body limit | `src/transports/http.ts`, CONTRACT section 4 |
| 4 | Webhook signature on raw body, constant time, unsigned 401 | `src/webhooks/`, CONTRACT section 5 |
| 5 | Media server tokens, expiry, traversal safe, loopback | media host, CONTRACT section 6 |
| 6 | HTTPS only, SSRF guard, Meta CDN downloads, sanitized names | publishing and media tools |
| 7 | Account allowlist on every tool | `src/config/accounts.ts` |
| 8 | CI gates | `.github/workflows/ci.yml` |
| 9 | SECURITY.md with reporting and threat model summary | [../SECURITY.md](../SECURITY.md), this file |

## What you must do yourself

- Treat the machine as the trust boundary: anyone with your user account can use your tokens through the keychain. Disk encryption and a screen lock are your job.
- Use the encrypted-file or env backend carefully: `INSTAGRAM_MCP_MASTER_KEY` in a client config file or service environment file is a secret; keep those files mode 0600.
- Do not expose port 8765 or 8766 directly to the internet. Use a tunnel with narrow routes ([../examples/cloudflared-config.yml](../examples/cloudflared-config.yml)). If you must serve the MCP endpoint remotely, put TLS and an authenticating proxy in front and set `http.allow_remote` and `allowed_hosts` deliberately.
- Rotate on suspicion: `instagram-mcp http-token rotate`, reset the app secret in the Meta dashboard then `auth set-app-secret`, and generate a new token then `auth set-token`.
- Require human confirmation for `instagram_approve` in your MCP client.

## Residual risks and limits

- A token holder can do anything the granted scopes allow outside this server; the server only constrains itself.
- Approval gates what the agent does through this server. They do not stop a human who approves a bad action.
- Meta's behaviour on some endpoints is unverified (see [TESTING-LIVE.md](TESTING-LIVE.md)); the server fails closed (it surfaces Meta's error) rather than guessing.
- On the Instagram Login path the token is sent as a query parameter (the documented form) unless `token_in_header` is set; redaction keeps it out of logs, but it is in the URL on the wire (TLS protected).
