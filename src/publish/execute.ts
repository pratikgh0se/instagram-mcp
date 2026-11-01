import type { AppContext } from '../context.js';
import type { ResolvedAccount } from '../config/index.js';
import { AppError, isAppError } from '../errors.js';
import type { GraphClient } from '../graph/client.js';
import { withProbe } from '../graph/capabilities.js';
import { createRuploadClient } from '../graph/rupload.js';
import {
  cleanupStaging, deleteStaged, ensureMediaHost, getStagedPath, publicUrl, stageFile, stagedExpiry
} from '../media-host/index.js';
import { reportProgress } from '../safety/progress.js';
import { containerBody, mediaRoute, usesBranding, type UrlResolver } from './plan.js';
import type { ContainerState, PublishParams, StagedTokens } from './types.js';

export interface Runtime {
  ctx: AppContext;
  account: ResolvedAccount;
  graph: GraphClient;
  ig: string;
}

export interface Hooks {
  /** Persist container progress (scheduled jobs). */
  persist(state: ContainerState): void;
  /** Persist reconciliation hints before the risky media_publish call. */
  setReconcile(data: Record<string, unknown>): void;
}

export interface PublishResult {
  kind: string;
  media_id: string;
  permalink: string | null;
  creation_id: string;
  child_creation_ids?: string[];
}

/** URLs / file paths a publish needs, resolved from local files (staged) or remote URLs. */
export interface Resolved {
  /** Per media item: public URL, or null for resumable upload. */
  urls: Array<string | null>;
  /** Local file to upload for resumable items. */
  files: Array<{ path: string; size: number } | null>;
  cover: string | undefined;
}

export const emptyState = (): ContainerState => ({ children: [], finished: [] });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.INSTAGRAM_MCP_POLL_INTERVAL_MS);
  return Number.isInteger(n) && n >= 1 ? n : 2000;
}

export function localMediaNeedsHost(account: ResolvedAccount, p: PublishParams): boolean {
  return p.media.some((m) => mediaRoute(account.login, m) === 'host') || p.cover?.source === 'local';
}

// ---------- staging ----------

/** Stage the local files of an immediate publish (host route + cover) and resolve URLs. Returns tokens for cleanup. */
export async function stageForPublish(rt: Runtime, p: PublishParams, ownerId: string): Promise<{ resolved: Resolved; tokens: string[] }> {
  const { ctx, account } = rt;
  const tokens: string[] = [];
  const urls: Array<string | null> = [];
  const files: Resolved['files'] = [];
  const expiresAt = stagedExpiry(ctx);
  try {
    for (const m of p.media) {
      const route = mediaRoute(account.login, m);
      files.push(null);
      if (route === 'url') urls.push(m.url);
      else if (route === 'resumable') {
        // Upload from a staged copy whose hash matched the approval, never from the original path (TOCTOU).
        const s = await stageFile(ctx, { sourcePath: m.real_path ?? m.path!, contentType: m.content_type ?? 'application/octet-stream', account: account.alias, ownerId, expiresAt, expectedSha256: m.sha256 ?? undefined });
        tokens.push(s.token);
        urls.push(null);
        files[files.length - 1] = { path: s.path, size: s.size };
      } else {
        const s = await stageFile(ctx, { sourcePath: m.real_path ?? m.path!, contentType: m.content_type ?? 'application/octet-stream', account: account.alias, ownerId, expiresAt, expectedSha256: m.sha256 ?? undefined });
        tokens.push(s.token);
        urls.push(s.token);
      }
    }
    let cover: string | undefined;
    if (p.cover) {
      if (p.cover.source === 'url') cover = p.cover.url ?? undefined;
      else {
        const s = await stageFile(ctx, { sourcePath: p.cover.real_path ?? p.cover.path!, contentType: 'image/jpeg', account: account.alias, ownerId, expiresAt, expectedSha256: p.cover.sha256 ?? undefined });
        tokens.push(s.token);
        cover = s.token;
      }
    }
    // Resumable uploads read their staged copy directly; only host-route media and a local cover need the host.
    if (localMediaNeedsHost(account, p)) await ensureMediaHost(ctx);
    // Turn tokens into public URLs only after the host is up.
    const resolvedUrls = urls.map((u, i) => (u !== null && p.media[i]!.source === 'local' ? publicUrl(ctx, u) : u));
    const resolvedCover = cover && p.cover?.source === 'local' ? publicUrl(ctx, cover) : cover;
    return { resolved: { urls: resolvedUrls, files, cover: resolvedCover }, tokens };
  } catch (error) {
    deleteStaged(ctx, tokens);
    throw error;
  }
}

/** Resolve URLs from the staged copies of a scheduled job. */
export async function resolveStaged(rt: Runtime, p: PublishParams, staged: StagedTokens): Promise<Resolved> {
  const { ctx, account } = rt;
  const urls: Array<string | null> = [];
  const files: Resolved['files'] = [];
  let needsHost = p.cover?.source === 'local';
  p.media.forEach((m, i) => {
    const route = mediaRoute(account.login, m);
    const token = staged.media[i] ?? null;
    if (route === 'url') {
      urls.push(m.url);
      files.push(null);
    } else if (route === 'resumable') {
      const path = token ? getStagedPath(ctx, token) : undefined;
      if (!path) throw new AppError('STALE_PREVIEW', 'A staged media copy is missing; the scheduled post cannot be published.');
      urls.push(null);
      files.push({ path, size: m.size ?? 0 });
    } else {
      if (!token || !getStagedPath(ctx, token)) throw new AppError('STALE_PREVIEW', 'A staged media copy is missing; the scheduled post cannot be published.');
      needsHost = true;
      urls.push(publicUrl(ctx, token));
      files.push(null);
    }
  });
  if (needsHost) await ensureMediaHost(ctx);
  let cover: string | undefined;
  if (p.cover) cover = p.cover.source === 'url' ? (p.cover.url ?? undefined) : staged.cover ? publicUrl(ctx, staged.cover) : undefined;
  return { urls, files, cover };
}

// ---------- containers ----------

function annotate(error: unknown, creationId: string | undefined): unknown {
  if (creationId && isAppError(error) && !error.details?.creation_id) {
    error.details = { ...(error.details ?? {}), creation_id: creationId };
  }
  return error;
}

/** Container creation is not publishing: strip the ambiguity flag so the failure is definite. */
function definite(error: unknown): unknown {
  if (isAppError(error) && error.details?.ambiguous) {
    const { ambiguous: _ambiguous, ...rest } = error.details;
    error.details = rest;
  }
  return error;
}

function currentId(state: ContainerState): string | undefined {
  return state.parent ?? state.children[state.children.length - 1];
}

async function createContainer(rt: Runtime, body: Record<string, string>, branded: boolean, upload: { path: string; size: number } | null): Promise<string> {
  const post = (): Promise<{ id?: string }> => rt.graph.post<{ id?: string }>(`/${rt.ig}/media`, body);
  let res: { id?: string };
  try {
    res = branded ? await withProbe(rt.ctx, rt.account, 'branded_content', post) : await post();
  } catch (error) {
    throw definite(error);
  }
  if (!res.id) throw new AppError('UPSTREAM_REJECTED', 'Instagram did not return a container id.');
  if (upload) {
    try {
      const token = await rt.ctx.auth.getAccessToken(rt.account);
      await createRuploadClient({ version: rt.ctx.config.graph_api_version, token }).upload({ containerId: res.id, filePath: upload.path, fileSize: upload.size });
    } catch (error) {
      throw annotate(definite(error), res.id);
    }
  }
  return res.id;
}

/** Poll one container to FINISHED (contract 2.3 "Poll"). */
export async function pollContainer(graph: GraphClient, id: string): Promise<void> {
  const interval = pollIntervalMs();
  const maxPolls = Math.min(300, Math.ceil(300_000 / interval));
  let last: string | null = null;
  for (let n = 1; n <= maxPolls; n++) {
    const res = await graph.get<{ status_code?: string }>(`/${id}`, { fields: 'status_code' });
    last = res.status_code ?? null;
    if (last === 'FINISHED') return;
    if (last === 'ERROR') {
      let status: unknown = null;
      try {
        status = (await graph.get<{ status?: unknown }>(`/${id}`, { fields: 'status,status_code' })).status ?? null;
      } catch { /* keep null */ }
      throw new AppError('UPSTREAM_REJECTED', 'Instagram failed to process the media container.', { details: { creation_id: id, status_code: 'ERROR', status } });
    }
    if (last === 'EXPIRED') {
      throw new AppError('UPSTREAM_REJECTED', 'The media container expired before it was published.', { details: { creation_id: id, status_code: 'EXPIRED' } });
    }
    if (last === 'PUBLISHED') {
      throw new AppError('OUTCOME_UNKNOWN', 'The container is already published; the earlier publish outcome is unknown.', { details: { creation_id: id, reconcile: { creation_id: id } } });
    }
    if (n < maxPolls) await sleep(interval);
  }
  throw new AppError('UPSTREAM_TRANSIENT', 'Timed out waiting for the media container to finish processing.', {
    retryable: true,
    details: { creation_id: id, last_status_code: last, timed_out: true }
  });
}

export function isPollTimeout(error: unknown): boolean {
  return isAppError(error) && error.code === 'UPSTREAM_TRANSIENT' && error.details?.timed_out === true;
}

/**
 * Create (if not yet created) and poll every container: carousel children one by one, then the parent.
 * Idempotent over `state`, so a scheduler pass can resume after a poll timeout.
 */
export async function ensureContainers(rt: Runtime, p: PublishParams, resolved: Resolved, state: ContainerState, hooks: Hooks): Promise<void> {
  const resolver: UrlResolver = { media: (i) => resolved.urls[i] ?? null, cover: () => resolved.cover };
  const branded = usesBranding(p);
  const count = p.media.length;
  const total = p.kind === 'carousel' ? 2 * count + 3 : 3;
  const settle = async (id: string, label: string): Promise<void> => {
    if (state.finished.includes(id)) return;
    reportProgress(label, total);
    await pollContainer(rt.graph, id);
    state.finished.push(id);
    hooks.persist(state);
  };
  try {
    if (p.kind === 'carousel') {
      for (let i = 0; i < p.media.length; i++) {
        if (state.children[i] === undefined) {
          reportProgress(`${resolved.files[i] ? 'Uploading video' : 'Creating item'} ${i + 1} of ${count}`, total);
          state.children[i] = await createContainer(rt, containerBody(p, i, resolver), false, resolved.files[i] ?? null);
          hooks.persist(state);
        }
        await settle(state.children[i]!, `Waiting for container ${i + 1} of ${count}`);
      }
      if (!state.parent) {
        reportProgress('Creating carousel', total);
        state.parent = await createContainer(rt, containerBody(p, 'parent', resolver, state.children), branded, null);
        hooks.persist(state);
      }
    } else if (!state.parent) {
      reportProgress(resolved.files[0] ? 'Uploading video' : 'Creating container', total);
      state.parent = await createContainer(rt, containerBody(p, 'single', resolver), branded, resolved.files[0] ?? null);
      hooks.persist(state);
    }
    await settle(state.parent!, p.kind === 'carousel' ? 'Waiting for carousel' : 'Waiting for container');
  } catch (error) {
    throw annotate(error, currentId(state));
  }
}

/** media_publish + permalink read. Only an ambiguous media_publish failure is OUTCOME_UNKNOWN. */
export async function publishContainer(rt: Runtime, p: PublishParams, state: ContainerState, hooks: Hooks): Promise<PublishResult> {
  const creationId = state.parent!;
  // Persist the container id BEFORE the risky call so an orphaned operation can be reconciled (contract 1.13.9).
  hooks.setReconcile({ creation_id: creationId });
  reportProgress('Publishing');
  let mediaId: string | undefined;
  try {
    mediaId = (await rt.graph.post<{ id?: string }>(`/${rt.ig}/media_publish`, { creation_id: creationId })).id;
  } catch (error) {
    if (isAppError(error) && error.code === 'UPSTREAM_TRANSIENT' && error.details?.ambiguous) {
      throw new AppError('OUTCOME_UNKNOWN', `media_publish may or may not have been applied (${error.message}).`, {
        details: { creation_id: creationId, reconcile: { creation_id: creationId } }
      });
    }
    throw annotate(error, creationId);
  }
  if (!mediaId) throw new AppError('UPSTREAM_REJECTED', 'Instagram did not return a media id.', { details: { creation_id: creationId } });
  let permalink: string | null = null;
  try {
    permalink = (await rt.graph.get<{ permalink?: string }>(`/${mediaId}`, { fields: 'id,permalink' })).permalink ?? null;
  } catch { /* permalink is best effort */ }
  return {
    kind: p.kind,
    media_id: mediaId,
    permalink,
    creation_id: creationId,
    ...(p.kind === 'carousel' ? { child_creation_ids: [...state.children] } : {})
  };
}

/** Immediate publish: stage, create + poll containers, publish, read permalink, clean up staged files. */
export async function publishNow(rt: Runtime, p: PublishParams, ownerId: string, hooks: Hooks): Promise<PublishResult> {
  try { cleanupStaging(rt.ctx); } catch { /* opportunistic */ }
  const { resolved, tokens } = await stageForPublish(rt, p, ownerId);
  const state = emptyState();
  let unknown = false;
  try {
    await ensureContainers(rt, p, resolved, state, hooks);
    return await publishContainer(rt, p, state, hooks);
  } catch (error) {
    unknown = isAppError(error) && (error.code === 'OUTCOME_UNKNOWN' || (error.code === 'UPSTREAM_TRANSIENT' && error.details?.ambiguous === true));
    throw error;
  } finally {
    // Any terminal outcome removes the public staged copies; only an unknown outcome keeps them until expiry.
    if (!unknown) deleteStaged(rt.ctx, tokens);
  }
}
