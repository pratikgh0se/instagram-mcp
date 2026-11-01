import { AsyncLocalStorage } from 'node:async_hooks';

/** MCP progress for one instagram_approve call (contract 1.13.11). Labels never contain ids or secrets. */
export interface ProgressReporter {
  /** A step completed or started; `total` is the planned step count when known. */
  step(label: string, total?: number): void;
}

const store = new AsyncLocalStorage<ProgressReporter | undefined>();

export function withProgress<T>(reporter: ProgressReporter | undefined, fn: () => T): T {
  return store.run(reporter, fn);
}

/** Called by executors; a no-op unless the current approve call asked for progress. */
export function reportProgress(label: string, total?: number): void {
  store.getStore()?.step(label, total);
}

export const KEEPALIVE_MS = 5_000;
const MIN_GAP_MS = 1_000;

export type SendProgress = (n: { progress: number; total?: number; message: string }) => void | Promise<void>;

/**
 * Reporter that sends at most one notification per second for steps and a keepalive beat every KEEPALIVE_MS while quiet.
 * `progress` is a strictly increasing integer; `total` is dropped once progress would exceed it.
 */
export function createProgressReporter(send: SendProgress): { reporter: ProgressReporter; stop(): void } {
  let progress = 0;
  let total: number | undefined;
  let label = 'Working';
  const startedAt = Date.now();
  let lastSent = 0;
  const emit = (): void => {
    progress += 1;
    lastSent = Date.now();
    const body: { progress: number; total?: number; message: string } = { progress, message: label };
    if (total !== undefined && progress <= total) body.total = total;
    try {
      void Promise.resolve(send(body)).catch(() => undefined);
    } catch { /* progress is best effort */ }
  };
  const timer = setInterval(() => { if (Date.now() - Math.max(lastSent, startedAt) >= KEEPALIVE_MS) emit(); }, 1_000);
  timer.unref();
  return {
    reporter: {
      step(next, t) {
        label = next;
        if (t !== undefined) total = t;
        if (Date.now() - lastSent >= MIN_GAP_MS) emit();
      }
    },
    stop: () => clearInterval(timer)
  };
}
