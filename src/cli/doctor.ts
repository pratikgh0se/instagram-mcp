import type { AppContext } from '../context.js';
import { listAccounts, type ResolvedAccount } from '../config/index.js';
import { errorMessage } from '../redact.js';
import { isAppError } from '../errors.js';
import { resolveMatrix } from '../graph/capabilities.js';
import { envTokenName, GLOBAL_SCOPE } from '../secrets/index.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

async function checkAccount(ctx: AppContext, account: ResolvedAccount, out: Check[]): Promise<void> {
  const label = `account ${account.alias} (${account.login})`;
  const status = await ctx.auth.status(account).catch(() => undefined);
  const hasEnv = Boolean(process.env[envTokenName(account.alias)]);
  if (!status?.has_token && !hasEnv) {
    out.push({ name: `${label}: token`, status: 'fail', detail: 'No access token stored.', fix: `Run: instagram-mcp auth set-token --account ${account.alias}` });
    return;
  }
  // Token validity via GET /me (instagram) or /{ig_user_id} (facebook).
  try {
    const graph = ctx.graph(account);
    const path = account.login === 'instagram' ? '/me' : `/${await graph.igUserId()}`;
    const fields = account.login === 'instagram' ? 'user_id,username' : 'id,username';
    const me = await graph.get<{ username?: string }>(path, { fields });
    out.push({ name: `${label}: token valid`, status: 'ok', detail: `Authenticated as @${me.username ?? '?'}.` });
  } catch (error) {
    out.push({
      name: `${label}: token valid`, status: 'fail', detail: errorMessage(error),
      fix: isAppError(error) && error.action ? error.action : `Run: instagram-mcp auth set-token --account ${account.alias}`
    });
    return;
  }
  if (status?.expires_at) {
    const soon = (status.days_remaining ?? 99) < 7;
    out.push({
      name: `${label}: expiry`, status: soon ? 'warn' : 'ok',
      detail: `Expires ${status.expires_at} (${status.days_remaining} day(s) left).`,
      fix: soon ? `Run: instagram-mcp auth refresh --account ${account.alias}` : undefined
    });
  } else {
    out.push({ name: `${label}: expiry`, status: 'ok', detail: 'No expiry recorded (Page token, env token or unknown).' });
  }
  out.push({ name: `${label}: scopes`, status: 'ok', detail: status?.scopes?.length ? status.scopes.join(', ') : 'Not recorded.' });
  const matrix = resolveMatrix(ctx, account);
  const yes = Object.entries(matrix).filter(([, v]) => v === 'yes').map(([k]) => k);
  const probe = Object.entries(matrix).filter(([, v]) => v === 'probe').map(([k]) => k);
  const no = Object.entries(matrix).filter(([, v]) => v === 'no').map(([k]) => k);
  out.push({ name: `${label}: capabilities`, status: 'ok', detail: `yes: ${yes.join(', ') || '-'} | probe: ${probe.join(', ') || '-'} | no: ${no.join(', ') || '-'}` });
  try {
    const graph = ctx.graph(account);
    const res = await graph.get<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(`/${await graph.igUserId()}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const q = res.data?.[0];
    out.push({ name: `${label}: publishing quota`, status: 'ok', detail: q ? `${q.quota_usage ?? 0}/${q.config?.quota_total ?? '?'} used.` : 'No data returned.' });
  } catch (error) {
    out.push({ name: `${label}: publishing quota`, status: 'warn', detail: errorMessage(error) });
  }
}

/** Run all checks; prints a report to stdout. Returns the exit code (0 ok, 1 problems). */
export async function runDoctor(ctx: AppContext): Promise<number> {
  const checks: Check[] = [];
  checks.push({ name: 'config', status: 'ok', detail: `Loaded ${ctx.paths.configPath} (state dir ${ctx.paths.home}).` });
  if (ctx.config.accounts.length === 0) {
    checks.push({ name: 'accounts', status: 'fail', detail: 'No accounts configured.', fix: 'Run: instagram-mcp accounts add --alias <name> --login instagram' });
  }
  try {
    await ctx.secrets.get(GLOBAL_SCOPE, 'app_secret');
    checks.push({ name: `secrets backend (${ctx.secrets.backend})`, status: 'ok', detail: ctx.secrets.readOnly ? 'Readable (read-only).' : 'Readable and writable.' });
  } catch (error) {
    checks.push({ name: `secrets backend (${ctx.secrets.backend})`, status: 'fail', detail: errorMessage(error), fix: isAppError(error) ? error.action : undefined });
  }
  const hasApp = Boolean(await ctx.secrets.get(GLOBAL_SCOPE, 'app_secret').catch(() => undefined));
  checks.push({ name: 'app secret', status: hasApp ? 'ok' : 'warn', detail: hasApp ? 'Present.' : 'Not set (needed for token exchange, appsecret_proof, webhooks).', fix: hasApp ? undefined : 'Run: instagram-mcp auth set-app-secret' });
  const hasBearer = Boolean(await ctx.secrets.get(GLOBAL_SCOPE, 'http_bearer').catch(() => undefined));
  checks.push({ name: 'http bearer', status: hasBearer ? 'ok' : 'warn', detail: hasBearer ? 'Present.' : 'Not set (only required for `serve --http`).', fix: hasBearer ? undefined : 'Run: instagram-mcp http-token rotate' });

  for (const account of listAccounts(ctx.config)) await checkAccount(ctx, account, checks);

  const icon = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' } as const;
  for (const c of checks) {
    process.stdout.write(`[${icon[c.status]}] ${c.name}: ${c.detail}\n`);
    if (c.fix && c.status !== 'ok') process.stdout.write(`       fix: ${c.fix}\n`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  process.stdout.write(failed ? `\n${failed} problem(s) found.\n` : '\nAll checks passed.\n');
  return failed ? 1 : 0;
}
