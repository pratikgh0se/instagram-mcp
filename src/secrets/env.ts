import { AppError } from '../errors.js';
import { GLOBAL_SCOPE, type SecretKind, type TokenStore } from './types.js';

/** INSTAGRAM_MCP_TOKEN_<ALIAS>: uppercased, every non-alphanumeric character becomes "_". */
export function envTokenName(alias: string): string {
  return `INSTAGRAM_MCP_TOKEN_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function envVarFor(scope: string, kind: SecretKind): string {
  switch (kind) {
    case 'access_token': return envTokenName(scope);
    case 'app_secret': return 'INSTAGRAM_MCP_APP_SECRET';
    case 'http_bearer': return 'INSTAGRAM_MCP_HTTP_TOKEN';
    case 'webhook_verify_token': return 'INSTAGRAM_MCP_WEBHOOK_VERIFY_TOKEN';
  }
}

export class EnvTokenStore implements TokenStore {
  readonly backend = 'env' as const;
  readonly readOnly = true;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(scope: string, kind: SecretKind): Promise<string | undefined> {
    if (kind !== 'access_token' && scope !== GLOBAL_SCOPE) scope = GLOBAL_SCOPE;
    const v = this.env[envVarFor(scope, kind)]?.trim();
    return v ? v : undefined;
  }

  async set(scope: string, kind: SecretKind): Promise<void> {
    throw new AppError('CONFIG_INVALID', 'The env secrets backend is read-only.', {
      action: `Set ${envVarFor(scope, kind)} in the process environment, or switch secrets.backend to keychain/encrypted-file.`
    });
  }

  async delete(scope: string, kind: SecretKind): Promise<void> {
    return this.set(scope, kind);
  }
}
