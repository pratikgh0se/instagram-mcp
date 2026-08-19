import assert from 'node:assert/strict';
import test from 'node:test';

import { PublishService } from '../src/publish-service.js';

class FakeGraph {
  publishCalls = 0;
  async post<T>(path: string): Promise<T> {
    if (path.endsWith('/media')) return { id: 'creation-1' } as T;
    this.publishCalls += 1;
    return { id: 'media-1' } as T;
  }
  async get<T>(): Promise<T> { return { status_code: 'FINISHED' } as T; }
}

const validInput = (overrides = {}) => ({
  account_id: '1', media_kind: 'image' as const,
  assets: [{ url: 'https://cdn.example.test/image.jpg', media_type: 'image' as const }],
  caption: 'Hello', publish_intent: 'public' as const, confirm: true,
  idempotency_key: '1234567890123456', ...overrides
});

test('rejects a publish without explicit confirmation', async () => {
  const service = new PublishService(new FakeGraph() as never, new Set(['1']), async () => undefined);
  await assert.rejects(service.publish(validInput({ confirm: false })), { code: 'MISSING_CONFIRMATION' });
});

test('returns the original result for a repeated successful idempotency key', async () => {
  const graph = new FakeGraph();
  const service = new PublishService(graph as never, new Set(['1']), async () => undefined);
  const first = await service.publish(validInput());
  const second = await service.publish(validInput());
  assert.deepEqual(second, first);
  assert.equal(graph.publishCalls, 1);
});
