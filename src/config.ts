export type InstagramErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_ALLOWED'
  | 'MISSING_CONFIRMATION'
  | 'AUTHENTICATION_FAILED'
  | 'MISSING_PERMISSION'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TRANSIENT'
  | 'UPSTREAM_REJECTED'
  | 'RECONCILIATION_REQUIRED';

export class InstagramError extends Error {
  constructor(
    public readonly code: InstagramErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'InstagramError';
  }
}

export interface InstagramMcpConfig {
  accountIds: Set<string>;
  accessToken: string;
  apiBaseUrl: string;
  apiVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): InstagramMcpConfig {
  const accountIds = new Set(
    (env.INSTAGRAM_ACCOUNT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
  const accessToken = env.INSTAGRAM_ACCESS_TOKEN?.trim();

  if (accountIds.size === 0 || !accessToken) {
    throw new InstagramError(
      'INVALID_INPUT',
      'INSTAGRAM_ACCOUNT_IDS and INSTAGRAM_ACCESS_TOKEN must both be configured.'
    );
  }

  return {
    accountIds,
    accessToken,
    apiBaseUrl: (env.INSTAGRAM_API_BASE_URL ?? 'https://graph.instagram.com').replace(/\/$/, ''),
    apiVersion: env.INSTAGRAM_API_VERSION ?? 'v25.0'
  };
}
