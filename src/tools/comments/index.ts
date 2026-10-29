import type { AppContext } from '../../context.js';
import type { ToolDef } from '../types.js';

/** Tools for the "comments" domain (comments, inbox, mentions). Owned by the comments unit. */
export const tools: ToolDef[] = [];

/** Register executable actions (registerAction) and background jobs (registerJob) for this domain. */
export function register(_ctx: AppContext): void {}
