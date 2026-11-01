# Live end-to-end test checklist

Run this together (owner and orchestrator) on the test account after [SETUP.md](SETUP.md) section J passes `doctor`. The point is to confirm the "unverified upstream facts" at the bottom and to see every tool work against real Meta.

Rules for the run:

- Use only the dedicated test account. Everything created is cleaned up at the end (delete media, cancel scheduled).
- Set `policy.dry_run: true` first and run each write once as a dry run, then set it to `false` for the real run.
- Record each result in the Result column: PASS, FAIL (paste the error code, never a token), or N/A (with reason). Note the Meta error code and message for every FAIL; they are the evidence for the unverified list.
- Keep the app secret and tokens out of anything you paste.

Two extra accounts help: a second personal Instagram account (called "B" below) that can DM and @mention the test account, and optionally a public business account for discovery. Run it twice if you set up both login paths (aliases `test-ig` and `test-fb`); rows marked FB only run on the Facebook path.

## Preconditions

| # | Check | Expected | Result |
|---|---|---|---|
| 0.1 | `instagram-mcp doctor` | no FAIL lines | |
| 0.2 | `instagram_list_accounts` | account listed with login path, capability matrix, token expiry, scopes | |
| 0.3 | `instagram_get_profile` | username, counts, `account_type` on the instagram path | |
| 0.4 | `instagram_get_rate_limits` | publishing quota with `quota_total` (see U5) | |

## Checklist

| # | Feature | Tools | Prerequisites | Steps | Expected outcome | Result |
|---|---|---|---|---|---|---|
| 1 | Publish image (URL) | `instagram_preflight_publish`, `instagram_approve` | A public HTTPS JPEG URL | `kind: image`, caption with a hashtag, approve | Post on the profile; result has `media_id` and `permalink` | |
| 2 | Publish image (local file) | same | `media_host.public_base_url` and tunnel running (SETUP F); a local JPEG | `kind: image`, `path` | Post published; `/m/<token>` no longer served afterwards | |
| 3 | Publish reel (URL) | same | Public MP4 URL | `kind: reel`, with `share_to_feed` | Reel on profile | |
| 4 | Publish reel (local video) | same | Local MP4; instagram path needs the media host, facebook path uses resumable upload | `kind: reel`, `path` | Reel published | |
| 5 | Publish story | same | JPEG or MP4 | `kind: story` | Story visible; `instagram_list_stories` lists it | |
| 6 | Publish carousel | same | 3 JPEGs | `kind: carousel` | Carousel with 3 children | |
| 7 | Carousel of 20 | same | 20 JPEGs | `kind: carousel`, 20 items | Either published or `UPSTREAM_REJECTED` (see U4) | |
| 8 | Schedule | same, `instagram_list_scheduled`, `instagram_cancel_scheduled` | Daemon running (SETUP G) | `publish_at` about 15 minutes ahead; approve; list; wait | Job goes scheduled, containers_created, published at the time. Second job: cancel it, status canceled | |
| 9 | Schedule missed | `instagram_list_scheduled` | Stop the daemon past `publish_at` plus grace, restart | Job is `missed`, not posted late | | |
| 10 | Publish status | `instagram_get_publish_status` | A creation id from a publish result | `status_code` returned | | |
| 11 | Quota | `instagram_get_rate_limits` | after publishing | `quota_usage` increased | | |
| 12 | Delete media | `instagram_preflight_delete_media`, approve | A throwaway post | Preview shows permalink; approve; post gone | Instagram path: either works or `CAPABILITY_UNAVAILABLE` (U3). Facebook path: works | |
| 13 | Comments off and on | `instagram_preflight_set_comments_enabled`, approve | A post | Disable, check `instagram_get_media` `is_comment_enabled` false, enable | Works, or Meta 100 error (U6) | |
| 14 | List and read media | `instagram_list_media`, `instagram_get_media` | Posts exist | Filter by product type | Carousel children, permalink, counts | |
| 15 | Comment, reply | `instagram_preflight_comment_actions`, approve | Account B comments on a test post | `reply` to B's comment, then new top-level `comment` | Both visible in the app | |
| 16 | Hide and unhide | same | A comment from B | `hide`, check `hidden: true` in `instagram_list_comments`, `unhide` | Works | |
| 17 | Delete comment | same | A comment from B | `delete` | Gone, or per-item `failed` (U23) | |
| 18 | Batch comment actions | same | 3 comments | One approval with 3 ops | Per-item outcomes; one failure does not stop others | |
| 19 | Inbox | `instagram_get_inbox`, `instagram_mark_handled` | B has commented | List, mark one handled | `unanswered` and `handled` flags correct | |
| 20 | Private reply | `instagram_preflight_comment_actions` (`private_reply`) | A comment from B less than 7 days old | `private_reply` | DM arrives at B, or Meta error (messaging, see U7, U18) | |
| 21 | Mentions | `instagram_list_mentions`, `instagram_preflight_reply_mention` | B @mentions the test account in a comment or caption | List; reply | Mention listed; reply posted. Tag lookups may fail on some paths (U13) | |
| 22 | DMs list and read | `instagram_list_conversations`, `instagram_get_conversation` | B sends a DM to the test account first (opens the 24-hour window) | List, read | Conversation with `window_open: true` (U7, U21) | |
| 23 | DM send | `instagram_preflight_send_message`, approve | Window open | Text message to B | Delivered to B (app Live; fails in Development mode, U36) | |
| 24 | DM window closed | same | Conversation older than 24 hours | Preflight | `MESSAGING_WINDOW_CLOSED` | |
| 25 | Messaging profile | `instagram_preflight_set_messaging_profile`, approve | | Set 2 ice breakers, then clear | Visible in B's chat start, then removed | |
| 26 | Account insights | `instagram_get_account_insights` | Account with some activity | `views`, `reach`, period `day` | Normalized metrics. A deprecated metric (`impressions`) is rejected locally with the replacement named | |
| 27 | Media insights | `instagram_get_media_insights` | A post and a reel | No metric list given | Valid set chosen per product type | |
| 28 | Audience | `instagram_get_audience` | Account with 100+ followers may be needed | Demographics; online followers | Data or null/unavailable, never a hard error (U8, U15) | |
| 29 | Snapshot and growth | `instagram_snapshot_insights`, `instagram_get_growth` | Two snapshots on different days (daemon does it daily) | Snapshot now; growth | Snapshot id; series with deltas | |
| 30 | Report | `instagram_performance_report` | Posts in the last 30 days | `30d` | JSON plus markdown | |
| 31 | Best time | `instagram_best_time_to_post` | | Run | States data source used | |
| 32 | Media kit | `instagram_media_kit` | | Run | JSON plus markdown | |
| 33 | Download media | `instagram_download_media` | | Download one post and a carousel | Files plus `.json` sidecar under `downloads/<username>/` | |
| 34 | Backup | `instagram_backup_account` | | Run twice | Second run skips already-saved media | |
| 35 | Business discovery (FB only) | `instagram_lookup_account`, `instagram_compare_accounts` | Facebook path; a public business or creator username | Lookup; compare with 2 | Counts and recent media (U11 `fallback_fields`). On instagram path: `CAPABILITY_UNAVAILABLE` naming the facebook path | |
| 36 | Hashtags (FB only) | `instagram_search_hashtag`, `instagram_get_hashtag_media` | Facebook path | Search one tag; top and recent | Media, or a permissions error if Public Content Access is not granted in development mode | |
| 37 | Collab invites | `instagram_list_collab_invites`, `instagram_preflight_respond_collab_invite` | Another account invites the test account as collaborator | List; accept or decline | Works or `CAPABILITY_UNAVAILABLE` (U22) | |
| 38 | Branded content | `instagram_preflight_publish` with `is_paid_partnership` | | Publish with the flag | Works (facebook) or probed (U10) | |
| 39 | Webhooks | daemon | SETUP H complete | Have B comment and DM | Events appear in `instagram_get_inbox` with `source: webhook`; bad signature returns 401 | |
| 40 | HTTP mode | `serve --http` | `http-token rotate` done | Connect a client with the bearer; try without a bearer and with a wrong Host | Works with bearer; 401 without; 403 for a bad Host | |
| 41 | Policy | config | | `read_only: true` then retry a preflight; `disabled_actions: ["delete_media"]` | `POLICY_DENIED` | |
| 42 | Approval rules | `instagram_approve` | | Approve twice; approve after TTL | Second returns the stored outcome with `replayed: true`; expired gives `APPROVAL_EXPIRED` | |
| 43 | Operations | `instagram_list_operations`, `instagram_get_operation` | | After the run | Every write has a ledger entry, no tokens in output | |
| 44 | Token refresh (IG path) | `auth refresh` | Token at least 24 hours old | `instagram-mcp auth refresh --account test-ig` | New `expires_at` about 60 days out | |
| 45 | Secrets hygiene | all | | Search `~/.instagram-mcp` logs and output for the token with grep | No matches (the keychain holds it) | |

Cleanup: delete test posts (row 12), cancel scheduled jobs, `unhide` nothing is left hidden, clear ice breakers, `instagram-mcp auth logout --account <alias>` if you want a clean slate, and reset the app secret in Meta's dashboard if it was exposed during the session.

## Unverified upstream facts this run confirms

From [CONTRACT.md](CONTRACT.md) section 7. For each, record the observed answer; the server tolerates either answer, so a surprise is documentation to fix, not a crash.

| # | Fact | Confirmed by row | Observed |
|---|---|---|---|
| U1 | `Authorization: Bearer` accepted on `graph.instagram.com` | Set `token_in_header: true` and re-run row 0.3 | |
| U2 | `appsecret_proof` accepted or required on `graph.instagram.com` | Calls work on the instagram path without it | |
| U3 | `DELETE /{media_id}` works on the instagram path | 12 | |
| U4 | Carousel of 20 children accepted | 7 | |
| U5 | Publish quota is 50 vs 100 | 0.4, 11 | |
| U6 | `comment_enabled` parameter name on `POST /{media_id}` | 13 | |
| U7 | Webhooks and DMs work in development mode | 20, 22, 23, 39 | |
| U8 | `online_followers` shape and `follower_count` existence | 28, 31 | |
| U9 | rupload for instagram-login accounts (never attempted) | 4 | |
| U10 | Branded content parameters on the instagram path | 38 | |
| U11 | Business discovery field set | 35 | |
| U12 | Human-agent tag parameters | 23 with `allow_human_agent_tag: true` after 24 hours | |
| U13 | `/stories` and `/tags` on the instagram path | 5, 21 | |
| U14 | `views` breakdown names | 26 with `breakdown` | |
| U15 | Demographic `timeframe` values | 28 | |
| U16 | Image containers need polling | 1 | |
| U17 | `account_type` on the instagram path | 0.3 | |
| U18 | Messaging on the facebook path | 22, 23 on `test-fb` | |
| U19 | Error codes 9/2207042 and 10/2534022 | 11 (only if quota is hit), 24 | |
| U20 | Header `X-Hub-Signature-256` | 39 | |
| U21 | Nested field syntax on conversations | 22 | |
| U22 | Collab invite field names | 37 | |
| U23 | Delete-comment token owner | 17 | |
| U24 | Hashtag media field set | 36 | |
| U25 | Comments pagination via `after` | 15 with more than one page of comments | |
| U26 | Reels maximum duration 15 vs 20 minutes | Not practical to test; leave open | |
| U27 | Webhook subscribe endpoint path | 39 (subscription is done in the dashboard) | |

Also confirm from [SETUP.md](SETUP.md): the labels marked "(Meta's UI may label this differently)", the Instagram Tester invite flow, whether the redirect URL is required, and which features work in development mode. Write corrections back into SETUP.md.
