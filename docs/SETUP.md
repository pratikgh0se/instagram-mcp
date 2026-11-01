# Setup guide

This guide takes you from "no Meta developer account" to a working self-hosted instagram-mcp, on either login path. Do the sections in order; sections M to P are optional.

## Contents

- [A. Read this first](#a-read-this-first)
- [B. Choose a login path](#b-choose-a-login-path)
- [C. Prepare the Instagram account](#c-prepare-the-instagram-account)
- [D. Register as a Meta developer](#d-register-as-a-meta-developer)
- [E. Create the Meta app](#e-create-the-meta-app)
- [F. Roles and testers](#f-roles-and-testers)
- [G. Permissions and access levels](#g-permissions-and-access-levels)
- [H. Tokens and ids](#h-tokens-and-ids)
- [I. Install](#i-install)
- [J. Store secrets and add the account](#j-store-secrets-and-add-the-account)
- [K. Connect Claude Desktop or Claude Code](#k-connect-claude-desktop-or-claude-code)
- [L. First run](#l-first-run)
- [M. Optional: media host for local files](#m-optional-media-host-for-local-files)
- [N. Optional: daemon for scheduling and snapshots](#n-optional-daemon-for-scheduling-and-snapshots)
- [O. Optional: Go Live (needed for real webhooks)](#o-optional-go-live-needed-for-real-webhooks)
- [P. Optional: webhooks](#p-optional-webhooks)
- [Q. What works in Development mode and at Standard Access](#q-what-works-in-development-mode-and-at-standard-access)
- [R. Troubleshooting](#r-troubleshooting)
- [Appendix: glossary](#appendix-glossary)

## A. Read this first

### TL;DR

1. Make a Professional Instagram account (and, on the Facebook path, a Facebook Page linked to it).
2. Register at developers.facebook.com, create an app, add yourself as a tester, copy a token.
3. Install the server, run `auth set-app-secret` and `auth set-token`, run `doctor`, connect Claude.

Everything beyond that (local file upload, scheduling, webhooks) is optional.

### The map

```
 Core path (about 60 to 90 minutes the first time)
 ------------------------------------------------------------------------------
 C Instagram   D Developer    E Create    F Roles    G Permissions  H Token
 Professional  account        app         (testers)  (per feature)  + ids
 (+ Page)  --> (Facebook   --> (wizard) --> ------ --> ------------> ------
                user)
                                                                        |
      L First run  <--  K Connect Claude  <--  J Secrets + account  <-- I Install
      (dry run)         (Desktop or Code)       (doctor shows PASS)

 Optional branches
 ------------------------------------------------------------------------------
 M Media host (tunnel)       needed to upload local images/video, and for P
 N Daemon                    needed for scheduled posts, and for P
 O Go Live + P Webhooks      push events; needs M (hooks hostname) + N + a policy page
```

### Status of each path

| | Facebook Login | Instagram Login |
|---|---|---|
| Verified end to end by the maintainer | Yes, live on 2026-11-01 | No (see the note below) |
| Where steps come from | A live click-through | Meta's published docs, fetched 2026-11-01 |

Instagram Login note: the Instagram Login path has not been live-tested by the maintainer. Its steps below follow Meta's current pages ([create an Instagram app](https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app.md) and [get started](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started), both fetched 2026-11-01; Meta's pages carry no publication date). If a label differs on your screen, follow Meta's page in parallel and tell us.

Meta renames dashboard items often. Steps are dated "(confirmed 2026-11-01)" where they were walked live; anything undated comes from Meta's docs.

### What you will collect

Keep these in a password manager, not in a file in this repo.

| Item | Where it comes from | Used for |
|---|---|---|
| Access token | section H | `auth set-token` |
| App ID | App settings, Basic | config `app.app_id` (Facebook path exchange) |
| App secret | App settings, Basic | `auth set-app-secret` (exchange, `appsecret_proof`, webhook signatures) |
| `ig_user_id` | filled automatically by `auth set-token` | account config |
| Page ID (Facebook path only) | Graph API Explorer | `accounts add --page-id` |

### Commands: `instagram-mcp` vs `node dist/cli.js`

They are the same program. After `npm link` (section I) you can type `instagram-mcp ...`. Without it, write `node /ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js ...` wherever this guide says `instagram-mcp`.

### Do I need App Review?

- No, if you only operate Instagram accounts you own or manage. That is Standard Access, and publishing, comments, insights, private replies and reading DMs of people who have a role on the app all work at Standard Access.
- Yes, if you want to message people who have no role on your app, or serve other people's accounts. That is Advanced Access, which needs App Review (and, per Meta's [overview](https://developers.facebook.com/docs/instagram-platform/overview), Business Verification). See [section Q](#q-what-works-in-development-mode-and-at-standard-access).

## B. Choose a login path

| | Instagram Login | Facebook Login (for Business) |
|---|---|---|
| Needs a Facebook Page | No | Yes, linked to the Instagram account |
| Token steps | Click "Generate token" in the dashboard (60 days, refreshable) | Graph API Explorer user token; the server exchanges it for a Page token that does not expire |
| Local image upload | Needs the media host (section M) | Needs the media host (section M) |
| Local video upload | Needs the media host | Resumable upload, no tunnel |
| Delete media | Unverified, probed | Yes |
| Competitor lookup, benchmarks | No | Yes |
| Hashtag search | No | Yes |
| Branded content flags | Unverified, probed | Yes |
| Verified live | No | Yes |

Recommendation:

- Want every feature (delete, local video upload, competitor lookup, hashtags, branded content): use Facebook Login.
- Want the shortest path to publishing, comments, DMs and insights, and have no Page: use Instagram Login.
- This server does not support Unified Login tokens; use the Instagram or Facebook setup. Meta's overview recommends Unified Login for new integrations, but the server's two token types are the Instagram Login token and the Facebook Login user/Page token.

You can add the other path later as a second account alias for the same Instagram account. Steps that differ are labelled "Instagram Login" or "Facebook Login".

## C. Prepare the Instagram account

You can use your real professional account. The server writes to Instagram only after you approve a preview, and you can start with `policy.dry_run: true` (section L), so the risk is low. A throwaway account works equally well if you prefer.

The API only works with Professional (Creator or Business) accounts.

1. In the Instagram app open your profile, tap the menu (three lines, top right), then **Settings and activity**.
2. Scroll to **For professionals** (older versions: **Account type and tools**) and tap **Switch to professional account**.
3. Pick **Creator** or **Business**. Both work with the API. Pick a category and continue.
4. Make sure the account is public. Switching a private account to Professional makes it public, and Meta's docs say an account added for testing must be public.

You should see: a Professional dashboard on your profile and an Insights button.

Facebook Login only:

5. Create a Facebook Page you fully control (facebook.com, **Pages**, **Create new Page**). Choose **Public Page**, not "Upgrade your existing profile". Any name and category is fine. An Instagram account already linked to a different Page must be unlinked there first.
6. Link the Instagram account, either from the Page (**Settings**, **Linked accounts**, **Instagram**, **Connect account**; confirmed 2026-11-01) or from the Instagram app (**Edit profile**, **Page**; not walked live).
7. Verify the link in section H3 (`GET me/accounts?fields=id,name,instagram_business_account`). If `instagram_business_account` is missing there, linking failed. This is the most common setup failure; fix it before going on.

## D. Register as a Meta developer

(Written from Meta's flow, not walked live in the maintainer's run; labels may differ.) The developer account belongs to a Facebook user, which is not your Instagram login. That user becomes the app Administrator and is the user who logs in to Graph API Explorer on the Facebook path.

1. Log in at https://www.facebook.com with the Facebook user that will own the app. If you have none, create one first.
2. Open https://developers.facebook.com and click **Get Started** (or **Log in**).
3. Accept the Meta Platform Terms, verify your phone number or email if asked, and pick a role (any works).
4. You land on the App Dashboard at https://developers.facebook.com/apps.
5. If Meta asks you to enable two-factor authentication before creating an app, do so (Facebook, **Settings**, **Accounts Centre**, **Password and security**).

You should see: the App Dashboard, with a **Create App** (or **Create First App**) button.

## E. Create the Meta app

Direct link: https://developers.facebook.com/apps (**Create App**).

### Facebook Login (confirmed 2026-11-01)

1. Click **Create App**. The wizard has five steps: **App details**, **Use cases**, **Business**, **Requirements**, **Overview**.
2. App details: enter an app name and your contact email. The name must not contain "Instagram", "IG", "Facebook" or "Meta" (Meta rejects it as a name restriction).
3. Use cases: tick **Manage messaging & content on Instagram** AND **Manage everything on your Page**. The second one lets the token read the linked Page.
4. Business: choose **I don't want to connect a business portfolio yet**. A portfolio was not needed in Development mode.
5. Requirements showed nothing to fill in. Continue to **Overview** and click **Create app**.
6. In the dashboard click **Customize the Manage messaging & content on Instagram use case**. The left list shows **Permissions and features**, **API setup with Unified login** and **API setup with Facebook login**. Use **API setup with Facebook login** and ignore the Unified login entry.

You should see: the use case page with the left list above.

### Instagram Login (not live-tested; follows Meta's page fetched 2026-11-01)

Source: https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app.md

1. Click **Create App**, name it as above (no "Instagram", "IG", "Facebook" or "Meta").
2. Meta's page says to choose the use case **Other**, then the app type **Business**. Follow Meta's page here. The live Facebook run showed the Other option labelled "going away soon", so if your wizard no longer offers it, pick **Manage messaging & content on Instagram** and look for an **API setup with Instagram login** entry in the use case's left list (the Facebook run's list showed only the Unified and Facebook entries, so this may differ).
3. Open the dashboard's **Instagram** product, then **API setup with Instagram login**.
4. Set up **Instagram business login**: Meta lists three fields there, an OAuth redirect URI, a deauthorize callback URL and a data deletion request URL. The "Generate token" button and this server do not use them, but the dashboard may insist. Use the hosted pages from [section O](#o-optional-go-live-needed-for-real-webhooks) for the data deletion URL, and any HTTPS URL you control for the rest. Meta's rules for HTTPS and localhost here are not documented.
5. Add your Instagram account in section F, then generate a token in section H2.

## F. Roles and testers

In Development mode only people with a role on the app are visible to it. Roles live at **App roles**, **Roles** in the left menu.

| Role | What it is for |
|---|---|
| Administrator | The Facebook user that owns the app. Can change everything. |
| Developer | Can change app settings and use the permissions. |
| Tester | Can use the app while it is in Development mode. |
| Instagram Tester | An Instagram account (not a Facebook user) that the app may read: your own account on the Instagram Login path, and other people's accounts whose DMs you want to read in Development mode. |

### Add an Instagram account as an Instagram Tester (confirmed 2026-11-01)

1. In the App dashboard open **App roles**, **Roles**, **Add People**.
2. Choose **Instagram Tester** and enter the Instagram username.
3. Log in as that Instagram account on a desktop browser and open https://www.instagram.com/accounts/manage_access/ , then **Tester Invites**, then **Accept**. The Instagram mobile app does not show the invite.

You should see: the account listed under Roles with a status that is not "pending".

Who needs this:

- Instagram Login: your own account (Meta's page: App Roles, Roles, or the **Generate access tokens** table under API setup; not live-tested).
- Facebook Login: your own Page-linked account did not need an invite in the live run, because the Facebook user is the app Administrator. Anyone whose DMs you want to read does.

If your Facebook user is not the same person as the Instagram account owner, also add that person's Facebook user as Administrator, Developer or Tester.

## G. Permissions and access levels

Leave the app in Development mode for now. Meta says Standard Access (apps serving only accounts you own or manage) does not need App Review ([app review](https://developers.facebook.com/documentation/instagram-platform/app-review.md), fetched 2026-11-01).

### Add the permissions

Facebook Login (confirmed 2026-11-01): under **API setup with Facebook login** click **Add required content permissions** and **Add required messaging permissions**. Then in **Permissions and features** click **Add** on `instagram_manage_comments`, `instagram_manage_contents`, `instagram_manage_insights` and **Instagram Public Content Access**. Do NOT add the `instagram_business_*` permissions; those belong to the Instagram Login path. The status then shows **Ready for testing**. You pick the same scopes again when you generate the token in section H3.

Instagram Login: the dashboard adds the `instagram_business_*` permissions by default when you set up the product. Meta spells some names inconsistently across pages (for example `content_publish` vs `content_publishing`); use the exact string the dashboard shows.

### Which permission for which feature

| Feature | Instagram Login | Facebook Login | Works in Development mode (role users) |
|---|---|---|---|
| Profile, media (required) | `instagram_business_basic` | `instagram_basic` | Yes |
| Publishing | `instagram_business_content_publish` | `instagram_content_publish` | Yes |
| Comments, mentions | `instagram_business_manage_comments` | `instagram_manage_comments` | Yes |
| Insights | `instagram_business_manage_insights` | `instagram_manage_insights` | Yes |
| Read DMs | `instagram_business_manage_messages` | `instagram_manage_messages` | Only for people with a role (Instagram Tester); Facebook path confirmed 2026-11-01 |
| Send DMs | same as above | same as above | Role holders: works once the app is Live, fails in Development mode (confirmed 2026-11-01, facebook path). People with no role: needs Advanced Access (Meta docs, untested) |
| Private reply to a comment | same as above | same as above | Yes (Facebook path confirmed 2026-11-01) |
| Delete media | `instagram_manage_contents` (unverified on this path) | `instagram_manage_contents` | Yes (Facebook path) |
| Business discovery (competitors) | Not available | `pages_read_engagement` | Not tested |
| Hashtag search | Not available | **Instagram Public Content Access** feature | Not confirmed; Meta normally grants it through App Review |
| Webhooks (Page subscription) | n/a | `pages_manage_metadata` | Needs Live, see section O |
| Listing the Page | n/a | `pages_show_list` | Yes |

Also add `business_management` in Graph API Explorer on the Facebook path (it was part of the permission set in the live run).

### OAuth redirect URL

The "Generate token" button and Graph API Explorer do not need a redirect URL. If the dashboard insists on one when you click **Set up** under "Set up Instagram business login", enter an HTTPS URL you control (your hosted pages from section O are fine) and Save. The server never receives OAuth redirects.

## H. Tokens and ids

Token lifetimes: an Explorer user token lasts about 1 hour; a dashboard "Generate token" token lasts 60 days; a Business Login token lasts 1 hour (Meta's [get started page](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started), fetched 2026-11-01). A Facebook Page token derived from a long-lived user token has `expires_at: null` (confirmed 2026-11-01), so no refresh is needed.

### H1. App ID and app secret (both paths)

1. In the app dashboard open **App settings**, **Basic** (https://developers.facebook.com/apps, pick your app).
2. Copy the **App ID**. Click **Show** next to **App secret**, enter your password, and copy it.

Do not paste either into a chat, a commit or a screenshot. You will put the app secret into the server's secret store in section J.

### H2. Instagram Login: generate the token

Not live-tested; follows Meta's page fetched 2026-11-01.

1. Do sections I and J steps 1 to 4 first, so the token is not wasted waiting.
2. In the dashboard open **Instagram**, **API setup with Instagram login**.
3. Under **Generate access tokens**, find your account (it must have accepted the Instagram Tester invite, section F) and click **Generate token**.
4. Log in to Instagram if asked, approve, and copy the token.

You should see: a long token string; Meta states dashboard tokens are valid for 60 days. Store it right away with `auth set-token --no-exchange` (section J).

### H3. Facebook Login: user token in Graph API Explorer (confirmed 2026-11-01)

Do sections I and J steps 1 to 4 first. The Explorer token lasts about 1 hour, so generate it last and run `auth set-token` immediately.

1. Open https://developers.facebook.com/tools/explorer/ logged in as the Facebook user that owns the app.
2. In the right panel choose your app in **Meta App**.
3. Set the host dropdown (next to the request URL) to `graph.facebook.com`. Do not use `graph.instagram.com`: it fails with "Invalid OAuth access token - Cannot parse access token".
4. Under **User or Page** choose **User Token**.
5. In **Permissions**, add: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `instagram_manage_messages`, `instagram_manage_contents`, `pages_show_list`, `pages_read_engagement`, `business_management`. If you will use webhooks (section P), also add `pages_manage_metadata` now. Then click **Generate Access Token**.
6. A Facebook dialog asks which Pages and Instagram accounts to give access to. Select your Page and Instagram account, then continue. If the Instagram account is missing from the list, the Page link in section C failed.
7. Copy the token from the **Access Token** field.
8. Find your ids: run `GET me/accounts?fields=id,name,instagram_business_account`. It shows each Page `id` and the linked `instagram_business_account.id` (the `ig_user_id`). If `me/accounts` is empty, the token lacks `pages_show_list` or your Facebook user has no full control of the Page. The number in the `facebook.com/profile.php?id=...` address bar is NOT the Page ID.

You do not do the long-lived and Page token steps by hand: `auth set-token` exchanges the user token for a long-lived one, then fetches the Page token using `page_id`. It needs the app id in the config and the app secret stored first (section J).

If you add `pages_manage_metadata` later, regenerate the token here, run `auth set-token` again, and restart the daemon if one is running.

### Ids

| Id | How to get it |
|---|---|
| `ig_user_id` | Filled in for you; `auth set-token` reads it from Meta and saves it to the config. |
| `page_id` | Facebook Login only: step 8 above. |

## I. Install

### macOS prerequisites

Requires Node.js 22.13 or newer (`node --version`) and git.

1. `xcode-select --install` (installs git and compilers; skip if `git --version` works).
2. `brew install node@22 git`, or use nvm. If you use nvm, remember the absolute path from `command -v node`: Claude Desktop does not read your shell profile, so a bare `node` is not found (section K).

### Install from source

3. Run:

   ```sh
   git clone https://github.com/pratikgh0se/instagram-mcp.git
   cd instagram-mcp
   npm ci
   npm run build
   npm link        # optional: puts `instagram-mcp` on your PATH
   ```

You should see: `npm run build` finishes with no errors and `dist/cli.js` exists. `instagram-mcp version` prints the version.

## J. Store secrets and add the account

Pick the alias `main` (any name works; use the same one everywhere).

1. Add the account.

   Instagram Login:

   ```sh
   instagram-mcp accounts add --alias main --login instagram
   ```

   Facebook Login:

   ```sh
   instagram-mcp accounts add --alias main --login facebook --page-id <PAGE_ID> --app-id <APP_ID>
   ```

   You should see: `Added account "main". Next: instagram-mcp auth set-token --account main`. The config is `~/.instagram-mcp/config.json` (mode 0600). On the Facebook path you can also set the app id separately with `instagram-mcp app set --app-id <APP_ID>`; it writes `app.app_id`. Instagram Login does not need it.

2. Store the app secret (both paths; required for the Facebook exchange, webhooks and `appsecret_proof`).

   ```sh
   instagram-mcp auth set-app-secret
   ```

   Paste the secret at the hidden prompt and press Enter. You should see: `App secret stored.` On macOS the default backend is the keychain (macOS may ask for permission). Elsewhere the default is an encrypted file, which needs `INSTAGRAM_MCP_MASTER_KEY` (`openssl rand -base64 32`, kept somewhere safe) exported in the shell that runs the server.

3. Do section H2 or H3 now to get a token.

4. Store the access token. It is read from a hidden prompt or stdin, never from a command-line argument.

   Instagram Login (dashboard token, already long-lived):

   ```sh
   instagram-mcp auth set-token --account main --no-exchange
   ```

   Facebook Login (run it immediately, the Explorer token lasts about 1 hour):

   ```sh
   instagram-mcp auth set-token --account main
   ```

   To pipe instead: `pbpaste | instagram-mcp auth set-token --account main`.

   You should see one JSON line with `"alias":"main"`, `"ig_user_id":"..."`, `"username":"..."`, an `expires_at` (Instagram path: about 60 days out; Facebook path: `null`) and a `notes` array. On the Facebook path `"exchanged":true` means the long-lived exchange worked. A note such as "Long-lived user-token exchange failed" means the app id or app secret is missing or wrong; the token was stored as given and will expire in about an hour. Fix and run it again.

5. Run the health check.

   ```sh
   instagram-mcp doctor
   ```

   You should see:

   ```
   [PASS] config: Loaded ...
   [PASS] secrets_backend: keychain backend is usable.
   [PASS] tokens: Every account has a token.
   [PASS] token_validity: /me succeeded for 1 account(s).
   [PASS] capabilities: main: ...
   [PASS] quota: content_publishing_limit succeeded.
   [WARN] media_host: media_host.public_base_url is not set ...
   [WARN] daemon: No daemon is running ...
   [WARN] webhooks: Webhooks are disabled.
   All checks passed.
   ```

   The three WARN lines are normal until you do sections M, N and P. A FAIL line prints a `fix:` line; see section R. Exit codes: 0 all good, 1 a check failed, 2 config could not be loaded. `instagram-mcp auth status --check` prints JSON with token presence, expiry and a live `/me` result at any time.

Instagram Login tokens last 60 days. The daemon (section N) refreshes them daily when due; without the daemon, the server refreshes lazily when a tool is used. If a token expires, generate a new one and run `auth set-token` again.

## K. Connect Claude Desktop or Claude Code

Use absolute paths. Get your Node path with `command -v node` (Apple Silicon Homebrew: `/opt/homebrew/bin/node`; nvm: a path under `~/.nvm`).

### Claude Desktop

1. In Claude Desktop open **Settings**, **Developer**, **Edit Config**. This opens `~/Library/Application Support/Claude/claude_desktop_config.json`.
2. Add:

   ```json
   {
     "mcpServers": {
       "instagram": {
         "command": "/ABSOLUTE/PATH/TO/node",
         "args": ["/ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js", "serve"]
       }
     }
   }
   ```

3. Quit Claude Desktop fully (Cmd+Q, not just closing the window) and reopen it.

You should see: the `instagram` server with its tools. If it shows "server disconnected", the node or cli.js path is wrong (see section R).

If you use the encrypted-file backend, add `"env": { "INSTAGRAM_MCP_MASTER_KEY": "..." }` to that entry (this puts the key in the client config file; keep that file private). The macOS keychain may prompt the first time Desktop starts the server; choose Always Allow.

### Claude Code

```sh
claude mcp add instagram -- node /ABSOLUTE/PATH/TO/instagram-mcp/dist/cli.js serve
claude mcp list
```

You should see `instagram` connected.

### HTTP mode instead of stdio

```sh
instagram-mcp http-token rotate              # prints the bearer once
instagram-mcp serve --http --port 8765       # or: instagram-mcp daemon --http
claude mcp add --transport http instagram http://127.0.0.1:8765/mcp --header "Authorization: Bearer <TOKEN>"
```

### Gate writes

In your client's permission settings require confirmation for the tool `instagram_approve` only. In Claude Desktop this is the per-tool permission prompt for that tool.

## L. First run

1. Optional but recommended: in `config.json` set `"policy": { "dry_run": true }`. Approvals then return the planned Graph calls without sending anything. Set it to `false` (or remove it) when you want real posts.
2. In Claude ask: "List my Instagram accounts" (calls `instagram_list_accounts`), then "Show my profile" and "How many posts can I publish today?" (`instagram_get_rate_limits`).
3. Ask for a post from a public image URL: Claude calls `instagram_preflight_publish`, shows the preview, you agree, then `instagram_approve` runs.

You should see: a preview with `planned_calls`; with `dry_run` the approve returns the planned calls and nothing appears on Instagram.

## M. Optional: media host for local files

Instagram downloads media from a public HTTPS URL. If you give the server a local file path, it stages a copy under an unguessable token and serves it from a small local web server on port 8766. If the daemon (or another instance with the same `INSTAGRAM_MCP_HOME`) already owns that port, the second instance reuses it. You need a public HTTPS hostname that reaches it. This applies to both login paths, and to local images on the Facebook path too (only local video bypasses it there).

Options:

1. Skip it: publish only from public HTTPS URLs.
2. Simple: a Cloudflare quick tunnel, no domain needed, but the URL changes every run.
3. Durable: a named Cloudflare Tunnel on a domain you own (also gives the stable hooks hostname that webhooks need).
4. Any other HTTPS host you control that forwards `/m/` to `127.0.0.1:8766`.

Install the tool first: `brew install cloudflared`.

### Simple: quick tunnel

1. Start the server's media host by running the daemon in one terminal (`instagram-mcp daemon`), or note that it starts on demand when you publish a local file.
2. In another terminal run `cloudflared tunnel --url http://127.0.0.1:8766`.
3. It prints an `https://<random-words>.trycloudflare.com` URL. Put it in `config.json`:

   ```json
   "media_host": { "public_base_url": "https://<random-words>.trycloudflare.com", "port": 8766 }
   ```

4. Restart whatever runs the server. Each time you restart `cloudflared` the hostname changes, so `public_base_url` goes stale: repeat steps 2 and 3. Quick tunnels are not for webhooks, which need a stable URL.

### Durable: named tunnel on your domain

You need a domain on Cloudflare.

1. `cloudflared tunnel login` (opens a browser; pick the domain).
2. `cloudflared tunnel create instagram-mcp` prints a tunnel UUID and writes a credentials JSON file. Note both.
3. Copy [../examples/cloudflared-config.yml](../examples/cloudflared-config.yml) to `~/.cloudflared/instagram-mcp.yml`. Replace `<TUNNEL_UUID>`, the credentials path and the hostnames (`media.example.com`, and `hooks.example.com` if you will do section P). Port 8766 is the media host (only `/m/` is forwarded); port 8765 is the daemon listener (only `/webhooks/instagram` is forwarded). The MCP endpoint is never exposed.
4. `cloudflared tunnel route dns instagram-mcp media.yourdomain.example` (and the hooks hostname).
5. Run it: `cloudflared tunnel --config ~/.cloudflared/instagram-mcp.yml run instagram-mcp`. Leave it running. To install it as a service, `cloudflared service install` runs as root and reads its config from `/etc/cloudflared/`, so copy the config and credentials there and fix the paths in it first.
6. Set the URL in `config.json`:

   ```json
   "media_host": { "public_base_url": "https://media.yourdomain.example", "port": 8766 }
   ```

   `public_base_url` must be https. The media host binds 127.0.0.1; in Docker set `"bind": "0.0.0.0", "allow_remote": true` and publish the port on 127.0.0.1 only. Local media is read only from `local_media_dirs` (default `~/.instagram-mcp/media`, created 0700).

Check (both options): `instagram-mcp doctor` now shows `[PASS] media_host`. The host starts on demand when you publish a local file; before then nothing listens on 8766 and the public URL returns a tunnel error. That is expected. [TESTING-LIVE.md](TESTING-LIVE.md) covers a real reachability check.

## N. Optional: daemon for scheduling and snapshots

The daemon runs the scheduler (scheduled posts), the webhook receiver, daily insight snapshots, token refresh and staging cleanup. Stdio use does not need it, except for scheduled posts and webhooks. One daemon runs per state directory. It listens on port 8765 (`http.port`) when webhooks are enabled or `--http` is given.

Quick test in a terminal: `instagram-mcp daemon` (add `--http` to also serve MCP over HTTP). Stop with Ctrl-C. `doctor` in another terminal shows `[PASS] daemon`.

macOS (launchd):

1. Copy [../examples/com.instagram-mcp.daemon.plist](../examples/com.instagram-mcp.daemon.plist) to `~/Library/LaunchAgents/`.
2. Edit the placeholders: the node path (`command -v node`; Apple Silicon Homebrew is `/opt/homebrew/bin/node`, nvm users need the absolute nvm path), the absolute path to `dist/cli.js`, and `/Users/YOU`.
3. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.instagram-mcp.daemon.plist`
4. Check: `launchctl print gui/$(id -u)/com.instagram-mcp.daemon` and `instagram-mcp doctor`. Logs are at the paths in the plist.
5. Stop: `launchctl bootout gui/$(id -u)/com.instagram-mcp.daemon`.

Tokens are read from the keychain, so none go in the plist.

Linux (systemd): copy [../examples/instagram-mcp-daemon.service](../examples/instagram-mcp-daemon.service) to `/etc/systemd/system/`, edit the user and paths, put `INSTAGRAM_MCP_MASTER_KEY=...` in `/etc/instagram-mcp.env` with mode 0600, set `secrets.backend` to `encrypted-file`, then `systemctl enable --now instagram-mcp-daemon`.

Secrets are cached in memory per process. After `auth set-token` or `auth refresh` from the CLI, restart the running daemon: `launchctl kickstart -k gui/$(id -u)/com.instagram-mcp.daemon` (macOS) or `systemctl restart instagram-mcp-daemon` (Linux).

Docker: see the header of the [Dockerfile](../Dockerfile).

Cron alternative without a daemon: run `instagram-mcp scheduler run-once` every few minutes. It exits 3 if a daemon already holds the lease.

## O. Optional: Go Live (needed for real webhooks)

On the Facebook path, real webhooks arrive only once the app is Live (confirmed 2026-11-01). Going Live worked without Business Verification for an app serving only the owner's own account, after adding the four items below. Meta's [create an Instagram app page](https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app.md) says "Business Verification is required before you can publish"; the live run did not need it. Treat that as observed 2026-11-01 and subject to change.

### O1. Host the two pages (free, GitHub Pages)

Meta needs a public privacy policy URL and a data deletion instructions URL: public, crawlable, not geoblocked and your own ([Meta's rules](https://developers.facebook.com/documentation/development/terms-and-policies/privacy-policy.md), fetched 2026-11-01). Templates are in [legal/privacy-policy-template.md](legal/privacy-policy-template.md) and [legal/data-deletion-template.md](legal/data-deletion-template.md). They are templates, not legal advice; read and adapt them.

1. Create a new public GitHub repository, for example `my-instagram-mcp-pages`.
2. Add two files, `privacy.md` and `data-deletion.md`, containing the templates' text from below the dividing line. Replace every `<PLACEHOLDER>` and delete the template introduction.
3. In the repo open **Settings**, **Pages**. Under **Build and deployment** choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and Save.
4. After a minute the pages are at `https://<your-github-username>.github.io/my-instagram-mcp-pages/privacy` and `.../data-deletion` (GitHub renders the `.md` files).
5. Open both URLs in a private browser window to confirm they load. Optionally paste each into Meta's Sharing Debugger (https://developers.facebook.com/tools/debug/) and confirm HTTP 200.

Any other static host (Cloudflare Pages, Netlify, your own site) works the same way.

### O2. Fill in the app settings

1. Open **App settings**, **Basic** for your app.
2. Set **Privacy policy URL** to the privacy page URL.
3. Set **User data deletion** to **Data deletion instructions URL** and paste the data deletion page URL.
4. Upload an **App icon** (1024 x 1024 PNG).
5. Choose a **Category**. Set a contact email if missing.
6. Click **Save changes**.

### O3. Publish

1. In the app dashboard find the **Publish** step (the app mode switch, top of the dashboard; label confirmed 2026-11-01 as Publish) and click it.
2. If a required field is flagged, fix it and try again.

You should see: the app shown as **Live**.

What changes: your role holders still work, webhooks now deliver, and sending DMs to role holders (for example an Instagram Tester) now works (confirmed 2026-11-01, facebook path). What does not change: you still have Standard Access, so sending DMs to people without a role still needs Advanced Access per Meta (untested, section Q). Serving other people's accounts needs App Review and Advanced Access.

## P. Optional: webhooks

Webhooks give the inbox push events. Without them the inbox polls the API, which is fine for testing. Confirmed 2026-11-01 on the Facebook path: once the app is Live and subscribed to the Page, real comment and DM webhooks arrive within seconds, and DMs need no extra permission. In Development mode only role holders' DMs are delivered.

Requirements: the daemon (section N) listening on port 8765, a stable public HTTPS hostname forwarding `/webhooks/instagram` to that port (section M, durable option with the hooks hostname), the app secret stored, and, on the Facebook path, the app Live (section O) and a token with `pages_manage_metadata` (section H3).

1. Choose a verify token, any long random string: `openssl rand -base64 24`.
2. Store it: `instagram-mcp webhooks set-verify-token` (hidden prompt).
3. In `config.json` set `"webhooks": { "enabled": true, "path": "/webhooks/instagram" }`.
4. Start the daemon, then run `instagram-mcp doctor`: `[PASS] webhooks`. Check the tunnel: `curl -i "https://hooks.yourdomain.example/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"` should return `403` (reaching the server proves the route works). Do not put your real verify token in a logged command line.
5. In the Meta dashboard: **Instagram**, **API setup with Instagram login** (or Facebook login), section **Configure webhooks**. Enter the **Callback URL** `https://hooks.yourdomain.example/webhooks/instagram` and the **Verify token**, then **Verify and save**. The daemon must be running.
6. Subscribe to fields in that dashboard section: `comments`, `mentions`, `messages`, `message_reactions`, `messaging_postbacks` (and `story_insights` on the Facebook path). This dashboard field subscription is separate from the Page subscription in step 8; the server never toggles dashboard fields for you.
7. Instagram Login (not live-tested): also make sure your account is subscribed to the app's webhooks (a per-account toggle next to the account on the API setup page).
8. Facebook path only, required for real events: subscribe the app to the linked Page.

   ```sh
   instagram-mcp webhooks subscribe-page --account main
   instagram-mcp webhooks page-subscription --account main
   ```

   Confirm `"subscribed": true`. The default field is `feed`; change it with `--fields`, undo with `--unsubscribe`. This needs `pages_manage_metadata` on the stored Page token: if it fails with a permission error, regenerate the token with that permission (section H3), run `auth set-token` again, restart the daemon, and retry. Do not subscribe `messages` here (it needs `pages_messaging` and is not required). `doctor` reports `page_subscription` when webhooks are enabled.

Meta may deliver webhook events for accounts you do not own only after Advanced Access.

## Q. What works in Development mode and at Standard Access

All of the following were observed on the Facebook path on 2026-11-01 unless marked otherwise.

| Capability | Result |
|---|---|
| Publish, comments, hide, reply, insights, delete media | Works for your own account |
| Read DMs from someone with no role on the app | Empty list (their conversation is invisible) |
| Read DMs from an Instagram Tester | Works |
| Private reply to a comment | Works |
| Send a DM to an Instagram Tester, Development mode | Fails: Meta `(#10) This message is sent outside of allowed window` (subcode 2534022), mapped to `MESSAGING_WINDOW_CLOSED`, even inside the 24 h window. Do not retry; publish the app (Live) first |
| Send a DM to an Instagram Tester, Live, Standard Access | Works inside the 24 h window (confirmed 2026-11-01, facebook path: list, read and send all passed) |
| Send a DM to people with no role on the app | Needs Advanced Access for `instagram_manage_messages` (App Review) per [Meta](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message). Untested |
| Real webhooks | Need Live plus Page subscription (sections O and P) |
| Hashtag search | Not confirmed in Development mode |

Notes:

- Connected tools, **Allow access to messages** is a phone-app-only setting; it was absent on the tester's account and app version.
- A DM from someone who does not follow the account lands in **Message requests**, not the main inbox.
- Replying to mentions (`instagram_preflight_reply_mention`) only works for @mentions in a caption or comment, not photo tags. Ask the poster to add `@<username>` to the caption.

## R. Troubleshooting

Run `instagram-mcp doctor` first; it prints a `fix:` line for each failure. Tool errors carry an `error.code` and an `action`.

### Setup-phase problems

| Symptom | Likely cause | Fix |
|---|---|---|
| App name rejected | Name contains "Instagram", "IG", "Facebook" or "Meta" | Rename (observed 2026-11-01) |
| Explorer: "Invalid OAuth access token - Cannot parse access token" | Host set to `graph.instagram.com` | Set the host to `graph.facebook.com` (section H3) |
| Explorer dialog does not list your Instagram account | Instagram not linked to the Page, account not Professional or not public | Section C steps 5 to 7 |
| `me/accounts` is empty | Token lacks `pages_show_list`, or your Facebook user lacks full control of the Page | Regenerate the token with the scope; check Page roles |
| `me/accounts` shows the Page but no `instagram_business_account` | Link not made or points at a different Page | Section C step 6 |
| Meta code 190 right after generating a token | The Explorer token expired (about 1 hour) before `auth set-token` | Generate a fresh one and run `auth set-token` at once |
| `auth set-token` note "Long-lived user-token exchange failed" | App id or app secret missing or wrong | `app set --app-id`, `auth set-app-secret`, then `auth set-token` again |
| A tool reports `CAPABILITY_UNAVAILABLE` although the feature should work, or doctor WARNs `capabilities` | A cached "no" from an earlier failed probe | `capabilities reset --account <alias>` (add `--feature <name>` for one feature) |
| Instagram Tester invite stays "pending" | Not accepted | Accept at https://www.instagram.com/accounts/manage_access/ in a desktop browser (section F) |
| `webhooks subscribe-page` fails with a permission error | Token has no `pages_manage_metadata` | Section P step 8 |
| Webhooks never arrive on the Facebook path | App not Live, or Page not subscribed | Sections O and P step 8; `webhooks page-subscription` |
| Claude Desktop: "server disconnected" or `spawn node ENOENT` | Desktop does not read your shell PATH (nvm), or a wrong cli.js path | Use the absolute node path from `command -v node` and an absolute cli.js path (section K) |
| macOS keychain prompt every run | Keychain item ACL | Choose Always Allow, or use the `encrypted-file` backend |
| App will not add the account | Account is private or not Professional | Section C |

### Runtime errors

| Symptom or code | Likely cause | Fix |
|---|---|---|
| `CONFIG_INVALID` at start | Invalid JSON, unknown key, group/world-writable, foreign-owned or symlinked config file, http API URL override or `media_host.public_base_url` (https only outside test mode), facebook account without `page_id` | Read the message; `chmod 600 ~/.instagram-mcp/config.json`; fix the field |
| `AUTH_REQUIRED` | No token stored for the account | `instagram-mcp auth set-token --account <alias>` |
| Meta code 190 (`TOKEN_EXPIRED` or `AUTH_FAILED`), also subcode 463 or 467 | Token expired, revoked, or user changed password | Generate a new token (section H) and run `auth set-token` again |
| Meta code 10 or 200-299 (`MISSING_PERMISSION`) | Permission not selected or not granted (code 10 with "story media" or "not mentioned" in the message is not a permission problem: see the next rows) | Add the permission (section G table), regenerate the token, accept it for the right account |
| `INVALID_INPUT` on a mention reply, Meta "User is not mentioned in the caption" | The user was only photo-tagged | Ask the poster to add `@<username>` to the caption |
| Meta code 100 (`INVALID_INPUT`) | Bad parameter, or a field not supported for this account | Read `details.meta`; check media specs and `account_type` |
| Meta code 4, 17, 32, 613, 80002 (`RATE_LIMITED`) | Rate limit hit | Wait; `instagram_get_rate_limits` shows usage |
| Meta code 9 / subcode 2207042 (`PUBLISH_QUOTA_EXHAUSTED`) | Daily publishing limit used | Wait for the window |
| Meta code 9007 or 2207xxx (`UPSTREAM_REJECTED`) | Media rejected (format, size, aspect, not ready) | Read the Meta message; use JPEG for images, MP4 or MOV for video |
| `MESSAGING_WINDOW_CLOSED` (code 10 / 2534022) | More than 24 hours since the user's last message, the app is still in Development mode, or (Standard Access) a send to someone outside the app's roles | Do not retry. Ask the person to message again; make sure the app is Live; if it still fails the recipient needs Advanced Access (section Q) |
| `CAPABILITY_UNAVAILABLE` | Feature not available on this login path | Follow the `action` (it names the other path) |
| `MEDIA_HOST_UNAVAILABLE` | `media_host.public_base_url` unset or port 8766 busy (a second instance with the same state dir, such as the daemon, is fine) | Section M |
| `OUTCOME_UNKNOWN` | Publish response lost | Do not retry; call `instagram_get_operation` with the approval id |
| `POLICY_DENIED` | `read_only` or `disabled_actions` | Change `policy` in the config |
| `APPROVAL_EXPIRED` | Approval older than the TTL | Run the preflight again |
| `STALE_PREVIEW` | Target changed or vanished since preview | Run the preflight again |
| HTTP server will not start | No bearer stored, or non-loopback host | `instagram-mcp http-token rotate`; keep `127.0.0.1` |
| HTTP 401 or 403 from `/mcp` | Wrong bearer, Host or Origin | Check the header; add your origin to `http.allowed_origins` |
| Webhook verification fails in the dashboard | Daemon not running, tunnel not routing, verify token mismatch | Section P step 4; re-run `webhooks set-verify-token` |
| Webhook POSTs return 401 | App secret mismatch | `instagram-mcp auth set-app-secret` with the current secret |
| Webhook POSTs return 503 | No app secret stored | `instagram-mcp auth set-app-secret` |
| Daemon: "Another daemon already holds the lease" | Second daemon or stale lease | Stop the other; wait 60 seconds after a crash |

## Appendix: glossary

- Standard Access: the default. The app can use permissions on accounts that have a role on it (accounts you own or manage). No App Review.
- Advanced Access: needed to serve people or accounts with no role on your app (for example sending DMs to people with no role). Needs App Review and Business Verification.
- Development mode vs Live: Development mode shows the app only to role holders. Live is the published state; webhooks need it.
- Page ID vs Instagram id: the Page ID identifies the Facebook Page (Facebook path, `--page-id`); the Instagram id (`ig_user_id`) identifies the Instagram account and is found for you.
- Long-lived token: a token Meta accepts for weeks or months (60 days for Instagram Login). A Page token derived from a long-lived user token has `expires_at: null`.
- Instagram Tester: an app role for an Instagram account, accepted in a desktop browser at https://www.instagram.com/accounts/manage_access/.
