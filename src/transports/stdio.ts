import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppContext } from '../context.js';
import { buildServer } from '../server.js';

/** stdio transport. stdout is the MCP channel: nothing else may write to it. */
export async function runStdio(ctx: AppContext): Promise<void> {
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await server.close().catch(() => undefined);
}
