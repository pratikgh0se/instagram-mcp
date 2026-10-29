import { constants, createReadStream, openSync, promises as fsp, realpathSync, type ReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

const expand = (p: string): string => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** Configured local media directories (default `<home>/media`), `~` expanded, as given (not realpath'd). */
export function configuredMediaDirs(ctx: AppContext): string[] {
  const dirs = ctx.config.local_media_dirs;
  return dirs && dirs.length > 0 ? dirs.map(expand) : [join(ctx.paths.home, 'media')];
}

/** Allowed directories that exist, realpath'd. */
function realDirs(ctx: AppContext): string[] {
  const out: string[] = [];
  for (const d of configuredMediaDirs(ctx)) {
    try { out.push(realpathSync(d)); } catch { /* missing dir allows nothing */ }
  }
  return out;
}

const inside = (root: string, target: string): boolean => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

const notAllowed = (ctx: AppContext): AppError =>
  new AppError('INVALID_INPUT', 'The local media path is not inside an allowed media directory (config local_media_dirs).', {
    details: { reason: 'path_not_allowed', allowed_dirs: configuredMediaDirs(ctx) },
    action: 'Copy the file into one of the allowed media directories and use that path.'
  });

export function expandLocalPath(p: string): string {
  return expand(p);
}

/**
 * Resolve a local media path for publishing: realpath (symlinks resolved) must be inside an allowed directory and be a
 * regular file. Anything outside the allowlist yields the same generic error whether or not the file exists.
 * Throws INVALID_INPUT (details.reason "path_not_allowed" | "file_not_found" | "not_a_file").
 */
export async function resolveLocalMedia(ctx: AppContext, given: string): Promise<{ path: string; real_path: string }> {
  const path = expand(given);
  const roots = realDirs(ctx);
  let real: string;
  try {
    real = await fsp.realpath(path);
  } catch {
    // Missing: only say so when the path is lexically inside an allowed directory (no oracle outside the allowlist).
    const lexical = configuredMediaDirs(ctx).some((d) => inside(d, path)) || roots.some((d) => inside(d, path));
    if (lexical) throw new AppError('INVALID_INPUT', 'The local media file does not exist or is not readable.', { details: { reason: 'file_not_found' } });
    throw notAllowed(ctx);
  }
  if (!roots.some((d) => inside(d, real) && real !== d)) throw notAllowed(ctx);
  let st;
  try {
    st = await fsp.stat(real);
  } catch {
    throw new AppError('INVALID_INPUT', 'The local media file does not exist or is not readable.', { details: { reason: 'file_not_found' } });
  }
  if (!st.isFile()) throw new AppError('INVALID_INPUT', 'The local media path is not a regular file.', { details: { reason: 'not_a_file' } });
  return { path, real_path: real };
}

/** Re-validate at approve/stage time: the stored real_path must still be inside an allowed dir and still the realpath of `path`. */
export async function recheckLocalMedia(ctx: AppContext, path: string, realPath: string): Promise<void> {
  const now = await resolveLocalMedia(ctx, path);
  if (now.real_path !== realPath) {
    throw new AppError('STALE_PREVIEW', 'A local media path now resolves to a different file; nothing was sent.', { action: 'Run instagram_preflight_publish again.' });
  }
}

/** Read stream over a verified real path, opened without following a final symlink. */
export function openNoFollow(path: string, range?: { start?: number }): ReadStream {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  return createReadStream('', { fd, ...(range?.start !== undefined ? { start: range.start } : {}) });
}
