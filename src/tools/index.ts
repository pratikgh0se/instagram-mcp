import type { AppContext } from '../context.js';
import * as account from './account/index.js';
import * as comments from './comments/index.js';
import * as discovery from './discovery/index.js';
import * as insights from './insights/index.js';
import * as media from './media/index.js';
import * as messages from './messages/index.js';
import * as publish from './publish/index.js';
import type { ToolDef } from './types.js';

// Each domain folder exports `tools` and `register(ctx)`. Later units edit only their own folder.
const domains = [account, media, publish, comments, messages, insights, discovery];

export const allTools: ToolDef[] = domains.flatMap((d) => d.tools);

/** Call once per process (before serving): registers actions and jobs for every domain. */
export function registerAll(ctx: AppContext): void {
  for (const d of domains) d.register(ctx);
}

export * from './types.js';
