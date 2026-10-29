import type { AppContext } from '../../context.js';
import type { ToolDef } from '../types.js';

/** Tools for the "discovery" domain (business discovery, hashtags, collab invites). Owned by the discovery unit. */
export const tools: ToolDef[] = [];

/** Register executable actions (registerAction) and background jobs (registerJob) for this domain. */
export function register(_ctx: AppContext): void {}
