# youtube-mcp: reusable patterns for instagram-mcp

Source: `/Users/pratik/CodeBase/youtube-mcp` (v0.3.0, MIT, dev repo; public clone at `/Users/pratik/CodeBase/youtube-mcp-public`). Read-only sweep, 2026-10-29. Vault notes used for orientation only, then checked against code. Where the vault and code disagree, the code wins (see "Vault drift" at the end).

## TL;DR

- Stack: TypeScript ESM, Node 22.13+, `@modelcontextprotocol/sdk` 1.x (McpServer), zod 4, `tsc` only for lint and build, vitest 4 for tests. No ESLint, no Prettier.
- Write safety is the core asset: `preflight -> youtube_approve -> execute`, one shared operation ledger, single-use approvals with a 5-minute TTL, approval bound to profile, channel, kind, target and a SHA-256 of the desired change, plus a fresh provider-state fingerprint at execute time.
- Storage is local and file-based: `node:sqlite` (built in, no native deps) plus per-profile JSON, all under `YOUTUBE_MCP_STATE_DIR`. Modes 0700 and 0600.
- Secrets live in plaintext JSON under the state dir (not keychain). Nothing logs tokens. Errors are a single `AppError` shape serialised as JSON in `isError` results.
- Transports: stdio by default, loopback-only Streamable HTTP as an opt-in with no auth. Stateless: one McpServer per request.
- 79 tools, all registered in one file (`src/mcp/server.ts`) with `readTool` / `writeTool` / `downloadTool` helpers.
- Tests: 202+ offline vitest tests, a live E2E script gated by env vars, and config/packaging tests. No separate code-blind test repo exists for youtube-mcp.

---

## 1. Project layout, tooling, CI

**Layout (tracked files, abridged)**
- `bin/youtube-mcp.mjs`: one line, `import '../dist/index.js'`. Published entry.
- `src/index.ts`: composition root. Builds every service and passes them as a `dependencies` object to `createMcpServer`. Handles `--version`, `youtube-auth`, `--transport stdio|http`.
- `src/config.ts`: env loading (`process.loadEnvFile` from cwd, shell values win), `readEnv` (empty string = unset), `loadConfig`.
- `src/errors.ts`: `AppError` and the error factory functions.
- `src/types.ts`: shared types (`OperationState`, `OperationPreview`, `OperationReceipt`, `AppConfig`, `ConnectionProfile`).
- `src/mcp/server.ts` (registrations, 284 lines) and `src/mcp/schemas.ts` (zod schemas, 202 lines).
- `src/auth/oauth.ts`: OAuth service, token file, desktop login flow.
- `src/operations/{approval,service,store}.ts`: the write-safety ledger.
- `src/transports/{stdio,http}.ts`.
- `src/sqlite/{open-database,warning-filter}.ts`: `node:sqlite` wrapper and the ExperimentalWarning filter.
- `src/youtube/*.ts`: one service per domain (public, account, analytics, creator-content, creator-report, uploads, upload-store, upload-validation, playlists, moderation, channel-profile, subscriptions, resources, read-after-write, client).
- `src/consumption/*.ts`: Takeout import, local insights, curation (store + service).
- `configs/*`: 16 client configs (Claude Desktop, Codex TOML, Cursor, VS Code, Zed, goose YAML, etc.), all using one npx launch.
- `mcpb/manifest.json` (Desktop bundle), `.claude-plugin/{plugin,marketplace}.json`, `gemini-extension.json`, `llms-install.md`, `AGENTS.md`, `SKILL.md`.
- `scripts/`: `build-mcpb.mjs`, `live-e2e.mjs`, `read-only-smoke.mjs`, `private-playlist-smoke.mjs`.
- `docs/`: `README.md`, `SETUP.md`, `CHANGELOG.md`, `PHASE-2-HANDOFF.md`, `superpowers/` (specs and plans).
- Root: `README.md`, `SECURITY.md`, `LICENSE` (MIT), `.env.example`, `.gitignore`, `.mcp.json`.
- Gotcha: `SKILL.md` is still the unfilled template ("A brief description of what this skill does"). Do not copy it.

**package.json**
- `name` youtube-mcp, `version` 0.3.0, `"type": "module"`, `"private": true` in the dev repo (public repo has its own manifest), `license` MIT, `bin` maps `youtube-mcp` to `bin/youtube-mcp.mjs`.
- `engines.node` `>=22.13.0`. `files` allowlist: `.env.example`, `bin`, `configs`, `docs/CHANGELOG.md`, `docs/README.md`, `dist`, `scripts`.
- Scripts:
  - `build`: `tsc -p tsconfig.json`
  - `build:mcpb`: `node scripts/build-mcpb.mjs`
  - `auth`: `node dist/index.js youtube-auth`
  - `dev:stdio` / `dev:http`: `tsx src/index.ts --transport ...`
  - `prepare` and `prepack`: `npm run build`
  - `lint`: `tsc --noEmit -p tsconfig.json` (this is the whole lint step)
  - `typecheck`: same as lint
  - `typecheck:tests`: `tsc --noEmit -p tsconfig.tests.json`
  - `test`: `vitest run`
  - `smoke:read-only`, `smoke:e2e`, `smoke:private-playlist`: the `scripts/*.mjs` files
- Dependencies: `@modelcontextprotocol/sdk ^1.26.0`, `googleapis ^171.4.0`, `youtube-transcript ^1.2.1`, `zod ^4.1.12`.
- DevDependencies: `@types/node ^22.20.1`, `tsx ^4.20.6`, `typescript ^5.9.3`, `vitest ^4.0.14`.
- No `better-sqlite3`. Storage uses the built-in `node:sqlite`, so there is no native addon and one universal `.mcpb` works on every OS.
- Lockfile: npm, `lockfileVersion` 3.

**tsconfig**
- `tsconfig.json`: target ES2022, `module` and `moduleResolution` NodeNext, `strict`, `esModuleInterop`, `skipLibCheck`, `declaration: true`, `rootDir: src`, `outDir: dist`. Includes only `src/**/*.ts`.
- `tsconfig.tests.json`: extends the above, `noEmit`, `rootDir: "."`, includes `src` and `tests`.
- `vitest.config.ts`: `include: ['tests/**/*.test.ts']`, `environment: 'node'`, `setupFiles: ['tests/setup.ts']`.

**Node**: pinned to 22 in every workflow. No `.nvmrc` or `.node-version`. `src/index.ts` checks `node:sqlite` at startup and fails with `storage_unavailable` on older Node.

**Lint and format**: no ESLint, no Prettier, no EditorConfig in the repo root. Style is hand-kept. Lint equals `tsc --noEmit`.

**CI (`.github/workflows/`)**
- `verify.yml` (on `pull_request` and push to `main`): `ubuntu-latest`, Node 22 with npm cache, then `npm ci`, `npm run lint`, `typecheck`, `typecheck:tests`, `build`, `test`, `npm pack --dry-run`, `smoke:read-only` (a no-op unless `YOUTUBE_LIVE_SMOKE=1`). Separate `secrets` job runs `gitleaks/gitleaks-action@v2` with `fetch-depth: 0`. Top-level permissions are `contents: read`, `pull-requests: read`.
- `publish.yml`: `workflow_dispatch` only. First step fails while `package.json` has `"private": true`. Uses npm trusted publishing (OIDC, `id-token: write`), `npm publish --provenance --access public`. Inert by design (npm publish not approved). This file pins actions by full SHA, the others use `@v4` tags. Copy the SHA-pinning style.
- `mcpb.yml` (on tags `v*` and manual dispatch): two jobs.
  - `build`: checks the tag equals `package.json` version, runs `npm run build:mcpb`, attests provenance (`actions/attest-build-provenance`), uploads artifact, `gh release create || upload --clobber`.
  - `tarball`: `npm pack` to `.tarball-build/`, same attest and release steps. The tarball is the install artifact for `npx <github release tgz>`.

**Lint and format for instagram-mcp**: match this. `tsc --noEmit` plus vitest is enough. Add ESLint only if you want it new.

---

## 2. Write-safety: preflight, approve, execute

**Tool naming**: `youtube_preflight_<action>` (read and preview, returns an `OperationPreview`), then `youtube_approve({approvalId, confirm: true})` (one shared tool for every kind), then `youtube_<action>({...same fields, approvalId, confirm: true})`.

**Preflight** (`src/operations/service.ts`, `OperationService.preflight`)
1. `requireSelectedChannel(profile)`: fails with `channel_required` if profile id or channel id is missing.
2. `approvalId = randomUUID()`.
3. `desiredFingerprint = sha256(JSON.stringify(sortKeysRecursively(desired)))`. Canonical key order, so the same change always gives the same hash.
4. `currentFingerprint` comes from the domain: a hash of the freshly read provider state (for example `fingerprint(current)` in `creator-content.ts`).
5. `expiresAt = now + (expiresInMs ?? 5 * 60_000)`.
6. `reconciliation` defaults to `{tool: 'youtube_get_operation_status', ...}`. **Gotcha**: that tool is not registered in `src/mcp/server.ts`. Domains usually pass their own reconcile tool (for example `youtube_get_owned_video`, `youtube_list_subscriptions`). Do not copy the default.
7. Stored with `state: 'planned'` in the per-profile ledger.

**Stored shape** (`src/operations/store.ts`, `StoredOperation`): `approvalId`, `profile {id, channelId, ...}`, `kind` (string such as `video.upload`, `video.metadata.update`, `caption.upload`, `comment.reply`, `comment.moderation.set`, `comment.delete`), `targetId`, `desired`, `desiredFingerprint`, `currentFingerprint`, `expiresAt`, `state`, `reconciliation`.

**States** (`OperationState`): `planned`, `approved`, `running`, `succeeded`, `failed`, `unknown`, `cancelled`.

**Approve** (`OperationService.approve`, and `src/operations/approval.ts` wraps it)
1. Lookup by `approvalId` scoped to the active `profileId` and `channelId`. Mismatch gives `profile_mismatch`.
2. Reject if expired (`stale_preview`).
3. `confirm !== true` gives `approval_required`.
4. `store.approve` is a compare-and-set `planned -> approved` under the profile lock. A second approve or a consumed approval gives `approval_consumed`.
5. Returns the preview echoing `kind`, `targetId`, `desired`. The human sees the exact change here.

`approval.ts` comment: approving here never widens what execute accepts. Execute re-checks everything.

**Execute** (domain services, for example `creator-content.ts` `claim` and `requireApproved`)
1. `operations.requireApproved({approvalId, confirm, profileId, channelId})`: needs `confirm === true`; `planned` gives `approval_required`; anything other than `approved` gives `approval_consumed`; expiry checked again.
2. Context check: the domain requires `preview.kind === kind`, `preview.targetId === targetId`, and `preview.desiredFingerprint === fingerprint(desired)`. Otherwise `approval_required`.
3. Re-read provider state, recompute the fingerprint, and compare to the stored `currentFingerprint`. Mismatch gives `stale_preview` (the target changed since preview).
4. `store.claim`: atomic `approved -> running`. Second claim fails with `approval_consumed`. This is the single-use guarantee.
5. Provider call, wrapped in `providerOutcome`:
   - success: `succeeded`
   - `isDefinitiveRejection(error)` (definitive 4xx-style refusal): `failed`, rethrow safe error
   - anything else (timeouts, 5xx, network): `unknown`, throw `provider_outcome_unknown` with the reconciliation tool and operation id. The caller must reconcile before retrying.
6. Read-after-write: `retryWhileMissing` (backoff 500, 1000, 2000, 4000 ms) runs only while the just-created item is missing from list-by-id. An item owned by another channel is returned at once so the ownership check can reject it.

**Ledger concurrency and persistence** (`store.ts`)
- File: `<stateDir>/profiles/<profileId>/operations.json` (JSON array), dir 0700, file 0600.
- Write: temp file (`wx`, 0600), then `rename`. Atomic on POSIX.
- Lock: a lease row per profile in `<stateDir>/operation-locks.sqlite` (`operation_locks`: `profile_id` PK, `token`, `expires_at`, `owner_pid`). Acquire is `INSERT OR IGNORE`. A stale lease is stolen only if expired and `process.kill(pid, 0)` says the owner is dead. Defaults: 2 s wait, 30 s stale, 5 ms retry. Timeout gives `operation_store_busy` (retryable).
- Expired-plan pruning: `OperationStore.pruneExpired` exists but **has no callers** in `src/`. Dead code today. Decide whether instagram-mcp needs it.

**Gating for direct writes** (no preflight)
- Account actions (`youtube_subscribe`, `youtube_unsubscribe`, `youtube_rate_video`, `youtube_create_comment`) and local curation resets use `requireConfirmation(input)`, which needs a literal `confirm: true` (`confirmation_required` otherwise). Declared `destructiveHint: true`.
- `elevated` flags exist for public, scheduled or ban-author changes (`SetModerationStatusInput.elevated`, metadata publish intent).
- Downloads (`youtube_download_caption`) are read-only on YouTube, so no approval. Writes only to `<stateDir>/downloads/`, refuses overwrite, plain filename only.

**Bounded batches**
- `youtube_preflight_unsubscribe_many` plus `youtube_unsubscribe_many`: up to 100 items, one approval covers the whole list, per-item status `removed | already_gone | failed | unknown | not_attempted`, stops with a partial report when quota runs out. The `unknown` status tells the caller to reconcile with `youtube_list_subscriptions` before retrying.
- Curation can save and propose a finite queue but has **no apply tool** (vault decision D5, confirmed by absence in `server.ts`).

**Idempotency** (no client idempotency keys)
- Single-use approval plus `planned -> approved -> running -> terminal` state machine.
- Fingerprint match means a retried execute with the same approval is refused, not repeated.
- Takeout import dedupes with `INSERT OR IGNORE` on `watch_events.source_key` (primary key).
- Unsubscribe maps "already not subscribed" to `already_gone`, so retries converge.

---

## 3. Auth and token storage

**Two credential tiers**
- `YOUTUBE_API_KEY`: public reads only. Cannot authorise account actions (vault D2, confirmed: `apiKey` never reaches OAuth code).
- `YOUTUBE_OAUTH_CLIENT_SECRET_FILE`: absolute path to a Google Desktop OAuth client JSON (`installed.client_id`, optional `client_secret`). Read from disk on each refresh (`loadDesktopCredentials`). The file itself is never copied into state.

**Where tokens live**
- Plaintext JSON, not keychain, not encrypted.
- Path: `<YOUTUBE_MCP_STATE_DIR>/profiles/<profileId>/oauth-token.json` (or `<stateDir>/oauth-token.json` if no profile). Default state dir `~/.youtube-mcp`.
- Content: `{ refreshToken: string, scopes: string[] }`. Validated by `isStoredToken`.
- Write: dir 0700, temp file `wx` 0600, `rename`, then `chmod` 0600.
- Profile id is validated against `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` (path-traversal guard).

**Scopes**
- Login requests `youtube`, `youtube.force-ssl`, `yt-analytics.readonly`, with `access_type: 'offline'` and `prompt: 'consent'`.
- Capability map in `oauth.ts`: `youtube.read` (accepts readonly, force-ssl or youtube), `youtube.write` (force-ssl or youtube), `youtube.upload`, `analytics.read`. Each tool checks only what it needs. Matches vault D3, least privilege.

**Refresh logic**
- No in-process access-token cache. `getAccessToken(capability)` reads the token file, checks scope readiness (`reauthorization_required` if missing), then calls googleapis `getAccessToken()` with the stored refresh token.
- **No single-flight lock on refresh.** The only lock in the codebase is the operation-ledger lease. If instagram-mcp needs refresh single-flight, it must add it.

**Login flow** (`youtube-auth` subcommand)
- Starts a local HTTP callback server on `127.0.0.1:0`, random port, path `/oauth2/callback`.
- Generates a random UUID `state` and verifies it on callback (`authorization_failed` on mismatch or error).
- Opens the browser (`open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows), detached.
- Exchanges the code, writes the token, prints status JSON to stdout (no tokens in it).
- If the stored token already has all three scopes, returns status without re-auth.

**Keeping secrets out of logs**
- stdio mode: stdout is reserved for JSON-RPC. Diagnostics go to stderr, and only `error.message` and `error.action` are written (`src/index.ts`).
- `AppError.toJSON` serialises only safe fields. Provider errors pass through `toSafeError`, which maps them to codes and drops raw messages.
- `config.diagnostics()` reports presence only (`apiKey=configured|missing`), never values.
- There is no logger module, so there is nothing to scrub. Keep it that way: never log request bodies or token objects.
- `.gitignore` covers `.env`, `.env.*`, `secret.json`, `/.yt-mcp/`. `.env.example` is the only env file tracked.

---

## 4. Transports

**Selection** (`src/index.ts`)
- `--transport stdio` or `--transport http`. **No default**: missing `--transport` throws a usage error. This contradicts vault note D1, which says stdio is the default.
- `youtube-auth` is a separate subcommand.

**stdio** (`src/transports/stdio.ts`): five lines. `server.connect(new StdioServerTransport())`. One process, one server.

**HTTP** (`src/transports/http.ts`)
- Node `http.createServer`, not Express.
- Bind address hard-coded to `127.0.0.1` in `index.ts` (and as the default in `runHttp`). Not configurable from env.
- Port: `PORT` env, default 3000, validated 1 to 65535 (`parseHttpPort`).
- Path: `/mcp` only. Other paths return 404 JSON. Non-POST returns 405 with `Allow: POST`.
- **Stateless**: a fresh `McpServer` and a fresh `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request, both closed on response close.
- Errors: a thrown error before headers gives 500 with JSON-RPC error `-32603`, "Internal server error."
- **Authentication: none.** No bearer token, no Origin or Host check in our code. Loopback bind is the only access control. Any local process, and any browser page able to POST to localhost, can call every tool, including writes. The SDK transport's own Origin or DNS-rebinding checks were not verified in this sweep.
- For instagram-mcp: if you ship HTTP, add a bearer token check and an Origin allowlist, or keep HTTP out of scope.

**Client configs**: all use stdio (`command: npx`, `args: [-y, <tgz url>, --transport, stdio]`). The HTTP mode is local dev only (`dev:http`) and documented as "Optional: local HTTP" in the README.

---

## 5. Persistence

**Location**: `YOUTUBE_MCP_STATE_DIR` (default `~/.youtube-mcp`). Dirs 0700, files 0600, `chmod` after every write.

**SQLite via `node:sqlite`** (not better-sqlite3; the vault's D7 is stale)
- Wrapper: `src/sqlite/open-database.ts` (`openDatabase`, `DatabaseSync`). Busy timeout default 5000 ms. `transaction()` uses `BEGIN IMMEDIATE` by default. `pragma()` runs `PRAGMA ...`.
- `warning-filter.ts` suppresses the ExperimentalWarning for `node:sqlite`. Install before first load.
- Lazy load with `createRequire`, so the filter runs first. `assertSqliteAvailable()` runs at startup and reports `storage_unavailable`.

**Databases and tables**

| File | Table | Key columns |
| --- | --- | --- |
| `consumption.sqlite` | `watch_events` | `source_key` TEXT PK, `watched_at`, `video_id`, `channel_id`, `title`, `event_type`, `query`, `topic` |
| `consumption.sqlite` | `curation_policies` | `profile_id` PK, `allowed_sources`, retention |
| `consumption.sqlite` | `curation_candidates` | `profile_id`, `video_id`, source provenance |
| `consumption.sqlite` | `consumption_queues` | `queue_id` PK, `profile_id` |
| `operation-locks.sqlite` | `operation_locks` | `profile_id` PK, `token`, `expires_at` INTEGER, `owner_pid` INTEGER |

**JSON files**
- `profiles/<id>/operations.json`: the operation ledger (array). Not SQLite, on purpose: whole-file atomic rewrite under the lease.
- `profiles/<id>/oauth-token.json`: refresh token.
- Upload records: per-upload JSON in a per-profile uploads directory (`upload-store.ts`, `uploadDirectory()`). Fields: `uploadId`, `sessionUrl`, `fileSize`, `fileFingerprint`, `offset`, `metadataFingerprint`, `createdAt`, `lastStatus`.
- `downloads/`: caption downloads, plain filenames only.

**Migrations**: `CREATE TABLE IF NOT EXISTS` in the store constructors. One ad hoc migration: `PRAGMA table_info` then `ALTER TABLE ... ADD COLUMN owner_pid` if missing. There is no migration framework.

---

## 6. Scheduling and background jobs

- None. No cron, no timers, no workers, no daemon.
- The only timers are the lease retry loop (5 ms) and read-after-write backoff. Both are inline awaits.
- `OperationStore.pruneExpired` is the only sweep, and nothing calls it (see section 2).
- Scheduled publishing is a YouTube-side field (`publishAt`) set through the upload or metadata preflight. The server does not run a scheduler.
- Curation proposes queues; nothing applies them automatically.

---

## 7. Error model

**`AppError`** (`src/errors.ts`): `constructor(code, message, action, retryable, operationId?, reconciliation?, status?, reason?)`.
- `toJSON()` returns only `code`, `message`, `action`, `retryable`, and optional `operationId`, `reconciliation`, `status`, `reason`. The message is non-enumerable by default, so it is serialised explicitly.
- `action` is a human next step ("Preflight the operation again...", "Repeat the call with confirm: true...").

**Codes seen in code** (not exhaustive): `approval_required`, `approval_consumed`, `stale_preview`, `profile_mismatch`, `channel_required`, `invalid_profile`, `confirmation_required`, `provider_outcome_unknown`, `reauthorization_required`, `authorization_failed`, `oauth_configuration_invalid`, `provider_error`, `quota_exhausted` (Google 403 `quotaExceeded`), `storage_unavailable`, `operation_store_busy`, `operation_store_lease_lost`, `invalid_input`, `invalid_file`, `ownership_required`, `already_archived`.

**Return path** (`src/mcp/server.ts`, `resultOf` and `success`)
- Success: `content: [{type:'text', text: JSON.stringify(obj)}]` plus `structuredContent: obj`. Non-object results are wrapped as `{items: value}`.
- Failure: `toSafeError(error)` (maps any thrown value to an `AppError`), then `{content: [{type:'text', text: JSON.stringify(safe)}], isError: true}`. The JSON in `text` is the only error channel, so clients parse it.
- Tool handlers never throw to the SDK. Every handler is wrapped in `resultOf`.

---

## 8. Tool registration conventions

**Where**: one function, `createMcpServer(dependencies)` in `src/mcp/server.ts`, 79 `server.registerTool(...)` calls. Dependencies are passed as `Pick<Service, ...>` types, so tests stub only what a tool needs.

**Naming**: `youtube_<noun>_<verb>` or `youtube_<verb>_<noun>`, snake_case. Preflight tools are `youtube_preflight_<verb>`. Approval is `youtube_approve` (one tool). Reads have no prefix convention beyond `youtube_list_*` and `youtube_get_*`.

**Annotations** (three helpers, no others):
- `readTool(desc, schema)`: `annotations: { readOnlyHint: true }`
- `writeTool(desc, schema)`: `annotations: { destructiveHint: true }` (used for preflights too)
- `downloadTool(desc, schema)`: `annotations: { destructiveHint: false }`
- Not used: `idempotentHint`, `openWorldHint`, `title`.
- Caveat: preflight tools are `writeTool` (destructive) even though they do not mutate. Keep that, or refine it deliberately.

**Schemas**: zod 4 (`import { z } from 'zod'`) in `src/mcp/schemas.ts`.
- Shared primitives: `id = z.string().min(1)`, `date` (regex `YYYY-MM-DD`), `rfc3339` (`z.string().datetime({offset: true, message})`), `maxResults = z.number().int().min(1).max(50).optional()`.
- Reusable shapes: `pageSchema = maxResults + pageToken`, `dateRange`, and `uploadFields` / `metadataFields` spread into the preflight and execute schemas.
- Execute schemas are preflight fields plus `approvalId: id` and `confirm: z.boolean().optional()`.
- Cross-field rules use `.refine(...)` (for example `videoCategoriesSchema`: exactly one of `regionCode` or `id`).
- Zod objects are not `.strict()` (0 uses). Unknown keys are stripped.
- Descriptions carry real operational facts: quota cost, reversibility, and "requires approval", written for the model.

**Output**: `structuredContent` for object results plus JSON text in `content`. Both must stay in sync. Clients can read either.

---

## 9. Testing

**Runner**: vitest 4, `environment: node`, `include: tests/**/*.test.ts`, `setupFiles: tests/setup.ts`. Tests import `src` directly.

**Counts**: vault says 202 tests in Oct 27 and 380 offline tests after v0.3.0. A quick grep counted about 305 `it(`/`test(` call sites, so the figure is approximate. Run `npm test` for the real count.

**Layout** (`tests/`)
- `auth/`, `config.test.ts`, `errors.test.ts`, `mcp/server.test.ts` (tool registration), `operations/{approval,service,store}.test.ts`, `sqlite/`, `transports/{stdio,http}.test.ts`, `youtube/*.test.ts` (one per domain), `consumption/*.test.ts`.
- `configs/*.test.ts`: packaging and config contract tests. These enforce the rules in AGENTS.md: one entrypoint per config, only five env vars, no `${` in Codex config, version bumped in every file, tarball URL matches version, the packaged artifact actually executes. Good model for instagram-mcp's "config drift" tests.
- `e2e/read-only-smoke.test.ts`.
- `fixtures/takeout/` (synthetic watch and search history in HTML and JSON).
- `helpers/youtube-api.ts`: `testYouTubeApi(overrides)` returns a fake of the googleapis resource surface (`search`, `videos`, `channels`, `commentThreads`, and so on) with empty defaults. Tests override only what they need.
- `setup.ts`: `setReadAfterWriteSleep(async () => undefined)` so backoff is instant.

**Rules**: tests are fully offline (AGENTS.md). "Tests never make a live mutation."

**Live E2E**: `scripts/live-e2e.mjs`
- Opt-in: `YOUTUBE_LIVE_E2E=1`. Guard: `YOUTUBE_E2E_CONFIRM_CHANNEL` must equal both `youtube_my_account` id and `YOUTUBE_MCP_CHANNEL_ID`, so it cannot run against the wrong channel.
- Drives the real stdio server through the MCP SDK `Client` and `StdioClientTransport`.
- Groups selectable by `YOUTUBE_E2E_GROUPS`. Optional inputs skip, not fail.
- Result statuses: `PASS`, `PASS-GUARD` (correct refusal because a precondition cannot be produced), `BLOCKED` (account-level refusal), `SKIPPED`, `FAIL`.
- Quota: about 5,900 units per full run out of 10,000/day (vault note). Uses ffmpeg to generate a test video.
- Writes a report to `YOUTUBE_E2E_OUT_DIR`.
- Also `scripts/read-only-smoke.mjs` (one search call, opt-in via `YOUTUBE_LIVE_SMOKE=1`; runs in CI as a no-op) and `scripts/private-playlist-smoke.mjs`.

**Separate code-blind test repo**: **none found for youtube-mcp**. No references in the repo, `AGENTS.md`, `docs/`, or the `CodeBase/` folder. The vault spec `Specs/2026-10-24 - Blind validator test repo.md` describes a *Capsule Corp* harness (validator container, `--network=none`, results-only flow), not youtube-mcp. If instagram-mcp wants blind tests, that spec is the reference, and youtube-mcp does not provide it.

---

## 10. Docs, release, licence

**README.md** (about 25 KB), headings in order: Quick start (4 steps), What it can do (Read without account, Read with OAuth, Write with preflight, Private viewing), Safety model, Requirements, Install in your AI agent (per client: Claude Code, Claude Desktop, Codex CLI, Gemini CLI, Antigravity, Cursor, VS Code, Windsurf, Cline, Zed, goose, Other agents), Account and creator tools: authorize once, Google credentials (create, env vars), Run from a local checkout, Optional: local HTTP, Example prompts. Badges: licence, Node version, MCP server.

**docs/**
- `SETUP.md` (about 16 KB): beginner guide, 14 numbered sections: what you get, Google Cloud project, enable APIs, API key, OAuth consent, desktop client, channel ID, sign in, put values into agent, check it works, limits, troubleshooting, production, security notes. Style: numbered steps, exact button labels, a copy-paste env file block with `chmod 600`.
- `CHANGELOG.md`: Keep a Changelog 1.1.0. `[Unreleased]`, then versioned entries with a **Breaking changes** paragraph first, then `### Added` and other sections. Tool counts stated in the entry.
- `README.md` (docs): developer-facing overview.
- `PHASE-2-HANDOFF.md`: planning handoff (internal).
- `superpowers/specs` and `superpowers/plans`: design specs and implementation plans (internal planning, dated filenames `YYYY-MM-DD-topic-design.md`).

**Root docs**
- `AGENTS.md`: two audiences. Part 1 is an install playbook for an AI agent installing the server for a user (canonical launch, env table, steps, which config file per client, safety rules). Part 2 is repo rules for agents changing the repo. Strong pattern: write it for the agent.
- `SECURITY.md`: private vulnerability reporting, enabled on GitHub.
- `llms-install.md`: short install guide for LLM-driven setup.
- `LICENSE`: MIT, "Copyright (c) 2026 Pratik Ghose".
- `SKILL.md`: unfilled template (see section 1).

**Release process**
- Version bump in five places: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`plugins[0].version`), `gemini-extension.json`, `mcpb/manifest.json`. Plus `docs/CHANGELOG.md`. Plus every `npx` spec URL (configs, README, `.mcp.json`, `gemini-extension.json`) with the `vX.Y.Z` tag and `youtube-mcp-X.Y.Z.tgz` filename. Enforced by `tests/configs/packaging.test.ts`.
- Tag `vX.Y.Z` triggers `mcpb.yml`: builds `.mcpb` and the npm tarball, checks tag equals version, attests, attaches both to the GitHub Release.
- No npm publish. Users run `npx -y https://github.com/.../youtube-mcp-X.Y.Z.tgz --transport stdio`. `publish.yml` is present but inert.
- Tags: the local dev clone has **no tags** (`git tag` returned nothing). Per the vault, `v0.3.0` exists on the public repo. Check there before relying on it.
- Cold `npx` start is about 6 s on the tarball, about 70 to 80 s from `github:`. Claude Code's 30 s MCP connect timeout is shorter than the cold `github:` start, so the README asks users to prewarm. Prefer the tarball URL.

---

## Vault drift (corrected by code)

| Vault claim | Reality in code |
| --- | --- |
| D1: stdio is the default transport | `src/index.ts` throws usage without `--transport`. No default. |
| D7: SQLite via better-sqlite3 | `node:sqlite` (built in, Node 22.13+). No native deps. |
| D8: proprietary licence | Superseded: MIT on both repos (vault note updated 2026-10-28). |
| Architecture mention of 202 or 380 tests | Count depends on snapshot. Run `npm test`. |
| `youtube_get_operation_status` as reconcile default | Referenced in `service.ts`, not registered as a tool. |

## Gotchas to avoid in instagram-mcp

1. Do not copy the `youtube_get_operation_status` default reconciliation tool without registering it.
2. Do not assume refresh single-flight exists. It does not. Add it if access tokens can race.
3. Do not ship HTTP without auth. The loopback bind is the only control.
4. `pruneExpired` is dead code. Wire it or drop it.
5. Preflight tools are annotated `destructiveHint: true`. Decide whether that is what you want.
6. `SKILL.md` is a template placeholder. Fill it or delete it.
