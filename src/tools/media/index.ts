import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { backupAccount, downloadMedia, MEDIA_LIST_FIELDS, upsertMediaIndex } from '../../archive/index.js';
import { accountParam, cursorParam, limitParam, parseTimestamp } from '../shared.js';
import { defineTool, LOCAL_WRITE, ok, READ_ONLY, type ToolAnnotations, type ToolDef } from '../types.js';

const mediaIdParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'media_id must match ^[A-Za-z0-9_-]{1,64}$').describe('Instagram media id.');

const LIST_KEYS = MEDIA_LIST_FIELDS.split(',');
const STORY_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url';
const STORY_KEYS = STORY_FIELDS.split(',');
const GET_FIELDS = `${MEDIA_LIST_FIELDS},is_shared_to_feed,shortcode,alt_text,username,children{id,media_type,media_url,thumbnail_url}`;

/** Local file writers that also fetch from Instagram (Graph + CDN): not read-only, open world. */
const LOCAL_WRITE_OPEN: ToolAnnotations = { ...LOCAL_WRITE, openWorldHint: true };

function pickKeys(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, src[k] ?? null]));
}

const listMedia = defineTool({
  name: 'instagram_list_media',
  title: 'List media',
  description:
    "List the account's own media (newest first) with caption, type, permalink, counts and URLs. Optional media_product_type filter (FEED|REELS|STORY|AD) is applied after each page is fetched, so a page may hold fewer than limit items while next_cursor is set. since/until are ISO 8601 or YYYY-MM-DD.",
  inputSchema: {
    account: accountParam,
    media_product_type: z.enum(['FEED', 'REELS', 'STORY', 'AD']).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: limitParam,
    cursor: cursorParam
  },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const since = input.since ? Math.floor(parseTimestamp(input.since, 'since').getTime() / 1000) : undefined;
    const until = input.until ? Math.floor(parseTimestamp(input.until, 'until').getTime() / 1000) : undefined;
    const account = ctx.account(input.account);
    const graph = ctx.graph(account);
    const igId = await graph.igUserId();
    const page = await graph.list<Record<string, unknown>>(
      `/${igId}/media`,
      { fields: MEDIA_LIST_FIELDS, since, until },
      { limit: input.limit ?? 25, cursor: input.cursor }
    );
    const all = page.data.map((m) => pickKeys(m, LIST_KEYS));
    upsertMediaIndex(ctx, account.alias, all as Array<{ id: string }>);
    const items = input.media_product_type ? all.filter((m) => m.media_product_type === input.media_product_type) : all;
    return ok({ items, next_cursor: page.next_cursor }, `${items.length} media item(s)${page.next_cursor ? ', more available' : ''}.`);
  }
});

const getMedia = defineTool({
  name: 'instagram_get_media',
  title: 'Get media',
  description: 'Details of one media item: caption, type, permalink, counts, URLs, shortcode, alt text, username and carousel children.',
  inputSchema: { account: accountParam, media_id: mediaIdParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const m = await ctx.graph(account).get<Record<string, unknown>>(`/${input.media_id}`, { fields: GET_FIELDS });
    const kids = (m.children as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
    const data: Record<string, unknown> = {
      ...pickKeys(m, [...LIST_KEYS, 'is_shared_to_feed', 'shortcode', 'alt_text', 'username']),
      children: kids.map((c) => pickKeys(c, ['id', 'media_type', 'media_url', 'thumbnail_url']))
    };
    return ok(data, `${String(data.media_product_type ?? data.media_type ?? 'media')} ${String(data.id ?? input.media_id)}.`);
  }
});

const listStories = defineTool({
  name: 'instagram_list_stories',
  title: 'List stories',
  description: "List the account's currently live stories (last 24 hours).",
  inputSchema: { account: accountParam, limit: limitParam, cursor: cursorParam },
  annotations: READ_ONLY,
  async handler(ctx, input) {
    const graph = ctx.graph(ctx.account(input.account));
    const igId = await graph.igUserId();
    const page = await graph.list<Record<string, unknown>>(`/${igId}/stories`, { fields: STORY_FIELDS }, { limit: input.limit ?? 25, cursor: input.cursor });
    const items = page.data.map((m) => pickKeys(m, STORY_KEYS));
    return ok({ items, next_cursor: page.next_cursor }, `${items.length} stor${items.length === 1 ? 'y' : 'ies'}.`);
  }
});

const downloadMediaTool = defineTool({
  name: 'instagram_download_media',
  title: 'Download media',
  description:
    'Save one of your media items (and carousel children, video thumbnails) to the local downloads directory with a JSON sidecar. Only Instagram CDN hosts are fetched, no credentials are sent, and existing files are skipped. Writes local files only.',
  inputSchema: {
    account: accountParam,
    media_id: mediaIdParam,
    include_children: z.boolean().optional().describe('Download carousel children (default true).'),
    include_thumbnail: z.boolean().optional().describe('Download video thumbnails (default true).')
  },
  annotations: LOCAL_WRITE_OPEN,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const r = await downloadMedia(ctx, account, input.media_id, { include_children: input.include_children, include_thumbnail: input.include_thumbnail });
    const fresh = r.files.filter((f) => !f.skipped).length;
    return ok({ ...r }, `Saved ${fresh} new file(s), ${r.files.length - fresh} already present, for media ${r.media_id}.`);
  }
});

const backupAccountTool = defineTool({
  name: 'instagram_backup_account',
  title: 'Back up account',
  description:
    "Incrementally download all of the account's media into the local downloads directory (skipping items already downloaded) and write insights-latest.json. max_items caps how many recent items are considered (default 500). Per-item failures do not abort the run.",
  inputSchema: {
    account: accountParam,
    max_items: z.number().int().min(1).max(10000).optional().describe('Maximum media items to consider (default 500).')
  },
  annotations: LOCAL_WRITE_OPEN,
  async handler(ctx, input) {
    const account = ctx.account(input.account);
    const r = await backupAccount(ctx, account, input.max_items ?? 500);
    return ok({ ...r }, `Backup of @${r.username}: ${r.downloaded} downloaded, ${r.skipped} skipped, ${r.failed} failed of ${r.total_seen}.`);
  }
});

/** Tools for the "media" domain (list/get media, stories, download, backup). */
export const tools: ToolDef[] = [listMedia, getMedia, listStories, downloadMediaTool, backupAccountTool];

/** Media owns no approval actions or background jobs. */
export function register(_ctx: AppContext): void {}
