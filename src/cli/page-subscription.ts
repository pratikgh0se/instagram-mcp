import type { AppContext } from '../context.js';
import type { ResolvedAccount } from '../config/index.js';
import { AppError } from '../errors.js';

export interface PageSubscription {
  alias: string;
  page_id: string;
  app_id: string | null;
  subscribed: boolean;
  subscribed_fields: string[];
}

interface SubscribedApp { id?: unknown; subscribed_fields?: unknown }

export const DEFAULT_PAGE_FIELDS = 'feed';
const FIELD_RE = /^[a-z_]{1,64}$/;

/** Contract 3.6: facebook-path accounts only. */
export function requireFacebookPath(account: ResolvedAccount): string {
  if (account.login === 'unified') {
    throw new AppError('CAPABILITY_UNAVAILABLE', `Account "${account.alias}" uses the unified login path; Unified-login apps receive webhooks through the app's Instagram webhook subscription in the Meta dashboard, not a Page subscription.`, {
      action: 'Configure the Instagram webhook subscription for the app in the Meta dashboard.'
    });
  }
  if (account.login !== 'facebook' || !account.page_id) {
    throw new AppError('CAPABILITY_UNAVAILABLE', `Account "${account.alias}" uses the instagram login path; Instagram-login apps receive webhooks without a Page subscription.`, {
      action: 'Use an account configured with login "facebook" (needs page_id) for Page subscriptions.'
    });
  }
  return account.page_id;
}

/** Contract 3.6: a missing token is AUTH_FAILED. */
export async function requireToken(ctx: AppContext, account: ResolvedAccount): Promise<void> {
  try {
    await ctx.auth.getAccessToken(account);
  } catch (error) {
    if (error instanceof AppError && error.code === 'AUTH_REQUIRED') {
      throw new AppError('AUTH_FAILED', error.message, { action: error.action ?? `Run: instagram-mcp auth set-token --account ${account.alias}` });
    }
    throw error;
  }
}

export function parseFields(raw: string | undefined): string {
  const items = (raw ?? DEFAULT_PAGE_FIELDS).split(',').map((s) => s.trim());
  if (items.length < 1 || items.length > 20 || items.some((s) => !FIELD_RE.test(s))) {
    throw new AppError('INVALID_INPUT', '--fields must be 1 to 20 comma-separated names matching ^[a-z_]{1,64}$.');
  }
  return items.join(',');
}

/** `GET /{page_id}/subscribed_apps` with the account (Page) token. */
export async function getPageSubscription(ctx: AppContext, account: ResolvedAccount, pageId: string): Promise<PageSubscription> {
  const res = await ctx.graph(account).get<{ data?: SubscribedApp[] }>(`/${pageId}/subscribed_apps`);
  const entries = Array.isArray(res.data) ? res.data : [];
  const appId = ctx.config.app.app_id ?? null;
  const entry = appId === null ? entries[0] : entries.find((e) => String(e.id) === appId);
  const fields = entry && Array.isArray(entry.subscribed_fields) ? entry.subscribed_fields.map(String) : [];
  return { alias: account.alias, page_id: pageId, app_id: appId, subscribed: Boolean(entry), subscribed_fields: fields };
}
