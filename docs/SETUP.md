# Setup guide

This guide takes you from nothing to a working server on a fresh Instagram test account. Do the sections in order; sections F to H are optional.

Honesty note: Meta changes its dashboard wording often, and this guide was written from Meta's published docs (accessed 2026-10-29), not from a live click-through. Steps marked "(Meta's UI may label this differently)" could not be confirmed from a 2025-2026 source. If a label differs, look for the closest one. Section J lists common errors and fixes.

## Contents

- [A. Choose a login path](#a-choose-a-login-path)
- [B. Prepare the Instagram account](#b-prepare-the-instagram-account)
- [C. Create the Meta app](#c-create-the-meta-app)
- [D. Generate a token and collect ids](#d-generate-a-token-and-collect-ids)
- [E. Install and configure instagram-mcp](#e-install-and-configure-instagram-mcp)
- [F. Optional: media host for local files (Cloudflare Tunnel)](#f-optional-media-host-for-local-files-cloudflare-tunnel)
- [G. Optional: daemon for scheduling and snapshots](#g-optional-daemon-for-scheduling-and-snapshots)
- [H. Optional: webhooks](#h-optional-webhooks)
- [I. Connect Claude Desktop or Claude Code](#i-connect-claude-desktop-or-claude-code)
- [J. Troubleshooting](#j-troubleshooting)

Checklist of what you will end up with (keep these in a password manager, not in a file in this repo):

| Item | Where it comes from | Used for |
|---|---|---|
| Access token | section D | `auth set-token` |
| App ID | App settings, Basic | config `app.app_id` (Facebook path exchange) |
| App secret | App settings, Basic | `auth set-app-secret` (exchange, `appsecret_proof`, webhook signatures) |
| `ig_user_id` | filled automatically by `auth set-token` | account config |
| Page ID (Facebook path only) | your Facebook Page | `accounts add --page-id` |

## A. Choose a login path

| | Instagram Login | Facebook Login (for Business) |
|---|---|---|
| Extra setup | None beyond the Instagram account | A Facebook Page linked to the Instagram account |
| Token steps | Click "Generate token" in the dashboard | Graph API Explorer user token, then the server exchanges it for a long-lived Page token |
| Delete media | Unverified, probed | Yes |
| Local video upload without a tunnel | No | Yes |
| Competitor lookup, benchmarks | No | Yes |
| Hashtag search | No | Yes |
| Branded content flags | Unverified, probed | Yes |

Recommendation:

- Want every feature (delete, local video upload, competitor lookup, hashtags, branded content): use Facebook Login.
- Want the shortest path to publishing, comments, DMs and insights: use Instagram Login. You can add the other path later as a second account alias for the same Instagram account.

Pick one now. Steps that differ are labelled "Instagram Login" or "Facebook Login".

## B. Prepare the Instagram account

Use a separate test account, not your main one. The API only works with Professional accounts.

1. In the Instagram app, open your profile, tap the menu (three lines, top right), then **Settings and activity**.
2. Scroll to **For professionals** (older versions: **Account type and tools**) and tap **Switch to professional account**. (Meta's UI may label this differently; Meta's help text names the path as Settings and activity, Account type and tools, Switch to professional account.)
3. Pick **Creator** or **Business**. Both are Professional accounts and work with the API. Pick a category and continue.
4. Make sure the account is public. Switching a private account to Professional makes it public. The Meta docs say a test account added to the app must be public.

You should see: a Professional dashboard on your profile, and an Insights button.

Facebook Login only:

5. Create a Facebook Page you control (facebook.com, **Pages**, **Create new Page**). Any name and category is fine.
6. Link the Instagram account to the Page. In the Instagram app: **Edit profile**, **Page** (under Public business information), **Connect or create** and choose the Page. Alternatively, in the Facebook Page settings, **Linked accounts**, **Instagram**, **Connect account**. (Meta's UI may label this differently.)
7. Note the Page ID: on the Page, **About** (or **Page transparency**), then copy the **Page ID**. Keep it for section E.

## C. Create the Meta app

You need a Meta developer account (developers.facebook.com) logged in with a Facebook user. That user becomes the app Administrator. This can be your normal Facebook login; it does not have to be the Instagram test account.

1. Open `https://developers.facebook.com/apps` and click **Create App** (top right). If you have no apps, the button reads **Create First App**. (Meta's UI may label this differently.)
2. If asked to connect a business portfolio, you can skip it for now. It is only needed to publish the app, and you are not publishing it.
3. Use case: select **Other**, then **Next**. Meta's docs name this as the only use case listed for Instagram access. An older flow offered "Manage messaging & content on Instagram"; if you see that instead, it is also fine. (Meta's UI may label this differently.)
4. App type: select **Business**, then **Next**. The Instagram product needs a Business app.
5. Enter an app name (anything) and your contact email, then **Create app**.
6. In the app dashboard, scroll to the **Instagram** product and click **Set up**.
   - Instagram Login: this adds **API setup with Instagram login** to the left menu.
   - Facebook Login: use **API setup with Facebook login** instead (Meta's docs name it for Page-linked accounts).

You should see: **Instagram** in the left menu with an API setup page.

### Add the test account

7. Open **App roles**, **Roles** in the left menu (or **Instagram**, **API setup with Instagram login**, section "Generate access tokens"). Add your Instagram test account. You will be asked to log in to Instagram. (Meta's UI may label this differently; Meta's current docs do not use the name "Instagram Tester".)
8. If the dashboard shows the account as pending, accept the invite from the Instagram side. Older Meta tester flows place it in Instagram, **Settings**, **Apps and Websites**, **Tester Invites** (or web: `instagram.com/accounts/manage_access/`), then **Accept**. (Meta's UI may label this differently; this path comes from older Instagram Basic Display guides and is not confirmed for the current platform.)
9. If your Facebook user is not the same person as the Instagram account, also add the Facebook user of the test account to **App roles** as Administrator, Developer or Tester.

You should see: the Instagram account listed with a status that is not "pending".

### Development mode

Leave the app in Development mode. Meta's App Review page says Standard Access (apps serving only accounts you own or manage) does not need App Review. Accounts with a role on the app can use the permissions below without review. What is not confirmed from the docs: exactly which features (webhooks, DMs, hashtags) work in development mode for role holders. [TESTING-LIVE.md](TESTING-LIVE.md) is the run that confirms it, and the server falls back gracefully (inbox polls if webhooks do not arrive).

### Permissions to select

Instagram Login (`instagram_business_*`; the dashboard adds these by default when you set up the product):

| Permission | Needed for |
|---|---|
| `instagram_business_basic` | profile, media, token refresh (required) |
| `instagram_business_content_publish` | publishing |
| `instagram_business_manage_comments` | comments and mentions |
| `instagram_business_manage_messages` | direct messages |
| `instagram_business_manage_insights` | insights |
| `instagram_manage_contents` | delete media (Meta's changelog lists it as required since 2025-12-03; unverified for this path, so if a delete is refused, check this scope) |

Facebook Login (`instagram_*` plus Page scopes; you select these when generating the token in section D):

| Permission | Needed for |
|---|---|
| `instagram_basic` | profile and media (required) |
| `instagram_content_publish` | publishing |
| `instagram_manage_comments` | comments and mentions |
| `instagram_manage_insights` | insights |
| `instagram_manage_messages` | direct messages |
| `instagram_manage_contents` | delete media |
| `pages_show_list` | listing the Page |
| `pages_read_engagement` | reading the Page's linked account, business discovery |
| `pages_manage_metadata` | webhook subscriptions on the Page (only if you use webhooks) |
| `business_management` | only if Meta asks for it (not confirmed) |

Hashtag search additionally needs Meta's "Instagram Public Content Access" feature, which Meta normally grants through App Review. It may not work in development mode. (Not confirmed; the live test checks it.)

### OAuth redirect URL

The "Generate token" button and Graph API Explorer do not need a redirect URL. If the dashboard insists on one when you click **Set up** under "Set up Instagram business login", enter any HTTPS URL, for example `https://example.com/callback` (HTTPS and localhost rules are not confirmed in Meta's docs), and Save. The server never receives OAuth redirects. (Meta's UI may label this differently.)

## D. Generate a token and collect ids

### D1. App ID and app secret (both paths)

1. In the app dashboard open **App settings**, **Basic**.
2. Copy the **App ID**. Click **Show** next to **App secret**, enter your password, and copy it.

Do not paste either into a chat, a commit or a screenshot. You will put the app secret into the server's secret store in section E.

### D2. Instagram Login: generate the token

1. In the dashboard open **Instagram**, **API setup with Instagram business login**.
2. Under "Generate access tokens", find your test account and click **Generate token**.
3. Log in to Instagram if asked, approve, and copy the token. Meta states dashboard tokens are valid for 60 days.

You can sanity-check the token with curl (this puts the token in your shell history, so skip this and use `doctor` in section E if you prefer):
`GET https://graph.instagram.com/v26.0/me?fields=user_id,username`.

### D3. Facebook Login: generate a user token in Graph API Explorer

1. Open `https://developers.facebook.com/tools/explorer/`.
2. In the right panel choose your app in **Meta App**.
3. Under **User or Page** choose **User Token**.
4. In **Permissions**, add every permission from the Facebook Login table above, then click **Generate Access Token**.
5. A Facebook dialog asks which Pages and Instagram accounts to give access to. Select your test Page and Instagram account, then continue.
6. Copy the token from the **Access Token** field.

This is a short-lived user token. You do not do the long-lived and Page token steps by hand: `instagram-mcp auth set-token` exchanges it for a long-lived user token, then fetches the Page token using `page_id` (Meta's UI may label this differently). It needs the app id in the config and the app secret stored first (section E).

### D4. Ids

| Id | How to get it |
|---|---|
| `ig_user_id` | Filled in for you. `auth set-token` reads it from Meta and saves it to the config. |
| `page_id` | Facebook Login only. Section B step 7, or Graph API Explorer: `GET me/accounts?fields=id,name,instagram_business_account` shows each Page `id` and the linked `instagram_business_account.id`. |

## E. Install and configure instagram-mcp

Requires Node.js 22.13 or newer (`node --version`).

1. Install from source.

   ```sh
   git clone https://github.com/pratikgh0se/instagram-mcp.git
   cd instagram-mcp
   npm ci
   npm run build
   npm link        # optional: puts `instagram-mcp` on your PATH
   ```

   Without `npm link`, write `node /ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js` wherever you see `instagram-mcp` below.
   You should see: `npm run build` finishes with no errors and `dist/cli.js` exists. `instagram-mcp version` prints `1.0.0-rc.1`.

2. Add the account. Pick the alias `test`.

   Instagram Login:

   ```sh
   instagram-mcp accounts add --alias test --login instagram
   ```

   Facebook Login:

   ```sh
   instagram-mcp accounts add --alias test --login facebook --page-id <PAGE_ID>
   ```

   (Facebook Login: add `--app-id <APP_ID>` here to set the app id in the same step, see step 3.) You should see: `Added account "test". Next: instagram-mcp auth set-token --account test`. The config file is `~/.instagram-mcp/config.json` (mode 0600).

3. Facebook Login only: set the app id in the config (it is used for the long-lived token exchange):

   ```sh
   instagram-mcp app set --app-id <APP_ID>
   ```

   You can also pass `--app-id <APP_ID>` to `accounts add` in step 2. This writes `"app": { "app_id": "..." }` to `~/.instagram-mcp/config.json`. Instagram Login does not need this.

4. Store the app secret (recommended for both paths; required for the Facebook path exchange, webhooks and `appsecret_proof`).

   ```sh
   instagram-mcp auth set-app-secret
   ```

   Paste the secret at the hidden prompt and press Enter. You should see: `App secret stored.` On macOS the default backend is the keychain; macOS may ask permission to access it. Elsewhere the default is an encrypted file, which needs `INSTAGRAM_MCP_MASTER_KEY` (generate one with `openssl rand -base64 32` and keep it somewhere safe) exported in the shell that runs the server.

5. Store the access token. The token is read from a hidden prompt, or from stdin, never from a command-line argument.

   Instagram Login with a dashboard token (already long-lived):

   ```sh
   instagram-mcp auth set-token --account test --no-exchange
   ```

   Facebook Login:

   ```sh
   instagram-mcp auth set-token --account test
   ```

   Paste the token and press Enter. To pipe it instead: `pbpaste | instagram-mcp auth set-token --account test`.

   You should see one JSON line with `"alias":"test"`, `"ig_user_id":"..."`, `"username":"..."`, an `expires_at` (Instagram path; the Facebook path shows the Page token's expiry or null) and a `notes` array. For Facebook Login, `"exchanged":true` means the long-lived exchange worked. Notes such as "Long-lived user-token exchange failed" mean the app id or app secret is missing or wrong; the token was stored as given. Fix and run it again.

6. Run the health check.

   ```sh
   instagram-mcp doctor
   ```

   You should see a list like:

   ```
   [PASS] config: Loaded ... 
   [PASS] secrets_backend: keychain backend is usable.
   [PASS] tokens: Every account has a token.
   [PASS] token_validity: /me succeeded for 1 account(s).
   [PASS] capabilities: test: ...
   [PASS] quota: content_publishing_limit succeeded.
   [WARN] media_host: media_host.public_base_url is not set ...
   [WARN] daemon: No daemon is running ...
   [WARN] webhooks: Webhooks are disabled.
   All checks passed.
   ```

   The three WARN lines are normal until you do sections F, G and H. A FAIL line prints a `fix:` line; see section J. `quota` WARN with a permissions message means a missing publish or insights permission.

7. Optional: try a dry run first. In `config.json` set `"policy": { "dry_run": true }`. Approvals then return the planned calls without sending them. Remove it (or set `false`) when you want real posts.

8. Check auth status any time: `instagram-mcp auth status --check` prints JSON with token presence, source, expiry and whether `/me` succeeded.

Instagram Login tokens last 60 days. The daemon (section G) refreshes them daily when due; without the daemon, the server refreshes lazily when a tool is used. If a token expires, generate a new one and run `auth set-token` again.

## F. Optional: media host for local files (Cloudflare Tunnel)

Instagram downloads media from a public HTTPS URL. If you give the server a local file path, it stages a copy under an unguessable token and serves it from a small local web server on port 8766. If the daemon (or another server instance with the same `INSTAGRAM_MCP_HOME`) already owns that port, the second instance reuses it, because both read the same staging directory. You need a public hostname that tunnels to it. Skip this section if you only publish from URLs, or (Facebook Login) only upload local videos, which use resumable upload instead.

You need a domain on Cloudflare and the `cloudflared` tool (`brew install cloudflared`).

1. `cloudflared tunnel login` (opens a browser; pick the domain).
2. `cloudflared tunnel create instagram-mcp` prints a tunnel UUID and writes a credentials JSON file. Note both.
3. Copy [../examples/cloudflared-config.yml](../examples/cloudflared-config.yml) to `~/.cloudflared/instagram-mcp.yml`. Replace `<TUNNEL_UUID>`, the credentials path, and the hostnames (`media.example.com`, and `hooks.example.com` if you will do section H). Only `/m/` is forwarded to the media host, and only `/webhooks/instagram` to the daemon. The MCP endpoint is never exposed.
4. `cloudflared tunnel route dns instagram-mcp media.yourdomain.example` (and the hooks hostname).
5. Run it: `cloudflared tunnel --config ~/.cloudflared/instagram-mcp.yml run instagram-mcp`. Leave it running (or install it as a service with `cloudflared service install`).
6. Tell the server the public URL. In `config.json`:

   ```json
   "media_host": { "public_base_url": "https://media.yourdomain.example", "port": 8766 }
   ```

   `public_base_url` must be https. The media host binds 127.0.0.1; in Docker set `"bind": "0.0.0.0", "allow_remote": true` and publish the port on 127.0.0.1 only. Local media is read only from `local_media_dirs` (default `~/.instagram-mcp/media`, created 0700).

7. Check: `instagram-mcp doctor` now shows `[PASS] media_host`. The host starts on demand when you publish a local file; before then nothing listens on 8766, so a request to the public URL returns a tunnel error. That is expected. [TESTING-LIVE.md](TESTING-LIVE.md) covers a real reachability check during a publish.

## G. Optional: daemon for scheduling and snapshots

The daemon runs the scheduler (scheduled posts), the webhook receiver, daily insight snapshots, token refresh and staging cleanup. Stdio use does not need it, except for scheduled posts and webhooks. One daemon runs per state directory.

Quick test in a terminal: `instagram-mcp daemon` (add `--http` to also serve MCP over HTTP). Stop with Ctrl-C. `doctor` in another terminal shows `[PASS] daemon`.

macOS (launchd):

1. Copy [../examples/com.instagram-mcp.daemon.plist](../examples/com.instagram-mcp.daemon.plist) to `~/Library/LaunchAgents/`.
2. Edit the placeholders: the Node path (`which node`), the absolute path to `dist/cli.js`, and `/Users/YOU`.
3. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.instagram-mcp.daemon.plist`
4. Check: `launchctl print gui/$(id -u)/com.instagram-mcp.daemon` and `instagram-mcp doctor`. Logs are at the paths in the plist.
5. Stop: `launchctl bootout gui/$(id -u)/com.instagram-mcp.daemon`.

Tokens are read from the keychain, so none go in the plist.

Linux (systemd): copy [../examples/instagram-mcp-daemon.service](../examples/instagram-mcp-daemon.service) to `/etc/systemd/system/`, edit the user and paths, put `INSTAGRAM_MCP_MASTER_KEY=...` in `/etc/instagram-mcp.env` with mode 0600, set `secrets.backend` to `encrypted-file`, then `systemctl enable --now instagram-mcp-daemon`.

Docker: see the header of the [Dockerfile](../Dockerfile).

Cron alternative without a daemon: run `instagram-mcp scheduler run-once` every few minutes. It exits 3 if a daemon already holds the lease.

## H. Optional: webhooks

Webhooks give the inbox push events. Without them it polls, which is fine for testing. Requirements: the daemon running, a public HTTPS hostname forwarding `/webhooks/instagram` to the daemon port (section F, hooks hostname), and the app secret stored.

1. Choose a verify token, any long random string: `openssl rand -base64 24`.
2. Store it: `instagram-mcp webhooks set-verify-token` (hidden prompt).
3. In `config.json` set `"webhooks": { "enabled": true, "path": "/webhooks/instagram" }`.
4. Start the daemon (section G), then check `instagram-mcp doctor`: `[PASS] webhooks`. Check that the tunnel works: `curl -i "https://hooks.yourdomain.example/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"` should return `403` (reaching the server proves the route works). Do not put your real verify token in a command line that is logged.
5. In the Meta dashboard: **Instagram**, **API setup with Instagram login** (or Facebook login), section **Configure webhooks** (Meta's UI may label this differently). Enter **Callback URL** `https://hooks.yourdomain.example/webhooks/instagram` and **Verify token**, then **Verify and save**. Meta calls your URL; the daemon must be running.
6. Subscribe to fields: `comments`, `mentions`, `messages`, `message_reactions`, `messaging_postbacks`. On the Facebook Login path `story_insights` is also available. The server never subscribes by itself; you toggle fields in the dashboard (the contract lists the subscribe endpoint as unverified).
7. For Instagram Login, also make sure the test account is subscribed to the app's webhooks (a per-account toggle next to the account under the API setup page; Meta's UI may label this differently).

Limits: Meta may deliver webhook events for accounts you do not own only after Advanced Access. For your own test account in development mode, delivery is not confirmed from the docs; the live test records what happens. If no events arrive, the inbox still works by polling.

## I. Connect Claude Desktop or Claude Code

Use absolute paths.

Claude Desktop: edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop. You should see the `instagram` server with its tools.

If you use the encrypted-file backend, add `"env": { "INSTAGRAM_MCP_MASTER_KEY": "..." }` to that entry (this puts the key in the client config file; keep that file private).

Claude Code:

```sh
claude mcp add instagram -- node /ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js serve
claude mcp list
```

You should see `instagram` connected. Then ask: "List my Instagram accounts" (calls `instagram_list_accounts`) and "Show my profile".

HTTP mode instead of stdio:

```sh
instagram-mcp http-token rotate              # prints the bearer once
instagram-mcp serve --http --port 8765       # or: instagram-mcp daemon --http
claude mcp add --transport http instagram http://127.0.0.1:8765/mcp --header "Authorization: Bearer <TOKEN>"
```

Gate writes: in your client's permission settings, require confirmation for the tool `instagram_approve` only.

## J. Troubleshooting

Run `instagram-mcp doctor` first; it prints a `fix:` line for each failure. Tool errors carry an `error.code` and an `action`.

| Symptom or code | Likely cause | Fix |
|---|---|---|
| `CONFIG_INVALID` at start | Invalid JSON, unknown key, group/world-writable, foreign-owned or symlinked config file, http API URL override or `media_host.public_base_url` (https only outside test mode), facebook account without `page_id` | Read the message; `chmod 600 ~/.instagram-mcp/config.json`; fix the field |
| `AUTH_REQUIRED` | No token stored for the account | `instagram-mcp auth set-token --account <alias>` |
| Meta code 190 (`TOKEN_EXPIRED` or `AUTH_FAILED`) | Token expired, revoked, or user changed password | Generate a new token (section D) and run `auth set-token` again |
| Meta code 190 subcode 463 or 467 | Token expired or session invalidated | Same as above |
| Meta code 10 or 200-299 (`MISSING_PERMISSION`) | Permission not selected or not granted | Add the permission (section C table), regenerate the token, accept it for the right account |
| Meta code 100 (`INVALID_INPUT`) | Bad parameter, or a field not supported for this account | Read `details.meta`; check media specs and `account_type` |
| Meta code 4, 17, 32, 613, 80002 (`RATE_LIMITED`) | Rate limit hit | Wait; `instagram_get_rate_limits` shows usage |
| Meta code 9 / subcode 2207042 (`PUBLISH_QUOTA_EXHAUSTED`) | Daily publishing limit used | Wait for the window; the limit is read at runtime |
| Meta code 9007 or 2207xxx (`UPSTREAM_REJECTED`) | Media rejected (format, size, aspect, not ready) | Read the Meta message in the error; use JPEG for images, MP4 or MOV for video |
| `MESSAGING_WINDOW_CLOSED` (code 10 / 2534022) | Over 24 hours since the user's last message | Have the person message the account again |
| `CAPABILITY_UNAVAILABLE` | Feature not available on this login path | Follow the `action` (it names the other path) |
| `MEDIA_HOST_UNAVAILABLE` | `media_host.public_base_url` unset or port 8766 busy (a second instance with the same state dir, such as the daemon, is fine and shares the port) | Section F |
| `OUTCOME_UNKNOWN` | Publish response lost | Do not retry; call `instagram_get_operation` with the approval id |
| `POLICY_DENIED` | `read_only` or `disabled_actions` | Change `policy` in the config |
| `APPROVAL_EXPIRED` | Approval older than the TTL | Run the preflight again |
| `STALE_PREVIEW` | Target changed or vanished since preview | Run the preflight again |
| HTTP server will not start | No bearer stored, or non-loopback host | `instagram-mcp http-token rotate`; keep `127.0.0.1` |
| HTTP 401 or 403 from `/mcp` | Wrong bearer, Host or Origin | Check the header; add your origin to `http.allowed_origins` |
| Webhook verification fails in the dashboard | Daemon not running, tunnel not routing, verify token mismatch | Section H step 4; re-run `webhooks set-verify-token` |
| Webhook POSTs return 401 | App secret mismatch | `instagram-mcp auth set-app-secret` with the current secret (Meta shows it under App settings, Basic) |
| Webhook POSTs return 503 | No app secret stored | `instagram-mcp auth set-app-secret` |
| macOS keychain prompt every run | Keychain item ACL | Choose Always Allow, or use the `encrypted-file` backend |
| App will not add the account | Account is private or not Professional | Section B |
| Daemon: "Another daemon already holds the lease" | Second daemon or stale lease | Stop the other; wait 60 seconds after a crash |
