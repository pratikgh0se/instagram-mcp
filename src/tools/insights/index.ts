import type { AppContext } from '../../context.js';
import type { ToolDef } from '../types.js';

/** Tools for the "insights" domain (insights, audience, snapshots, growth, reports). Owned by the insights unit. */
export const tools: ToolDef[] = [];

/** Register executable actions (registerAction) and background jobs (registerJob) for this domain. */
export function register(_ctx: AppContext): void {}
