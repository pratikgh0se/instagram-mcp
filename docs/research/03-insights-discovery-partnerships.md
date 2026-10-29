# Instagram Platform: Insights, Discovery, Partnerships (official API only)

**Access date:** 2026-10-29
**Scope:** Professional (Business/Creator) accounts, Meta official docs only. Private or unofficial APIs excluded.
**Method:** WebFetch of Meta's `.md` doc pages (via `developers.facebook.com/documentation/instagram-platform/llms.txt` index) plus a few WebSearch snippets. Some pages returned 404 or partial content; those items are marked UNVERIFIED.

## TL;DR

- Account and media insights exist for both Instagram Login and Facebook Login paths. Metric names changed in 2024-2025 (`impressions`, `video_views`, `plays`, `profile_views` are gone or deprecated). Use `views`.
- Business Discovery and Hashtag Search are Facebook Login only (plus Public Content Access feature for hashtags). Creators cannot use them through Instagram Login.
- Collab invites are listable and acceptable via API (creator side). Branded content tagging is possible at publish time. Creator Marketplace is for brands/agencies, not creators.
- Rate limits: Business Use Case (BUC) per app+user, `4800 x impressions` per rolling 24h. Business Discovery and Hashtag Search also fall under Platform rate limits.
- Many fields and limits need a second look before we commit to a design. See section 5.

## 1. Capability table

Legend: IG = Instagram API with Instagram Login (`graph.instagram.com`). FB = Instagram API with Facebook Login (`graph.facebook.com`, Page linked). UL = Unified Login (`graph.facebook.com`, system user token).

| Capability | Supported? | Endpoint + method | Metrics / fields | Permission (IG / FB) | Limits / caveats | Source |
|---|---|---|---|---|---|---|
| Account insights | Yes | `GET /{ig-user-id}/insights` | See section 2 | IG: `instagram_business_basic` + `instagram_business_manage_insights`. FB: `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement` (+ `ads_management`/`ads_read` if BM role) | Empty data set returned (not 0) when unavailable. Retention "up to 90 days". Demographics need `timeframe`. Default window with no since/until = last 24h | https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights.md ; https://developers.facebook.com/documentation/instagram-platform/insights.md |
| Follower demographics | Yes | `GET /{ig-user-id}/insights?metric=follower_demographics&breakdown=age\|gender\|city\|country&timeframe=...` | `follower_demographics` (lifetime, total_value) | Same as account insights | Not returned under 100 followers. Only top 45 performers. `timeframe` required, overrides since/until | api-reference/instagram-user/insights.md |
| Engaged-audience demographics | Yes | same endpoint, `metric=engaged_audience_demographics` | `engaged_audience_demographics` | Same | Not returned under 100 engagements in timeframe. Top 45 only. No since/until | api-reference/instagram-user/insights.md |
| Follows and unfollows | Yes | `GET /{ig-user-id}/insights?metric=follows_and_unfollows&breakdown=follow_type` | `follows_and_unfollows` (day) | Same | Not returned under 100 followers | api-reference/instagram-user/insights.md |
| Online followers | UNVERIFIED | `GET /{ig-user-id}/insights?metric=online_followers` (per changelog/limitations) | `online_followers` | Same | Only last 30 days; unavailable under 100 followers. Not in the metric table; period/breakdown/metric_type not confirmed | api-reference/instagram-user/insights.md (limitations section) |
| Profile fields | Yes | `GET /{ig-user-id}?fields=...` | See section 3 | IG: `instagram_business_basic`. FB: `instagram_basic` + `pages_read_engagement` | Page-backed only: `legacy_instagram_user_id`, `is_published` | https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user.md |
| Media list | Yes | `GET /{ig-user-id}/media` | `id` (other fields not confirmed on the page) | `instagram_basic` + `pages_read_engagement` or `pages_show_list` | Max 10K most recent media. since/until pagination | https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md |
| Media insights | Yes | `GET /{ig-media-id}/insights?metric=...` | See section 2b (per media_product_type) | Analogous to account insights (`instagram_manage_insights` / `instagram_business_manage_insights`). Media-specific mapping not confirmed | Album/carousel children: "Insights data is not available for any media within an Instagram Media album." Story metrics only for 24 hours. Error #10 "Not enough viewers" when values under 5 | https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights.md |
| Story insights webhook | Yes (FB and UL only) | Webhook field `story_insights` | Notification that story insights are ready/available (exact payload not verified) | UL: `instagram_manage_insights`. FB: `instagram_basic`, `instagram_manage_insights`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`. IG: not applicable | https://developers.facebook.com/documentation/instagram-platform/webhooks/fields.md |
| Business Discovery (other pro accounts) | Yes | `GET /{ig-user-id}?fields=business_discovery.username(X){followers_count,media_count,media{...}}` | `followers_count`, `media_count`, `media` with `id`, `comments_count`, `like_count`, `view_count` (Reels only, per changelog 2025-06-16) | FB only: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` (+ `ads_management` or `ads_read` if BM role). Not on IG Login | Age-gated accounts not returned. `media_url` omitted for copyrighted audio, flagged videos, reels with downloads off. Subject to Platform rate limits. No create/update/delete | https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery.md |
| Hashtag search | Yes (restricted) | `GET /ig_hashtag_search?user_id=...&q=...` then `GET /{ig-hashtag-id}/top_media` and `/recent_media`; `GET /{ig-user-id}/recently_searched_hashtags` | Hashtag media fields not documented on fetched page (only `id` in example) | FB and UL: `instagram_basic` + Feature "Instagram Public Content Access" (App Review). If Page role via BM: `ads_management` / `business_management` / `pages_read_engagement` | Max 30 unique hashtags per rolling 7 days; repeat queries do not reset. Fetching media counts as a query. Cannot comment on results. Stories hashtags not supported. Emojis not supported. Sensitive hashtags return generic error. Subject to Platform rate limits | https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search.md |
| Collab invites: list | Yes | `GET /{ig-user-id}/collaboration_invites` | Media ID, owner username, caption, media URL | `instagram_basic`, token of the tagged user | 300 calls per user per 24h. Feed image, Reels, Carousel only (not Stories) | https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/collaboration.md |
| Collab invites: accept/decline | Yes | `POST /{ig-user-id}/collaboration_invites` with `media_id`, `accept` (bool) | `{"success": true}` | `instagram_basic` | 50 calls per user per 24h. Changelog: added 2025-12-03 | collaboration.md ; changelog.md |
| Collaborative media (accepted) | Yes | `GET /{ig-user-id}/collaborative_media` ; `GET /{ig-user-id}?fields=collaborative_media_search.media_id(ID)` | Media where app user is accepted collaborator (excludes own) | `instagram_basic` (granted by a collaborator) | Access lost if owner removes user. Changelog 2026-04-22 | collaboration.md ; changelog.md |
| Add collaborators on publish | Yes | `POST /{ig-user-id}/media` (container) with `collaborators` | Up to 3 IG usernames | Publish permissions (see section 4) | Feed image, Reels, Carousel only. Not Stories | https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md |
| Paid partnership label (branded content) | Yes (FB only per docs) | Container create params `branded_content_sponsor_ids` and `is_paid_partnership` | Sponsor IDs (max 2). `is_paid_partnership` auto-true when sponsors given; can be used alone for label-only | FB: `instagram_branded_content_creator` or `instagram_basic` (sponsor IDs) | Not on remixed or close-friends-only posts. Look up brand IDs via Business Discovery. Changelog 2026-04-22: label settable at publish time | https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md ; changelog.md |
| Creator Marketplace (creator discovery) | Brand/agency only | `GET creator_marketplace_creators` (Discovery) and Brand Information endpoint | Creator search (country, follower range, age, gender, interests, engagement, keywords, similar); creator insights; audience demographics; recent branded media | `instagram_creator_marketplace_discovery`, `instagram_basic`, `pages_manage_metadata`, `pages_show_list`, `business_management`. Brand Info also `ads_management`. Needs App Review (Advanced Access). Page token for a brand-linked Page | Brand must be onboarded to Creator Marketplace. Standard access returns test data only. Rate: see section 5 (conflict) | https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/creator-marketplace.md |
| Partnership ads permissions (ads side) | Yes, ads-side | `branded_content_ad_permissions` (changelog 2026-03-30 adds `creator_username` filter) | Ad permission for a creator's content | Marketing API / ads permissions (`instagram_branded_content_creator`, `instagram_branded_content_brand`, `ads_management`) | Ad-side tool, not a creator analytics tool. Details UNVERIFIED | changelog.md ; WebSearch snippet (developers.facebook.com) |
| Like / unlike media and comments | Yes | Engagement endpoints (path not captured) | n/a | `instagram_manage_engagement` (new 2026-04-22) | Changelog 2026-04-22 | changelog.md |
| Delete media | Yes | Media delete endpoint (path not captured) | n/a | `instagram_manage_contents` (new 2025-12-03) | Posts, carousels, reels, stories | changelog.md |

## 2. Current valid metric names

### 2a. Account insights: `GET /{ig-user-id}/insights`

Source: `api-reference/instagram-user/insights.md` (table as extracted). Verify before shipping.

| Metric | Period | metric_type | Breakdowns | Notes |
|---|---|---|---|---|
| `accounts_engaged` | day | total_value | none | "This metric is estimated." |
| `comments` | day | total_value | `media_product_type` | "in development" |
| `engaged_audience_demographics` | lifetime | total_value | `age`, `city`, `country`, `gender` | timeframe required; 100-engagement threshold |
| `follows_and_unfollows` | day | total_value | `follow_type` | 100-follower threshold |
| `follower_demographics` | lifetime | total_value | `age`, `city`, `country`, `gender` | timeframe required; 100-follower threshold |
| `impressions` | day | total_value, time_series | none | DEPRECATED: v22.0+ and all versions from 2025-04-21. Do not use |
| `likes` | day | total_value | `media_product_type` | |
| `profile_links_taps` | day | total_value | `contact_button_type` | |
| `reach` | day | total_value, time_series | `media_product_type`, `follow_type` | "This metric is estimated." |
| `replies` | day | total_value | none | |
| `reposts` | day | total_value | none | Added 2025 (changelog) |
| `saves` | day | total_value | `media_product_type` | Note: account-level is `saves`, media-level is `saved` |
| `shares` | day | total_value | `media_product_type` | |
| `total_interactions` | day | total_value | `media_product_type` | |
| `views` | day | total_value | `follower_type`, `media_product_type` (table) | "in development". Breakdown list in the doc names only `follow_type`, so `follower_type` is UNVERIFIED |

- Period values seen: `day`, `lifetime`.
- Breakdown values: `follow_type` = FOLLOWER / NON_FOLLOWER / UNKNOWN. `media_product_type` = AD, STORY, REEL, FEED subtypes (CAROUSEL_CONTAINER, POST as stated in summary, UNVERIFIED). `contact_button_type` = BOOK_NOW, CALL, DIRECTION, EMAIL, INSTANT_EXPERIENCE, TEXT, UNDEFINED. Breakdowns apply only to `metric_type=total_value`. Unsupported breakdown returns an error.
- Timeframe values for demographics: `last_14_days`, `last_30_days`, `last_90_days`, `prev_month`, `this_month` (last 30 days), `this_week` (last 7 days). See conflict in section 5.
- since/until: Unix timestamps, inclusive. Default look-back 24h. No maximum range stated.

### 2b. Media insights by `media_product_type`

Source: `reference/instagram-media/insights.md`. Carousel/album insights not listed on that page.

**FEED (posts)**
`comments`, `facebook_views` (FB), `follows`, `impressions` (deprecated for media created after 2024-07-02), `likes`, `profile_activity`, `profile_visits`, `reach`, `reposts`, `saved`, `shares`, `total_interactions` (in dev), `views` (in dev). FB only: `total_comments`, `total_likes`, `total_views`.

**REELS**
`comments`, `crossposted_views`, `facebook_views`, `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time` (in dev), `likes`, `reach` (estimated), `reels_skip_rate` (estimated, in dev), `reposts`, `saved`, `shares`, `total_interactions` (in dev), `views` (in dev). FB only: `total_comments`, `total_likes`, `total_views`.

**STORY**
`facebook_views`, `follows`, `impressions` (deprecated for newer media), `link_clicks` (new 2026-06-22, changelog says FB Login only), `navigation` (breakdown `story_navigation_action_type`), `profile_activity` (breakdown `action_type`), `profile_visits`, `reach`, `replies`, `reposts`, `shares`, `total_interactions` (in dev), `views` (in dev). FB only: `total_views`.
- Story metrics only available for 24 hours after posting.
- Story `replies` returns 0 for stories created by users in Europe and Japan (per doc).

**Not in the media doc, but in changelog:** `plays`, `video_views`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count` are deprecated/removed (see section 3).

## 3. Definitively NOT supported / removed (with citations)

- `video_views`: removed for v21.0+ (all versions from 2025-01-08). Changelog 2024-10-02.
- `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `impressions` (media and user): deprecated for v22.0+ (all versions from 2025-04-21). Changelog 2025-01-21.
- `profile_views`, `website_clicks`, `phone_call_clicks` (user time-series): removed for v21.0+ (from 2025-01-08). Changelog 2024-10-02.
- `reached_audience_demographics` and timeframes `last_14_days`, `last_30_days`, `last_90_days`, `prev_month` for audience demographics: changelog 2024-05-21 says removed for v20.0+ (from 2024-08-19). CONFLICTS with the reference table, see section 5.
- Business Discovery and Hashtag Search on Instagram Login: not available (FB Login only per docs).
- Insights for media inside an Instagram album (children): "Insights data is not available for any media within an Instagram Media album."
- Creating/updating/deleting Business Discovery data: not supported.
- Hashtag search on Stories: not supported. Commenting on hashtagged media found through the API: not supported.
- Creators (non-brand) using Creator Marketplace Discovery: docs address brands and agencies. Access needs a brand-linked Page token and onboarding.
- Insights on Facebook Pages (not IG accounts): "Facebook Pages can't be queried" (insights page).
- Story insights webhook on Instagram Login: marked not applicable (x) in the webhook matrix.
- Collaborators on Stories: not supported.
- Partnership label on remixed or close-friends-only posts: not supported.

## 4. Account field list and login-path permissions

Account fields (IG User node):
`id`, `username`, `name`, `biography`, `website`, `followers_count`, `follows_count`, `media_count`, `profile_picture_url`, `has_profile_pic`, `alt_text`, `is_published` (Page-backed), `legacy_instagram_user_id` (Page-backed), `shopping_product_tag_eligibility` (needs `catalog_management` + `instagram_shopping_tag_products`), `collaborative_media_search` (FB only).
- Not found on the fetched page: `account_type`, `ig_id`. The page has `has_profile_pic`, not `has_profile_picture`.

Permissions by login path (from the requirements table in the insights page and IG User page):

| Feature | Instagram Login | Facebook Login | Unified Login |
|---|---|---|---|
| Account read / insights | `instagram_business_basic` + `instagram_business_manage_insights` | `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement` | `instagram_basic` + `instagram_manage_insights` |
| Publish media | UNVERIFIED (`instagram_business_content_publish` per 2024-07-23 changelog) | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` | UNVERIFIED |
| Business Discovery | not available | `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` | UNVERIFIED |
| Hashtag search | not available | `instagram_basic` + Public Content Access feature | `instagram_basic` + Public Content Access feature |
| Branded content sponsor IDs | not confirmed | `instagram_branded_content_creator` or `instagram_basic` | UNVERIFIED |
| Story insights webhook | x (not applicable) | 5 permissions above | `instagram_manage_insights` |
| Collab invites | `instagram_basic` (listed generically; login path not explicit) | `instagram_basic` | UNVERIFIED |
| Like / unlike | `instagram_manage_engagement` (new 2026-04-22) | same | same |
| Delete media | `instagram_manage_contents` (new 2025-12-03) | same | same |

Business Manager role on connected Page adds `ads_management` or `ads_read` for FB and UL paths.

## 5. Rate limits

**Business Use Case (BUC), Instagram**
- Formula: `Calls within 24 hours = 4800 * Number of Impressions`. Impressions = times content from the account appeared on screen in the last 24h. Unique per app + app user pair.
- Business Discovery and Hashtag Search are subject to Platform rate limits in addition.
- Header: `x-business-use-case-usage` (JSON keyed by business object ID, each with `type` = `instagram`, `call_count`, `total_cputime`, `total_time` as percentages, plus `estimated_time_to_regain_access` in minutes).
- Error code for Instagram BUC: 80002. "When the limit has been reached, stop making API calls."
- Messaging limits (separate): Conversations API 2 calls/sec per account. Send API 100/sec text/link/reaction/sticker, 10/sec audio/video. Private Replies 100/sec for Live comments, 750/hour for post/reel comments.

**Platform rate limits**
- Per the rate-limiting summary: Platform app-level limit 200 x Number of Users per hour. NOT verified directly on the Platform page (fetch returned only the Instagram section). Error codes 4, 17, 32, 613 come from the Platform section (UNVERIFIED for this summary).

**Creator Marketplace**
- Page says account-level 5000 requests per user per hour; app-level 5000 x effective users per hour (rolling 1h).
- Changelog 2026-03-30 says "Account-level rate limits for the Discovery API have increased from 240 to 1,000 queries per user per hour." CONFLICTS with 5000. Treat as UNVERIFIED.

**Collab invites**
- List: 300 calls per user per 24h. Accept/decline: 50 calls per user per 24h.

**Media create containers**
- 400 containers per rolling 24h (from IG User media page).

## 6. Open questions / unverified (do not treat as fact)

1. **`online_followers`**: appears only in limitations text. Period, breakdowns, metric_type not confirmed.
2. **`follower_count`**: named in limitations text, absent from metric table. Confirm whether it still exists.
3. **Timeframe conflict**: reference table lists `last_14_days`, `last_30_days`, `last_90_days`, `prev_month` for demographics. Changelog 2024-05-21 says removed for v20.0+. Need current answer before coding.
4. **`views` breakdowns**: table lists `follower_type` and `media_product_type`; the doc's breakdown section lists only `follow_type`, `contact_button_type`, `media_product_type`. Unclear whether `follower_type` is valid.
5. **Account insights on IG Login**: the table is from the unified/FB reference. Confirm the Instagram Login variant has the same metric set (changelog 2025-01-21 says insights are available to IG Login apps and `views` added).
6. **Media insights permissions**: media insights page did not state permissions per login path. Assumed analogous to account insights.
7. **Carousel insights**: "not available for any media within an Instagram Media album". Unclear whether the parent carousel has its own insights. Not confirmed.
8. **Business Discovery fields**: docs list only `followers_count`, `media_count`, `media`, `id`, `comments_count`, `like_count`, `view_count`. Fields such as `username`, `name`, `biography`, `permalink`, `timestamp`, `caption`, `media_type` are NOT confirmed as available inside business_discovery. Verify with a live call in dev mode.
9. **Hashtag media fields**: not documented on fetched pages. Verify with a live call. Also: how `top_media` ranks is not explained.
10. **Creator Marketplace rate limit**: 5000 vs 1000 per user per hour (conflict above).
11. **Creator Marketplace eligibility**: Discovery may need `instagram_creator_marketplace_discovery` plus App Review. Whether a creator (not brand) can use any part of it is NOT stated. Assume no.
12. **Partnership ads / branded content ad permissions**: `branded_content_ad_permissions` endpoint details not fetched. Ads-side, requires Marketing API. Whether a creator can list/accept partnership ad requests via API is UNVERIFIED (appears to be brand-side).
13. **Story insights webhook timing**: docs do not say when `story_insights` fires relative to the 24h window. Payload shape not captured.
14. **`is_paid_partnership` availability**: docs say FB Login only. Changelog 2026-04-22 says the label can be set at publish time. Confirm whether IG Login gets it.
15. **Permission names for IG Login publish path**: `instagram_business_content_publish` exists (2024-07-23 changelog) but the create-container page only lists FB-path permissions in the fetched text.
16. **Media `reach` for carousels/albums**: not captured.
17. **Business Discovery fetch of other account types**: docs say "Business or Creator Account"; personal accounts are excluded implicitly. Not explicitly stated.
18. **Platform rate limit 200 x users/hour**: from summary, not verified on primary page.
19. **Changelog dates are from a summarised read.** Quotes were truncated to 125 characters by the fetch tool. Re-verify the dates that matter (2024-10-02, 2025-01-21, 2026-04-22, 2026-07-30).
20. **Creator-side collab invite visibility**: the owner (inviter) cannot list or manage invites via API per the fetched text. Not confirmed.

## 7. Source list (access date 2026-10-29)

- Insights (account, IG User): https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights.md
- Insights guide: https://developers.facebook.com/documentation/instagram-platform/insights.md
- Media insights: https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights.md
- Business Discovery (FB Login): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery.md
- Hashtag search (FB Login): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search.md
- Collaboration: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/collaboration.md
- Creator Marketplace: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/creator-marketplace.md
- IG User node: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user.md
- IG User media (create containers): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md
- Webhook fields: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields.md
- Changelog: https://developers.facebook.com/documentation/instagram-platform/changelog.md
- Rate limiting (Platform, Instagram BUC section): https://developers.facebook.com/docs/graph-api/overview/rate-limiting
- Index used for discovery: https://developers.facebook.com/documentation/instagram-platform/llms.txt

Failed or incomplete fetches: `api-reference/instagram-media/insights.md` (404), `instagram-graph-api/reference/ig-media/insights.md` (404), `instagram-api-with-facebook-login/hashtag-search.md` (first attempt connection lost; second attempt succeeded), `creator-marketplace.md` (first attempt connection lost; second attempt succeeded).
