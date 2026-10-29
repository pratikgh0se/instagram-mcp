import { chmodSync, closeSync, constants as fsc, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AppError } from '../errors.js';
import { configSchema, type Config } from './schema.js';

export interface Paths {
  home: string;
  configPath: string;
  dbPath: string;
  downloadsDir: string;
  mediaDir: string;
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
    mediaDir: join(home, 'media'),
    stagingDir: join(home, 'staging'),
    encryptedSecretsPath: join(home, 'secrets.enc.json')
  };
}

/** Create a directory (and parents) with mode 0700 and enforce the mode on the leaf. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Create state directories. Call once at startup. A user-provided downloads_dir is created if missing but never chmod'ed. */
export function ensureStateDirs(paths: Paths): void {
  ensurePrivateDir(paths.home);
  if (paths.downloadsDir === join(paths.home, 'downloads')) ensurePrivateDir(paths.downloadsDir);
  else mkdirSync(paths.downloadsDir, { recursive: true });
  ensurePrivateDir(paths.stagingDir);
  ensurePrivateDir(paths.mediaDir);
}

/** Write a 0600 file atomically: exclusive-create (no symlink following) temp file, then rename. */
export function writePrivateFile(file: string, data: string | Buffer): void {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const flags = fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0);
  const fd = openSync(tmp, flags, 0o600);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off);
    fchmodSync(fd, 0o600);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

export function loadConfig(paths: Paths): Config {
  const withDefaults = (c: Config, provided: boolean): Config =>
    provided ? c : { ...c, local_media_dirs: [paths.mediaDir] };
  if (!existsSync(paths.configPath)) return withDefaults(configSchema.parse({}), false);

  const st = lstatSync(paths.configPath);
  if (st.isSymbolicLink()) {
    throw new AppError('CONFIG_INVALID', `Config file ${paths.configPath} is a symlink; refusing to load it.`, {
      action: 'Replace it with a regular file owned by you (mode 600).'
    });
  }
  if (!st.isFile()) throw new AppError('CONFIG_INVALID', `Config path ${paths.configPath} is not a regular file.`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new AppError('CONFIG_INVALID', `Config file ${paths.configPath} is owned by another user (uid ${st.uid}); refusing to load it.`, {
      action: `Run: chown $(id -u) ${paths.configPath}`
    });
  }
  if (st.mode & 0o022) {
    throw new AppError('CONFIG_INVALID', `Config file ${paths.configPath} is group- or world-writable; refusing to load it.`, {
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
  const providedMedia = Boolean(raw && typeof raw === 'object' && 'local_media_dirs' in (raw as object));
  const config = withDefaults(parsed.data, providedMedia);
  config.local_media_dirs = config.local_media_dirs.map((d) => resolve(d.replace(/^~(?=$|\/)/, homedir())));
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

const OVERRIDE_VARS = ['INSTAGRAM_MCP_GRAPH_URL_INSTAGRAM', 'INSTAGRAM_MCP_GRAPH_URL_FACEBOOK', 'INSTAGRAM_MCP_RUPLOAD_URL'];

/** Validate one URL override: http(s) without path/query, and https unless INSTAGRAM_MCP_TEST_MODE=1. Returns the trimmed value. */
export function checkUrlOverride(name: string, raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let u: URL | undefined;
  try { u = new URL(value); } catch { /* invalid */ }
  const shapeOk = u !== undefined && (u.protocol === 'http:' || u.protocol === 'https:') && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
  if (!shapeOk) throw new AppError('CONFIG_INVALID', `${name} must be an http(s) URL without path or query.`);
  if (u!.protocol !== 'https:' && env.INSTAGRAM_MCP_TEST_MODE !== '1') {
    throw new AppError('CONFIG_INVALID', `${name} must be https (cleartext overrides would leak access tokens; http is only allowed with INSTAGRAM_MCP_TEST_MODE=1).`);
  }
  return value;
}

/** Env overrides must be https URLs without path or query (http only in test mode). Throws CONFIG_INVALID. */
export function validateEnvOverrides(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of OVERRIDE_VARS) checkUrlOverride(name, env[name], env);
}

export function saveConfig(paths: Paths, config: Config): void {
  writePrivateFile(paths.configPath, JSON.stringify(config, null, 2) + '\n');
}
