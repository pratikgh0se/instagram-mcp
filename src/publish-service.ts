import { InstagramError } from './config.js';
import type { InstagramGraphClient } from './graph-client.js';
import { assertAllowedAccount, assertConfirmedWrite } from './policy.js';

export type MediaKind = 'image' | 'reel' | 'carousel' | 'story';
export interface PublishInput {
  account_id: string; media_kind: MediaKind;
  assets: Array<{ url: string; media_type: 'image' | 'video'; cover_url?: string }>;
  caption?: string; publish_intent: 'public'; confirm: boolean; idempotency_key: string;
}
export interface PublishResult { creation_id: string; media_id: string; status: 'published'; }

export class PublishService {
  private readonly completed = new Map<string, PublishResult>();
  constructor(
    private readonly graph: Pick<InstagramGraphClient, 'get' | 'post'>,
    private readonly allowedAccountIds: Set<string>,
    private readonly sleep: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    assertAllowedAccount(input.account_id, this.allowedAccountIds);
    assertConfirmedWrite(input.confirm);
    if (input.publish_intent !== 'public') throw new InstagramError('MISSING_CONFIRMATION', 'Publishing requires publish_intent: public.');
    if (input.idempotency_key.length < 16) throw new InstagramError('INVALID_INPUT', 'idempotency_key must be at least 16 characters.');
    const prior = this.completed.get(input.idempotency_key);
    if (prior) return prior;
    if (input.assets.length === 0) throw new InstagramError('INVALID_INPUT', 'At least one media asset is required.');

    const creationId = await this.createContainer(input);
    await this.waitUntilFinished(creationId);
    const published = await this.graph.post<{ id: string }>(`/${input.account_id}/media_publish`, { creation_id: creationId });
    const result: PublishResult = { creation_id: creationId, media_id: published.id, status: 'published' };
    this.completed.set(input.idempotency_key, result);
    return result;
  }

  private async createContainer(input: PublishInput): Promise<string> {
    if (input.media_kind === 'carousel') {
      if (input.assets.length < 2) throw new InstagramError('INVALID_INPUT', 'A carousel requires at least two assets.');
      const children = await Promise.all(input.assets.map(async (asset) => {
        const child = await this.graph.post<{ id: string }>(`/${input.account_id}/media`, { ...assetBody(asset), is_carousel_item: true });
        return child.id;
      }));
      const parent = await this.graph.post<{ id: string }>(`/${input.account_id}/media`, { media_type: 'CAROUSEL', children, caption: input.caption });
      return parent.id;
    }
    const asset = input.assets[0]!;
    const mediaType = input.media_kind === 'reel' ? 'REELS' : input.media_kind === 'story' ? 'STORIES' : undefined;
    const created = await this.graph.post<{ id: string }>(`/${input.account_id}/media`, { ...assetBody(asset), ...(mediaType ? { media_type: mediaType } : {}), ...(input.caption ? { caption: input.caption } : {}) });
    return created.id;
  }

  private async waitUntilFinished(creationId: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const status = await this.graph.get<{ status_code?: string; status?: string }>(`/${creationId}`, { fields: 'status_code,status' });
      if (status.status_code === 'FINISHED') return;
      if (status.status_code === 'ERROR' || status.status === 'ERROR') throw new InstagramError('UPSTREAM_REJECTED', 'Instagram media processing failed.', { creationId });
      await this.sleep(Math.min(5_000, 250 * 2 ** attempt));
    }
    throw new InstagramError('RECONCILIATION_REQUIRED', 'Media processing did not finish before the polling limit.', { creationId });
  }
}

function assetBody(asset: PublishInput['assets'][number]): Record<string, unknown> {
  return asset.media_type === 'video'
    ? { video_url: asset.url, ...(asset.cover_url ? { cover_url: asset.cover_url } : {}) }
    : { image_url: asset.url };
}
