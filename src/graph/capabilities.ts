import type { LoginPath, ResolvedAccount } from '../config/index.js';
import { AppError } from '../errors.js';
import type { AppContext } from '../context.js';
import { looksUnsupported } from './errors.js';

export type Support = 'yes' | 'no' | 'probe';

export interface CapabilityRow {
  description: string;
  instagram: Support;
  facebook: Support;
  unified: Support;
}

/** Static matrix, spec 2.1. Domains may add rows via registerCapability() in their register hook. */
const MATRIX: Record<string, CapabilityRow> = {
  publish_url_media: { description: 'Publish media from a public URL', instagram: 'yes', facebook: 'yes', unified: 'yes' },
  publish_local_video_resumable: { description: 'Resumable local video upload (rupload.facebook.com)', instagram: 'no', facebook: 'yes', unified: 'yes' },
  delete_media: { description: 'Delete own media', instagram: 'probe', facebook: 'yes', unified: 'yes' },
  business_discovery: { description: 'Business discovery of other public professional accounts', instagram: 'no', facebook: 'yes', unified: 'yes' },
  hashtag_search: { description: 'Hashtag search and hashtag media', instagram: 'no', facebook: 'yes', unified: 'probe' },
  branded_content: { description: 'Paid partnership / branded content flags', instagram: 'probe', facebook: 'yes', unified: 'probe' },
  story_insights_webhook: { description: 'story_insights webhook', instagram: 'no', facebook: 'yes', unified: 'yes' },
  messaging: { description: 'Direct messaging', instagram: 'yes', facebook: 'probe', unified: 'yes' },
  collab_invites: { description: 'List/respond to collaboration invites', instagram: 'probe', facebook: 'yes', unified: 'probe' }
};

export function registerCapability(feature: string, row: CapabilityRow): void {
  MATRIX[feature] = row;
}

export function capabilityFeatures(): string[] {
  return Object.keys(MATRIX);
}

export function staticSupport(feature: string, login: LoginPath): Support {
  const row = MATRIX[feature];
  if (!row) throw new AppError('INTERNAL', `Unknown capability feature "${feature}".`);
  return row[login];
}

const NO_TTL_MS = 7 * 86_400_000;

/** Static support with any cached probe result applied. */
export function resolveSupport(ctx: AppContext, account: ResolvedAccount, feature: string): Support {
  const base = staticSupport(feature, account.login);
  const cached = ctx.storage.capabilityCache.get(account.alias, feature);
  if (cached && (cached.status === 'yes' || ctx.clock.nowMs() - Date.parse(cached.checked_at) < NO_TTL_MS)) {
    if (base === 'probe') return cached.status;
  }
  return base;
}

export function resolveMatrix(ctx: AppContext, account: ResolvedAccount): Record<string, Support> {
  return Object.fromEntries(capabilityFeatures().map((f) => [f, resolveSupport(ctx, account, f)]));
}

function unavailable(account: ResolvedAccount, feature: string, reason?: string): AppError {
  const other: LoginPath = account.login === 'instagram' ? 'facebook' : 'instagram';
  const row = MATRIX[feature];
  const otherWorks = row && row[other] !== 'no';
  return new AppError('CAPABILITY_UNAVAILABLE', `${row?.description ?? feature} is not available on the ${account.login} login path${reason ? ` (${reason})` : ''}.`, {
    action: otherWorks
      ? `Use an account configured with login "${other}" (Facebook Login for Business, needs page_id) for this feature.`
      : 'This feature is not available through the official API for this account.',
    details: { feature, login: account.login }
  });
}

/** Throws CAPABILITY_UNAVAILABLE when the feature is `no` (statically or via a cached probe). */
export function requireCapability(ctx: AppContext, account: ResolvedAccount, feature: string): void {
  if (resolveSupport(ctx, account, feature) === 'no') {
    const cached = ctx.storage.capabilityCache.get(account.alias, feature);
    throw unavailable(account, feature, cached?.reason ?? undefined);
  }
}

/**
 * Run `fn`; for `probe` features, cache `yes` on success and cache `no` + throw CAPABILITY_UNAVAILABLE when
 * Meta answers with an unsupported/permission error. Other errors propagate untouched.
 */
export async function withProbe<T>(ctx: AppContext, account: ResolvedAccount, feature: string, fn: () => Promise<T>): Promise<T> {
  requireCapability(ctx, account, feature);
  const isProbe = staticSupport(feature, account.login) === 'probe';
  try {
    // A successful probe is deliberately NOT cached (contract 1.12): only failures cache `no`.
    return await fn();
  } catch (error) {
    if (isProbe && looksUnsupported(error)) {
      const reason = (error as AppError).message;
      ctx.storage.capabilityCache.set(account.alias, feature, 'no', reason.slice(0, 300), ctx.clock.nowIso());
      throw unavailable(account, feature, 'Meta rejected the call');
    }
    throw error;
  }
}
