import type { AppContext } from '../../context.js';
import type { ToolDef } from '../types.js';

/** Tools for the "media" domain (list/get media, stories, download, backup). Owned by the media unit. */
export const tools: ToolDef[] = [];

/** Register executable actions (registerAction) and background jobs (registerJob) for this domain. */
export function register(_ctx: AppContext): void {}
