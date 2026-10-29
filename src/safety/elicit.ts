import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Human confirmation through MCP elicitation. The transport layer wraps each tool call in `withElicitor(...)` when the
 * connected client advertises the `elicitation` capability; `instagram_approve` asks it before executing.
 */
export type ElicitDecision = 'accept' | 'decline' | 'cancel';

export interface Elicitor {
  ask(message: string): Promise<ElicitDecision>;
}

const store = new AsyncLocalStorage<Elicitor | undefined>();

export function withElicitor<T>(elicitor: Elicitor | undefined, fn: () => T): T {
  return store.run(elicitor, fn);
}

export function currentElicitor(): Elicitor | undefined {
  return store.getStore();
}

/** Elicitor for a connected MCP server, or undefined when the client lacks the elicitation capability. Call per request. */
export function elicitorFromServer(server: Server): Elicitor | undefined {
  if (!server.getClientCapabilities()?.elicitation) return undefined;
  return {
    async ask(message: string): Promise<ElicitDecision> {
      const res = await server.elicitInput({
        message,
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve and execute this action', default: false } },
          required: ['approve']
        }
      });
      if (res.action === 'accept' && res.content?.approve === true) return 'accept';
      return res.action === 'cancel' ? 'cancel' : 'decline';
    }
  };
}
