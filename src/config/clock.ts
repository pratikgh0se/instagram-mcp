export interface Clock {
  now(): Date;
  nowMs(): number;
  nowIso(): string;
}

/** INSTAGRAM_MCP_NOW overrides the clock only when INSTAGRAM_MCP_TEST_MODE=1. */
export function createClock(env: NodeJS.ProcessEnv = process.env): Clock {
  const override = env.INSTAGRAM_MCP_TEST_MODE === '1' ? env.INSTAGRAM_MCP_NOW : undefined;
  const fixed = override ? Date.parse(override) : NaN;
  const now = (): Date => (Number.isNaN(fixed) ? new Date() : new Date(fixed));
  return { now, nowMs: () => now().getTime(), nowIso: () => now().toISOString() };
}
