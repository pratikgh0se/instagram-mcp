import { TokenManager } from './auth/manager.js';
import {
  buildPaths, createClock, ensureStateDirs, loadConfig, resolveAccount, validateEnvOverrides,
  type Clock, type Config, type Paths, type ResolvedAccount
} from './config/index.js';
import { GraphClient } from './graph/client.js';
import { log, type Logger } from './log.js';
import { registerSecret } from './redact.js';
import { createTokenStore, SECRET_KINDS, GLOBAL_SCOPE, type TokenStore } from './secrets/index.js';
import { openStorage, type Storage } from './storage/index.js';

/** Everything a tool handler, action or job needs. One per process. */
export interface AppContext {
  mode: 'stdio' | 'http' | 'cli' | 'daemon';
  config: Config;
  paths: Paths;
  storage: Storage;
  secrets: TokenStore;
  clock: Clock;
  auth: TokenManager;
  log: Logger;
  /** Load every configured secret (all accounts + global) from env and backend and register it with the redactor. */
  primeSecrets(): Promise<void>;
  /** Resolve an alias (or the default account). Throws ACCOUNT_NOT_ALLOWED / AUTH_REQUIRED / INVALID_INPUT. */
  account(alias?: string | null): ResolvedAccount;
  /** Graph client bound to an account (alias or resolved account; omitted = default account). */
  graph(account?: string | ResolvedAccount | null): GraphClient;
  close(): void;
}

export interface CreateContextOptions {
  mode?: AppContext['mode'];
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createContext(opts: CreateContextOptions = {}): AppContext {
  const env = opts.env ?? process.env;
  validateEnvOverrides(env);
  const bootPaths = buildPaths(undefined, env);
  const config = loadConfig(bootPaths);
  const paths = buildPaths(config, env);
  ensureStateDirs(paths);
  const storage = openStorage(paths.dbPath);
  const clock = createClock(env);
  const secrets = createTokenStore(config, paths, env);
  const auth = new TokenManager({ config, store: secrets, storage, clock, fetch: opts.fetch, sleep: opts.sleep });

  const primeSecrets = async (): Promise<void> => {
    for (const kind of SECRET_KINDS) {
      const scopes = kind === 'access_token' ? config.accounts.map((a) => a.alias) : [GLOBAL_SCOPE];
      for (const scope of scopes) {
        try { registerSecret(await secrets.get(scope, kind)); } catch { /* backend unavailable: nothing to register */ }
      }
    }
  };
  void primeSecrets();

  const clients = new Map<string, GraphClient>();
  const account = (alias?: string | null): ResolvedAccount => resolveAccount(config, alias);
  const graph = (a?: string | ResolvedAccount | null): GraphClient => {
    const resolved = typeof a === 'object' && a ? a : account(a);
    let client = clients.get(resolved.alias);
    if (!client) {
      client = new GraphClient(resolved, auth.http(resolved.login, resolved.alias), auth);
      clients.set(resolved.alias, client);
    }
    return client;
  };

  return {
    mode: opts.mode ?? 'cli',
    config, paths, storage, secrets, clock, auth, log, primeSecrets, account, graph,
    close: () => { try { storage.db.close(); } catch { /* already closed */ } }
  };
}
