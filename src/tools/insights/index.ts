import type { AppContext } from '../../context.js';
import { registerSnapshotJob } from '../../insights/snapshot.js';
import type { ToolDef } from '../types.js';
import { getAudience, getGrowth, snapshotInsights } from './audience-growth.js';
import { getAccountInsights, getMediaInsights } from './metrics-tools.js';
import { bestTimeToPost, mediaKit, performanceReport } from './reports.js';

export { snapshotNow } from '../../insights/snapshot.js';

/** Tools for the "insights" domain (insights, audience, snapshots, growth, reports). */
export const tools: ToolDef[] = [
  getAccountInsights, getMediaInsights, getAudience, snapshotInsights, getGrowth, performanceReport, bestTimeToPost, mediaKit
];

/** Registers the daily "snapshots" background job. */
export function register(_ctx: AppContext): void {
  registerSnapshotJob();
}
