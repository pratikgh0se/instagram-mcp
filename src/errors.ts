export const ERROR_CODES = [
  'CONFIG_INVALID', 'AUTH_REQUIRED', 'AUTH_FAILED', 'TOKEN_EXPIRED', 'MISSING_PERMISSION',
  'ACCOUNT_NOT_ALLOWED', 'CAPABILITY_UNAVAILABLE', 'POLICY_DENIED', 'INVALID_INPUT', 'NOT_FOUND',
  'RATE_LIMITED', 'PUBLISH_QUOTA_EXHAUSTED', 'MESSAGING_WINDOW_CLOSED', 'HASHTAG_BUDGET_EXHAUSTED',
  'APPROVAL_NOT_FOUND', 'APPROVAL_EXPIRED', 'APPROVAL_ALREADY_USED', 'STALE_PREVIEW',
  'UPSTREAM_REJECTED', 'UPSTREAM_TRANSIENT', 'OUTCOME_UNKNOWN', 'MEDIA_HOST_UNAVAILABLE', 'INTERNAL'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorInit {
  action?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly action?: string;
  readonly retryable: boolean;
  details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, init: AppErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AppError';
    this.code = code;
    this.action = init.action;
    this.retryable = init.retryable ?? false;
    this.details = init.details;
  }

  toJSON(): { code: ErrorCode; message: string; action?: string; retryable: boolean; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.action ? { action: this.action } : {}),
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
