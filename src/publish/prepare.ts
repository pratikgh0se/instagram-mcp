import type { AppContext } from '../context.js';
import type { ResolvedAccount } from '../config/index.js';
import { AppError } from '../errors.js';
import type { GraphClient } from '../graph/client.js';
import { requireCapability } from '../graph/capabilities.js';
import { parseTimestamp } from '../tools/shared.js';
import { resolveLocalMedia } from './localmedia.js';
import { mediaRoute, usesBranding } from './plan.js';
import type { CoverParam, Kind, MediaParam, MediaType, PublishParams, UserTag } from './types.js';
import {
  assertPublicUrl, headRemote, inspectLocalFile, maxBytes, typeFromContentType, typeFromExtension, verifyRemoteMedia
} from './validate.js';

/** Raw (schema-validated) input of instagram_preflight_publish. */
export interface PublishInput {
  kind: Kind;
  media: Array<{ url?: string; path?: string; type?: MediaType; alt_text?: string; user_tags?: UserTag[] }>;
  caption?: string;
  location_id?: string;
  collaborators?: string[];
  user_tags?: UserTag[];
  cover?: { url?: string; path?: string };
  thumb_offset_ms?: number;
  share_to_feed?: boolean;
  audio_name?: string;
  trial_reel?: { graduation_strategy: 'MANUAL' | 'SS_PERFORMANCE' };
  is_paid_partnership?: boolean;
  branded_content_sponsor_ids?: string[];
  is_ai_generated?: boolean;
  publish_at?: string;
}

const invalid = (message: string, fields?: string[]): AppError =>
  new AppError('INVALID_INPUT', message, { details: fields ? { fields } : undefined, action: 'Fix the input and run instagram_preflight_publish again.' });

/** Applicability matrix and shape rules (contract 2.3); step 6, no network. */
function checkShape(input: PublishInput): void {
  const { kind } = input;
  const bad: string[] = [];
  const count = input.media.length;
  if (kind === 'carousel' ? count < 2 || count > 20 : count !== 1) {
    throw invalid(kind === 'carousel' ? 'A carousel needs 2 to 20 media items.' : `kind "${kind}" needs exactly 1 media item.`, ['media']);
  }
  input.media.forEach((m, i) => {
    if (Boolean(m.url) === Boolean(m.path)) bad.push(`media[${i}]`);
  });
  if (bad.length) throw invalid('Each media item needs exactly one of url or path.', bad);

  const only = (fields: Array<[string, unknown]>, allowed: boolean, text: string): void => {
    const hit = fields.filter(([, v]) => v !== undefined).map(([k]) => k);
    if (hit.length && !allowed) throw invalid(`${hit.join(', ')} ${text}`, hit);
  };
  only([['caption', input.caption], ['location_id', input.location_id], ['collaborators', input.collaborators]], kind !== 'story', 'not allowed for stories.');
  only([['cover', input.cover], ['thumb_offset_ms', input.thumb_offset_ms], ['share_to_feed', input.share_to_feed], ['audio_name', input.audio_name], ['trial_reel', input.trial_reel]], kind === 'reel', 'only apply to kind "reel".');
  only([['is_paid_partnership', input.is_paid_partnership], ['branded_content_sponsor_ids', input.branded_content_sponsor_ids], ['is_ai_generated', input.is_ai_generated]], kind !== 'story', 'not allowed for stories.');
  if (kind !== 'image' && input.media.some((m) => m.alt_text !== undefined)) {
    throw invalid('alt_text is only supported for kind "image".', input.media.flatMap((m, i) => (m.alt_text !== undefined ? [`media[${i}].alt_text`] : [])));
  }
  if (input.user_tags) {
    if (kind === 'carousel') throw invalid('For a carousel, set user_tags per media item (media[i].user_tags).', ['user_tags']);
    if (input.media[0]!.user_tags) throw invalid('Give user_tags either at the top level or on media[0], not both.', ['user_tags', 'media[0].user_tags']);
  }
  if (input.cover && Boolean(input.cover.url) === Boolean(input.cover.path)) throw invalid('cover needs exactly one of url or path.', ['cover']);
  if (input.caption) {
    const hashtags = (input.caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
    const mentions = (input.caption.match(/@[A-Za-z0-9._]+/g) ?? []).length;
    if (hashtags > 30) throw invalid(`caption has ${hashtags} hashtags; the limit is 30.`, ['caption']);
    if (mentions > 20) throw invalid(`caption has ${mentions} @-mentions; the limit is 20.`, ['caption']);
  }
}

function checkKindType(kind: Kind, type: MediaType, index: number): void {
  if (kind === 'image' && type !== 'image') throw invalid('kind "image" needs an image (JPEG).', [`media[${index}]`]);
  if (kind === 'reel' && type !== 'video') throw invalid('kind "reel" needs a video.', [`media[${index}]`]);
}

function checkUserTags(tags: UserTag[] | undefined, type: MediaType, kind: Kind, field: string): void {
  if (tags && type === 'image' && kind !== 'story' && tags.some((t) => t.x === undefined || t.y === undefined)) {
    throw invalid('Each user tag on an image needs both x and y.', [field]);
  }
}

export interface PreparedPublish {
  params: PublishParams;
  warnings: string[];
  media: Array<{ bytes: number | null; content_type: string | null }>;
}

/**
 * Normalise and validate a publish request. Throws INVALID_INPUT / MEDIA_HOST_UNAVAILABLE.
 * Network use: none by default. With policy.verify_remote_media: pinned DNS + one HEAD per remote media/cover, in order.
 */
export async function preparePublish(ctx: AppContext, account: ResolvedAccount, input: PublishInput): Promise<PreparedPublish> {
  checkShape(input);
  const { kind } = input;
  if (usesBranding(toLooseParams(input))) requireCapability(ctx, account, 'branded_content');

  let publishAt: string | undefined;
  let containerAt: string | undefined;
  if (input.publish_at !== undefined) {
    const when = parseTimestamp(input.publish_at, 'publish_at');
    if (when.getTime() <= ctx.clock.nowMs()) throw invalid('publish_at must be later than now.', ['publish_at']);
    publishAt = when.toISOString();
    const lead = ctx.config.scheduler.container_lead_minutes * 60_000;
    containerAt = new Date(Math.max(ctx.clock.nowMs(), when.getTime() - lead)).toISOString();
  }

  const verify = verifyRemoteMedia(ctx);
  const warnings: string[] = [];
  const media: MediaParam[] = [];
  const pending: Array<{ index: number; type: MediaType | undefined }> = [];

  // Pass 1 (no HTTP): types, local files, URL rules.
  for (let i = 0; i < input.media.length; i++) {
    const m = input.media[i]!;
    const userTags = i === 0 && input.user_tags ? input.user_tags : m.user_tags;
    const base = { ...(m.alt_text !== undefined ? { alt_text: m.alt_text } : {}), ...(userTags ? { user_tags: userTags } : {}) };
    if (m.path) {
      const loc = await resolveLocalMedia(ctx, m.path);
      const path = loc.path;
      const type = m.type ?? typeFromExtension(path);
      if (!type) throw invalid(`Cannot tell whether media[${i}] is an image or a video; pass type.`, [`media[${i}].type`]);
      checkKindType(kind, type, i);
      checkUserTags(userTags, type, kind, `media[${i}].user_tags`);
      const info = await inspectLocalFile(loc.real_path, { kind, type });
      warnings.push(...info.warnings);
      media.push({ source: 'local', url: null, path, real_path: loc.real_path, type, size: info.size, sha256: info.sha256, content_type: info.content_type, ...base });
      pending.push({ index: i, type });
    } else {
      await assertPublicUrl(m.url!, process.env, `media[${i}].url`);
      const type = m.type ?? typeFromExtension(new URL(m.url!).pathname);
      if (!type && !verify) throw invalid(`Cannot tell whether media[${i}] is an image or a video; pass type.`, [`media[${i}].type`]);
      if (type) {
        checkKindType(kind, type, i);
        checkUserTags(userTags, type, kind, `media[${i}].user_tags`);
      }
      media.push({ source: 'url', url: m.url!, path: null, type: type ?? 'image', size: null, sha256: null, content_type: null, ...base });
      pending.push({ index: i, type });
    }
  }
  let cover: CoverParam | undefined;
  let coverRemote: string | undefined;
  if (input.cover) {
    if (input.cover.path) {
      const loc = await resolveLocalMedia(ctx, input.cover.path);
      const info = await inspectLocalFile(loc.real_path, { kind: 'cover', type: 'image' });
      cover = { source: 'local', url: null, path: loc.path, real_path: loc.real_path, size: info.size, sha256: info.sha256, content_type: info.content_type };
    } else {
      await assertPublicUrl(input.cover.url!, process.env, 'cover.url');
      cover = { source: 'url', url: input.cover.url!, path: null, real_path: null, size: null, sha256: null, content_type: null };
      coverRemote = input.cover.url;
    }
  }

  const params: PublishParams = {
    kind,
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    ...(input.location_id !== undefined ? { location_id: input.location_id } : {}),
    ...(input.collaborators?.length ? { collaborators: input.collaborators } : {}),
    ...(cover ? { cover } : {}),
    ...(input.thumb_offset_ms !== undefined ? { thumb_offset_ms: input.thumb_offset_ms } : {}),
    ...(input.share_to_feed !== undefined ? { share_to_feed: input.share_to_feed } : {}),
    ...(input.audio_name !== undefined ? { audio_name: input.audio_name } : {}),
    ...(input.trial_reel ? { trial_reel: input.trial_reel } : {}),
    ...(input.is_paid_partnership !== undefined ? { is_paid_partnership: input.is_paid_partnership } : {}),
    ...(input.branded_content_sponsor_ids?.length ? { branded_content_sponsor_ids: input.branded_content_sponsor_ids } : {}),
    ...(input.is_ai_generated !== undefined ? { is_ai_generated: input.is_ai_generated } : {}),
    ...(publishAt ? { publish_at: publishAt, container_create_at: containerAt } : {}),
    media
  };

  // Local files that need the public media host.
  const needsHost = media.some((m) => mediaRoute(account.login, m) === 'host') || cover?.source === 'local';
  if (needsHost && !ctx.config.media_host.public_base_url) {
    throw new AppError('MEDIA_HOST_UNAVAILABLE', 'A local file needs the media host, but media_host.public_base_url is not configured.', {
      action: 'Set media_host.public_base_url to the public HTTPS URL of a tunnel to the media host port, or pass public https URLs instead of local paths.'
    });
  }

  // Pass 2 (network): HEAD per remote media, then the cover.
  const facts: PreparedPublish['media'] = [];
  for (const { index, type } of pending) {
    const m = media[index]!;
    if (m.source === 'local') {
      facts.push({ bytes: m.size, content_type: m.content_type });
      continue;
    }
    if (!verify) {
      warnings.push(`MEDIA_UNVERIFIED: media[${index}] was not checked locally (policy.verify_remote_media is off); Instagram will fetch it at publish time.`);
      facts.push({ bytes: null, content_type: null });
      continue;
    }
    const head = await headRemote(m.url!, { type, limit: maxBytes(kind, type ?? 'video'), label: `media[${index}]` });
    if (!head.verified) warnings.push(`MEDIA_UNVERIFIED: could not verify media[${index}] with HEAD; Instagram will fetch it at publish time.`);
    let resolvedType = type;
    if (!resolvedType) {
      resolvedType = typeFromContentType(head.content_type);
      if (!resolvedType) throw invalid(`Cannot tell whether media[${index}] is an image or a video; pass type.`, [`media[${index}].type`]);
      checkKindType(kind, resolvedType, index);
      checkUserTags(m.user_tags, resolvedType, kind, `media[${index}].user_tags`);
      if (head.content_length !== null && head.content_length > maxBytes(kind, resolvedType)) {
        throw invalid(`media[${index}] is ${head.content_length} bytes; the limit is ${maxBytes(kind, resolvedType)} bytes.`, [`media[${index}]`]);
      }
      m.type = resolvedType;
    }
    facts.push({ bytes: head.content_length, content_type: head.content_type });
  }
  if (coverRemote && !verify) {
    warnings.push('MEDIA_UNVERIFIED: the cover image was not checked locally (policy.verify_remote_media is off); Instagram will fetch it at publish time.');
  } else if (coverRemote) {
    const head = await headRemote(coverRemote, { type: 'image', limit: maxBytes('cover', 'image'), label: 'cover' });
    if (!head.verified) warnings.push('MEDIA_UNVERIFIED: could not verify the cover image with HEAD.');
  }
  return { params, warnings, media: facts };
}

function toLooseParams(input: PublishInput): PublishParams {
  return { kind: input.kind, media: [], is_paid_partnership: input.is_paid_partnership, branded_content_sponsor_ids: input.branded_content_sponsor_ids };
}

/** Read the publishing quota. Throws PUBLISH_QUOTA_EXHAUSTED when used up; adds QUOTA_NEAR_LIMIT at >= 90 %. */
export async function checkQuota(graph: GraphClient, ig: string, warnings: string[]): Promise<{ used: number; total: number } | null> {
  const res = await graph.get<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(`/${ig}/content_publishing_limit`, { fields: 'quota_usage,config' });
  const first = res.data?.[0];
  const used = first?.quota_usage;
  const total = first?.config?.quota_total;
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) return null;
  if (used >= total) {
    throw new AppError('PUBLISH_QUOTA_EXHAUSTED', `The 24 h publishing quota is used up (${used}/${total}).`, {
      action: 'Wait for the quota window to reset (see instagram_get_rate_limits) or schedule the post for later.',
      details: { quota_usage: used, quota_total: total }
    });
  }
  if (used >= total * 0.9) warnings.push(`QUOTA_NEAR_LIMIT: ${used} of ${total} publishes used in the current window.`);
  return { used, total };
}
