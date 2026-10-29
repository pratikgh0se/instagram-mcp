import type { z } from 'zod';
import type { AppContext } from '../context.js';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What a handler returns: `data` becomes structuredContent, `summary` the one-line text. */
export interface ToolSuccess {
  data: Record<string, unknown>;
  summary: string;
  /** Set for tools whose result object itself represents a failure (instagram_approve failed/unknown). */
  isError?: boolean;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** instagram_<verb>_<noun> */
  name: string;
  title: string;
  description: string;
  /** zod raw shape, e.g. { account: accountParam, limit: z.number().optional() } */
  inputSchema: S;
  annotations: ToolAnnotations;
  handler(ctx: AppContext, input: z.infer<z.ZodObject<S>>): Promise<ToolSuccess>;
}

/** Type-inferring constructor; returns a ToolDef erased to the common type so it fits `tools: ToolDef[]`. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function ok(data: Record<string, unknown>, summary: string): ToolSuccess {
  return { data, summary };
}

// Annotation presets (spec section 3).
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const READ_ONLY_LOCAL: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const LOCAL_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const LOCAL_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const REMOTE_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
