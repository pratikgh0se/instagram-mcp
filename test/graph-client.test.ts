import assert from 'node:assert/strict';
import test from 'node:test';

import { InstagramGraphClient } from '../src/graph-client.js';
import { StaticTokenProvider } from '../src/token-provider.js';

type ResponseSpec = { status: number; body: unknown; headers?: Record<string, string> };

function response(spec: ResponseSpec): Response {
  return new Response(JSON.stringify(spec.body), { status: spec.status, headers: spec.headers });
}

function sequenceFetch(specs: ResponseSpec[]) {
  let calls = 0;
  const fetch = async (): Promise<Response> => response(specs[calls++]!);
  return { fetch: fetch as typeof globalThis.fetch, get calls() { return calls; } };
}

function clientFor(mock: ReturnType<typeof sequenceFetch>) {
  return new InstagramGraphClient({
    apiBaseUrl: 'https://graph.instagram.com',
    apiVersion: 'v25.0',
    tokenProvider: new StaticTokenProvider('secret-token'),
    fetch: mock.fetch,
    sleep: async () => undefined,
    maxReadAttempts: 2
  });
}

test('retries a GET after a rate-limit response', async () => {
  const mock = sequenceFetch([
    { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } },
    { status: 200, body: { data: [] } }
  ]);

  assert.deepEqual(await clientFor(mock).get('/123/media'), { data: [] });
  assert.equal(mock.calls, 2);
});

test('does not retry a POST after a transient failure', async () => {
  const mock = sequenceFetch([{ status: 500, body: { error: { message: 'temporary' } } }]);

  await assert.rejects(clientFor(mock).post('/123/media', { image_url: 'https://example.test/a.jpg' }));
  assert.equal(mock.calls, 1);
});

test('does not place the access token in an upstream error message', async () => {
  const mock = sequenceFetch([{ status: 400, body: { error: { message: 'bad request' } } }]);

  await assert.rejects(clientFor(mock).get('/123'), (error: unknown) => {
    assert.equal(String(error).includes('secret-token'), false);
    return true;
  });
});
