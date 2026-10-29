# Instagram Platform: Content Publishing and Media Management (official API only)

**Research date:** 2026-10-29
**Latest Graph API version observed:** v26.0 (released 2026-07-29 per the Graph API versions page; v25.0 released 2026-02-18, v24.0 released 2025-10-08). All Instagram reference examples use v26.0.
**Scope:** Professional (Business/Creator) accounts. Official Meta docs only. Unofficial/private APIs excluded.

Login path shorthand used below:
- **IG Login** = Instagram API with Instagram Login (`graph.instagram.com`, Instagram User token, `instagram_business_*` permissions)
- **FB Login** = Instagram API with Facebook Login (`graph.facebook.com`, Facebook Page/User token, `instagram_basic` / `instagram_content_publish` family)
- **Unified** = Instagram API with Unified Login (Business Integration System User token, `graph.facebook.com`), named on the content-publishing page's permissions table

Base doc URLs:
- Content publishing guide: https://developers.facebook.com/docs/instagram-platform/content-publishing
- IG User Media: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- IG Media: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
- IG Container: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
- Stories: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/stories
- Content publishing limit: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
- Changelog: https://developers.facebook.com/docs/instagram-platform/changelog

---

## 0. TL;DR

- Publishing is a **two-step** flow: `POST /{ig-user-id}/media` creates a container, then `POST /{ig-user-id}/media_publish` publishes it. Containers expire after 24 h.
- **No native scheduling.** The server must hold the container and call `media_publish` at the target time.
- **Editing is almost nil.** Only `comment_enabled` is documented as updatable on `POST /{ig-media-id}`. Caption edits, archive and pin are not documented.
- **Deletion exists** via `DELETE /{ig-media-id}` but is documented only for the FB Login path (and conflicting docs exist, see Section 5).
- **Local video upload** (resumable) is documented only for FB Login-for-Business apps. IG Login path needs a public `video_url`.
- **Rate limits conflict** in Meta's own docs (50 vs 100 posts per 24 h). Treat the published-post limit as unresolved.

---

## 1. Capability table

Legend: Yes / No / Partial / Undocumented.

| Capability | Supported? | Endpoint + method | Params | Permission (IG Login / FB Login) | Limits / caveats | Source URL |
|---|---|---|---|---|---|---|
| Create image container (single image) | Yes | `POST /{ig-user-id}/media` | `image_url` (public URL), `caption`, `alt_text`, `user_tags`, `location_id`, `product_tags`, `collaborators`, `is_ai_generated`, `branded_content_sponsor_ids`, `is_paid_partnership`, `poll_attachment`, `is_comment_prompt_used`, `access_token` | IG Login: `instagram_business_basic` + `instagram_business_content_publish`. FB Login: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` (+ `ads_management`/`ads_read` if Business Manager role) | Image must be publicly hosted at publish time. JPEG only (MPO/JPS not supported). Min width 320, max 1440 (scaled). Aspect 4:5 to 1.91:1. 8 MB max. `alt_text` is image-only. `media_type` not shown for images in the example (default IMAGE). | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Create video / Reel container | Yes | `POST /{ig-user-id}/media` with `media_type=REELS` (or `VIDEO`) | `video_url` OR resumable upload, `caption`, `cover_url`, `thumb_offset`, `share_to_feed`, `audio_name`, `trial_params`, `collaborators`, `location_id`, `user_tags`, `is_ai_generated`, `upload_type=resumable` | IG Login and FB Login as above | See Section 2 for Reel specs. `share_to_feed` and `audio_name` Reels only. `audio_name` renamable once. `cover_url` overrides `thumb_offset`. `trial_params.graduation_strategy` = `MANUAL` or `SS_PERFORMANCE`. Reels cannot go in carousels. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Create Stories container (image or video) | Yes | `POST /{ig-user-id}/media` with `media_type=STORIES` | `image_url` or `video_url` (not both `video_url` and Reels URL), `user_tags` (x/y optional for stories) | IG Login and FB Login as above | Stories expire after 24 h. Video stories max 60 s, 3 s min, 100 MB. Image stories 8 MB max, 9:16 recommended. Caption, `alt_text`, `location_id`, `collaborators` not applicable to stories per the parameter table. The content-publishing page has a copy error ("To publish a reel") in the stories section. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Create carousel (album) container | Yes | 1) `POST /{ig-user-id}/media` with `is_carousel_item=true` for each child (image or video); 2) `POST /{ig-user-id}/media` with `media_type=CAROUSEL` and `children=<id1>,<id2>,...`; 3) `media_publish` with the carousel container ID | `children` (comma-separated container IDs), `is_carousel_item`, `caption` (parent only) | Same as above | Up to 20 items, mixed image/video allowed. Carousel images cropped to first image's aspect ratio (default 1:1). Caption, `location_id`, `alt_text`/`is_ai_generated` not for children (`is_ai_generated` on carousel: set on parent only, per changelog). Child readiness before parent creation: **not documented** (see Section 4). | https://developers.facebook.com/docs/instagram-platform/content-publishing |
| Publish container | Yes | `POST /{ig-user-id}/media_publish` | `creation_id` (container ID), `access_token` | Same as container creation | Returns `{"id": "<IG_MEDIA_ID>"}`. Counts against the published-post limit (Section 1 row "Publishing rate limit"). No time/schedule parameter. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish (linked from content-publishing) |
| Poll container status | Yes | `GET /{ig-container-id}?fields=status_code` (also `status`) | `fields` | Same as container creation | `status_code` values: `EXPIRED`, `ERROR`, `FINISHED`, `IN_PROGRESS`, `PUBLISHED`. Docs recommend polling once per minute, max 5 minutes. If `ERROR`, `status` holds an error subcode. Video uploads are asynchronous; `FINISHED` means ready. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container |
| Container expiry | Yes (fixed) | n/a | n/a | n/a | Containers expire if not published within 24 h (`status_code=EXPIRED`). No expiry timestamp field is documented. Account creates max 400 containers per rolling 24 h. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container |
| Publishing quota check | Yes | `GET /{ig-user-id}/content_publishing_limit` | `fields` (optional; default returns `quota_usage`), `since` (Unix timestamp, no older than 24 h) | IG Login: `instagram_business_basic` + `instagram_business_content_publish`. FB Login: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` | Returns `quota_usage` and `config` (`quota_total`, `quota_duration`). Current doc values: `quota_total=50`, `quota_duration=86400`. Conflicts with other limit text on the publishing page (Section 4). | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit |
| Local video upload (resumable) | Partial | 1) `POST` container with `upload_type=resumable` on `rupload.facebook.com`; 2) `POST https://rupload.facebook.com/ig-api-upload/<API_VERSION>/<IG_CONTAINER_ID>` with `Authorization: OAuth <TOKEN>`, `offset: 0`, `file_size: <bytes>`, binary body | `upload_type`, `offset`, `file_size`, `file_url` (hosted-URL variant) | Documented for FB Login-for-Business apps and Unified path. The doc says `upload_type=resumable` is "Only for apps that have implemented Facebook Login for Business." IG Login path lists only `graph.instagram.com` as host. | Unverified whether IG Login can use rupload (see Section 4). Response `{"success":true,"message":"Upload successful."}`; failures include `debug_info` with `retriable` and `type`. Parameter list on the page is truncated for the start-session step. | https://developers.facebook.com/docs/instagram-platform/content-publishing |
| Public URL publish (video or image) | Yes | Same container create with `video_url` / `image_url` | `video_url`, `image_url` | All paths | Media must be publicly hosted "at the time of the attempt." Retention period after the attempt is not documented. Meta fetches it (cURL). | https://developers.facebook.com/docs/instagram-platform/content-publishing |
| Read media list | Yes | `GET /{ig-user-id}/media` | `since`, `until` (Unix or strtotime). Default page size not documented. | IG Login: `instagram_business_basic`. FB Login: `instagram_basic` + `pages_read_engagement` or `pages_show_list` (+ `ads_management`/`business_management` if Business Manager role) | Returns up to 10K most recent media (per doc text). Stories not returned here (use `/stories`). Some `media_url` values omitted (Section 1, row "media_url"). Pagination cursor behaviour not documented on this page. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Read single media | Yes | `GET /{ig-media-id}?fields=...` | `fields` | IG Login: `instagram_business_basic`. FB Login: `instagram_basic` | Readable fields: `id`, `caption` (FB Login only), `media_type` (`CAROUSEL_ALBUM`, `IMAGE`, `VIDEO`), `media_product_type` (`AD`, `FEED`, `STORY`, `REELS`; FB Login only), `media_url`, `permalink` (not on album children), `thumbnail_url` (VIDEO only), `timestamp` (ISO 8601 UTC), `like_count` (omitted if owner hid likes), `comments_count` (includes replies), `is_comment_enabled`, `is_shared_to_feed` (Reels), `is_ai_generated`, `media_audio_type` (`MUSIC`/`ORIGINAL_SOUND`, video only), `shortcode`, `alt_text`, `owner` (only if requester created it), `username`, `view_count` (Business Discovery, Reels), `total_like_count`/`total_comments_count`/`total_views_count`/`reposts_count`/`shares_count`/`saved_count`/`boost_ads_list`/`boost_eligibility_info`/`copyright_check_information` (FB Login, various). Edges: `children`, `collaborators` (FB Login), `comments`, `ordered_comments` (FB Login), `insights`. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media |
| Read stories | Yes | `GET /{ig-user-id}/stories` | none documented | FB Login only in docs: Facebook User token with `instagram_basic` + `pages_read_engagement` (+ Business Manager extras) | Returns story IG Media objects. Stories expire after 24 h. Live video stories not returned. Reshared story creations not returned. Only one caption returned per story. No pagination documented. IG Login permissions not listed on this page. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/stories |
| Update media: comments on/off | Yes | `POST /{ig-media-id}` with `comment_enabled=true\|false` | `comment_enabled` | FB Login (ig-media page). IG Login permission not stated on that page. | Only documented updatable field. Live video not supported. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media |
| Update caption | **Undocumented** (treat as No) | none documented | n/a | n/a | Only `comment_enabled` is listed as updatable on `POST /{ig-media-id}`. Caption not listed. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media |
| Delete post / carousel / reel / story | Yes (FB Login only in docs) | `DELETE /{ig-media-id}` (page header says DELETE; request syntax on page shows POST) | none | FB Login only per ig-media page: `instagram_basic` + `instagram_manage_contents`, Facebook User token on `graph.facebook.com` | Supported: non-ad posts, stories, reels, entire carousel albums. Individual child deletion in carousels NOT supported (pass parent carousel ID). Changelog (2025-12-03) says `DELETE /{ig_media_id}` for posts, carousels, reels, stories needs `instagram_manage_contents`. IG Login path not documented. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media ; changelog https://developers.facebook.com/docs/instagram-platform/changelog |
| Archive media | **Undocumented** | none found | n/a | n/a | No mention in reference or changelog 2025-2026. | (none found) |
| Pin / unpin media to profile | **Undocumented** | none found | n/a | n/a | No mention in reference or changelog 2025-2026. | (none found) |
| Native scheduled publishing | **No** (not in docs) | n/a. `media_publish` takes only `creation_id` and `access_token`. | n/a | n/a | The server must create the container, keep it within 24 h, and call `media_publish` at the target time. The publishing page only mentions apps that let users "schedule posts to be published in the future" as a reason to enforce the publishing limit. | https://developers.facebook.com/docs/instagram-platform/content-publishing |
| Download own media | Partial | `media_url` field on `GET /{ig-media-id}` | `fields=media_url` | Same as read single media | `media_url` omitted for: video with copyrighted/licensed audio (incl. Instagram audio library), copyright-flagged video, and other users' reels where owner disabled downloads. Expiry of `media_url` is **not documented**. Treat as optional; fall back to `permalink` or `thumbnail_url`. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media |
| Alt text on publish | Yes (images only) | `POST /{ig-user-id}/media` | `alt_text` (up to 1000 chars) | Same as container creation | Image posts only; not reels or stories. Added 2025-03-24 per changelog. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Tag users on publish | Yes | `POST /{ig-user-id}/media` | `user_tags` (usernames, x/y for images) | Same as container creation | x/y required for images; optional for stories. Image and video stories supported (changelog 2025-07-09). | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Product tags | Yes | `POST /{ig-user-id}/media` | `product_tags` (max 5; `product_id`, optional x/y) | FB Login plus `catalog_management` and `instagram_shopping_tag_products` | Shopping tags and filters not supported on carousel publishing per the publishing page. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Collaborators | Yes | `POST /{ig-user-id}/media` | `collaborators` (max 3 usernames) | Same as container creation | Feed images, reels, carousels only. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Location tag | Yes | `POST /{ig-user-id}/media` | `location_id` (Page ID with location) | Same as container creation | Not supported on carousel items. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Reel cover / thumbnail | Yes | `POST /{ig-user-id}/media` | `cover_url` (JPEG, 8 MB max) or `thumb_offset` (ms) | Same as container creation | `cover_url` overrides `thumb_offset`. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Trial Reels | Yes | `POST /{ig-user-id}/media` | `trial_params` (`graduation_strategy`: `MANUAL` or `SS_PERFORMANCE`) | Same as container creation | Reels only. Added 2025-12-03 per changelog. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| AI-generated label | Yes | `POST /{ig-user-id}/media` | `is_ai_generated` | Same as container creation | Carousel: set on the carousel container only. Setting on children errors. Added 2026-06-22 per changelog. | https://developers.facebook.com/docs/instagram-platform/changelog |
| Paid partnership label | Yes | `POST /{ig-user-id}/media` | `branded_content_sponsor_ids` (max 2), `is_paid_partnership` | Requires `instagram_branded_content_creator` or `instagram_basic` (per ig-user/media page) | Added 2026-04-22 per changelog. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Caption add-on: poll | Yes | `POST /{ig-user-id}/media` | `poll_attachment`; `is_poll_duration_extended` (needs `poll_attachment`) | Same as container creation | Cannot combine with `is_comment_prompt_used`. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Caption add-on: comment prompt | Yes | `POST /{ig-user-id}/media` | `is_comment_prompt_used` | Same as container creation | Cannot combine with `poll_attachment`. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Caption | Yes (on create) | `POST /{ig-user-id}/media` | `caption` | Same as container creation | Max 2,200 characters, 30 hashtags, 20 @-tags. Not on carousel items. | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| Insights (publishing-adjacent) | Not researched | n/a | n/a | n/a | Out of scope for this file. | n/a |

---

## 2. Media specs and limits

Source for all rows below: IG User Media reference (https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media), unless noted.

**General**
- Containers expire after 24 h.
- Max 400 containers created per account per rolling 24 h.
- Reels cannot appear in carousels.
- Music tagging only for original audio (per doc text).

**Image feed posts**
- Format: JPEG only (MPO and JPS not supported).
- Max file size: 8 MB.
- Aspect ratio: 4:5 to 1.91:1.
- Min width 320 (scaled up), max width 1440 (scaled down).
- Non-sRGB color spaces converted to sRGB.

**Reels (video)**
- Container: MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at front.
- Video codec: HEVC or H.264, progressive, closed GOP, 4:2:0 chroma.
- Frame rate: 23-60 FPS.
- Max width: 1920 px.
- Aspect ratio: allowed 0.01:1 to 10:1, 9:16 recommended.
- Video bitrate: VBR, 25 Mbps max. Audio bitrate: 128 kbps. Audio: AAC, 48 kHz max, mono or stereo.
- Duration: 3 s min, 15 min max.
- File size: 300 MB max.
- Cover image: JPEG, 8 MB max.

**Stories**
- Expire after 24 h. Either `video_url` or Reels URL, not both.
- Image: 8 MB max; 9:16 recommended to avoid crop/blank space.
- Video: 3 s min, 60 s max; 100 MB max; codec/frame-rate/bitrate as Reels; aspect 0.1:1 to 10:1, 9:16 recommended.

**Carousel**
- Up to 20 items total, images, videos, or mixed.
- Carousel images cropped to first item's aspect ratio (default 1:1).

**Text limits**
- Caption: 2,200 chars, 30 hashtags, 20 @-tags.
- Alt text: 1,000 chars (image posts only).
- Collaborators: up to 3.
- Product tags: up to 5, unique.

**Conflict:** Reels duration. The API reference says 15 min max. The Instagram consumer help pages say up to 20 min for recording and 90 s for boosted ads. Use 15 min as the API limit and verify with a test upload.

---

## 3. Publishing flow (end to end)

1. `POST /{ig-user-id}/media` with media params. Response `{"id": "<CONTAINER_ID>"}`. For resumable uploads the response may also include a `uri`.
2. If local video: start resumable session, then upload bytes to `rupload.facebook.com` (FB Login path only per doc). Otherwise use `video_url` / `image_url` (public).
3. Poll `GET /{CONTAINER_ID}?fields=status_code` once per minute, max 5 min, until `FINISHED` (or `ERROR`/`EXPIRED`).
4. `POST /{ig-user-id}/media_publish` with `creation_id=<CONTAINER_ID>`. Response `{"id": "<MEDIA_ID>"}`.
5. Check `GET /{ig-user-id}/content_publishing_limit` before step 1 if the app allows scheduling.

For carousels: create each child (`is_carousel_item=true`), poll children to `FINISHED`, create parent (`media_type=CAROUSEL`, `children=...`), poll parent, then publish the parent ID. The child-readiness requirement is inferred from general polling guidance; the docs do not state it explicitly.

---

## 4. Permissions by login path

| Login path | Token | Host | Publishing permissions | Read permissions |
|---|---|---|---|---|
| IG Login | Instagram User token | `graph.instagram.com` | `instagram_business_basic`, `instagram_business_content_publish` | `instagram_business_basic` |
| FB Login | Facebook Page token (or User) | `graph.facebook.com`, `rupload.facebook.com` | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` (+ `ads_management` / `ads_read` if Business Manager role) | `instagram_basic` + `pages_read_engagement` or `pages_show_list` |
| Unified | Business Integration System User token | `graph.facebook.com`, `rupload.facebook.com` | `instagram_basic`, `instagram_content_publish` | same as above |

- Product tagging additionally needs `catalog_management` and `instagram_shopping_tag_products`.
- Delete needs `instagram_basic` + `instagram_manage_contents` (documented for FB Login).
- Advanced Access or Standard Access required on all three paths (content-publishing page).
- Task requirement: the app user needs `MANAGE` or `CREATE_CONTENT` on the linked Page (FB Login).

---

## 5. Definitively NOT supported (with citations)

1. **Update/delete on the IG User Media endpoint.** `GET /{ig-user-id}/media`: "Update and delete operations are not supported for this endpoint." Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
2. **Update/delete on stories via the stories endpoint.** Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/stories ("Update and delete are not supported." Create uses the IG User Media endpoint.)
3. **Individual carousel child deletion.** "Individually deleting media within a carousel is not supported." Delete the parent album ID instead. Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
4. **Live video update.** Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media (live video not supported for update).
5. **Creating or reading a container's parameters via `GET /{container-id}`.** The IG Container reference has no edges and does not document container creation; creation is documented on `POST /{ig-user-id}/media`. Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
6. **Native scheduled publishing.** No time parameter exists on `media_publish` (only `creation_id` and `access_token`). Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish. This is an absence in the docs, not an explicit "not supported" statement. Treat as "not supported, verified by parameter list."
7. **Shopping tags and filters in carousel publishing.** Source: https://developers.facebook.com/docs/instagram-platform/content-publishing ("Not supported: Shopping tags and filters").
8. **Location tag on carousel items; caption on carousel items.** Source: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
9. **Reels inside carousels.** "Reels cannot appear in carousels." Source: same.
10. **Alt text on reels or stories.** "alt_text ... image posts only, not for reels or stories." Source: same.

---

## 6. Open questions / unverified

1. **Published-post limit conflict.** Content-publishing page says "100 API-published posts within a 24-hour moving period" (rate-limit section) and "50 published posts within a 24-hour period" (carousel section). The content_publishing_limit reference says `quota_total=50` **containers** per 86400 s. These may measure different things (containers vs. published posts). Unresolved. Build the server to read `content_publishing_limit` at runtime rather than hard-code.
2. **Container quota vs. publish quota.** The docs also cite 400 containers per rolling 24 h. Relation to the 50 figure is unclear.
3. **DELETE method and login path.** The ig-media page header says DELETE, but its request syntax shows POST. The page lists delete under FB Login only. The Dec 2025 changelog says `DELETE /{ig_media_id}` for posts, carousels, reels, stories requires `instagram_manage_contents`, with no login-path restriction. Verify against the live reference before shipping.
4. **Caption editing.** Not in the updatable list. Not documented as unsupported either. Treat as unsupported until a live test or doc confirms.
5. **Archive and pin.** No mention in reference pages or the 2025-2026 changelog. Treat as undocumented. Do not expose as tools without verification.
6. **IG Login local video upload.** Content-publishing page says `upload_type=resumable` is "Only for apps that have implemented Facebook Login for Business," and lists only `graph.instagram.com` as the host for the IG Login path. So local video upload on IG Login is unverified and probably unavailable. Public `video_url` is the documented path.
7. **Carousel child readiness.** No doc statement that children must reach `FINISHED` before the parent container is created. Inferred only. Poll children to `FINISHED` before parent creation as a safety measure.
8. **`media_url` expiry.** Not documented. The page says only that it can be omitted under copyright or download-disabled conditions. Changelog 2026-07-30: `media_url` is omitted for copyrighted audio/downloads-disabled reels; requests still return 200. Expiry or signed-URL lifetime is unknown. Download promptly; do not cache URLs.
9. **Public-URL retention.** The docs say media must be publicly hosted "at the time of the attempt." How long it must stay available after is not documented.
10. **Stories pagination and fields.** The stories page shows only `id` in the sample and says fields are returned "as normal" by reference to IG Media. Pagination not documented.
11. **`GET /{ig-user-id}/media` pagination.** The page documents `since`/`until` only. Cursor/paging behaviour and default page size not documented on this page.
12. **Max 10K recent media** is quoted from doc text. Not confirmed against a live response.
13. **Reels duration.** API doc says 15 min max. Consumer help says 20 min recording. Not reconciled.
14. **Publishing auth errors.** A Meta developer forum thread (community, not official) reports "Exception: Authorization Error" (code 100, subcode 33) on publish since 2026-05-23. Unverified and not an official statement. Check live.
15. **Rate-limit text vs. error codes.** Not researched in this pass. Error codes for publish failures other than `status_code=ERROR` subcodes are not catalogued here.
16. **Stories `caption`/`alt_text`/location.** The parameter table does not list these for stories. Assumed not supported; not explicitly stated.
17. **`share_to_feed` duplicate in example.** The reels example lists `share_to_feed` twice. Parameter is documented as Reels-only. Treat the example as a copy error.
18. **Carousel resumable example.** The doc example uses `media_type=VIDEO` in a carousel-resumable context. Unclear if intended.
19. **Scheduling via `scheduled_publish_time`.** Not in docs; not verified as absent beyond the parameter list.

---

## 7. Latest Graph API version and access date

- **Latest observed:** v26.0 (released 2026-07-29 per https://developers.facebook.com/docs/graph-api/changelog/versions; the reference examples use v26.0).
- **Prior:** v25.0 (released 2026-02-18, expires 2028-07-29); v24.0 (released 2025-10-08, expires 2028-02-18).
- **Access date:** 2026-10-29.
- **Changelog caveat:** The Instagram platform changelog lists 2025-2026 entries as "Applies to all versions," so version-specific behaviour changes are not separately enumerated.
- **Fetch issue:** The Graph API changelog page timed out once; version data came from the versions page instead.
