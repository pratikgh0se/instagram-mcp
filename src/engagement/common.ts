import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ResolvedAccount } from '../config/index.js';
import { AppError } from '../errors.js';
import { requireCapability } from '../graph/capabilities.js';
import type { GraphClient } from '../graph/client.js';
import { assertPolicyAllows } from '../safety/policy.js';
import { getAction } from '../safety/registry.js';

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Ids that go into URL paths (contract 1.5). */
export const idParam = (what: string) => z.string().regex(ID_RE, `${what} must match ^[A-Za-z0-9_-]{1,64}$`).describe(what);

/** Meta Instagram conversation ids are ~130 chars (contract 1.5). */
export const conversationIdParam = () => z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, 'conversation_id must match ^[A-Za-z0-9_-]{1,256}$').describe('conversation_id');

export const DAY_MS = 86_400_000;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
export const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Parse a Meta timestamp (accepts "+0000" offsets) to epoch ms, or NaN. */
export function tsMs(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return t;
  return Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

/** Policy -> capability -> token (contract 1.11 steps 3-5) for an action's preflight. */
export async function gatePreflight(ctx: AppContext, account: ResolvedAccount, actionName: string, extraCapabilities: string[] = []): Promise<void> {
  const spec = getAction(actionName);
  assertPolicyAllows(ctx, spec ?? { name: actionName });
  if (spec?.capability) requireCapability(ctx, account, spec.capability);
  for (const f of extraCapabilities) requireCapability(ctx, account, f);
  await ctx.auth.getAccessToken(account);
}

/** Own Instagram-scoped id, used to tell own messages/replies from others'. */
export async function ownId(account: ResolvedAccount, graph: GraphClient): Promise<string> {
  return account.ig_user_id ?? (await graph.igUserId());
}

/** DM edge owner: the Page on the facebook login path (Messenger Platform), the IG user on the instagram and unified paths (contract 2.5, 1.16.2). */
export async function dmBase(account: ResolvedAccount, graph: GraphClient): Promise<string> {
  if (account.login === 'facebook') {
    if (!account.page_id) throw new AppError('CONFIG_INVALID', `Account ${account.alias} uses facebook login but has no page_id.`);
    return account.page_id;
  }
  return graph.igUserId();
}

export function withTarget(error: unknown, target: Record<string, unknown>): never {
  if (error instanceof AppError && error.code === 'NOT_FOUND') {
    throw new AppError('NOT_FOUND', error.message, { action: error.action, details: { ...(error.details ?? {}), target } });
  }
  throw error;
}
