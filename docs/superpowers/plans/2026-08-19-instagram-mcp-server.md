# Instagram MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, policy-gated TypeScript MCP server for official Instagram publishing, owned-comment management, and analytics.

**Architecture:** A strict configuration and policy layer wraps an Instagram Graph API client. Tool handlers validate Zod input, enforce account/confirmation controls, then delegate to typed read, comment, or publish services. A resumable publish service owns the container lifecycle and in-memory idempotency state.

**Tech Stack:** Node.js 22+, TypeScript ESM, `@modelcontextprotocol/sdk`, Zod, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-19-instagram-mcp-design.md`

## Global Constraints

- Use only `graph.instagram.com` official Instagram API endpoints.
- Support only allowlisted Professional accounts via `INSTAGRAM_ACCOUNT_IDS`.
- Do not implement post likes, saves, shares, follows/unfollows, follower identity access, Highlights, scraping, private APIs, or browser automation.
- All writes require `confirm: true`; publication also requires `publish_intent: "public"` and a 16-character idempotency key.
- Never log or return access tokens. Retry GET requests on 429/5xx; never automatically retry write requests.

---

### Task 1: Project and configuration foundation

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `src/config.ts`
- Create: `src/errors.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces `loadConfig(env): InstagramMcpConfig` and `InstagramError` consumed by all remaining tasks.

- [ ] **Step 1: Write failing configuration tests**

```ts
test('loads a normalized allowlist from environment', () => {
  const config = loadConfig({ INSTAGRAM_ACCOUNT_IDS: '1, 2', INSTAGRAM_ACCESS_TOKEN: 'secret' });
  assert.deepEqual(config.accountIds, new Set(['1', '2']));
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- test/config.test.ts`
Expected: FAIL because project test setup and `loadConfig` do not exist.

- [ ] **Step 3: Implement the minimal strict ESM project and config parser**

```ts
export function loadConfig(env: NodeJS.ProcessEnv): InstagramMcpConfig {
  const accountIds = new Set((env.INSTAGRAM_ACCOUNT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  if (!accountIds.size || !env.INSTAGRAM_ACCESS_TOKEN) throw new InstagramError('INVALID_INPUT', 'Instagram configuration is incomplete');
  return { accountIds, accessToken: env.INSTAGRAM_ACCESS_TOKEN, apiBaseUrl: env.INSTAGRAM_API_BASE_URL ?? 'https://graph.instagram.com', apiVersion: env.INSTAGRAM_API_VERSION ?? 'v25.0' };
}
```

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`
Expected: PASS.

### Task 2: Token isolation and resilient Graph client

**Files:**
- Create: `src/token-provider.ts`
- Create: `src/graph-client.ts`
- Test: `test/graph-client.test.ts`

**Interfaces:**
- Consumes `InstagramMcpConfig`, `InstagramError`.
- Produces `TokenProvider`, `StaticTokenProvider`, and `InstagramGraphClient.request<T>()`.

- [ ] **Step 1: Write failing retry and write-safety tests**

```ts
test('retries a GET after a rate limit response', async () => {
  const fetch = sequenceFetch([response(429, {}, { 'retry-after': '0' }), response(200, { data: [] })]);
  const client = clientFor(fetch);
  assert.deepEqual(await client.get('/123/media'), { data: [] });
  assert.equal(fetch.calls, 2);
});

test('does not retry a POST after a transient failure', async () => {
  const fetch = sequenceFetch([response(500, { error: { message: 'temporary' } })]);
  await assert.rejects(clientFor(fetch).post('/123/media', {}));
  assert.equal(fetch.calls, 1);
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npm test -- test/graph-client.test.ts`
Expected: FAIL because `InstagramGraphClient` does not exist.

- [ ] **Step 3: Implement request construction, redacted errors, and bounded GET retry**

```ts
async get<T>(path: string, query?: Record<string, string>): Promise<T> {
  return this.request<T>('GET', path, query);
}

async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return this.request<T>('POST', path, undefined, body);
}
```

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`
Expected: PASS with GET retried and POST called once.

### Task 3: Policy gate and publish service

**Files:**
- Create: `src/policy.ts`
- Create: `src/publish-service.ts`
- Test: `test/publish-service.test.ts`

**Interfaces:**
- Consumes `InstagramGraphClient`, `InstagramMcpConfig`, `InstagramError`.
- Produces `assertAllowedAccount()`, `assertConfirmedWrite()`, and `PublishService.publish(input)`.

- [ ] **Step 1: Write failing policy/idempotency tests**

```ts
test('rejects a publish without explicit confirmation', async () => {
  await assert.rejects(service.publish(validInput({ confirm: false })), { code: 'MISSING_CONFIRMATION' });
});

test('returns the original result for a repeated successful idempotency key', async () => {
  const first = await service.publish(validInput());
  const second = await service.publish(validInput());
  assert.deepEqual(second, first);
  assert.equal(graph.publishCalls, 1);
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npm test -- test/publish-service.test.ts`
Expected: FAIL because `PublishService` does not exist.

- [ ] **Step 3: Implement container creation, bounded status polling, one publish call, and in-memory idempotency**

```ts
const creation = await this.graph.post<{ id: string }>(`/${input.account_id}/media`, containerBody);
await this.waitUntilFinished(creation.id);
const result = await this.graph.post<{ id: string }>(`/${input.account_id}/media_publish`, { creation_id: creation.id });
this.completed.set(input.idempotency_key, result);
```

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`
Expected: PASS; no write is replayed after an ambiguous failure.

### Task 4: Tool schemas and read/write handlers

**Files:**
- Create: `src/schemas.ts`
- Create: `src/tool-handlers.ts`
- Test: `test/tool-handlers.test.ts`

**Interfaces:**
- Consumes `InstagramGraphClient`, `PublishService`, policy helpers.
- Produces `createToolHandlers(deps)` with handlers for analytics, media, comments, status, publishing, comment reply, and moderation.

- [ ] **Step 1: Write failing handler tests**

```ts
test('analytics calls the media insights endpoint for a media target', async () => {
  await handlers.instagram_get_analytics({ account_id: '1', target: 'media', media_id: '9', metrics: ['reach'] });
  assert.equal(graph.lastPath, '/9/insights');
});

test('comment reply requires confirmation', async () => {
  await assert.rejects(handlers.instagram_reply_to_comment({ account_id: '1', comment_id: '2', message: 'Thanks', confirm: false }));
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npm test -- test/tool-handlers.test.ts`
Expected: FAIL because handler factory does not exist.

- [ ] **Step 3: Implement Zod schemas and narrow endpoint adapters**

```ts
async instagram_reply_to_comment(input: ReplyInput) {
  assertConfirmedWrite(input.confirm);
  return graph.post(`/${input.comment_id}/replies`, { message: input.message });
}
```

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`
Expected: PASS.

### Task 5: MCP server wiring and operator documentation

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Create: `README.md`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes `createToolHandlers`, schemas, and MCP SDK.
- Produces `createServer(deps)` and an executable stdio entrypoint.

- [ ] **Step 1: Write a failing tool-registration test**

```ts
test('registers only approved tools', async () => {
  const server = createServer(deps);
  const tools = await listTools(server);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['instagram_get_analytics', 'instagram_get_publish_status', 'instagram_list_comments', 'instagram_list_media', 'instagram_moderate_comment', 'instagram_publish_post', 'instagram_reply_to_comment']);
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npm test -- test/server.test.ts`
Expected: FAIL because the MCP server factory does not exist.

- [ ] **Step 3: Register tools with JSON schemas and annotations; document local configuration**

```ts
server.registerTool('instagram_get_analytics', {
  description: 'Read account or media insights.',
  inputSchema: analyticsInput.shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (input) => jsonResult(await handlers.instagram_get_analytics(input)));
```

- [ ] **Step 4: Run verification suite**

Run: `npm run check && npm test && npm run build`
Expected: strict type-check, all tests, and ESM build PASS.
