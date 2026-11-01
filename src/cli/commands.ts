import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { accountSchema, listAccounts, loadConfig, buildPaths, saveConfig, type Config } from '../config/index.js';
import { createContext, type AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { registerSecret } from '../redact.js';
import { GLOBAL_SCOPE } from '../secrets/index.js';
import { acquireLease, LEASE_RENEW_MS } from '../daemon/lease.js';
import { listJobs } from '../safety/registry.js';
import { sweepOrphans } from '../safety/orphans.js';
import { resolveHttpHost, runHttp } from '../transports/http.js';
import { runStdio } from '../transports/stdio.js';
import { registerAll, packageVersion } from '../server.js';
import { checkTokenValidity, printDoctor, runDoctorChecks } from './doctor.js';
import { envTokenName } from '../secrets/index.js';
import { errorMessage } from '../redact.js';
import { readSecret } from './secret-input.js';

const out = (line: string): void => void process.stdout.write(line + '\n');
const json = (value: unknown): void => out(JSON.stringify(value));

function usage(message: string): AppError {
  return new AppError('INVALID_INPUT', message);
}

// ---------- serve ----------
export async function serve(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { http: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' } },
    allowPositionals: false
  });
  const ctx = createContext({ mode: values.http ? 'http' : 'stdio' });
  registerAll(ctx);
  // Contract 1.13.9: before accepting requests, mark operations whose process died as unknown (no Graph requests).
  const orphaned = sweepOrphans(ctx);
  if (orphaned > 0) ctx.log.warn(`marked ${orphaned} orphaned operation(s) unknown`);
  if (values.http) {
    const port = values.port !== undefined ? Number(values.port) : ctx.config.http.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage('--port must be an integer 0-65535.');
    await runHttp(ctx, { host: resolveHttpHost(ctx.config.http.host, values.host), port });
  } else {
    await runStdio(ctx);
  }
  ctx.close();
  return 0;
}

// ---------- auth ----------
function accountArg(ctx: AppContext, alias: string | undefined) {
  return ctx.account(alias);
}

export async function auth(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      account: { type: 'string' }, scopes: { type: 'string' }, 'no-exchange': { type: 'boolean' },
      force: { type: 'boolean' }, json: { type: 'boolean' }, check: { type: 'boolean' }
    },
    allowPositionals: false
  });
  const ctx = createContext({ mode: 'cli' });
  try {
    switch (sub) {
      case 'set-token': {
        const account = accountArg(ctx, values.account);
        const token = await readSecret(`Access token for "${account.alias}" (input hidden): `);
        registerSecret(token);
        const res = await ctx.auth.storeToken(account, token, {
          exchange: !values['no-exchange'],
          scopes: values.scopes?.split(',').map((s) => s.trim()).filter(Boolean)
        });
        if (res.ig_user_id && !account.ig_user_id) {
          const config = loadConfig(ctx.paths);
          const entry = config.accounts.find((a) => a.alias === account.alias);
          if (entry) {
            entry.ig_user_id = res.ig_user_id;
            saveConfig(ctx.paths, config);
            res.notes.push(`Saved ig_user_id ${res.ig_user_id} to the config.`);
          }
        }
        json(res);
        return 0;
      }
      case 'set-app-secret': {
        const secret = await readSecret('App secret (input hidden): ');
        registerSecret(secret);
        await ctx.secrets.set(GLOBAL_SCOPE, 'app_secret', secret);
        out('App secret stored.');
        return 0;
      }
      case 'status': {
        const accounts = values.account ? [ctx.account(values.account)] : listAccounts(ctx.config);
        const rows = [];
        let allGood = true;
        for (const a of accounts) {
          const s = await ctx.auth.status(a);
          const envVar = envTokenName(a.alias);
          const fromEnv = Boolean(process.env[envVar]?.trim());
          const present = s.has_token || fromEnv;
          let valid: boolean | null = null;
          if (values.check && present) valid = (await checkTokenValidity(ctx, a)).ok;
          if (!present || valid === false || (!fromEnv && s.expired)) allGood = false;
          rows.push({
            alias: a.alias, login: a.login, ig_user_id: a.ig_user_id,
            token: { present, source: fromEnv ? 'env' : s.backend, env_var: envVar, expires_at: s.expires_at, scopes: s.scopes },
            valid
          });
        }
        const has = async (kind: 'app_secret' | 'http_bearer' | 'webhook_verify_token'): Promise<{ present: boolean }> => ({
          present: Boolean(await ctx.secrets.get(GLOBAL_SCOPE, kind).catch(() => undefined))
        });
        json({
          backend: ctx.secrets.backend, accounts: rows,
          app_secret: await has('app_secret'), http_bearer: await has('http_bearer'), webhook_verify_token: await has('webhook_verify_token')
        });
        return allGood ? 0 : 1;
      }
      case 'refresh': {
        const account = accountArg(ctx, values.account);
        const res = await ctx.auth.refresh(account, { force: Boolean(values.force) });
        json({ account: account.alias, ...res });
        return 0;
      }
      case 'logout': {
        if (!values.account) throw usage('auth logout needs --account <alias>.');
        const account = ctx.account(values.account);
        await ctx.auth.logout(account);
        out(`Removed the stored token for "${account.alias}".`);
        return 0;
      }
      default:
        throw usage('Usage: instagram-mcp auth set-token|set-app-secret|status|refresh|logout [--account <alias>]');
    }
  } finally {
    ctx.close();
  }
}

// ---------- accounts ----------
export async function accounts(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      alias: { type: 'string' }, login: { type: 'string' }, 'ig-user-id': { type: 'string' }, 'page-id': { type: 'string' }, 'app-id': { type: 'string' },
      default: { type: 'boolean' }, 'keep-secrets': { type: 'boolean' }
    },
    allowPositionals: false
  });
  const paths = buildPaths(undefined);
  const config: Config = loadConfig(paths);
  switch (sub) {
    case 'list': {
      json(listAccounts(config).map((a) => ({ alias: a.alias, login: a.login, ig_user_id: a.ig_user_id, page_id: a.page_id, default: a.is_default })));
      return 0;
    }
    case 'add': {
      if (!values.alias || !values.login) throw usage('accounts add needs --alias <name> --login instagram|facebook.');
      const entry = accountSchema.safeParse({ alias: values.alias, login: values.login, ig_user_id: values['ig-user-id'] ?? null, page_id: values['page-id'] ?? null });
      if (!entry.success) throw usage(`Invalid account: ${entry.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      if (entry.data.login === 'facebook' && !entry.data.page_id) throw usage('The facebook login path needs --page-id.');
      if (config.accounts.some((a) => a.alias === entry.data.alias)) throw usage(`Account "${entry.data.alias}" already exists.`);
      config.accounts.push(entry.data);
      if (values['app-id']) config.app.app_id = values['app-id'].trim();
      if (values.default || config.accounts.length === 1) config.default_account = entry.data.alias;
      saveConfig(paths, config);
      out(`Added account "${entry.data.alias}". Next: instagram-mcp auth set-token --account ${entry.data.alias}`);
      return 0;
    }
    case 'remove': {
      if (!values.alias) throw usage('accounts remove needs --alias <name>.');
      const idx = config.accounts.findIndex((a) => a.alias === values.alias);
      if (idx < 0) throw usage(`No account "${values.alias}".`);
      config.accounts.splice(idx, 1);
      if (config.default_account === values.alias) config.default_account = config.accounts[0]?.alias ?? null;
      saveConfig(paths, config);
      if (!values['keep-secrets']) {
        const ctx = createContext({ mode: 'cli' });
        try {
          await ctx.secrets.delete(values.alias, 'access_token').catch(() => undefined);
          ctx.storage.kv.delete(`token_meta:${values.alias}`);
        } finally {
          ctx.close();
        }
      }
      out(`Removed account "${values.alias}".`);
      return 0;
    }
    default:
      throw usage('Usage: instagram-mcp accounts add|list|remove  (add: --alias <n> --login instagram|facebook [--ig-user-id <id>] [--page-id <id>] [--app-id <id>] [--default])');
  }
}

// ---------- app ----------
/** `instagram-mcp app set --app-id <id>`: writes config `app.app_id` (used by the facebook-path token exchange). */
export async function app(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { 'app-id': { type: 'string' } }, allowPositionals: false });
  if (sub !== 'set') throw usage('Usage: instagram-mcp app set --app-id <id>');
  const appId = values['app-id']?.trim();
  if (!appId) throw usage('app set needs --app-id <id>.');
  if (!/^\d{5,32}$/.test(appId)) throw usage('--app-id must be the numeric App ID from the Meta app dashboard.');
  const paths = buildPaths(undefined);
  const config = loadConfig(paths);
  config.app.app_id = appId;
  saveConfig(paths, config);
  out(`Saved app.app_id ${appId} to ${paths.configPath}.`);
  return 0;
}

// ---------- http-token ----------
export async function httpToken(argv: string[]): Promise<number> {
  if (argv[0] !== 'rotate') throw usage('Usage: instagram-mcp http-token rotate');
  const ctx = createContext({ mode: 'cli' });
  try {
    const token = randomBytes(32).toString('base64url');
    registerSecret(token);
    await ctx.secrets.set(GLOBAL_SCOPE, 'http_bearer', token);
    process.stderr.write('New HTTP bearer token (shown once; it replaces the previous one):\n');
    out(token);
    return 0;
  } finally {
    ctx.close();
  }
}

// ---------- doctor / version ----------
export async function doctor(argv: string[]): Promise<number> {
  const asJson = argv.includes('--json');
  let ctx: AppContext;
  try {
    ctx = createContext({ mode: 'cli' });
  } catch (error) {
    // Unreadable/invalid/world-writable config: report only the config check, exit 2.
    printDoctor([{ id: 'config', status: 'fail', message: errorMessage(error), ...(error instanceof AppError && error.action ? { action: error.action } : {}) }], asJson);
    return 2;
  }
  try {
    return printDoctor(await runDoctorChecks(ctx), asJson);
  } finally {
    ctx.close();
  }
}

export function version(): number {
  out(packageVersion());
  return 0;
}

// ---------- scheduler ----------
/**
 * `scheduler run-once`: take the daemon lease (exit 3 when a live daemon/run holds it), register every domain,
 * run the job named "scheduler" once. The job's `run` may return `{ jobs: [...] }`; it is printed per contract 3.1.
 */
export async function scheduler(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'run-once') throw usage('Usage: instagram-mcp scheduler run-once');
  parseArgs({ args: rest, options: {}, allowPositionals: false });
  const ctx = createContext({ mode: 'cli' });
  const lease = acquireLease(ctx.storage.db);
  try {
    if (!lease) {
      process.stderr.write('instagram-mcp: another process holds the daemon lease for this INSTAGRAM_MCP_HOME; nothing processed.\n');
      return 3;
    }
    registerAll(ctx);
    const job = listJobs().find((j) => j.name === 'scheduler');
    if (!job) {
      process.stderr.write('instagram-mcp: no "scheduler" job is registered in this build; nothing to run.\n');
      json({ ok: true, now: ctx.clock.nowIso(), jobs: [] });
      return 0;
    }
    // Renew the lease while working so a long container poll cannot let a daemon take over mid-job.
    const renewTimer = setInterval(() => { lease.renew(); }, LEASE_RENEW_MS);
    renewTimer.unref();
    let result: unknown;
    try {
      result = (await job.run(ctx)) as unknown;
    } finally {
      clearInterval(renewTimer);
    }
    const jobs = result && typeof result === 'object' && Array.isArray((result as { jobs?: unknown }).jobs) ? (result as { jobs: unknown[] }).jobs : [];
    json({ ok: true, now: ctx.clock.nowIso(), jobs });
    return 0;
  } finally {
    lease?.release();
    ctx.close();
  }
}

// ---------- webhooks ----------
export async function webhooks(argv: string[]): Promise<number> {
  const [sub] = argv;
  if (sub !== 'set-verify-token') throw usage('Usage: instagram-mcp webhooks set-verify-token (token from stdin or hidden prompt)');
  const ctx = createContext({ mode: 'cli' });
  try {
    const token = await readSecret('Webhook verify token (input hidden): ');
    registerSecret(token);
    await ctx.secrets.set(GLOBAL_SCOPE, 'webhook_verify_token', token);
    out('Webhook verify token stored.');
    return 0;
  } finally {
    ctx.close();
  }
}
