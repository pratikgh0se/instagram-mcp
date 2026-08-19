import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyticsToolInput, listCommentsInput, listMediaInput, moderationInput, publishInput, replyInput } from './schemas.js';
import { createToolHandlers } from './tool-handlers.js';

type Handlers = ReturnType<typeof createToolHandlers>;
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

export function createServer(handlers: Handlers): McpServer {
  const server = new McpServer({ name: 'instagram-mcp', version: '0.1.0' });
  server.registerTool('instagram_get_analytics', { description: 'Read account or media insights.', inputSchema: analyticsToolInput.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async (input) => result(await handlers.instagram_get_analytics(input)));
  server.registerTool('instagram_list_media', { description: 'List media owned by the authorized account.', inputSchema: listMediaInput.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async (input) => result(await handlers.instagram_list_media(input)));
  server.registerTool('instagram_list_comments', { description: 'List comments on owned media.', inputSchema: listCommentsInput.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async (input) => result(await handlers.instagram_list_comments(input)));
  server.registerTool('instagram_get_publish_status', { description: 'Read an asynchronous media container status.', inputSchema: { account_id: listMediaInput.shape.account_id, creation_id: listCommentsInput.shape.media_id }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, async (input) => result(await handlers.instagram_get_publish_status(input)));
  server.registerTool('instagram_publish_post', { description: 'Publish approved media. Requires explicit confirmation.', inputSchema: publishInput.shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async (input) => result(await handlers.instagram_publish_post(input)));
  server.registerTool('instagram_reply_to_comment', { description: 'Reply publicly to a comment on owned media. Requires confirmation.', inputSchema: replyInput.shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, async (input) => result(await handlers.instagram_reply_to_comment(input)));
  server.registerTool('instagram_moderate_comment', { description: 'Hide, unhide, or delete a comment. Requires confirmation.', inputSchema: moderationInput.shape, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, async (input) => result(await handlers.instagram_moderate_comment(input)));
  return server;
}
