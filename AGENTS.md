# AGENTS.md

Playbook for an AI agent that installs or operates instagram-mcp for a user. Human-oriented setup is in [docs/SETUP.md](docs/SETUP.md); follow it for anything that needs the Meta dashboard.

## Hard rules

1. Never print, log, echo, paste or commit an access token, app secret, HTTP bearer, webhook verify token or master key. Do not put them in command-line arguments (shell history), config files in the repo, or chat. The CLI reads secrets from a hidden prompt or stdin only.
2. Never skip the preview. Every write is `instagram_preflight_<action>` first. Show the user the `preview`, `warnings` and `planned_calls`, and only then call `instagram_approve` with `{approval_id, confirm: true}` after the user agrees. Do not approve on the user's behalf unless they have explicitly delegated it for this task.
3. Never retry a publish after `OUTCOME_UNKNOWN`. Call `instagram_get_operation` with the approval or operation id to reconcile.
4. Do not edit `config.json` by hand except for the documented keys, and keep it mode 0600. Secrets never go in it.
5. Respect `CAPABILITY_UNAVAILABLE`: it names the other login path; tell the user rather than working around it.
6. Only the official Meta API is in scope. Do not suggest scraping, private endpoints or password logins.

## Installing for a user

Requirements: Node.js 22.13 or newer.

```sh
git clone https://github.com/pratikgh0se/instagram-mcp.git
cd instagram-mcp && npm ci && npm run build
node dist/cli.js accounts add --alias main --login instagram          # facebook: --login facebook --page-id <PAGE_ID>
node dist/cli.js auth set-app-secret                                  # user types it at the hidden prompt
node dist/cli.js auth set-token --account main --no-exchange          # instagram dashboard token; omit --no-exchange for the facebook path
node dist/cli.js doctor
```

The user must create the Meta app and token themselves (SETUP.md sections B to D); you cannot do that for them. Ask them to run the two `set-*` commands in their own terminal, or have them pipe the value on stdin. Do not ask them to paste a secret into the chat.

Facebook path: set the app id with `node dist/cli.js app set --app-id <APP_ID>` (or `accounts add ... --app-id <APP_ID>`) before `auth set-token`. An Instagram dashboard token that is already long-lived is stored as-is with a short note; `--no-exchange` skips the attempt.

## Client configuration

stdio (default):

```json
{ "mcpServers": { "instagram": { "command": "node", "args": ["/ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js", "serve"] } } }
```

Claude Code: `claude mcp add instagram -- node /ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js serve`.

HTTP: `node dist/cli.js http-token rotate` (bearer shown once), then `node dist/cli.js serve --http --port 8765`, client URL `http://127.0.0.1:8765/mcp` with header `Authorization: Bearer <token>`.

Recommend the user require confirmation on the `instagram_approve` tool only.

## Running doctor

`node dist/cli.js doctor` (add `--json` for machine output). Exit 0 all good, 1 a check failed, 2 the config could not be loaded. Each non-pass check prints a `fix:` line; apply it or relay it. WARN lines for media host, daemon and webhooks are normal when those optional features are not set up. On the facebook path with webhooks enabled, a WARN `page_subscription` means the app is not subscribed to the linked Page: run `node dist/cli.js webhooks subscribe-page --account <alias>` (check with `webhooks page-subscription`). `auth status --check` gives token presence, expiry and a live `/me` result as JSON.

## Operating

- Start with `instagram_list_accounts` (resolved capabilities) and `instagram_get_rate_limits` (publishing quota) before publishing.
- Multiple accounts: pass `account` (alias) on every tool call, or rely on `default_account`.
- Safe trial: set `policy.dry_run` to true; `instagram_approve` then returns `planned_calls` and sends nothing.
- Scheduling needs a running daemon (`node dist/cli.js daemon`) or `scheduler run-once` from cron. `instagram_list_scheduled` shows status; only `scheduled` jobs can be canceled.
- Local file publishing needs `media_host.public_base_url` and a tunnel (SETUP.md section F).
- Errors are structured: `structuredContent.error` has `code`, `message`, `action`, `retryable`. Follow `action`.

## Where state lives

`INSTAGRAM_MCP_HOME` (default `~/.instagram-mcp`, mode 0700):

| Path | Contents |
|---|---|
| `config.json` | Accounts, policy and other settings (no secrets); override the path with `INSTAGRAM_MCP_CONFIG` |
| `state.sqlite` | Approvals, operations, audit log, scheduled posts, snapshots, inbox state, capability cache |
| `secrets.enc.json` | Only with the `encrypted-file` backend (ciphertext) |
| `downloads/` | Downloaded media and backups (or `downloads_dir`) |
| `staging/` | Media staged for the media host (random token names) |

Secrets live in the macOS keychain (service `instagram-mcp`) by default on macOS, the encrypted file elsewhere, or env variables (`INSTAGRAM_MCP_TOKEN_<ALIAS>`, `INSTAGRAM_MCP_APP_SECRET`, `INSTAGRAM_MCP_HTTP_TOKEN`, `INSTAGRAM_MCP_WEBHOOK_VERIFY_TOKEN`) with the `env` backend.

## Changing this repo

- Behaviour is specified in [docs/CONTRACT.md](docs/CONTRACT.md); the design in [docs/superpowers/specs/2026-10-29-instagram-mcp-v1-design.md](docs/superpowers/specs/2026-10-29-instagram-mcp-v1-design.md). The spec wins on conflict.
- `npm run check` (typecheck), `npm run build`, `npm run smoke` (tool registry check). Behaviour tests live in a separate repository and are not part of this one.
- After adding or changing tools, run `npm run build && npm run docs:tools` and commit the regenerated `docs/TOOLS.md`.
- Never commit real tokens, app secrets or real ids; use placeholders.
