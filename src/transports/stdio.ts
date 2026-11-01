import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { drainMs } from '../config/index.js';
import type { AppContext } from '../context.js';
import { beginShutdown, createShutdownTrigger, waitForDrain } from '../safety/inflight.js';
import { buildServer } from '../server.js';

/** stdio transport. stdout is the MCP channel: nothing else may write to it. */
export async function runStdio(ctx: AppContext): Promise<void> {
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  // The client may be gone while a drained approve still writes its result; never crash on a closed pipe.
  process.stdout.on('error', () => undefined);
  const shutdown = createShutdownTrigger();
  process.stdin.once('end', () => shutdown.trigger('stdin end'));
  process.stdin.once('close', () => shutdown.trigger('stdin close'));
  await shutdown.first;
  // Contract 1.13.10: stop accepting calls, let in-flight approves finish (up to INSTAGRAM_MCP_DRAIN_MS), then exit 0.
  beginShutdown();
  const drained = await waitForDrain(drainMs());
  if (!drained) ctx.log.warn('drain deadline reached; leaving in-flight operations to orphan detection');
  shutdown.dispose();
  await server.close().catch(() => undefined);
}
