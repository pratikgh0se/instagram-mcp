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

/**
 * Reads check the process environment first (so Docker/CI can inject secrets without a backend),
 * then the configured backend. Writes always go to the configured backend. Every value read is
 * registered with the redactor.
 */
class OverlayStore implements TokenStore {
  readonly readOnly: boolean;
  readonly backend: TokenStore['backend'];
  constructor(private readonly env: EnvTokenStore, private readonly primary: TokenStore) {
    this.readOnly = primary.readOnly;
    this.backend = primary.backend;
  }
  async get(scope: string, kind: SecretKind): Promise<string | undefined> {
    const v = (await this.env.get(scope, kind)) ?? (await this.primary.get(scope, kind));
    registerSecret(v);
    return v;
  }
  async set(scope: string, kind: SecretKind, value: string): Promise<void> {
    registerSecret(value);
    await this.primary.set(scope, kind, value);
  }
  delete(scope: string, kind: SecretKind): Promise<void> {
    return this.primary.delete(scope, kind);
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
