import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { accountSchema, listAccounts, loadConfig, buildPaths, saveConfig, type Config } from '../config/index.js';
import { createContext, type AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { registerSecret } from '../redact.js';
import { GLOBAL_SCOPE } from '../secrets/index.js';
import { runHttp } from '../transports/http.js';
import { runStdio } from '../transports/stdio.js';
import { registerAll, packageVersion } from '../server.js';
import { runDoctor } from './doctor.js';
import { readSecret } from './secret-input.js';

const out = (line: string): void => void process.stdout.write(line + '\n');
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

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
  if (values.http) {
    const port = values.port !== undefined ? Number(values.port) : ctx.config.http.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw usage('--port must be an integer 0-65535.');
    await runHttp(ctx, { host: values.host ?? ctx.config.http.host, port });
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
        for (const a of accounts) rows.push(await ctx.auth.status(a));
        if (values.json) json(rows);
        else for (const r of rows) {
          out(`${r.alias} (${r.login}): token ${r.has_token ? 'present' : 'MISSING'} [${r.backend}]` +
            `${r.expires_at ? `, expires ${r.expires_at} (${r.days_remaining} d)${r.expired ? ' EXPIRED' : ''}` : ''}` +
            `${r.scopes ? `, scopes ${r.scopes.join(',')}` : ''}`);
        }
        return rows.some((r) => !r.has_token || r.expired) ? 1 : 0;
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
      alias: { type: 'string' }, login: { type: 'string' }, 'ig-user-id': { type: 'string' }, 'page-id': { type: 'string' },
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
      throw usage('Usage: instagram-mcp accounts add|list|remove');
  }
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
export async function doctor(): Promise<number> {
  const ctx = createContext({ mode: 'cli' });
  try {
    return await runDoctor(ctx);
  } finally {
    ctx.close();
  }
}

export function version(): number {
  out(packageVersion());
  return 0;
}
