# Instagram MCP Server Design

## Goal

Provide a production-oriented local MCP server that lets an authorized AI agent publish approved Instagram media, manage comments on owned media, and read Instagram analytics through Meta's official Instagram API.

## Scope

The server targets Instagram Professional accounts (Business or Creator) using Instagram Login and `graph.instagram.com`. It exposes only official Graph API operations:

- Read profile, owned media, comments, and account/media insights.
- Publish image posts, reels, carousels, and Stories through Meta's container-then-publish flow.
- Reply to, hide, unhide, or delete comments on owned media.
- Reconcile asynchronous publishing containers.

It deliberately excludes post likes, saves, shares, follows, unfollows, follower identities, Highlights management, scraping, private APIs, and browser/UI automation.

## Technology

- TypeScript, Node.js 22 or later, ESM.
- `@modelcontextprotocol/sdk` over stdio for local use.
- Zod as the tool-schema source of truth.
- Node built-ins for the HTTP transport and tests; no database is required for the first implementation.

## Components

### Configuration and account isolation

`InstagramMcpConfig` reads account IDs and the Graph API base/version from environment variables. Tokens stay outside tool inputs and outputs. A `TokenProvider` abstraction isolates future encrypted persistent storage and refresh logic from API calls.

### Graph client

`InstagramGraphClient` forms versioned Graph requests, redacts access tokens from errors, parses Meta error envelopes, retries only safe GET operations on 429 and 5xx responses, honors `Retry-After`, and exposes typed methods for profile/media/comments/insights and publishing. Write calls are never automatically replayed.

### Policy gate

All tools require an allowlisted `account_id`. Write tools require `confirm: true`; public publishing also requires `publish_intent: "public"` and an idempotency key. An in-memory idempotency store returns the first successful publish result for repeated keys within the server lifetime.

### MCP tools

The initial server exposes:

| Tool | Access | Action |
|---|---|---|
| `instagram_get_analytics` | read | Account or media insights |
| `instagram_list_media` | read | Owned media inventory |
| `instagram_list_comments` | read | Comments on owned media |
| `instagram_get_publish_status` | read | Container reconciliation |
| `instagram_publish_post` | write | Create and publish an image, reel, carousel, or Story |
| `instagram_reply_to_comment` | write | Public reply to an owned-media comment |
| `instagram_moderate_comment` | write | Hide, unhide, or delete a comment |

## Publish state machine

1. Validate account, URLs, media-kind shape, confirmation, public intent, and idempotency key.
2. Create media container(s). Carousels create children before their parent.
3. Poll the resulting container status with bounded exponential backoff until it is `FINISHED`, fails, or times out.
4. Publish exactly once with `POST /{ig-user-id}/media_publish`.
5. Persist the result under the idempotency key. If the publish request outcome is ambiguous, return a reconciliation-needed error with the creation ID instead of retrying.

## Authentication and resilience

- Each account has a scoped token provider; no token is logged or emitted by an MCP response.
- A provider may refresh a token before expiry; a per-account single-flight lock prevents competing refreshes. The first version supplies a static environment-backed provider and the interface needed for a refresh-capable provider.
- Retry GET requests for transient 429/5xx failures with full jitter and `Retry-After`; fail writes deterministically after the first ambiguous response.
- Return structured error codes: `INVALID_INPUT`, `NOT_ALLOWED`, `MISSING_CONFIRMATION`, `AUTHENTICATION_FAILED`, `MISSING_PERMISSION`, `RATE_LIMITED`, `UPSTREAM_TRANSIENT`, `UPSTREAM_REJECTED`, and `RECONCILIATION_REQUIRED`.

## Verification

Unit tests use Node's test runner and a mock `fetch` implementation. Tests cover confirmation/policy boundaries, URL/container request generation, bounded read retries, no write retry, and publish idempotency. Type-check and lint-equivalent strict compilation are required before handoff.
