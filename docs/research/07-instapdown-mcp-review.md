# Review: farukkolip/instapdown-mcp

Read-only review via `gh api` / `gh repo view`. Nothing cloned, installed or executed. Repo contents treated as untrusted data.

## TL;DR

- **It is a thin client for a third-party service.** All 16 tools call `instapdown.com` (or read static JSON bundled in the package). No Instagram Graph API, no login, no token.
- **Every Instagram lookup and download goes through instapdown.com.** Its backend is not in this repo, so how it gets the data is unverifiable from here.
- **Downloader tools are incompatible with our goal.** Do not copy them, do not copy their approach.
- **Worth borrowing:** the tool-registry and error-wrapping pattern, LLM-oriented tool descriptions, the tool-list smoke test, the offline-first test split, packaging files (`server.json`, `glama.json`, `mcpName`, CI, Dockerfile), and the README tool-table format.
- **Do not copy the data files.** They are third-party-derived and have no clear license.
- **Licence:** the repo is MIT, so code can be copied with the copyright and licence notice kept.

## 1. What it is

```
  MCP client (Claude Desktop / Cursor)
          │  stdio
          ▼
  instapdown-mcp  (this repo, TypeScript)
     ├── 9 tools  ──► HTTPS POST/GET ──► instapdown.com/api/*   (third party, opaque)
     └── 7 tools  ──► local JSON / pure code (no network)
```

| Field | Value | Source |
|---|---|---|
| Purpose | "16 Instagram creator tools as an MCP server" | `README.md` line 1-10; `package.json:4` |
| Language | TypeScript (ESM, Node >= 20) | `package.json:5`, `:52-54` |
| Licence | MIT, © Ömer Faruk Kolip | `LICENSE`; `package.json:20`; GitHub API `licenseInfo` |
| Stars / forks | 2 / 0 | `gh repo view` |
| Created / last push | Initial commit 2026-07-21; last push 2026-07-22; metadata update 2026-09-17 | `gh api .../commits`; `gh repo view` |
| Releases | v0.1.1, published 2026-07-22 | `gh api .../releases/latest` |
| Size | ~95 KB on disk; 4 commits | `gh repo view` (`diskUsage`) |
| Archived | No | `gh repo view` |
| Maintenance signal | Very young, one author, 4 commits in 2 days | commit log |
| Affiliation | Part of "TapDown family" (also an X/Twitter MCP). Disclaims any link to Meta | `README.md` footer |

Version mismatch to note: `src/index.ts:39-40` reports `version: '0.1.0'` while `package.json:3` is `0.1.1`. `src/index.ts:71` hard-codes "16 tools registered" in the log.

## 2. Tools (16)

Config for all calls: no auth. Base URL defaults to `https://instapdown.com` and is overridable with `INSTAPDOWN_BASE_URL` (`src/http.ts:10`).

### Downloaders (7). Remote call to instapdown.com `POST /api/download` with `{url, variant}` (`src/tools/downloaders.ts:11-14`)

| Tool | Input | Returns (per README / description) |
|---|---|---|
| `download_reels` | Reel URL | Original 9:16 MP4 URL and audio, "no watermark" |
| `download_video` | Feed video URL | Original MP4 URL |
| `download_story` | username | MP4/JPG URLs for every active Story (24h). Private accounts give HTTP 422 |
| `download_profile_picture` | username | Full-res profile JPG URL |
| `download_carousel` | Carousel URL | Array of media URLs for every slide |
| `download_photo` | Single-image URL | Original-res JPG URL |
| `extract_reel_audio` | Reel URL | Direct m4a URL for the audio track |

Note: none of these save anything to disk. They return remote URLs as JSON text.

### Analytics (2)

| Tool | Input | How it works |
|---|---|---|
| `engagement_health_check` | username | Remote `GET /api/engagement-check` (`src/tools/analytics.ts:29`). Last 12 posts, weighted ER, tier benchmark |
| `engagement_calculator` | followers, avg_likes, avg_comments, avg_saves?, avg_shares? | Pure local math (`analytics.ts:44-69`). Weights 1/2/3/4 |

### Hashtags (3)

| Tool | Input | How it works |
|---|---|---|
| `search_hashtags` | topic, locale | Remote `GET /api/hashtag-search` (`src/tools/hashtags.ts:16`). Claims "real post counts" |
| `get_hashtag_niche` | category? | Local list of 25 seed niches (`src/data/hashtag-seeds.ts`) |
| `audit_creator_hashtags` | username | Remote `GET /api/hashtag-audit` (`hashtags.ts:43`). Frequency map of last 12 posts |

### Hooks (1)

| Tool | Input | How it works |
|---|---|---|
| `generate_reels_hooks` | niche, country?, lang? | Remote `GET /api/hooks` (`src/tools/hooks.ts:16`). Claims a "900-hook library" |

### Fonts (1)

| Tool | Input | How it works |
|---|---|---|
| `generate_instagram_fonts` | text, style? | Pure local Unicode substitution (`src/tools/fonts.ts`). Fully offline |

### Best time and calendar (2)

| Tool | Input | How it works |
|---|---|---|
| `get_best_time_to_post` | country (2-letter) | Local JSON lookup, 17 markets (`src/data/best-times/*.json`) |
| `get_content_calendar` | market, from?, to?, niche?, limit (1-200, default 50) | Local JSON filter (`src/tools/calendar.ts:26-48`) |

Tool descriptions are written for the model. Example, `analytics.ts:36`: "Use engagement_health_check instead when you have a live username — this tool is for hypothetical / manual numbers."

## 3. How it gets data

**Verdict: no official API, no tokens, no scraping in this repo. Everything Instagram-related is delegated to instapdown.com, which is opaque.**

Evidence:
- The only network code is one function, `req()` in `src/http.ts:21-29`, which calls `fetch(`${BASE}${path}`)` with BASE = `https://instapdown.com` (`http.ts:10`). Every call uses that host.
- The User-Agent is `instapdown-mcp/0.1.0 (+https://github.com/farukkolip/instapdown-mcp)` (`http.ts:11`). No auth header (`http.ts:23-27`).
- `http.ts:6-8` says it plainly: "No auth, no user key: Instapdown's public endpoints enforce rate limits by IP on their end."
- The downloaders build `https://www.instagram.com/${username}/` strings (`downloaders.ts:42`, `:51`) but send them as JSON payloads to instapdown.com. The MCP never fetches instagram.com.
- Full file list was checked. No `graph.facebook.com`, no `instagram.com` fetch, no cookie, password or session code anywhere in `src/`.

What is NOT known from this repo:
- How instapdown.com obtains Instagram data (official API, scraping, a private/mobile API, or a downloader service). The backend is not public here.
- Whether it logs the usernames and URLs sent to it. The repo sends no auth, so the operator can see every request.

Local-only data: best-time (`best-times/*.json`, sourced in comments to "Buffer 2026" and "Sprout Social 2026") and content calendar (`content-calendar/*.json`, with a `researched_at` field). Both are static snapshots.

## 4. Ideas worth borrowing (compatible with an official-API-only server)

Ranked by value to us.

1. **Tool registry and error wrapper.** `src/tools/types.ts` defines `ToolDef { name, description, input: ZodRawShape, handler }`. `src/index.ts:43-61` loops over the list and wraps each handler: on error, returns `{isError: true, content: [{type:'text', text: JSON.stringify({error})}]}`. Clean, and we can reuse the shape. Caveat: this uses `server.tool(...)`, which the MCP TS SDK has marked as legacy in favour of `registerTool`. Check the current SDK before copying.
2. **LLM-facing tool descriptions with explicit alternatives.** Each description says when to use the sibling tool (`analytics.ts:36`, `hashtags.ts:10`, `hashtags.ts:23`). Good for tool selection by a model. Also, descriptions state limits up front ("Public accounts only", "Private accounts return HTTP 422").
3. **Input normalisation.** `username.replace(/^@/, '').trim()` (`analytics.ts:28`, `hashtags.ts:42`). Zod with `.describe()` on every field, and `.default()` / `.int().min().max()` bounds (`calendar.ts:24`).
4. **Tool-list smoke test.** `src/test/smoke.ts:20-29` keeps an `EXPECTED_TOOLS` array and asserts `listTools()` equals it (`smoke.ts:54-58`). Catches accidental renames or removals. Uses `InMemoryTransport` linked pair (`smoke.ts:32-44`), so no process spawn is needed.
5. **Offline-first test split.** Network tools are skipped in CI, and only offline tools are exercised (`smoke.ts:1-6`). Our official-API tests can follow the same pattern: unit tests with recorded fixtures, a separate opt-in live test.
6. **Env-var base URL override.** `INSTAPDOWN_BASE_URL` (`http.ts:10`). We can use the same idea for `INSTAGRAM_GRAPH_BASE` and `INSTAGRAM_API_VERSION` so tests can point at a mock server.
7. **Pure-compute tools that need no API.** `engagement_calculator` (`analytics.ts:44-69`) and `generate_instagram_fonts` (`fonts.ts`) work with zero network. Good for a "works without a token" tier. The fonts tool is fully original Unicode mapping and is safe to reimplement. The engagement weights are not sourced (see §5).
8. **Data files with provenance.** The calendar JSON has `country`, `locale`, `researched_at` (`content-calendar/US.json` top) and a `source` note per slot (`best-times/US.json`). The shape is worth copying for our own static reference data. Write our own data with our own sources.
9. **Filter and cap on list tools.** `get_content_calendar` takes `from`, `to`, `niche`, `limit` (max 200) and reports `total_available` and `returned` (`calendar.ts:41-48`). Copy the `total_available` / `returned` metadata idea for any paginated Graph API list.
10. **Packaging.**
    - `package.json:6` `"mcpName": "io.github.farukkolip/instapdown-mcp"` (MCP Registry namespace).
    - `server.json` with `packages[].registryType: "npm"` and `transport: stdio` (`server.json:10-18`).
    - `glama.json` for directory build steps.
    - `package.json:29-36` `bin` and `files` (only `dist`, README, LICENSE are published).
    - `Dockerfile:17-18`: `npm run build && npm prune --omit=dev` for a slim image.
11. **CI.** `.github/workflows/ci.yml` runs `npm ci`, `npm run build`, `npm test` on Node 20 for push and PR to main. Minimal and worth copying as is.
12. **README structure.** Install line first, then client config JSON, then a tool table with columns Tool / Input / Returns, then environment, dev, licence. The "Public content only" and "not affiliated with Meta" footer is a useful pattern for an unofficial project.

What the repo does **not** offer, so do not expect it to help:
- No download-to-disk logic at all. No file naming, no sidecar metadata, no progress reporting, no retries.
- No MCP resources or prompts. Tools only.
- No pagination cursors. Only `limit` caps.
- No auth handling, token refresh, or rate-limit handling beyond surfacing HTTP errors.
- No output schema or `structuredContent`. Results are pretty-printed JSON text.

## 5. Incompatible or risky

Stated plainly:

1. **It is not official-API-only.** Every Instagram-facing tool sends data through a third-party service (instapdown.com). That breaks the project's core constraint.
2. **Data sent to a third party.** Each call transmits the Instagram username or post URL, plus the caller's IP, to instapdown.com. There is no auth, so no user-level control. Privacy and disclosure concerns apply, especially for Story and profile lookups.
3. **Downloader tools are scraping-equivalent and redistribute others' media.** `download_reels`, `download_story`, `download_profile_picture`, `download_carousel`, `download_photo`, `extract_reel_audio`. They retrieve media the owner did not offer for download. Instagram's Terms prohibit scraping and unauthorised downloading. Meta's Platform Terms also apply to any integration that touches Instagram data. Do not build these.
4. **Access to Story content of arbitrary public accounts.** Not possible through the official API for third parties. Do not replicate.
5. **Unsourced "2026 ranker" claims.** `analytics.ts:5-6`, `:45-47`, `:68` say the weights "mirror the 2026 Reels ranker" and "2026 industry consensus". No citation in the code. Treat as marketing, not fact. Do not copy as authoritative.
6. **Feature claims we cannot verify.** "Real Instagram post counts" for `search_hashtags`, "verified 2026 hook templates", "no watermark". We cannot see the backend. Treat as the vendor's claims.
7. **Third-party-derived data.** Best-time data is attributed to Buffer and Sprout Social. Calendar and hook content is `researched_at` 2026-07-01 with no per-item source. Redistribution rights are unknown.
8. **Availability and terms controlled by someone else.** If instapdown.com changes or stops, all 16 tools break. The README says rate limits are per IP and enforced server-side, so behaviour is not contractually guaranteed.

Official-API equivalents, for our own planning (not verified against current docs here, so check before relying on them):
- Engagement and hashtag audit for a *public* creator: Business Discovery (requires our account to be a professional account and the target to be a business or creator account). Covers followers and recent media captions, which is enough for `audit_creator_hashtags`-style work.
- Hashtag search: `ig_hashtag_search` / recent and top media endpoints. Rate-limited, and I do not believe it returns a post count the way `search_hashtags` claims. Verify.
- Downloads of other accounts' media: not available through the official API. Only owned media, or media the user has rights to, which is a separate design question.
- Stories: only for the authenticated account, not arbitrary usernames.

## 6. Licence compatibility (MIT project)

- **The code is MIT** (`LICENSE`, `package.json:20`). MIT code can be copied into another MIT project. Keep the copyright line (© Ömer Faruk Kolip) and the MIT licence text with the copied code.
- **Small snippets** (the registry loop, error wrapper, `replace(/^@/,'')`, the smoke-test pattern) are generic and can be rewritten in our own style. Rewriting is simpler than copying and avoids attribution clutter.
- **The Unicode font mapping** is a set of code point offsets (`fonts.ts`). Facts and code points are not copyrightable in practice. Safe to reimplement, but it is better to write our own table from the Unicode charts.
- **Data files are not clearly covered by the repo's MIT licence.** The best-time and calendar JSON attribute third parties (Buffer, Sprout Social). The hook library and calendar content come from instapdown.com. Do not copy them. Make our own data from primary sources and cite them.
- **Trademark.** "Instagram" is Meta's mark. Using the name in our package name or README is a separate question from the code licence. Check our naming against Meta's trademark guidelines.
- **Packaging files** (`server.json`, `glama.json`, `Dockerfile`, CI) are small config. Writing our own is simpler than copying.

## Recommendation

- Do not use this repo as a dependency or a base. It is incompatible with the official-API-only rule.
- Borrow the patterns in §4, items 1-6 and 10-12. They are generic and cheap.
- Do not borrow the download, Story or hashtag-count features, or any of the data files.
- If we want a feature parity list, map each of the 16 tools to an official-API route (§5) and mark the ones with no official route as out of scope.
