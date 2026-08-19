import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolHandlers } from '../src/tool-handlers.js';

class FakeGraph {
  lastPath = '';
  async get<T>(path: string): Promise<T> { this.lastPath = path; return { data: [] } as T; }
  async post<T>(path: string): Promise<T> { this.lastPath = path; return { id: 'reply-1' } as T; }
  async delete<T>(path: string): Promise<T> { this.lastPath = path; return { success: true } as T; }
}

test('analytics selects the media insights endpoint', async () => {
  const graph = new FakeGraph();
  const handlers = createToolHandlers({ graph: graph as never, allowedAccountIds: new Set(['1']), publishService: {} as never });
  await handlers.instagram_get_analytics({ account_id: '1', target: 'media', media_id: '9', metrics: ['reach'] });
  assert.equal(graph.lastPath, '/9/insights');
});

test('comment reply requires confirmation', async () => {
  const handlers = createToolHandlers({ graph: new FakeGraph() as never, allowedAccountIds: new Set(['1']), publishService: {} as never });
  await assert.rejects(handlers.instagram_reply_to_comment({ account_id: '1', comment_id: '2', message: 'Thanks', confirm: false }), { code: 'MISSING_CONFIRMATION' });
});
