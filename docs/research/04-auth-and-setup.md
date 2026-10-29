# 04 - Auth and setup for the official Instagram Platform API (solo creator, self-hosted MCP)

**Access date:** 2026-10-29 (sources fetched that day; Meta docs pages were read via their `.md` mirrors and the `llms.txt` index).
**Scope:** Official Meta docs only. No private or unofficial APIs.

---

## TL;DR

- Use **Instagram API with Instagram Login** (`graph.instagram.com`). No Facebook Page needed. Meta's own index calls the newer **Unified Login** "the recommended setup for new integrations" (see Open questions, item 1).
- Setup = Meta app (type **Business**) + Instagram product + an Instagram Professional account (Business or Creator) + OAuth to get a token + exchange to a 60-day token.
- Tokens: short-lived (1 h) → long-lived (60 d) via `ig_exchange_token`. Refresh with `ig_refresh_token` once the token is at least 24 h old.
- Keep the **app secret** server-side only. Put tokens in a server, never in a client.
- Pin the Graph API version. Latest version seen in the docs: **v26.0**.

---

## 1. Path comparison

| Feature / property | Instagram API with Instagram Login | Instagram API with Facebook Login for Business |
|---|---|---|
| Host | `graph.instagram.com` (auth at `www.instagram.com/oauth/authorize`, token at `api.instagram.com/oauth/access_token`) | `graph.facebook.com` (dialog at `www.facebook.com/dialog/oauth`) |
| Account prerequisite | Instagram **Business or Creator** account. No Facebook Page required. | Instagram **Business or Creator** account **linked to a Facebook Page** |
| Media publishing | Yes | Yes |
| Comment management | Yes | Yes |
| Mentions | Yes | Yes |
| Insights | Yes | Yes |
| Messaging (DMs) | Yes | Not listed on the FB-Login overview page. Messaging API is documented separately as Messenger Platform messaging, which needs a Page-linked account. |
| Hashtag search | Not listed on the IG Login overview | **Yes** (listed on the FB-Login overview) |
| Business discovery, product tagging, partnership features | Not confirmed from the pages fetched | Not confirmed from the pages fetched |
| Token type for Graph calls | Instagram User access token | Page access token needed for Messaging; user token for Graph |
| Sample permission set | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, `instagram_business_manage_insights` | `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement` (plus messaging permissions if used) |

Source: [Instagram Platform overview](https://developers.facebook.com/docs/instagram-platform/), [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login.md), [FB Login for Business](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram.md).

**Recommendation for a solo creator: Instagram Login.**
- No Facebook Page to create or maintain. The brief's "fresh test account" setup is much shorter.
- Fewer moving parts: one token (Instagram User token), no Page-token step, no `me/accounts` lookup.
- Covers the features an MCP server for a solo creator would most likely expose (publish, comments, insights, DMs).
- Downside: hashtag search is not listed on this path. If hashtag search is a must-have, the FB-Login path (with a linked Page) is the one to use. Confirm before committing (see Open questions).

---

## 2. Account prerequisites

| Item | Status | Source |
|---|---|---|
| Account must be Business or Creator (Professional) | Confirmed (both paths) | Overview pages |
| Facebook Page required | Not for IG Login. Required for FB Login and for Messenger Platform messaging. | Overview pages |
| Meta Business portfolio required | Not stated as required for IG Login. The app-creation flow asks you to **connect a business** before publishing; that business must complete **Business Verification**. | [create-an-instagram-app](https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app.md) |
| Business vs Creator differences that matter for API | **Not confirmed.** The Business Login page does not distinguish them. Both are "Instagram professional accounts" in the docs. | Business Login page |

**Switching a personal account to Professional** (Help Center, read via search snippet only):
- Path in the app: **Settings and activity > Account type and tools > Switch to professional account**. Pick a category. The category does not decide Business vs Creator.
- Business: suited to retailers, local businesses, brands, organisations, service providers. Creator: public figures, content producers, artists, influencers.
- Switching private → professional makes the account **public**. Pending follow requests are auto-accepted.
- Switching back to personal removes ads access and may remove some tools. Any connected Facebook Page is disconnected.
- Source: [Instagram Help Center, set up a professional account](https://help.instagram.com/502981923235522). The fetched page returned only a heading, so the menu labels above come from a search-result summary and are **unverified** against the live page.

**Test account note:** the `create-an-instagram-app` page says the Instagram account added as a test account "must be public."

---

## 3. Creating the Meta app

Steps from [create-an-instagram-app](https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app.md):

1. Go to `developers.facebook.com/apps`. Click **Create App** (upper right), or **Create New App** from the upper-left dropdown on an existing app.
   - Limit: up to **15** apps where you hold a developer or admin role, unless the apps are connected to a Meta Verified business portfolio. Archived apps still count.
2. **Connect a business.** Required before you can publish. Can be done now or later under **App settings > Basic**. Business must complete Business Verification.
3. **Select the use case:** choose **Other**, then **Next**. The page says this is the only use case listed for Instagram access.
   - **Conflict:** the brief expected "Manage messaging & content on Instagram." That name is not on the current page. Treat it as possibly outdated (see Open questions).
4. **Select the app type:** choose **Business**, then **Next**. The Instagram product requires a Business app type.
5. **App details:** app name, contact email, **Next**.
6. **Add the Instagram product:** scroll to **Instagram**, click **Set up**. This adds **API setup with Instagram login** automatically. (If you use a Page-linked account, choose **API setup with Facebook login** instead.)
7. **Test accounts / tokens:** add an Instagram account to get test tokens. Menu paths: **App Roles > Roles**, or **Instagram > API Setup with Instagram login** in the left menu. The account must be public.
8. **Webhooks (optional for MCP):** click **Configure**, enter **Callback URL** and **Verify token**, **Save**. Default subscriptions: `comments`, `live_comments`, `message_reactions`, `messages`, `messaging_optins`, `messaging_postbacks`, `messaging_referral`, `messaging_seen`.
9. **Instagram business login:** in section "3. Set up Instagram business login," click **Set up**, enter **Redirect URL**, **Save**. Under **Business login settings** add extra **OAuth Redirect URIs**, **Deauthorize callback URL**, **Data deletion request URL**, **Save**.
10. **App Review:** click the chevron next to **Complete App Review**, then **Go to App Review**. Only needed for Advanced Access (see section below).

**Permissions added by default** on the IG-Login setup: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`, `instagram_business_manage_messages`. Human Agent is added automatically when `instagram_business_manage_messages` is requested.

### Roles (from [App roles](https://developers.facebook.com/docs/development/build-and-test/app-roles))

- **Administrator:** full access. Can reset app secret, remove app, assign roles. Limit 500 per app.
- **Developer:** technical settings and insights. Cannot reset app secret or change roles.
- **Tester:** can test login permissions, features, products. Cannot edit settings or see insights.
- **Authorized App Tester:** a Facebook user with no role, invited to test. Accepts via Facebook **Settings & privacy > Your activity > Apps and Websites > Requests > Accept**.
- **Analytics User:** inconsistent on the page (text vs table). Not needed for MCP.
- Administrator, Developer, Analytics need a Meta Developer Account.
- **Instagram Tester role and its invite-acceptance flow in Instagram settings: not documented in the pages I could read.** The brief's wording could not be confirmed. Use the **App Roles** page in the dashboard and check for an Instagram invite in the account after adding it.

### Development vs Live mode and App Review

- The create-app page does **not** use "Development mode" / "Live mode" names. It says Instagram requires **successful App Review before your app can access live data**.
- App Review page: **Standard Access** is for apps that serve only a business you own or manage, and **App Review is not required** for that scenario. Advanced Access needs App Review and is required for Instagram professional accounts you do not own or manage.
- Apps approved for Advanced Access may be automatically granted Advanced Access to Instagram business permissions.
- **Not confirmed:** exactly which features work in dev mode for role-holders. The App Review page does not say. Test with a role-holder account and check the error responses.
- **Business verification:** required to publish the app (connect a verified business). Not stated as required for Standard Access on a self-owned account.
- App Review submission needs: app icon 1024x1024, Privacy Policy URL, category, business email, step-by-step test instructions, one screencast per permission, English UI if possible, and a successful API call before requesting Advanced Access to certain permissions.

---

## 4. Tokens and token lifecycle

### 4a. Generate a token from the dashboard (quickest for a single account)

From [get-started](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started):

1. App Dashboard > left menu **Instagram > API setup with Instagram business login**.
2. Click **Generate token** next to the Instagram account.
3. Log in to Instagram, copy the token.
- Dashboard tokens are **long-lived, 60 days**.
- Test call: `GET https://graph.instagram.com/v26.0/me?fields=user_id,username&access_token=<TOKEN>`

### 4b. OAuth flow (for the MCP server, or any non-dashboard user)

**Authorize (browser redirect):**
```
GET https://www.instagram.com/oauth/authorize
  ?client_id=<APP_ID>
  &redirect_uri=<EXACT_REDIRECT_URI>
  &response_type=code
  &scope=instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish
```
Optional: `enable_fb_login` (bool, default true), `force_reauth` (bool), `state` (CSRF value, echoed back).

**Redirect result:** `code` arrives as a query param. Valid **1 hour**, **single use**. Strip the trailing `#_` before use. On cancel: `error=access_denied`, `error_reason=user_denied`.

**Code exchange (short-lived token), server-side:**
```
POST https://api.instagram.com/oauth/access_token
  client_id=<APP_ID>
  client_secret=<APP_SECRET>
  grant_type=authorization_code
  redirect_uri=<SAME_REDIRECT_URI>
  code=<CODE>
```
Response shape: `{"data":[{"access_token":"...","user_id":"...","permissions":"instagram_business_basic,..."}]}`. The short-lived token is valid **1 hour**.

**Long-lived exchange (60 days), server-side:**
```
GET https://graph.instagram.com/access_token
  ?grant_type=ig_exchange_token
  &client_secret=<APP_SECRET>
  &access_token=<SHORT_LIVED_TOKEN>
```
Response: `access_token`, `token_type` (`bearer`), `expires_in` (seconds; sample 5183944, about 60 days).

**Refresh (extends a long-lived token), server-side:**
```
GET https://graph.instagram.com/refresh_access_token
  ?grant_type=ig_refresh_token
  &access_token=<LONG_LIVED_TOKEN>
```
Conditions:
- Token is at least **24 hours old**.
- Token is not expired.
- User granted `instagram_business_basic`.
- A token **not refreshed within 60 days expires and cannot be refreshed**. Re-run the OAuth flow.
- Practical rule for the MCP server: refresh on a schedule (for example, every 30 days) and always before expiry.

**Verify / debug:** the `me` call above confirms validity. A `debug_token` endpoint for Instagram tokens was **not** confirmed (see Open questions).

### 4c. FB Login for Business path (for reference)

- Dialog: `GET https://www.facebook.com/dialog/oauth` (the examples use `/v26.0/dialog/oauth`) with `client_id`, `display=page`, `extras={"setup":{"channel":"IG_API_ONBOARDING"}}`, `redirect_uri` (must match a Valid OAuth Redirect URI), `response_type=token`, `scope=<comma list>`.
- Redirect carries values in the **URL fragment**: `access_token` (short-lived user token), `data_access_expiration_time`, `expires_in`, `long_lived_token`. Use `long_lived_token`.
- Page tokens: `GET https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=<USER_TOKEN>`. Store each Page's `access_token` and `instagram_business_account.id`. Page tokens are needed for Messaging. The user token is used for the Graph API.
- **Not confirmed on the pages read:** the long-lived user token exchange endpoint for this path (the page links to a separate guide), system user tokens, and the Business Manager requirement.

---

## 5. Scopes per path

### IG Login (`instagram_business_*`)

| Scope | Purpose (as named) | Source |
|---|---|---|
| `instagram_business_basic` | Basic profile and media read. Required for `refresh_access_token`. | Business Login page |
| `instagram_business_content_publish` | Publish media | Business Login page |
| `instagram_business_manage_comments` | Comments | Business Login page |
| `instagram_business_manage_messages` | DMs. Human Agent added automatically. | create-app page |
| `instagram_business_manage_insights` | Insights | create-app page (default list) |
| `instagram_manage_engagement` | Like media / comments. New Apr 22 2026. | [changelog](https://developers.facebook.com/documentation/instagram-platform/changelog.md) |
| `instagram_manage_contents` | Delete media. Required since Dec 3 2025. | changelog |

Deprecated: the old `business_*` values (no `instagram_` prefix) stopped working on **Jan 27 2025**.

### FB Login for Business (`instagram_*` + Page scopes)

| Scope | Source |
|---|---|
| `instagram_basic` | Business Login for Instagram (FB) example |
| `instagram_content_publish` | same |
| `instagram_manage_comments` | same |
| `instagram_manage_insights` | same |
| `pages_show_list` | same |
| `pages_read_engagement` | same |
| `instagram_manage_messages` | Messaging API (listed by the changelog and messaging docs; not confirmed on the page read) |
| `business_management` | **Not confirmed.** The page does not mention it. |

The page says the scope list depends on which endpoints the app calls. Request only what the server uses.

---

## 6. Security notes

- **App secret:** used only in server-side code (`client_secret` in the exchange and long-lived calls). Never in browser, mobile, or the repo. Store in env vars or a secret manager. Reset it in the dashboard (Administrator role) if leaked. The Require App Secret toggle is under **App Settings > Advanced > Security**, and the secret itself is under **Settings > Basic**.
- **appsecret_proof:** on the FB-Login docs it is `HMAC-SHA256(key=app_secret, msg=access_token)`. The `securing-requests` page uses `graph.facebook.com` only. **Whether `graph.instagram.com` accepts or requires it is not confirmed.** Recommendation: compute it for `graph.facebook.com` calls; for `graph.instagram.com`, test, and follow the Require App Secret setting if it is on.
- **Token placement:** the docs show `access_token` as a **query parameter** on `graph.instagram.com` (all examples). **Support for an `Authorization: Bearer` header on `graph.instagram.com` is not confirmed.** Safer to follow the documented query form, keep the URL out of logs, and never log tokens.
- **Redirect URIs:** must **exactly** match an entry in the dashboard's OAuth Redirect URIs list (the dashboard may add a trailing slash). Same URI must be sent in the code exchange. **HTTPS requirement and localhost rules are not confirmed on these pages.** The example uses `https://my.m.redirect.net/`. For local dev, use HTTPS via a tunnel if the docs or a test confirm it.
- **State param:** use `state` on the authorize URL for CSRF protection and check it on return.
- **Transport:** Graph API requires TLS 1.2 or 1.3 (from `securing-requests`).
- **Token storage:** long-lived tokens are account-level credentials for 60 days. Encrypt at rest. Rotate by refresh or re-auth.
- **Data deletion and deauthorize URLs:** Business Login settings require a Deauthorize callback URL and a Data deletion request URL. The MCP server needs endpoints for both if it is published as a Live app.

---

## 7. Graph API versioning

- Latest version seen: **v26.0** (used in all example endpoints on the Instagram pages).
- Lifetime, per [versioning](https://developers.facebook.com/docs/graph-api/guides/versioning): each version works for **at least 2 years** after its release, then is deprecated after the next version has been out for 2 years. (Read from a Thai-language render of the page. Wording may differ slightly in English.)
- Version-specific dates were not readable on the page. Check the [changelog](https://developers.facebook.com/documentation/instagram-platform/changelog.md).
- Note: the Business Login token-exchange examples are **unversioned** (`graph.instagram.com/access_token`). The `me` and `media` examples use `v26.0`.
- Recommendation: pin `v26.0` in the server config. Make the version a single constant.

---

## 8. Setup steps for a solo creator (IG Login path)

1. Make or prepare a **test Instagram account**. Convert to Professional: **Settings and activity > Account type and tools > Switch to professional account**. Pick Creator or Business. Note: the account becomes public.
2. Go to `developers.facebook.com/apps` > **Create App**. Use case **Other** > **Next**. App type **Business** > **Next**. Enter app name and contact email > **Next**.
3. In the app dashboard, under **Instagram**, click **Set up** (adds **API setup with Instagram login**).
4. Add the test Instagram account under **App Roles > Roles** or **Instagram > API setup with Instagram login**. Accept any invite in the Instagram account if prompted (flow not confirmed; see Open questions).
5. Under **Instagram business login**, click **Set up**, enter the Redirect URL, **Save**. Add the same URI under **Business login settings > OAuth Redirect URIs** if needed.
6. For a quick first token: **Instagram > API setup with Instagram business login > Generate token**. Copy it. Test `GET https://graph.instagram.com/v26.0/me?fields=user_id,username&access_token=...`.
7. For the MCP server: run the OAuth flow (section 4b). Store the `client_secret`, `client_id`, redirect URI in the server's env.
8. Exchange the short-lived token for a 60-day token with `ig_exchange_token`.
9. Schedule a refresh (`ig_refresh_token`) for any token at least 24 h old, before it expires.
10. Only if the MCP needs more than your own account: complete **App Review** for Advanced Access, verify the business, provide a Privacy Policy URL.

---

## 9. Open questions / unverified

1. **Unified Login.** The overview page says the **Instagram API with Unified Login** is "the recommended setup for new integrations" and supports messaging, publishing, comment moderation, and ad management, with no Page needed. This was not in the brief. Read its page before picking IG Login over Unified Login.
2. **Use case name.** The create-app page says use case **Other**. The brief expected "Manage messaging & content on Instagram." One of them is outdated. Confirm in the live dashboard.
3. **Instagram Tester role and invite acceptance in Instagram settings.** Not found in any page read. The App Roles page describes Facebook-side acceptance for Authorized App Testers only. Confirm by adding a test account and looking at the Instagram app's notifications.
4. **Dev mode behaviour.** No page confirmed what works in development mode for role-holders without App Review. Test it.
5. **Hashtag search, business discovery, product tagging, partnership features** on IG Login: not confirmed. Hashtag search is listed only on the FB-Login path.
6. **Business vs Creator** differences for API access: not confirmed. Help Center page did not render. Assumed to make no API difference, but unverified.
7. **Help Center menu labels** for switching accounts come from a search snippet, not the live page. Re-check on a device.
8. **`debug_token` for Instagram tokens:** endpoint fetch returned 404 / timeout. Not confirmed. Use the `me` call as a validity check, or check the Access Token Debugger in the dashboard.
9. **appsecret_proof** on `graph.instagram.com`: not confirmed.
10. **Authorization: Bearer header** on `graph.instagram.com`: not confirmed.
11. **HTTPS and localhost rules for redirect URIs:** not confirmed. Test with the real app.
12. **FB-Login long-lived user token exchange and system user tokens:** not confirmed. Page links to a separate guide that I could not read.
13. **`business_management` scope** on FB Login: not confirmed on the page read.
14. **Business verification** requirement for Standard Access on a self-owned account: not confirmed.
15. **Graph API version lifetime wording** came from a Thai-language render of the versioning page. Confirm wording in English.
16. **Sample `client_id`** in the Business Login page (`990602627938098`) is a doc example. Do not use it.
17. **`instagram_manage_messages`** on FB Login: the permission name is inferred from the Messaging docs, not read directly.

---

## 10. Sources read

- https://developers.facebook.com/docs/instagram-platform/ (overview)
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login.md
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram.md
- https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app.md
- https://developers.facebook.com/documentation/instagram-platform/app-review.md
- https://developers.facebook.com/documentation/instagram-platform/reference/access_token.md
- https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token.md (listed in index; not separately read)
- https://developers.facebook.com/documentation/instagram-platform/changelog.md
- https://developers.facebook.com/docs/development/build-and-test/app-roles
- https://developers.facebook.com/docs/graph-api/securing-requests
- https://developers.facebook.com/docs/graph-api/guides/versioning
- https://developers.facebook.com/documentation/instagram-platform/llms.txt (index)
- https://help.instagram.com/502981923235522 (search snippet only; page did not render)

Dropped / not fetched: `debug_token` (404 / timeout), `oauth-authorize` reference, `refresh-access-token` reference (index lists them; not reached within the budget).
