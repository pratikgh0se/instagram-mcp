import { z } from 'zod';
import { AppError, invalidCursor } from '../errors.js';

/** Optional account alias accepted by every tool. */
export const accountParam = z.string().min(1).max(64).optional().describe('Account alias; defaults to the configured default account.');

export const limitParam = z.number().int().min(1).max(100).optional().describe('Page size (max 100).');
export const cursorParam = z.string().min(1).max(2048).optional().describe('Opaque cursor from a previous next_cursor.');

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T = unknown>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw invalidCursor();
  }
}

/** ISO 8601 with Z or numeric offset, or date-only YYYY-MM-DD (= 00:00:00Z). Anything else is INVALID_INPUT. */
export function parseTimestamp(value: string, field: string): Date {
  const ok =
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const d = ok ? new Date(value) : new Date(NaN);
  if (Number.isNaN(d.getTime())) {
    throw new AppError('INVALID_INPUT', `${field} must be ISO 8601 (with Z or offset) or YYYY-MM-DD.`, {
      details: { issues: [{ path: field, message: 'invalid timestamp' }] }
    });
  }
  return d;
}
