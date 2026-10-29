import type { AppContext } from '../context.js';
import { listAccounts, type ResolvedAccount } from '../config/index.js';
import { errorMessage } from '../redact.js';
import { isAppError } from '../errors.js';
import { resolveMatrix } from '../graph/capabilities.js';
import { currentLeaseHolder } from '../daemon/lease.js';
import { envTokenName, GLOBAL_SCOPE } from '../secrets/index.js';

export interface DoctorCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  action?: string;
}

const check = (id: string, status: DoctorCheck['status'], message: string, action?: string): DoctorCheck => ({ id, status, message, ...(action ? { action } : {}) });

/** `/me` check (contract 1.4): instagram `GET /me?fields=user_id,username`, facebook `GET /{ig_user_id}?fields=id,username`. */
export async function checkTokenValidity(ctx: AppContext, account: ResolvedAccount): Promise<{ ok: boolean; message: string }> {
  try {
    const graph = ctx.graph(account);
    const me =
      account.login === 'instagram'
        ? await graph.get<{ username?: string }>('/me', { fields: 'user_id,username' })
        : await graph.get<{ username?: string }>(`/${await graph.igUserId()}`, { fields: 'id,username' });
    return { ok: true, message: `${account.alias}: authenticated as @${me.username ?? '?'}` };
  } catch (error) {
    return { ok: false, message: `${account.alias}: ${isAppError(error) ? error.code : 'ERROR'}: ${errorMessage(error)}` };
  }
}

async function hasToken(ctx: AppContext, account: ResolvedAccount): Promise<boolean> {
  return Boolean(process.env[envTokenName(account.alias)]?.trim()) || Boolean(await ctx.secrets.get(account.alias, 'access_token').catch(() => undefined));
}

/** Run all checks (no probes). Returns the checks; the caller prints and picks the exit code. */
export async function runDoctorChecks(ctx: AppContext): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [check('config', 'pass', `Loaded ${ctx.paths.configPath} (state dir ${ctx.paths.home}).`)];

  try {
    await ctx.secrets.get(GLOBAL_SCOPE, 'app_secret');
    out.push(check('secrets_backend', 'pass', `${ctx.secrets.backend} backend is usable${ctx.secrets.readOnly ? ' (read-only)' : ''}.`));
  } catch (error) {
    out.push(check('secrets_backend', 'fail', errorMessage(error), isAppError(error) ? error.action : undefined));
  }

  const accounts = listAccounts(ctx.config);
  const withToken: ResolvedAccount[] = [];
  for (const a of accounts) if (await hasToken(ctx, a)) withToken.push(a);
  const missingAliases = accounts.filter((a) => !withToken.includes(a)).map((a) => a.alias);
  if (accounts.length === 0) out.push(check('tokens', 'fail', 'No accounts configured.', 'Run: instagram-mcp accounts add --alias <name> --login instagram'));
  else if (missingAliases.length) {
    out.push(check('tokens', 'fail', `Missing token for: ${missingAliases.join(', ')}.`, `Run: instagram-mcp auth set-token --account ${missingAliases[0]}`));
  } else out.push(check('tokens', 'pass', 'Every account has a token.'));

  const bad: string[] = [];
  for (const a of withToken) {
    const r = await checkTokenValidity(ctx, a);
    if (!r.ok) bad.push(r.message);
  }
  if (withToken.length === 0) out.push(check('token_validity', 'warn', 'Skipped: no account has a token.'));
  else if (bad.length) out.push(check('token_validity', 'fail', bad.join(' | '), 'Re-authenticate: instagram-mcp auth set-token --account <alias>'));
  else out.push(check('token_validity', 'pass', `/me succeeded for ${withToken.length} account(s).`));

  out.push(check('capabilities', 'pass', accounts.map((a) => {
    const m = resolveMatrix(ctx, a);
    return `${a.alias}: ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  }).join(' | ') || 'No accounts.'));

  const quotaFailures: string[] = [];
  for (const a of withToken) {
    try {
      const graph = ctx.graph(a);
      await graph.get(`/${await graph.igUserId()}/content_publishing_limit`, { fields: 'quota_usage,config' });
    } catch (error) {
      quotaFailures.push(`${a.alias}: ${errorMessage(error)}`);
    }
  }
  if (withToken.length === 0) out.push(check('quota', 'warn', 'Skipped: no account has a token.'));
  else out.push(quotaFailures.length ? check('quota', 'warn', quotaFailures.join(' | ')) : check('quota', 'pass', 'content_publishing_limit succeeded.'));

  const mh = ctx.config.media_host.public_base_url;
  out.push(mh ? check('media_host', 'pass', `public_base_url is ${mh}.`) : check('media_host', 'warn', 'media_host.public_base_url is not set (local files cannot be published).', 'Set media_host.public_base_url to your tunnel URL.'));

  // Real wall time: the lease never follows the frozen test clock.
  const lease = currentLeaseHolder(ctx.storage.db);
  out.push(lease ? check('daemon', 'pass', 'A daemon holds the lease.') : check('daemon', 'warn', 'No daemon is running (scheduled posts and webhooks need it).'));

  const wh = ctx.config.webhooks.enabled;
  const verify = Boolean(await ctx.secrets.get(GLOBAL_SCOPE, 'webhook_verify_token').catch(() => undefined));
  const appSecret = Boolean(await ctx.secrets.get(GLOBAL_SCOPE, 'app_secret').catch(() => undefined));
  out.push(wh && verify && appSecret ? check('webhooks', 'pass', 'Enabled with verify token and app secret.') : check('webhooks', 'warn', wh ? 'Enabled but the verify token or app secret is missing.' : 'Webhooks are disabled.'));
  return out;
}

export function printDoctor(checks: DoctorCheck[], asJson: boolean): number {
  const failed = checks.some((c) => c.status === 'fail');
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: !failed, checks }) + '\n');
  } else {
    const tag = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
    for (const c of checks) {
      process.stdout.write(`[${tag[c.status]}] ${c.id}: ${c.message}\n`);
      if (c.action && c.status !== 'pass') process.stdout.write(`       fix: ${c.action}\n`);
    }
    process.stdout.write(failed ? '\nProblems found.\n' : '\nAll checks passed.\n');
  }
  return failed ? 1 : 0;
}
