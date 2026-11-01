// In-flight work tracking and shutdown signalling (contract 1.13.10).
const inflight = new Set<Promise<unknown>>();
let shuttingDown = false;

/** Register long-running work (an approve call, a scheduler pass) so a shutdown can wait for it. Returns the same promise. */
export function trackInflight<T>(work: Promise<T>): Promise<T> {
  inflight.add(work);
  const done = (): void => { inflight.delete(work); };
  work.then(done, done);
  return work;
}

export const inflightCount = (): number => inflight.size;
export const isShuttingDown = (): boolean => shuttingDown;
export const beginShutdown = (): void => { shuttingDown = true; };

/** Wait until nothing is in flight or `ms` elapsed. Resolves immediately when nothing is in flight. Returns true when drained. */
export async function waitForDrain(ms: number): Promise<boolean> {
  if (inflight.size === 0) return true;
  const deadline = Date.now() + ms;
  while (inflight.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((r) => { timer = setTimeout(r, left); });
    await Promise.race([Promise.allSettled([...inflight]), timeout]);
    clearTimeout(timer);
  }
  return true;
}

export interface ShutdownTrigger {
  /** Resolves with the reason of the first trigger (signal name or a caller-supplied reason). */
  readonly first: Promise<string>;
  trigger(reason: string): void;
  dispose(): void;
}

/**
 * First SIGINT/SIGTERM (or `trigger`) starts the shutdown; any later signal exits the process immediately.
 * Signal listeners stay installed until `dispose`.
 */
export function createShutdownTrigger(): ShutdownTrigger {
  let triggered = false;
  let resolveFirst: (reason: string) => void = () => undefined;
  const first = new Promise<string>((r) => { resolveFirst = r; });
  const trigger = (reason: string): void => {
    if (triggered) return;
    triggered = true;
    resolveFirst(reason);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (triggered) process.exit(0);
    trigger(signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    first, trigger,
    dispose: () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  };
}
