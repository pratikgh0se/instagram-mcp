import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { AppError, isAppError } from './errors.js';
import { errorMessage, redact, redactDeep } from './redact.js';
import { allTools, registerAll } from './tools/index.js';
import type { ToolDef } from './tools/types.js';
import { elicitorFromServer, withElicitor } from './safety/elicit.js';

export const SERVER_NAME = 'instagram-mcp';

export function packageVersion(): string {
  return '1.0.0-rc.1';
}

const oneLine = (text: string, max = 300): string => {
  const flat = redact(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Last-line defence: deep-redact every string in the envelope (structuredContent and text). */
export function finalize(result: CallToolResult): CallToolResult {
  return redactDeep(result);
}

export function successResult(data: Record<string, unknown>, summary: string, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    structuredContent: redactDeep(data),
    content: [{ type: 'text', text: oneLine(summary || 'ok') }]
  };
}

export function errorResult(error: unknown): CallToolResult {
  const app = isAppError(error) ? error : new AppError('INTERNAL', `Unexpected error: ${errorMessage(error)}`);
  const body = redactDeep(app.toJSON());
  return {
    isError: true,
    structuredContent: { error: body },
    content: [{ type: 'text', text: oneLine(`${body.code}: ${body.message}`) }]
  };
}

/** Run a tool: strict validation (INVALID_INPUT), handler, uniform envelope. Never throws. */
export async function runTool(ctx: AppContext, tool: ToolDef, rawArgs: unknown): Promise<CallToolResult> {
  try {
    await ctx.primeSecrets();
    const parsed = z.strictObject(tool.inputSchema).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new AppError('INVALID_INPUT', `Invalid input: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`, {
        details: { issues },
        action: 'Fix the listed fields and call the tool again.'
      });
    }
    const out = await tool.handler(ctx, parsed.data);
    return finalize(successResult(out.data, out.summary, out.isError));
  } catch (error) {
    if (!isAppError(error)) ctx.log.error(`tool ${tool.name} failed: ${errorMessage(error)}`);
    return finalize(errorResult(error));
  }
}

export function listToolDescriptors(): Array<Record<string, unknown>> {
  return allTools.map((t) => {
    const schema = z.toJSONSchema(z.strictObject(t.inputSchema), { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, title: t.title, description: t.description, inputSchema: schema, annotations: { title: t.title, ...t.annotations } };
  });
}

/**
 * Build an MCP server from the tool registry. Uses the low-level Server so that input validation failures
 * come back as INVALID_INPUT tool results (not protocol errors). Actions/jobs must be registered first
 * (call registerAll(ctx) once per process).
 */
export function buildServer(ctx: AppContext): Server {
  const server = new Server({ name: SERVER_NAME, version: packageVersion() }, { capabilities: { tools: {} } });
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const descriptors = listToolDescriptors();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: descriptors as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) return errorResult(new AppError('INVALID_INPUT', `Unknown tool "${req.params.name}".`));
    return await withElicitor(elicitorFromServer(server), () => runTool(ctx, tool, req.params.arguments));
  });
  return server;
}

export { registerAll };
