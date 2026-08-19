import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { InstagramGraphClient } from './graph-client.js';
import { PublishService } from './publish-service.js';
import { createServer } from './server.js';
import { StaticTokenProvider } from './token-provider.js';
import { createToolHandlers } from './tool-handlers.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const graph = new InstagramGraphClient({ apiBaseUrl: config.apiBaseUrl, apiVersion: config.apiVersion, tokenProvider: new StaticTokenProvider(config.accessToken) });
  const publishService = new PublishService(graph, config.accountIds);
  const handlers = createToolHandlers({ graph, allowedAccountIds: config.accountIds, publishService });
  const server = createServer(handlers);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Instagram MCP failed to start.'); process.exitCode = 1; });
