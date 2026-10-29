export type SecretKind = 'access_token' | 'app_secret' | 'http_bearer' | 'webhook_verify_token';

/** Scope for secrets that are not tied to one account (app secret, HTTP bearer, webhook verify token). */
export const GLOBAL_SCOPE = '_global';

export interface TokenStore {
  readonly backend: 'keychain' | 'encrypted-file' | 'env';
  readonly readOnly: boolean;
  /** `scope` is an account alias or GLOBAL_SCOPE. */
  get(scope: string, kind: SecretKind): Promise<string | undefined>;
  set(scope: string, kind: SecretKind, value: string): Promise<void>;
  delete(scope: string, kind: SecretKind): Promise<void>;
}

export const SECRET_KINDS: SecretKind[] = ['access_token', 'app_secret', 'http_bearer', 'webhook_verify_token'];

export function assertSecretValue(value: string): void {
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error('Secret value must be a non-empty single line.');
  }
}
