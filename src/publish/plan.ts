import type { LoginPath } from '../config/index.js';
import { supportsRupload } from '../graph/rupload.js';
import type { PlannedCall } from '../safety/index.js';
import type { MediaParam, PublishParams } from './types.js';

/** How a media item reaches Instagram. */
export type Route = 'url' | 'host' | 'resumable';

export function mediaRoute(login: LoginPath, m: MediaParam): Route {
  if (m.source === 'url') return 'url';
  return m.type === 'video' && supportsRupload(login) ? 'resumable' : 'host';
}

/** Supplies the public URL for each media item (null = resumable upload, no URL) and the reel cover. */
export interface UrlResolver {
  media(index: number): string | null;
  cover(): string | undefined;
}

const json = (v: unknown): string => JSON.stringify(v);

function shared(p: PublishParams, body: Record<string, string>): void {
  if (p.caption !== undefined) body.caption = p.caption;
  if (p.location_id !== undefined) body.location_id = p.location_id;
  if (p.collaborators?.length) body.collaborators = json(p.collaborators);
  if (p.is_ai_generated !== undefined) body.is_ai_generated = String(p.is_ai_generated);
  if (p.is_paid_partnership !== undefined) body.is_paid_partnership = String(p.is_paid_partnership);
  if (p.branded_content_sponsor_ids?.length) body.branded_content_sponsor_ids = json(p.branded_content_sponsor_ids);
}

function mediaUrlParams(m: MediaParam, url: string | null, body: Record<string, string>): void {
  if (m.type === 'image') {
    body.image_url = url!;
  } else if (url === null) {
    body.upload_type = 'resumable';
  } else {
    body.video_url = url;
  }
}

/** Does this container request carry partnership parameters (capability `branded_content`)? */
export function usesBranding(p: PublishParams): boolean {
  return p.is_paid_partnership !== undefined || Boolean(p.branded_content_sponsor_ids?.length);
}

/**
 * POST /{IG}/media parameters for one container (contract 2.3 table). `which` is the carousel child index,
 * 'single' (image/reel/story) or 'parent' (carousel parent). Only provided options are included.
 */
export function containerBody(p: PublishParams, which: number | 'single' | 'parent', r: UrlResolver, childPlaceholders?: string[]): Record<string, string> {
  const body: Record<string, string> = {};
  if (which === 'parent') {
    body.media_type = 'CAROUSEL';
    body.children = (childPlaceholders ?? []).join(',');
    shared(p, body);
    return body;
  }
  const index = which === 'single' ? 0 : which;
  const m = p.media[index]!;
  const url = r.media(index);
  if (typeof which === 'number') {
    body.is_carousel_item = 'true';
    if (m.type === 'video') body.media_type = 'VIDEO';
    mediaUrlParams(m, url, body);
    if (m.user_tags?.length) body.user_tags = json(m.user_tags);
    return body;
  }
  if (p.kind === 'story') {
    body.media_type = 'STORIES';
    mediaUrlParams(m, url, body);
    if (m.user_tags?.length) body.user_tags = json(m.user_tags);
    return body;
  }
  if (p.kind === 'reel') {
    body.media_type = 'REELS';
    mediaUrlParams(m, url, body);
    const cover = r.cover();
    if (cover) body.cover_url = cover;
    if (p.thumb_offset_ms !== undefined) body.thumb_offset = String(p.thumb_offset_ms);
    if (p.share_to_feed !== undefined) body.share_to_feed = String(p.share_to_feed);
    if (p.audio_name !== undefined) body.audio_name = p.audio_name;
    if (p.trial_reel) body.trial_params = json({ graduation_strategy: p.trial_reel.graduation_strategy });
  } else {
    // image
    mediaUrlParams(m, url, body);
    if (m.alt_text !== undefined) body.alt_text = m.alt_text;
  }
  shared(p, body);
  if (m.user_tags?.length) body.user_tags = json(m.user_tags);
  return body;
}

/** Placeholder resolver for planned_calls: `<media-host-url:N>` for local files that need the media host. */
export function placeholderResolver(p: PublishParams, login: LoginPath): UrlResolver {
  return {
    media: (i) => {
      const m = p.media[i]!;
      const route = mediaRoute(login, m);
      return route === 'url' ? m.url : route === 'host' ? `<media-host-url:${i + 1}>` : null;
    },
    cover: () => (p.cover ? (p.cover.source === 'url' ? (p.cover.url ?? undefined) : '<media-host-url:cover>') : undefined)
  };
}

/** The exact ordered Graph requests an approve (or later the scheduler) will send. */
export function plannedCalls(ig: string, p: PublishParams, login: LoginPath): PlannedCall[] {
  const calls: PlannedCall[] = [];
  const resolver = placeholderResolver(p, login);
  const poll = (id: string): PlannedCall => ({ method: 'GET', path: `/${id}`, params: { fields: 'status_code' } });
  const upload = (m: MediaParam, id: string): void => {
    if (mediaRoute(login, m) === 'resumable') {
      calls.push({ method: 'POST', path: `/ig-api-upload/${id}`, params: { offset: '0', file_size: String(m.size ?? 0) } });
    }
  };
  if (p.kind === 'carousel') {
    const placeholders = p.media.map((_, i) => `{child_${i + 1}_container_id}`);
    p.media.forEach((m, i) => {
      calls.push({ method: 'POST', path: `/${ig}/media`, params: containerBody(p, i, resolver) });
      upload(m, placeholders[i]!);
      calls.push(poll(placeholders[i]!));
    });
    calls.push({ method: 'POST', path: `/${ig}/media`, params: containerBody(p, 'parent', resolver, placeholders) });
  } else {
    calls.push({ method: 'POST', path: `/${ig}/media`, params: containerBody(p, 'single', resolver) });
    upload(p.media[0]!, '{container_id}');
  }
  calls.push(poll('{container_id}'));
  calls.push({ method: 'POST', path: `/${ig}/media_publish`, params: { creation_id: '{container_id}' } });
  calls.push({ method: 'GET', path: '/{media_id}', params: { fields: 'id,permalink' } });
  return calls;
}
