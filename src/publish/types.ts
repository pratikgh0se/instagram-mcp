export type Kind = 'image' | 'reel' | 'story' | 'carousel';
export type MediaType = 'image' | 'video';

export interface UserTag {
  username: string;
  x?: number;
  y?: number;
}

export interface MediaParam {
  source: 'url' | 'local';
  url: string | null;
  path: string | null;
  type: MediaType;
  alt_text?: string;
  user_tags?: UserTag[];
  /** Local files: size/sha256 at preflight (re-checked at approve). */
  size: number | null;
  sha256: string | null;
  content_type: string | null;
}

export interface CoverParam {
  source: 'url' | 'local';
  url: string | null;
  path: string | null;
  size: number | null;
  sha256: string | null;
}

/** The approved publish payload stored in the approval (and copied into a scheduled job). */
export interface PublishParams {
  kind: Kind;
  caption?: string;
  location_id?: string;
  collaborators?: string[];
  cover?: CoverParam;
  thumb_offset_ms?: number;
  share_to_feed?: boolean;
  audio_name?: string;
  trial_reel?: { graduation_strategy: 'MANUAL' | 'SS_PERFORMANCE' };
  is_paid_partnership?: boolean;
  branded_content_sponsor_ids?: string[];
  is_ai_generated?: boolean;
  publish_at?: string;
  container_create_at?: string;
  media: MediaParam[];
}

/** Staged copies of local files, parallel to params.media (null for remote media and resumable local video). */
export interface StagedTokens {
  media: Array<string | null>;
  cover: string | null;
}

export interface ContainerState {
  /** Carousel children container ids, in order (single kinds: empty). */
  children: string[];
  /** The container passed to media_publish. */
  parent?: string;
  /** Containers already seen as FINISHED (not polled again). */
  finished: string[];
}
