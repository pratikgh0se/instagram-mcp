import type { AppContext } from '../../context.js';
import type { ToolDef } from '../types.js';

/** Tools for the "publish" domain (preflight_publish, scheduling, delete, comments toggle, publish status). Owned by the publish unit. */
export const tools: ToolDef[] = [];

/** Register executable actions (registerAction) and background jobs (registerJob) for this domain. */
export function register(_ctx: AppContext): void {}
