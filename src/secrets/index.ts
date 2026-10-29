import type { Config, Paths } from '../config/index.js';
import { registerSecret } from '../redact.js';
import { EncryptedFileTokenStore } from './encrypted-file.js';
import { EnvTokenStore } from './env.js';
import { KeychainTokenStore } from './keychain.js';
import type { SecretKind, TokenStore } from './types.js';

export * from './types.js';
export { EnvTokenStore, envTokenName, envVarFor } from './env.js';
export { KeychainTokenStore } from './keychain.js';
export { EncryptedFileTokenStore } from './encrypted-file.js';

/** How long "not found" is remembered, so unauthenticated floods cannot reach the backend on every request. */
const NEGATIVE_TTL_MS = 30_000;

/**
 * Reads check the process environment first (so Docker/CI can inject secrets without a backend),
 * then an in-memory cache, then the configured backend. Found values are cached for the life of the
 * process and only change through this store's set/delete (so `auth set-token` and token refresh keep
 * the cache current); misses are cached for 30 s. Writes always go to the configured backend. Every
 * value read is registered with the redactor.
 */
class OverlayStore implements TokenStore {
  readonly readOnly: boolean;
  readonly backend: TokenStore['backend'];
  private readonly cache = new Map<string, string>();
  private readonly misses = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  constructor(private readonly env: EnvTokenStore, private readonly primary: TokenStore) {
    this.readOnly = primary.readOnly;
    this.backend = primary.backend;
  }
  async get(scope: string, kind: SecretKind): Promise<string | undefined> {
    const fromEnv = await this.env.get(scope, kind);
    if (fromEnv !== undefined) { registerSecret(fromEnv); return fromEnv; }
    const key = `${scope}\0${kind}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const missAt = this.misses.get(key);
    if (missAt !== undefined && Date.now() - missAt < NEGATIVE_TTL_MS) return undefined;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.primary.get(scope, kind).then((v) => {
        if (v !== undefined) { this.cache.set(key, v); this.misses.delete(key); registerSecret(v); }
        else this.misses.set(key, Date.now());
        return v;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }
  async set(scope: string, kind: SecretKind, value: string): Promise<void> {
    registerSecret(value);
    await this.primary.set(scope, kind, value);
    const key = `${scope}\0${kind}`;
    this.cache.set(key, value);
    this.misses.delete(key);
  }
  async delete(scope: string, kind: SecretKind): Promise<void> {
    await this.primary.delete(scope, kind);
    const key = `${scope}\0${kind}`;
    this.cache.delete(key);
    this.misses.delete(key);
  }
}

export function createTokenStore(config: Config, paths: Paths, env: NodeJS.ProcessEnv = process.env): TokenStore {
  const envStore = new EnvTokenStore(env);
  switch (config.secrets.backend) {
    case 'env':
      return new OverlayStore(envStore, envStore);
    case 'keychain':
      return new OverlayStore(envStore, new KeychainTokenStore());
    case 'encrypted-file':
      return new OverlayStore(envStore, new EncryptedFileTokenStore(paths.encryptedSecretsPath, env));
  }
}
