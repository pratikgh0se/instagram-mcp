import { InstagramError } from './config.js';

export function assertAllowedAccount(accountId: string, allowedAccountIds: Set<string>): void {
  if (!allowedAccountIds.has(accountId)) throw new InstagramError('NOT_ALLOWED', 'Account is not allowlisted.');
}

export function assertConfirmedWrite(confirm: boolean): void {
  if (confirm !== true) throw new InstagramError('MISSING_CONFIRMATION', 'Write operations require confirm: true.');
}
