# Instagram Platform API: engagement capabilities (comments, mentions, DMs, webhooks)

**Access date:** 2026-10-29
**Scope:** Official Meta Instagram Platform docs only (developers.facebook.com). Unofficial or private APIs are out of scope.
**Source note:** Pages were read via the `/documentation/instagram-platform/...` paths (the current site layout) and their `.md` variants. Several `/docs/...` URLs returned 404 or navigation-only content, so those were not used.

## TL;DR

- **Comments:** You can list, read, reply to, hide/unhide, and delete comments on your own media. Replies are limited to top-level comments. Liking comments is not documented.
- **Mentions:** Read mentions through `mentioned_comment` and `mentioned_media`, and reply with `POST /{ig-user-id}/mentions`. Mention webhooks are the discovery path.
- **DMs:** The Send API, conversations, private replies, quick replies, generic templates, persistent menu and ice breakers are all documented with Instagram Login. The 24-hour window applies.
- **Webhooks:** 15 fields in the matrix. `comments` and `live_comments` need Advanced Access. Payloads are signed with SHA256 using the App Secret.
- **Biggest gaps:** `comment_enabled` parameter name, whether you can comment on other accounts' media, the human_agent tag parameter, and conflicting rate-limit numbers. See section 4.

---

## 1. Capability table

Permission key: **IG** = Instagram API with Instagram Login (`graph.instagram.com`). **FB** = Instagram API with Facebook Login (`graph.facebook.com`). **UL** = Unified Login (`graph.facebook.com`, named in some pages).

| Capability | Supported? | Endpoint + method | Key params / fields | Permission (IG / FB) | Limits / caveats | Source |
|---|---|---|---|---|---|---|
| List comments on own media | Yes | `GET /{ig-media-id}/comments` | Returns top-level comments only. Replies via field expansion (`replies`). Reverse-chronological. Max 50 per query. No timestamp filter. Fields in sample: `id`, `text`, `timestamp`. | IG: `instagram_business_basic`, `instagram_business_manage_comments`. FB: `instagram_basic`, `instagram_manage_comments` (+`ads_management`/`ads_read` if Business Manager role). Token must be from a user who created the media. | Boosted posts also return ad-media comments. For multi-media ads, use `/ordered_comments` (FB Login only). Pagination on this edge is not described on the page. | [ig-media/comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments.md), [comment-moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md) |
| Get one comment | Yes | `GET /{ig-comment-id}?fields=...` | Fields: `from` (`id`, `username`), `hidden`, `id`, `like_count`, `legacy_instagram_comment_id`, `media` (`id`, `media_product_type`), `parent_id`, `replies`, `text`, `timestamp`, `user` (only if app user created it), `username`. Unsupported: `comment_type`, `mentioned_instagram_users`. | IG: `instagram_business_basic`, `instagram_business_manage_comments`. FB: `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`. | `username` field requires manage_comments permission (since 2024-08-27). Comments from restricted users and age-gated media are not returned. Live-video comments are readable only while the broadcast is live. | [ig-comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md) |
| List replies on a comment | Yes | `GET /{ig-comment-id}/replies` | Returns `id`, `text`, `timestamp` in sample. No documented query params. | Token from the user who created the comment (per replies page). FB adds `pages_show_list`, `page_read_engagement`. | Cannot read replies to a deleted comment. | [ig-comment/replies](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies.md) |
| Reply to a comment | Yes | `POST /{ig-comment-id}/replies?message=...` | `message` (required). Returns `id` of new comment. | Token from the comment creator per replies page. Same scopes as above. | Only top-level comments can be replied to. A reply to a reply is added to the top-level thread. Cannot reply to hidden comments. Cannot reply to live-video comments (use private reply). Replies cannot be updated or deleted. | [ig-comment/replies](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies.md) |
| Comment on own media | Yes (documented) | `POST /{ig-media-id}/comments?message=...` | `message` (required). Returns `id`. | Same as list comments. Per the Requirements table, `instagram_basic` and `instagram_manage_comments` (UL); the POST section itself lists no permissions. | Not supported on live video IG Media. Whether this works on media you do not own is **not stated** (see section 4). | [ig-media/comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments.md) |
| Hide / unhide a comment | Yes | `POST /{ig-comment-id}?hide=true` or `?hide=false` | `hide` (required, boolean). | Token must be from the owner of the media that the comment is on. | Not supported on live-video comments. Comments by the media owner always display, even with `hide=true`. Comment-moderation page does not name the param; the IG Comment reference page does. | [ig-comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md), [comment-moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md) |
| Delete a comment | Yes | `DELETE /{ig-comment-id}` | None. | **Conflict in docs:** one section says the token must be from the comment creator, the limitations section says only the owner of the media can delete. | Not supported on live-video comments. | [ig-comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md) |
| Enable / disable comments on media | Stated, param unverified | `POST /{ig-media-id}` | Comment-moderation page says this disables or enables comments but does **not** name the parameter. `comment_enabled` is not confirmed in the pages read. | Not confirmed. | Treat as unverified until the param is read from the media reference. | [comment-moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md) |
| Like a comment | **Not found** | No endpoint found | `like_count` is readable on the comment node. No like/unlike write endpoint appeared in any page read. | n/a | Treat as not supported until a doc shows otherwise (see section 2). | [ig-comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md) |
| Read @mentions in comments | Yes | `GET /{ig-user-id}?fields=mentioned_comment.comment_id({comment-id}){fields}` | `comment_id` (required; from webhook payload). Default fields: `id`, `text`, `timestamp`. Also `like_count`, `media`. | IG: `instagram_business_basic`, `instagram_business_manage_comments`. FB/UL: `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`. Tasks: `MANAGE`, `CREATE_CONTENT`, or `MODERATE`. | Returns error if comments are disabled on the media where the mention was made. Read only. | [ig-user/mentioned_comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_comment.md) |
| Read @mentions in captions | Yes | `GET /{ig-user-id}?fields=mentioned_media.media_id({media-id}){fields}` | `media_id` (required; from webhook payload). Fields: `id`, `caption` (@ removed unless app user created it), `comments`, `comments_count`, `like_count`, `media_type`, `media_url`, `owner`, `timestamp`, `username`. | Same as mentioned_comment. | `media_url` omitted for some copyrighted-audio videos and reels with downloads disabled. Read only. Pagination via `before`/`after` cursors only. | [ig-user/mentioned_media](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_media.md) |
| List media where account is tagged | Yes | `GET /{ig-user-id}/tags` (IG: `graph.instagram.com/{IG_ID}/tags`) | `fields`, `media_type` (`IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`), `posted_after`, `posted_before` (ISO 8601; no offset = UTC). | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` (+ads if Business Manager). Token type: User. | Read only. Private media not returned. `media_url` omitted for copyrighted-audio video. Page can return fewer items than requested or none; keep paginating. Filter feature is rolling out gradually. Field list not on page; refers to IG Media node. | [ig-user/tags](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/tags.md) |
| Reply to a mention | Yes | `POST /{ig-user-id}/mentions` with (a) `media_id` + `message` for caption mention, or (b) `comment_id` + `media_id` + `message` for comment mention | `message` (required). `media_id` from webhook. `comment_id` from webhook for comment replies. Returns `id` of new comment. | FB: `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`, `pages_show_list`. IG: `instagram_business_basic`, `instagram_business_manage_comments`. | Not on Stories. Not on photos where account was tagged. No webhook for private-account media. Read/update/delete via this edge not supported. | [ig-user/mentions](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentions.md), [IG Login mentions](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions.md) |
| Send DM (text, links, reactions, stickers, media, shares) | Yes | `POST /{ig-id}/messages` (sample: `graph.instagram.com/v26.0/{IG_ID}/messages`) | `recipient.id` (IGSID), `message`. Text max 1000 bytes UTF-8. Images PNG/JPEG up to 8 MB, up to 10 attachments, `attachment_id` allowed. Audio/video/PDF up to 25 MB. Heart sticker: attachment type `like_heart`. Reactions: `sender_action` = `react` / `unreact`. Shared post: `MEDIA_SHARE` (app user must own post). Reply: `reply_to.mid`. | IG: `instagram_business_basic`, `instagram_business_manage_messages`. | Only within 24-hour window (see below). Shares: only image/video URL is returned on read. | [messaging-api](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md) |
| List conversations | Yes | `GET /me/conversations?platform=instagram` (equivalent `/{IG_ID}/conversations`) | Returns `id`, `updated_time`. Filter with `user_id` (IGSID) to find one. Messages via `GET /{conversation-id}?fields=messages`. Message details via `GET /{message-id}?fields=id,created_time,from,to,message`. | IG: `instagram_business_basic`, `instagram_business_manage_messages`. Token from a person who can manage messages. | Requests-folder conversations inactive 30 days are not returned. Only the 20 most recent messages can be read in detail; older ones error. Pagination not documented. | [conversations-api](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api.md) |
| Quick replies | Yes (IG Login) | `POST /{IG_ID}/messages` with `message.quick_replies` | Each: `content_type: "text"`, `title`, `payload`. | IG messaging permissions above. | Max 13. Title truncated after 20 chars. Plain-text only. Phone and email quick replies disabled on Instagram. Not available on desktop. Requires `messages` and `messaging_postbacks` webhooks. | [quick-replies](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/quick-replies.md) |
| Generic template | Ambiguous for IG Login | `POST /{IG_ID}/messages` with `message.attachment.type = template`, `template_type = generic` | `elements` array (`title` required, `subtitle`, `image_url`, `default_action`, `buttons`). | As above. | Max 10 elements. Title 80 chars, subtitle 80 chars. Max 3 buttons per element. Only `postback` and `web_url` buttons. Not on desktop. **IG Login support not stated on page.** | [generic-template](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template.md) |
| Persistent menu | Yes (IG Login) | `POST /{IG_ID}/messenger_profile` (also `GET ...?fields=persistent_menu`, `DELETE` per page) | `platform=instagram`, `persistent_menu` array with `locale` and `call_to_actions` (`title`, `type` = `postback` or `web_url`, `payload` or `url`). | IG messaging permissions. | Not real-time: existing conversations see updates after the user refreshes. Cannot vary by IGSID. Page recommends max 5 items (best practice, not a hard limit). Page conflicts on `webview_height_ratio` and `composer_input_disabled`. | [persistent-menu](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/persistent-menu.md) |
| Ice breakers | Yes (IG Login) | `POST /{IG_ID}/messenger_profile` with `ice_breakers`; `GET /me/messenger_profile?fields=ice_breakers`; `DELETE /me/messenger_profile` | `platform=instagram`, `ice_breakers[].call_to_actions[]` (`question`, `payload`), optional `locale`. | IG: `instagram_business_basic`, `instagram_business_manage_messages`. | Max 4 questions. Question/payload length not stated. Not on desktop. Tap fires `messaging_postbacks`. | [ice-breakers](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/ice-breakers.md) |
| Private reply to a comment | Yes | `POST /{APP_USERS_IG_ID}/messages` with `recipient.comment_id` and `message.text` | Response: `recipient_id` (commenter's IGSID), `message_id`. | IG: `instagram_business_basic`, `instagram_business_manage_comments` (plus messaging scopes for sending). UL: `instagram_manage_messages` also listed. | Send within 7 days of comment. Only one message until commenter responds. Follow-up within 24 h of their response. Live: only during broadcast. Requires `comments` and `live_comments` webhooks. | [private-replies](https://developers.facebook.com/documentation/instagram-platform/private-replies.md) |
| 24-hour messaging window | Rule | n/a | Business may message only after user messages the account. Window lasts 24 h from user action; up to 7 days after first message following a Click-to-Direct ad. | n/a | Outside window, use Human Agent tag (7 days) if eligible. | [messaging-api](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md) |
| Human Agent response (7-day) | Stated, param unverified | Tag on send (parameter name not confirmed) | Extends response window to 7 days for human-agent replies. | Needs Human Agent feature (added when `instagram_business_manage_messages` is requested, per setup page; approval may be needed). | Exact tag name/value not found on pages read. See section 4. | [messaging-api](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md) |

### Access levels (applies to most rows)

- **Standard Access:** accounts you own or manage that are added to your app in the App Dashboard.
- **Advanced Access:** needed for Instagram professional accounts you do not own or manage (source: comment-moderation, messaging-api, conversations-api, ice-breakers, mentions pages). Advanced Access is also required for `comments` and `live_comments` webhooks.

### Login path summary

| Login path | Host | Token | Notes |
|---|---|---|---|
| Instagram API with Instagram Login | `graph.instagram.com` | Instagram User token | Only path documented with full DM feature set (quick replies, ice breakers, persistent menu on this path). |
| Instagram API with Facebook Login | `graph.facebook.com` | Facebook User token + linked Page | Adds `ads_*` permissions when Page role comes from Business Manager. `/ordered_comments` only here. `story_insights` webhook only here. |
| Unified Login | `graph.facebook.com` | Business Integration System User token | Uses `instagram_manage_comments` / `instagram_manage_messages` names. |

---

## 2. Definitively NOT supported (with citations)

- **Create an IG Comment node directly:** the IG Comment reference states that creating the node is "not supported." Use `POST /{ig-media-id}/comments` or `POST /{ig-comment-id}/replies`. ([ig-comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md))
- **Update or delete comment replies via the replies edge:** "Neither operation is supported on IG Comment replies." ([ig-comment/replies](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies.md))
- **Threaded replies to replies:** "You can only reply to top-level comments; replies to a reply will be added to the top-level comment." ([ig-comment/replies](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies.md))
- **Replying to hidden comments:** "You cannot reply to hidden comments." ([ig-comment/replies](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies.md))
- **Commenting or replying on live-video comments:** replies to live comments are not supported; use private reply. Creating comments on live video IG Media is not supported. ([ig-comment/replies](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies.md), [ig-media/comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments.md))
- **Hide or delete on live-video comments:** "Hiding and deleting aren't supported on live video comments." ([ig-comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md))
- **Hiding a reply, or hiding the owner's own comment:** owner comments "always display, even with `hide=true`." ([ig-comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md))
- **Mention edges for create, update or delete:** `mentioned_comment`, `mentioned_media`, and `tags` are "Reading only; creating, updating, and deleting are not supported." ([mentioned_comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_comment.md), [mentioned_media](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_media.md), [tags](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/tags.md))
- **Replying to mentions on Stories or on photos where you are tagged:** "Mentions on Stories are not supported." "Commenting on photos in which you were tagged is not supported." ([ig-user/mentions](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentions.md))
- **Mention webhooks for private-account media:** "Webhooks will not be sent if the Media upon which the comment or @mention appears" was created by a private account. ([IG Login mentions](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions.md))
- **Comment notifications for private accounts:** "Private accounts do not receive comment or mention notifications." ([webhooks/setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup))
- **Per-user webhook field selection:** "You cannot select fields for each app user account. An account receives every field selected for the app." ([webhooks/setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup))
- **Story insights webhook on Instagram Login:** `story_insights` is "Not supported" on Instagram Login; FB Login only. ([webhooks/fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields))
- **Message reactions, message echoes, messaging seen, postbacks, etc. on Facebook Login:** all "Not supported" on FB Login; they are Instagram Login / Unified only. ([webhooks/fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields))
- **`/ordered_comments` on Instagram Login or Unified:** "Available only with Instagram API with Facebook Login." ([comment-moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md))
- **Phone and email quick replies on Instagram:** "Phone number and email quick replies are disabled for Instagram." ([quick-replies](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/quick-replies.md))
- **Generic template buttons other than postback / web_url:** "Only `postback` and `web_url` buttons are supported." ([generic-template](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template.md))
- **Persistent menu real-time update or per-recipient menus:** "A menu is not updated in real time." "You can not customize a menu based on the recipient's Instagram-scoped ID (IGSID)." ([persistent-menu](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/persistent-menu.md))
- **Ice breakers above 4 questions:** "A maximum of 4 questions can be set via the Ice Breaker API." ([ice-breakers](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/ice-breakers.md))
- **Reading conversation messages older than the 20 most recent in detail:** returns error. ([conversations-api](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api.md))
- **Liking comments:** no like endpoint found in any page read. Listed as "not found" rather than "documented as not supported." Do not build on the assumption either way without a fresh check.

---

## 3. Webhooks

### Subscribable fields (Instagram webhooks matrix, 15 fields)

| Field | IG Login permission | FB Login permission | Unified Login permission |
|---|---|---|---|
| `comments` | `instagram_business_basic`, `instagram_business_manage_comments` | `instagram_basic`, `instagram_manage_comments`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` | `instagram_manage_comments` |
| `live_comments` | same as `comments` (IG) | same as `comments` (FB) | `instagram_manage_comments` |
| `mentions` | none separate (included in `comments` notification) | `instagram_basic`, `instagram_manage_comments`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` | `instagram_manage_comments` |
| `message_echoes` | `instagram_business_basic`, `instagram_business_manage_comments` | Not supported | Not listed |
| `message_reactions` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | `instagram_manage_messages` |
| `messages` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | `instagram_manage_messages` |
| `messaging_handover` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | Not listed |
| `messaging_optins` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | Not listed |
| `messaging_policy_enforcement` | Not supported | Not supported | Not listed |
| `messaging_postbacks` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | `instagram_manage_messages` |
| `messaging_referral` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | `instagram_manage_messages` |
| `messaging_seen` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | `instagram_manage_messages` |
| `response_feedback` | Not supported | Not supported | Not listed |
| `standby` | `instagram_business_basic`, `instagram_business_manage_messages` | Not supported | Not listed |
| `story_insights` | Not supported | `instagram_basic`, `instagram_manage_insights`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` | `instagram_manage_insights` |

Source: [webhooks/fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields). The webhooks overview page only lists "comments, mentions, story insights, messages, and other activity."

### Verification handshake

- Meta sends `hub.mode` (fixed value, `subscribe`), `hub.verify_token`, and `hub.challenge`.
- Endpoint must check `hub.verify_token` equals the **Verify Token** set in the App Dashboard.
- Endpoint must return `hub.challenge` as an **int**. (Source: [webhooks/setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup))

### Payload signing

- "We sign all Event Notification payloads with a **SHA256** signature."
- Compute HMAC-SHA256 over the raw payload using the **App Secret** and compare to the signature header. Header name is `X-Hub-Signature-256` per the task brief; the setup page itself does not name the header. Verify this header name in a live request before relying on it.
- Page says "You don't have to validate the payload, but you should." (Source: [webhooks/setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup))

### Endpoint requirements

- **HTTPS required.** "Self-signed certificates are not supported."
- Respond `200 OK` promptly. "Your server returns a success response before it starts slow work."
- Retries: "If any update sent to your server fails, we will retry immediately." Unacknowledged responses are dropped after **36 hours**. (Source: [webhooks/setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup))
- Public endpoint: the docs require an HTTPS callback endpoint. A local dev setup needs a tunnel (not a Meta requirement, just implied by HTTPS + public access).

### App subscription

- The setup page describes subscribing with `<WEBHOOK_FIELDS>` (comma-separated fields selected in the App Dashboard) on `graph.instagram.com` (IG Login) or `graph.facebook.com` (FB Login, `/me` allowed when token represents the linked Page). Success returns `"success": true`.
- The exact URL path for the subscribe call (the brief mentions `POST /{ig-user-id}/subscribed_apps`) was **not confirmed** in the text returned. See section 4.

### Limitations and dev mode

- **Advanced Access required** for `comments` and `live_comments` notifications.
- **Public accounts only** for comment and mention notifications.
- Live comment notifications stop when the broadcast ends.
- **Dev mode:** the setup page says "Your app must be published or **Live** to receive notifications for app users." Full dev-mode and test-account behavior was **not** found on the pages read. See section 4.
- Rate-limit guidance: Meta recommends webhooks over polling to avoid rate limits. Live comments can produce heavy notification load.

---

## 4. Open questions / unverified

1. **`comment_enabled` parameter.** The comment-moderation page says `POST /{IG_MEDIA_ID}` enables or disables comments but does not name the parameter. The name `comment_enabled` came from the brief, not from a source page. Verify on the IG Media reference node.
2. **Commenting on other accounts' media.** The media comments page documents `POST /{ig-media-id}/comments` but does not say whether it works on media you do not own. The Advanced Access note applies to accounts you do not own or manage in general. Treat as **unknown**.
3. **Like a comment.** No write endpoint found. Not confirmed unsupported.
4. **Delete comment token owner.** The IG Comment page gives two conflicting answers (creator vs media owner). Test before relying on either.
5. **Human Agent tag.** The messaging page says a response can be tagged for the 7-day window, but the tag parameter name and value were not on any page read. A WebSearch snippet pointed to the Human Agent feature being added when `instagram_business_manage_messages` is requested, and to needing a separate approval. Not verified against the live page.
6. **Rate limits (conflicting, from secondary search snippets, not from primary pages):**
   - Send API: 100 calls/s per IG professional account for text/link/reaction/sticker messages, later reported as raised to 300 calls/s in a changelog. Pages conflict.
   - Conversations API: 2 calls/s per IG professional account (secondary source).
   - Private replies: 750 calls/hour per IG professional account (secondary source).
   - Live comments: 100 calls/s per IG professional account (secondary source).
   - Non-messaging calls: Business Use Case rate limit; secondary source gives `4800 * Number of Impressions` per 24 h. Do not treat these as fact. Check the Graph API rate-limiting page and the Instagram platform overview.
7. **Subscribe-to-webhooks endpoint path.** Brief says `POST /{ig-user-id}/subscribed_apps`; the setup page text did not confirm the path or the exact `subscribed_fields` parameter name.
8. **Dev-mode and test-account behavior.** The webhooks limitations section does not cover dev mode; the webhooks/new page did not either. Needs a dedicated read (likely the webhooks setup "Requirements" section or the app-review docs).
9. **Quick replies and generic templates on Instagram Login.** Quick replies page is titled "Instagram API with Instagram Login." Generic template page does not say. Verify before shipping.
10. **Private reply permission on IG Login.** Private replies page lists `instagram_manage_messages` only under Unified Login. Whether IG Login also needs the messaging permission (`instagram_business_manage_messages`) to send the private reply is unconfirmed.
11. **Comments edge pagination.** Comments edge page describes no cursor paging; only `/ordered_comments` shows `after` and `limit`. Confirm whether `/comments` paginates with `after`.
12. **Persistent menu inconsistencies.** `webview_height_ratio` and `composer_input_disabled` are both described as "set" and "not available" on the same page.
13. **Messaging API version.** Samples use `v26.0` and `v20.0`. Pin a version in the MCP server and verify against the changelog.
14. **Unfetched pages.** `ig-user/tags` `.md` and `mentions` `.md` were fetched; the `/docs/...` URLs returned 404 or navigation-only content. The Messenger Platform Instagram page (`developers.facebook.com/docs/messenger-platform/instagram`) was not read in this pass.
15. **Changelog check.** The business-messaging changelog was not read directly; secondary snippets referenced changes (Send API rate limit, Human Agent permission re-application). Check it before finalizing.

---

## Sources (primary)

- Comment moderation: https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md
- IG Comment node: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment.md
- IG Comment replies edge: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies.md
- IG Media comments: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments.md
- IG User mentions: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentions.md
- IG User mentioned_comment: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_comment.md
- IG User mentioned_media: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/mentioned_media.md
- IG User tags: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/tags.md
- Mentions (IG Login guide): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions.md
- Messaging API (Send API): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api.md
- Conversations API: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api.md
- Quick replies: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/quick-replies.md
- Generic template: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/generic-template.md
- Persistent menu: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/persistent-menu.md
- Ice breakers: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/ice-breakers.md
- Private replies: https://developers.facebook.com/documentation/instagram-platform/private-replies.md
- Webhooks overview: https://developers.facebook.com/documentation/instagram-platform/webhooks.md
- Webhooks fields matrix: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields
- Webhooks setup: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
- Docs index: https://developers.facebook.com/documentation/instagram-platform/llms.txt
