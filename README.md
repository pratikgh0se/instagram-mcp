# instagram-mcp

A self-hosted MCP server that lets an AI agent run an Instagram creator's content cycle (plan, publish, schedule, engage, measure, report) using only Meta's official Instagram Platform API.

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg) ![Node >=22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)

Status: `1.0.0-rc.1`. The unit-level behaviour is specified in [docs/CONTRACT.md](docs/CONTRACT.md). The release candidate becomes 1.0.0 once the live run in [docs/TESTING-LIVE.md](docs/TESTING-LIVE.md) passes on a real account. Some Meta behaviours are not documented well enough to be certain; those are listed in [docs/TESTING-LIVE.md](docs/TESTING-LIVE.md) and the server tolerates either answer.

## What it is

- Self-hosted. It runs on your machine (or your own server). Nothing is relayed through a third party. Tokens stay in your keychain or an encrypted file.
- Official Meta API only. No scraping, no private API, no password login, no browser automation.
- Secure by default. Local transport, bearer-protected HTTP, redacted logs, account allowlist, approval before every write. See [Security model](#security-model).
- Built for a creator workflow: 42 tools covering publishing and scheduling, comment triage, DMs, insights, reports, a media kit and competitor benchmarks.

## Features

| Area | Tools | What you get |
|---|---|---|
| Account, auth, ops | 6 | Configured accounts and resolved capabilities, profile, publishing quota and rate usage, operation ledger and audit log, `instagram_approve` |
| Media and archive | 5 | List and read own posts and stories, download media with metadata sidecars, incremental account backup |
| Publishing | 6 | Preflight and publish image, reel, story, carousel (local files or URLs), scheduling, schedule list and cancel, delete media, comments on/off, publish status |
| Comments, mentions, inbox | 7 | List comments, unified triage inbox (unanswered, handled), batch reply, hide, unhide, delete, private reply, mentions and tagged media, reply to mentions |
| Direct messages | 4 | Conversations with 24-hour window state, read messages, send (text, media, reaction, quick replies), ice breakers and persistent menu |
| Insights and reports | 8 | Account and media insights, audience demographics, stored daily snapshots and growth, performance report, best time to post, media kit |
| Discovery and partnerships | 6 | Business discovery lookup, benchmark against up to 10 accounts, hashtag search and media, collaboration invites (Facebook Login path) |

Full per-tool reference: [docs/TOOLS.md](docs/TOOLS.md) (generated from the live registry).

## What this cannot do (and why)

The official API does not offer these, so this server does not either.

- Follow or unfollow accounts.
- List your followers or who you follow.
- Like posts or comments, or save posts.
- Archive posts in the app (hide from profile).
- Pin posts or comments.
- Edit a caption after publishing.
- Read other people's private content, or download media from accounts that are not business or creator accounts you own.
- Run partnership ads (that is the Marketing API).
- Use Creator Marketplace (brand-side and requires App Review).

## Known limitations

- Direct messages in Development mode (facebook login path): listing conversations may return an empty list for senders without an app role, even though a DM exists. Sending private replies works. Probable causes: a dev-mode restriction, or the phone-app-only "Allow access to messages" toggle (absent on some accounts). Observed 2026-11-01; see docs/CONTRACT.md U29.
- `instagram_get_profile` returns `account_type: null` on the facebook login path (the Graph API does not provide it there); a warning says so.
- Mention replies work only for caption or comment @mentions, not photo tags.

## Which login path

Each account is configured with one of two login paths. Both use only official endpoints.

| Feature | Instagram Login | Facebook Login (for Business) |
|---|---|---|
| Needs a Facebook Page | No | Yes |
| Publish by URL (image, reel, story, carousel) | Yes | Yes |
| Publish local files | Images and video through the media host (needs a tunnel) | Video by resumable upload (no tunnel); images still through the media host |
| Comments, mentions, insights, scheduling | Yes | Yes |
| Direct messages | Yes | Probed (Messenger Platform on the Page); unverified |
| Delete media | Probed (unverified) | Yes |
| Business discovery (competitor lookup, benchmarks) | No | Yes |
| Hashtag search | No | Yes |
| Branded content and paid partnership flags | Probed (unverified) | Yes |
| Collaboration invites | Probed (unverified) | Yes |
| `story_insights` webhook | No | Yes |
| Token | 60 days, refreshable by the server | Long-lived Page token |

"Probed" means the server tries the call and, if Meta refuses it, remembers that for the account and returns `CAPABILITY_UNAVAILABLE` naming the other path. Recommendation: Facebook Login for full features, Instagram Login as the simpler path. [docs/SETUP.md](docs/SETUP.md) section A helps you choose.

## Quick start

Requires Node.js 22.13 or newer. Installation is from source (the package is not published to npm yet).

```sh
git clone https://github.com/pratikgh0se/instagram-mcp.git
cd instagram-mcp
npm ci
npm run build

# Optional: put the CLI on your PATH. Otherwise use `node dist/cli.js` wherever this README says `instagram-mcp`.
npm link

instagram-mcp accounts add --alias main --login instagram      # facebook path: --login facebook --page-id <PAGE_ID> --app-id <APP_ID>
instagram-mcp auth set-token --account main                    # paste the token (hidden prompt) or pipe it on stdin
instagram-mcp doctor
```

Before this works you need a Professional Instagram account, a Meta app and a token. [docs/SETUP.md](docs/SETUP.md) walks through that step by step. `doctor` prints PASS, WARN or FAIL per check with a fix for each.

## Connect an MCP client

Use absolute paths. Replace `/ABSOLUTE/PATH/TO/instagram-mcp` with your clone.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "instagram": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js", "serve"]
    }
  }
}
```

Claude Code (stdio):

```sh
claude mcp add instagram -- node /ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js serve
```

HTTP mode (Streamable HTTP at `/mcp`, bearer required, loopback by default):

```sh
instagram-mcp http-token rotate        # prints a new bearer once; stores it in your secrets backend
instagram-mcp serve --http --port 8765
```

```sh
claude mcp add --transport http instagram http://127.0.0.1:8765/mcp --header "Authorization: Bearer <TOKEN>"
```

The server refuses to start in HTTP mode without a stored bearer, and refuses a non-loopback bind unless `http.allow_remote` is true. `INSTAGRAM_MCP_HTTP_HOST` overrides `http.host` (the `--host` flag wins over both); the `allow_remote` rule applies to the effective host.

Tip: set your client to ask before running `instagram_approve` and let everything else run. That one tool is the only one that changes Instagram.

Long approves: publishing a large carousel (up to 20 items) can take several minutes while Instagram processes each container. `instagram_approve` sends MCP progress notifications whenever the client supplies a progress token, so if your client has a request timeout (many default to 60 s), enable reset-on-progress (`resetTimeoutOnProgress` in the MCP SDK) or raise the timeout for that tool. If a client kills the server mid-approve, the operation is marked `unknown` the next time the server starts or any operation is looked up; use `instagram_get_operation` to reconcile it. On shutdown (stdin closed, SIGTERM, SIGINT) the server waits up to `INSTAGRAM_MCP_DRAIN_MS` (default 5 minutes) for in-flight approves; a second signal exits immediately.

## How writes work

Every Instagram-side write goes through two steps.

1. `instagram_preflight_<action>` is read-only. It validates input, policy, capability, quota and media specs, reads the current target state, and returns a preview, warnings and an `approval_id` that expires (default 10 minutes).
2. `instagram_approve` with `confirm: true` executes exactly what was previewed. It is single-use, re-checks the target still exists, and records an audit row. Repeating it returns the stored outcome without re-executing.

Controls in `config.json` under `policy`:

- `read_only: true` makes every preflight and approve fail with `POLICY_DENIED`.
- `dry_run: true` makes `instagram_approve` validate and return the planned Graph calls without sending anything. Good for a first trial.
- `disabled_actions: ["delete_media", "send_message"]` blocks named actions.
- `approval_ttl_seconds` sets the approval lifetime.
- `verify_remote_media` (default `false`): when true, preflights resolve remote media hosts (pinned DNS) and send one HEAD each; when false no non-Meta request is made and a `MEDIA_UNVERIFIED` warning is returned.
- `confirm_via_elicitation` (default `true`): `instagram_approve` asks you to confirm through MCP elicitation when the client supports it; declining returns `POLICY_DENIED`.

Other keys: `local_media_dirs` (array, default `["<home>/media"]`) lists the only directories local publish media may come from; `media_host.bind` (default `127.0.0.1`) and `media_host.allow_remote` (default `false`, required for a non-loopback bind, e.g. in Docker).

Publishing never double-posts: an ambiguous `media_publish` failure is recorded as outcome `unknown` with the creation id, and `instagram_get_operation` reconciles it instead of retrying.

## Scheduling and the daemon

Giving `instagram_preflight_publish` a `publish_at` creates a scheduled job on approval. The job is executed by the daemon (or `instagram-mcp scheduler run-once` from cron): containers are created shortly before the time and published at the time. A job missed by more than `missed_grace_minutes` (default 60) is marked `missed` and never posted late.

```sh
instagram-mcp daemon            # scheduler, webhooks (if enabled), daily snapshots, token refresh
instagram-mcp daemon --http     # also serves the MCP endpoint over HTTP
```

One daemon runs per state directory. Ready-made [launchd](examples/com.instagram-mcp.daemon.plist) and [systemd](examples/instagram-mcp-daemon.service) files and a [Dockerfile](Dockerfile) are included. See [docs/SETUP.md](docs/SETUP.md) section G.

## Webhooks

The daemon can receive Instagram webhooks (comments, mentions, messages and more) on `POST /webhooks/instagram`, verifying `X-Hub-Signature-256` with your app secret. It needs a public HTTPS URL (a Cloudflare Tunnel works; see [examples/cloudflared-config.yml](examples/cloudflared-config.yml)). Without webhooks, the inbox polls the API instead. Setup: [docs/SETUP.md](docs/SETUP.md) section H.

## Security model

- Secrets live in the macOS keychain, an AES-256-GCM encrypted file, or read-only environment variables. They never appear in tool output, errors, logs, audit rows or the SQLite database.
- State directory is mode 0700 and files 0600; a config file that is group/world-writable, foreign-owned or a symlink is refused. Cleartext (http) API URL overrides and media host URLs are rejected outside test mode.
- Keychain items can be read by any process running as your user; use the encrypted-file backend with a passphrase if that matters (see [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)).
- HTTP transport: loopback default, mandatory bearer (constant-time compare), Host and Origin checks, 1 MB body limit, rate-limited failures, session idle expiry and server timeouts.
- Webhooks are accepted only with a valid HMAC signature. The media host serves only unguessable, expiring tokens for staged files.
- User-supplied URLs are fetched over HTTPS only with an SSRF guard; downloads only come from Meta CDN hosts.
- Only configured accounts are reachable from any tool.

Details and the threat model: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md). Reporting: [SECURITY.md](SECURITY.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Step-by-step Meta, token, install, tunnel, daemon and webhook setup |
| [docs/TOOLS.md](docs/TOOLS.md) | Generated tool reference |
| [docs/CONTRACT.md](docs/CONTRACT.md) | Behaviour contract |
| [docs/TESTING-LIVE.md](docs/TESTING-LIVE.md) | Live end-to-end checklist and unverified upstream facts |
| [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) | Threat model |
| [AGENTS.md](AGENTS.md) | Playbook for AI agents installing and operating this server |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |
| [docs/superpowers/specs/2026-10-29-instagram-mcp-v1-design.md](docs/superpowers/specs/2026-10-29-instagram-mcp-v1-design.md) | v1 design spec |

## License

MIT. Copyright (c) 2026 Pratik Ghose. See [LICENSE](LICENSE).
