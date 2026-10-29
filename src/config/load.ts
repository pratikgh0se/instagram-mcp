import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AppError } from '../errors.js';
import { configSchema, type Config } from './schema.js';

export interface Paths {
  home: string;
  configPath: string;
  dbPath: string;
  downloadsDir: string;
  stagingDir: string;
  encryptedSecretsPath: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INSTAGRAM_MCP_HOME?.trim();
  return resolve(raw ? raw.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), '.instagram-mcp'));
}

export function buildPaths(config: Config | undefined, env: NodeJS.ProcessEnv = process.env): Paths {
  const home = resolveHome(env);
  return {
    home,
    configPath: resolve(env.INSTAGRAM_MCP_CONFIG?.trim() || join(home, 'config.json')),
    dbPath: join(home, 'state.sqlite'),
    downloadsDir: config?.downloads_dir ? resolve(config.downloads_dir) : join(home, 'downloads'),
    stagingDir: join(home, 'staging'),
    encryptedSecretsPath: join(home, 'secrets.enc.json')
  };
}

/** Create a directory (and parents) with mode 0700 and enforce the mode on the leaf. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Create state directories. Call once at startup. */
export function ensureStateDirs(paths: Paths): void {
  ensurePrivateDir(paths.home);
  ensurePrivateDir(paths.downloadsDir);
  ensurePrivateDir(paths.stagingDir);
}

export function writePrivateFile(file: string, data: string | Buffer): void {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function loadConfig(paths: Paths): Config {
  if (!existsSync(paths.configPath)) return configSchema.parse({});

  const st = statSync(paths.configPath);
  if (st.mode & 0o002) {
    throw new AppError('CONFIG_INVALID', `Config file ${paths.configPath} is world-writable; refusing to load it.`, {
      action: `Run: chmod 600 ${paths.configPath}`
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configPath, 'utf8'));
  } catch (cause) {
    throw new AppError('CONFIG_INVALID', `Config file ${paths.configPath} is not valid JSON.`, {
      action: 'Fix the JSON syntax or delete the file and re-run `instagram-mcp accounts add`.',
      cause
    });
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', `Config file ${paths.configPath} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, {
      action: 'Fix the listed fields; secrets never belong in the config file.',
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
    });
  }
  const config = parsed.data;
  const aliases = new Set<string>();
  for (const a of config.accounts) {
    if (aliases.has(a.alias)) throw new AppError('CONFIG_INVALID', `Duplicate account alias "${a.alias}".`);
    aliases.add(a.alias);
    if (a.login === 'facebook' && !a.page_id) {
      throw new AppError('CONFIG_INVALID', `Account "${a.alias}" uses the facebook login path and needs "page_id".`, {
        action: 'Add page_id to the account (the Facebook Page linked to the Instagram account).'
      });
    }
  }
  if (config.default_account && !aliases.has(config.default_account)) {
    throw new AppError('CONFIG_INVALID', `default_account "${config.default_account}" is not a configured account.`);
  }
  return config;
}

/** Env overrides must be http(s) URLs without path or query (contract 1.2). Throws CONFIG_INVALID. */
export function validateEnvOverrides(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ['INSTAGRAM_MCP_GRAPH_URL_INSTAGRAM', 'INSTAGRAM_MCP_GRAPH_URL_FACEBOOK', 'INSTAGRAM_MCP_RUPLOAD_URL']) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    let ok = false;
    try {
      const u = new URL(raw);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
    } catch { /* invalid */ }
    if (!ok) throw new AppError('CONFIG_INVALID', `${name} must be an http(s) URL without path or query.`);
  }
}

export function saveConfig(paths: Paths, config: Config): void {
  writePrivateFile(paths.configPath, JSON.stringify(config, null, 2) + '\n');
}
