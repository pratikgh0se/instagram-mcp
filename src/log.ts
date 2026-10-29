import { redact } from './redact.js';

// stdout is the MCP channel in stdio mode: log to stderr only, always redacted.
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.INSTAGRAM_MCP_LOG ?? 'warn').toLowerCase() as Level;
  return order[raw] ?? order.warn;
}

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (order[level] < threshold()) return;
  const extra = fields ? ' ' + JSON.stringify(fields) : '';
  process.stderr.write(redact(`[instagram-mcp] ${level}: ${message}${extra}`) + '\n');
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const log: Logger = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f)
};
