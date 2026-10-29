# 05. Landscape and creator needs

Research date: 2026-10-29. Status: first pass by a research gatherer (Haiku). Items marked **needs verification** are not confirmed against Meta's live docs and must be checked by the API-verification agent before design decisions.

## TL;DR

- Official-API Instagram MCP servers exist but are small (0 to 12 stars each). None combines scheduling, a safety/approval layer, webhook triage, and reporting.
- Most "Instagram MCP" repos with large or many tools use username/password or private API. Those carry ban risk and are not our lane.
- Scheduling is the clearest gap. Meta's content-publishing page does not document a scheduled-publish parameter. Only the hosted PostOnce server advertises `publish_at`. A self-hosted scheduler is likely needed.
- Two Meta numbers conflict and must be verified: the 24h publish cap (100 vs 50) and the carousel max (20 per Meta, 10 in several servers).
- DMs are gated by App Review (`instagram_manage_messages`). Plan comment-to-DM via private replies (7-day window, one reply per comment) as the realistic DM path.

---

## 1. Competitor table

Star counts are a GitHub snapshot from 2026-10-29. "Official" means the Meta Graph API or Instagram Platform API. "Private" means username/password or instagrapi-style clients.

| Repo / tool | Stars | Official / private | Tools (count and notable) | Transport | Safety | Gaps | License | URL |
|---|---|---|---|---|---|---|---|---|
| adelaidasofia/instagram-mcp | 12 | Official (Graph API) | 29: accounts, publish (image, video, reel, carousel, story), insights (account, media, audience), comments (get, reply, hide, delete), hashtag and mentions, business_discovery, DMs (review-gated) | stdio (Python, FastMCP) | Token in env or OS keychain; DMs off until App Review flag; egress pinned to Meta hosts; token scrubber; input validation; JSONL audit log; `publishing_limit` tool | No scheduling; DMs need App Review; no webhooks noted | MIT | https://github.com/adelaidasofia/instagram-mcp |
| AleemHaider/instagram-mcp | 8 | Official (FB Graph API) | 24: profile and media, publishing, comments, DMs, insights; PyPI helper `instagram-mcp-get-token` mints long-lived tokens | stdio (Python, FastMCP + httpx) | Token in `.env`; scopes documented | No scheduling; FB Page required | MIT | https://github.com/AleemHaider/instagram-mcp |
| IvanBBaev/instagram-mcp (npm: instagram-mcp-ai) | 5 | Official (IG Platform and Graph) | 35 per badge: account, media, publishing, comment moderation, insights, discovery | stdio (TypeScript, locally run) | Official endpoints only; no cookie reuse; ingests media by public HTTPS URL only; CLI token refresh | Self-described: no tool exercised against a live account in CI; 0.8.0 status | MIT | https://github.com/IvanBBaev/instagram-mcp |
| William-Gao/instagram-mcp | 4 | Official, dual path: Instagram Login (IGAA) and FB Graph (EAA) | 28 (25 marked working): profile, media, insights, stories, mentions, publish (image, video, reel incl. Trial Reels, carousel), comments, DMs | stdio (Python) | Token refresh tool; validates token; no FB Page needed for core tools | Advanced Access features need App Review; hashtag and discovery need FB token | MIT | https://github.com/William-Gao/instagram-mcp |
| mcp-dir/instagram-mcp | 6 | Mixed: official for publish, comments, insights; "Advanced plan" adds like, follow, unfollow, DM start, and username/password login | Publish (photo, video, carousel, reel, story), comments, DMs, insights, job IDs (`get_job_status`) | Hosted remote HTTP (api.mcp.ai) | Async job IDs; hosted service holds credentials | Hosted SaaS; the Advanced actions are private-API style and violate our rule (do not copy) | MIT (repo); service is paid | https://github.com/mcp-dir/instagram-mcp |
| postoncehq/instagram-mcp | 2 | Official (Instagram API via PostOnce) | About 10: `create_post` (with `publish_at`), `create_draft`, `update_post`, `cancel_post`, `get_post`, `create_upload_url` | Hosted remote MCP (postonce.to/mcp) | Scheduling; drafts; AI-label flag; OAuth via PostOnce | Not supported: stories, comments, DMs, analytics, collaborators, location, alt text; paid key for non-Claude clients | MIT | https://github.com/postoncehq/instagram-mcp |
| Bob-lance/instagram-engagement-mcp | 47 | **Private** (username and password in `.env`) | `analyze_post_comments` (sentiment, themes, leads), `compare_accounts`, `extract_demographics`, `identify_leads`, engagement reports | stdio (Node, npm) | None beyond local `.env` | Account-ban risk; scraping-style analysis; Smithery listed | MIT | https://github.com/Bob-lance/instagram-engagement-mcp |
| HasData/instagram-mcp | 15 | Likely third-party scraping (**needs verification**) | Public profile and post feed by handle | Hosted remote | Hosted vendor | Public data only; not a creator-account tool | MIT | https://github.com/HasData/instagram-mcp |
| arjun1194/insta-mcp | 13 | **Private** (username and password, session files) | About 30: profile, followers, DMs, uploads, likes, follows, stories, discovery | stdio (Node) | Session stored in `data/` | Ban risk; no license file; not official | None (no license) | https://github.com/arjun1194/insta-mcp |
| pipeboard-co/meta-ads-mcp | 1341 | Official Meta Marketing API (ads, per description; **needs verification**) | Meta Ads reporting and management across FB and IG ads | Hosted remote (free plan) | Hosted vendor | Ads, not organic content; relevant only as a reference for ad-metrics tools | Other | https://github.com/pipeboard-co/meta-ads-mcp |
| supercorp-ai/instagram-mcp | 2 | Official (Instagram Login) | 4 tools | stdio | n/a | Very small | None | https://github.com/supercorp-ai/instagram-mcp |
| CDataSoftware/instagram-mcp-server-by-cdata | 4 | Read-only via CData JDBC driver | Read-only queries | stdio | Read-only | No writes; vendor product | MIT | https://github.com/CDataSoftware/instagram-mcp-server-by-cdata |
| official-Arvind/instagram-mcp | 5 | **Private** (instagrapi), claims 68+ tools | Full account control | stdio (FastMCP) | None | Ban risk | MIT | https://github.com/official-Arvind/instagram-mcp |

Takeaways from the table:
- Official-API repos with the most tools are 24 to 35 tools. They all do publish, comments, and insights. None has a dry-run or approval gate on writes except adelaidasofia (DM gating and audit log).
- Scheduling exists only in the hosted PostOnce server.
- Webhooks: none of the official repos reviewed exposes webhook-driven triage. This is an open lane.

### Commercial creator tools (features only, reference)

Sources are vendor and affiliate comparisons, so treat specifics as **needs verification**.

| Tool | Feature set (creator-relevant) |
|---|---|
| Later | Visual grid planner, Reels scheduling via Graph API, first comment, creator-monetization extras |
| Buffer | Simple scheduler, free tier (3 channels per one source), analytics: reach, impressions, engagement rate, follower growth, link clicks, saves |
| Metricool | Scheduling, analytics, competitor tracking, ad management; advanced reports paywalled per one source |
| Planoly | Grid-aesthetics planner, scheduling second |
| Meta Business Suite | Free, native Instagram scheduling (about 10 posts on free plan per one vendor), insights, first comment and thumbnail for Reels |

Sources: [Buffer vs Later vs Metricool comparison, hashtagtools](https://hashtagtools.io/blog/buffer-vs-later-vs-metricool-best-scheduler-2026), [Later vs Metricool vs Buffer, Rework](https://resources.rework.com/tools/social-media/later-vs-metricool-vs-buffer), [Metricool vs alternatives](https://metricool.com/metricool-vs/), [Best Instagram schedulers 2026, Sked Social](https://skedsocial.com/blog/best-instagram-schedulers.md).

---

## 2. Creator jobs-to-be-done

Feasibility is a guess from docs and READMEs. Every item needs verification by the API agent.

| # | Creator job | What the agent does | Feasible via official API? | Notes |
|---|---|---|---|---|
| 1 | Schedule and queue posts | Build a calendar, queue posts for later | **Partly. Needs verification.** Immediate publish is supported. No scheduled-publish parameter is documented on Meta's content-publishing page. | Build scheduling in our server (cron plus quota check). |
| 2 | Best time to post | Recommend posting windows | **Likely. Needs verification.** `online_followers` (per hour, last 30 days). Not available under 100 followers. | Combine with own post engagement history. |
| 3 | Caption and hashtag workflow | Draft captions, pick hashtags | **Agent-side for writing.** Hashtag research via `ig_hashtag_search` (**needs verification**: unique-hashtag cap per 7 days). | Hashtag search needs a Business/Creator account. |
| 4 | Repurpose YouTube to Reels | Cut a long video into Reels, add captions, publish | **Publish: yes. Needs verification** for reel specs (duration, size, aspect). Media must be on a public HTTPS URL. | YouTube download rights are a policy issue; use user-owned media. |
| 5 | Comment triage and replies | Sort comments, reply, hide spam | **Yes, likely.** Get, reply, hide, delete are in several repos. Comment webhooks need subscription (**needs verification**). | Use webhook plus approval queue. |
| 6 | DM management (collab inquiries, FAQs) | Read threads, answer, route | **Gated.** `instagram_manage_messages` needs App Review. Standard window is 24h after user's last message. | Expect App Review as a blocker. |
| 7 | Keyword auto-reply | Reply when a comment has a keyword | **Partly.** Private reply to a comment is allowed within 7 days, one per comment (Meta private-replies doc, via search). | Automated DMs need the same review. Human Agent tag is for human replies only (**needs verification**). |
| 8 | Weekly and monthly analytics report | Summarize reach, engagement, follows | **Yes, likely.** Account insights (reach, profile views, follower count) and media insights. 30-day windows (**needs verification**). | Store snapshots yourself; the API does not give a full follower history. |
| 9 | Per-post performance | Rank posts by reach, saves, shares | **Yes.** Media insights in several repos. Metric names may have changed (**needs verification**). | |
| 10 | Growth tracking | Follower trend over time | **Partly.** Current follower count is available. History beyond the window must be stored locally. | Snapshot daily. |
| 11 | Competitor and benchmark tracking | Compare with other creators | **Likely.** `business_discovery` on public Professional accounts by username (adelaidasofia, AleemHaider). Needs FB Graph. | Verify fields returned. |
| 12 | Hashtag and topic benchmarking | Top and recent media by tag | **Likely.** `top_media` and `recent_media` (**needs verification**). | Same cap as #3. |
| 13 | Brand partnership: media kit stats | Export follower count, engagement, demographics | **Yes, likely.** Account insights plus audience demographics (age, gender, country, city). Needs enough followers (**needs verification**). | Demographics likely need 100+ followers. |
| 14 | Sponsored or branded post performance | Track paid or branded posts | **Unknown. Needs verification.** Branded-content and partnership metrics may need separate permissions. | High-value gap; check first. |
| 15 | Content calendar | Plan themes and dates | **No API needed.** Internal feature. | Respect the publish quota (#1). |
| 16 | Mentions and tags tracking | See who tagged the account | **Yes.** `get_mentions` in adelaidasofia and William-Gao. | |
| 17 | Stories | Publish, read story insights | **Partly.** Publish story exists in some repos. Stories expire after 24h (**needs verification** of story insights and limits). | |
| 18 | Archive and backup own content | Save posts, captions, insights locally | **Yes.** `list_media`, `get_media`. Media URLs may expire (**needs verification**). | Download media soon after listing. |

---

## 3. Differentiating ideas for our server

1. **Built-in scheduler with quota awareness.** A local queue that publishes at the chosen time, checks `content_publishing_limit` before each run, and refuses to exceed the cap. Only the hosted PostOnce server offers this.
2. **Plan, approve, execute on every write.** Publish, reply, hide, and DM tools return a proposed action first. Execution needs an explicit approve call. This is a dry-run layer no official-API repo ships.
3. **Webhook-driven comment triage.** Subscribe to comment and mention webhooks. Classify comments by rule (keyword, sentiment, spam), then queue draft replies for approval. Private replies to commenters within the 7-day window.
4. **Weekly and monthly report generator with a local snapshot store.** Store follower and reach snapshots daily so the report has a history the API does not give.
5. **Media-kit export.** One command produces reach, engagement rate, top posts, and audience demographics as Markdown or PDF for brand pitches. No vendor needed.
6. **Best-time-to-post with honest confidence.** Use `online_followers` plus the account's own engagement history. Show the sample size and say when there is not enough data (under 100 followers).
7. **Repurposing pipeline.** Local video in, captions and cover generated, uploaded to user-controlled storage with a public URL, then published as a Reel. Validate specs before upload.
8. **Brand-deal tracker.** Tag each sponsored post with deal metadata and report per-deal reach and engagement. Depends on verifying branded-content metrics (job #14).
9. **Content backup.** Export posts, captions, and insights to a local folder on a schedule. Protects against account loss.
10. **Official-only guardrails as a feature.** Refuse any tool that needs username and password or private endpoints. Keep the scrubber, egress pin, and audit log from adelaidasofia as a reference design.

---

## 4. Discrepancies and open items for the verification agent

- **Publish cap:** Meta's content-publishing page states both "100 API-published posts within a 24-hour moving period" and "50 published posts within a 24-hour period" in the carousel section. Third-party sources cite 25 (older) and 100. Verify the current figure and check `content_publishing_limit`.
- **Carousel max:** Meta page says up to 20 images or videos. adelaidasofia and PostOnce say 2 to 10. Verify.
- **Scheduling:** Confirm whether any scheduled-publish parameter exists. Meta page only hints that apps may offer scheduling. PostOnce's `publish_at` is its own layer.
- **Webhook fields:** Meta's webhook page does not list the subscribable fields in the fetched text. Check `/webhooks/fields`.
- **Hashtag search cap:** Not verified in this pass (search returned nothing). Check the `ig_hashtag_search` reference.
- **Human Agent tag and private-reply limits:** From third-party vendor blogs. Verify against Meta messaging docs.
- **Trial Reels and scheduling:** A secondary source says scheduling, insights, and trending audio opened to all public accounts in March 2026. No Meta announcement was found. Treat as unverified.
- **Stars and activity** are a snapshot from 2026-10-29 and will change.
- **Blocked fetch:** `about.instagram.com/creators` redirected to `creators.instagram.com` and was not fetched. The Meta insights reference URL returned 404. Use `developers.facebook.com/documentation/instagram-platform` pages instead.

---

## 5. Sources (accessed 2026-10-29)

Repos and GitHub data:
- `gh search repos "instagram mcp"` and `gh search repos "instagram graph api mcp"`, run 2026-10-29.
- READMEs fetched via `gh api repos/{owner}/{repo}/readme`, 2026-10-29: adelaidasofia/instagram-mcp, Bob-lance/instagram-engagement-mcp, arjun1194/insta-mcp, AleemHaider/instagram-mcp, IvanBBaev/instagram-mcp, William-Gao/instagram-mcp, mcp-dir/instagram-mcp, postoncehq/instagram-mcp.
- Glama listings, 2026-10-29 (search only, not fetched): https://glama.ai/mcp/servers/luminarylane/instagram-mcp-server and related listings. Smithery was not searchable in this pass.

Meta official:
- Content publishing: https://developers.facebook.com/documentation/instagram-platform/content-publishing (fetched 2026-10-29; no date on page; cap conflict noted above).
- Webhooks: https://developers.facebook.com/documentation/instagram-platform/webhooks (fetched 2026-10-29; field list not in text).
- Private replies: https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies (via search, 2026-10-29).
- Insights reference: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights (search snippet, 2026-10-29; the direct fetch returned 404).

Third-party (treat as unverified):
- Publish limits: https://www.ayrshare.com/solutions/instagram-graph-api-error-9-the-25-post-daily-limit-how-to-fix-it.md ; https://bundle.social/blog/instagram-api-rate-limits ; https://blotato.com/blog/instagram-posting-api (2026-10-29, search snippets).
- Messaging rules: https://www.blotato.com/blog/instagram-messaging-api ; https://singhamandeep.com/?p=1404 (2026-10-29).
- Creator trends: https://www.marketingprofs.com/charts/2026/54489/the-creator-landscape-in-2026-content-monetization-and-ai-trends ; https://www.netinfluencer.com/creators-favor-long-term-brand-partnerships-as-platform-diversification-becomes-the-norm-report-finds/ (2026-10-29, search snippets).
- Scheduling tools: https://skedsocial.com/blog/best-instagram-schedulers.md ; https://hashtagtools.io/blog/buffer-vs-later-vs-metricool-best-scheduler-2026 (2026-10-29).

Creator-job evidence is thin. The creator-economy sources found did not measure time spent on comments, DMs, or brand deals directly. Job list above is inferred from product features and typical creator workflows, and should be treated as a hypothesis to validate with creators.
