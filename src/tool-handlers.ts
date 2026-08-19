import type { InstagramGraphClient } from './graph-client.js';
import type { PublishService } from './publish-service.js';
import { assertAllowedAccount, assertConfirmedWrite } from './policy.js';
import { analyticsInput, listCommentsInput, listMediaInput, moderationInput, publishInput, replyInput } from './schemas.js';

export function createToolHandlers(deps: { graph: Pick<InstagramGraphClient, 'get' | 'post' | 'delete'>; allowedAccountIds: Set<string>; publishService: Pick<PublishService, 'publish'> }) {
  const check = (accountId: string) => assertAllowedAccount(accountId, deps.allowedAccountIds);
  return {
    async instagram_get_analytics(raw: unknown) {
      const input = analyticsInput.parse(raw); check(input.account_id);
      const path = input.target === 'media' ? `/${input.media_id}/insights` : `/${input.account_id}/insights`;
      return deps.graph.get(path, { metric: input.metrics.join(','), ...(input.period ? { period: input.period } : {}), ...(input.since ? { since: input.since } : {}), ...(input.until ? { until: input.until } : {}) });
    },
    async instagram_list_media(raw: unknown) { const input = listMediaInput.parse(raw); check(input.account_id); return deps.graph.get(`/${input.account_id}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp', ...(input.limit ? { limit: String(input.limit) } : {}) }); },
    async instagram_list_comments(raw: unknown) { const input = listCommentsInput.parse(raw); check(input.account_id); return deps.graph.get(`/${input.media_id}/comments`, { fields: 'id,text,username,timestamp,replies', ...(input.limit ? { limit: String(input.limit) } : {}) }); },
    async instagram_get_publish_status(raw: unknown) { const input = listCommentsInput.pick({ account_id: true }).extend({ creation_id: listCommentsInput.shape.media_id }).parse(raw); check(input.account_id); return deps.graph.get(`/${input.creation_id}`, { fields: 'status_code,status' }); },
    async instagram_publish_post(raw: unknown) { return deps.publishService.publish(publishInput.parse(raw)); },
    async instagram_reply_to_comment(raw: unknown) { const input = replyInput.parse(raw); check(input.account_id); assertConfirmedWrite(input.confirm); return deps.graph.post(`/${input.comment_id}/replies`, { message: input.message }); },
    async instagram_moderate_comment(raw: unknown) { const input = moderationInput.parse(raw); check(input.account_id); assertConfirmedWrite(input.confirm); return input.action === 'delete' ? deps.graph.delete(`/${input.comment_id}`) : deps.graph.post(`/${input.comment_id}`, { hide: input.action === 'hide' }); }
  };
}
