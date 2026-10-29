import { parseArgs } from 'node:util';
import { listAccounts } from '../config/index.js';
import { createContext, type AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { errorMessage } from '../redact.js';
import { listJobs, registerJob, type JobSpec } from '../safety/registry.js';
import { registerAll } from '../server.js';
import { resolveHttpHost, startHttpServer, type HttpHandle } from '../transports/http.js';
import { createWebhookHandler } from '../webhooks/receiver.js';
import { acquireLease, LEASE_RENEW_MS, type LeaseHandle } from './lease.js';

const DAY_MS = 86_400_000;
const SHUTDOWN_GRACE_MS = 10_000;

/** Built-in daily token refresh (spec 2.6 / 2.9). Refreshes instagram-path tokens that are due; failures are logged per account. */
export function tokenRefreshJob(): JobSpec {
  return {
    name: 'token-refresh',
    intervalMs: DAY_MS,
    run: async (ctx: AppContext): Promise<void> => {
      for (const account of listAccounts(ctx.config)) {
        if (account.login !== 'instagram') continue;
        try {
          const r = await ctx.auth.refreshIfDue(account);
          if (r.refreshed) ctx.log.info(`token refreshed for ${account.alias}`);
        } catch (error) {
          ctx.log.warn(`token refresh failed for ${account.alias}: ${errorMessage(error)}`);
        }
      }
    }
  };
}

interface RunningJob {
  spec: JobSpec;
  timer?: NodeJS.Timeout;
  inflight?: Promise<unknown>;
}

/** `instagram-mcp daemon [--http] [--port N]`. Resolves with the exit code after a graceful shutdown. */
export async function runDaemon(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { http: { type: 'boolean' }, port: { type: 'string' }, host: { type: 'string' } },
    allowPositionals: false
  });
  const ctx = createContext({ mode: 'daemon' });
  let lease: LeaseHandle | undefined;
  let handle: HttpHandle | undefined;
  try {
    const port = values.port !== undefined ? Number(values.port) : ctx.config.http.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AppError('INVALID_INPUT', '--port must be an integer 0-65535.');

    registerAll(ctx);
    registerJob(tokenRefreshJob());

    lease = acquireLease(ctx.storage.db);
    if (!lease) {
      throw new AppError('CONFIG_INVALID', 'Another daemon already holds the lease for this INSTAGRAM_MCP_HOME.', {
        action: 'Stop the other daemon, or wait up to 60 seconds if it crashed.'
      });
    }

    const wantMcp = Boolean(values.http);
    const webhooksOn = ctx.config.webhooks.enabled;
    if (wantMcp || webhooksOn) {
      handle = await startHttpServer(ctx, {
        host: resolveHttpHost(ctx.config.http.host, values.host),
        port,
        mcp: wantMcp,
        exemptRoutes: webhooksOn ? { paths: [ctx.config.webhooks.path], handler: createWebhookHandler(ctx) } : undefined
      });
    }

    return await supervise(ctx, lease, handle);
  } finally {
    lease?.release();
    ctx.close();
  }
}

function supervise(ctx: AppContext, lease: LeaseHandle, handle: HttpHandle | undefined): Promise<number> {
  return new Promise<number>((resolve) => {
    let stopping = false;
    const running: RunningJob[] = listJobs().map((spec) => ({ spec }));

    const schedule = (job: RunningJob, delay: number): void => {
      if (stopping) return;
      job.timer = setTimeout(() => {
        job.inflight = job.spec
          .run(ctx)
          .catch((error: unknown) => ctx.log.error(`job ${job.spec.name} failed: ${errorMessage(error)}`))
          .finally(() => {
            job.inflight = undefined;
            schedule(job, job.spec.intervalMs);
          });
      }, delay);
    };
    for (const job of running) schedule(job, 0);

    const stop = async (code: number): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearInterval(renewTimer);
      for (const job of running) if (job.timer) clearTimeout(job.timer);
      const pending = running.map((j) => j.inflight).filter((p): p is Promise<void> => Boolean(p));
      if (pending.length) {
        await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
      }
      await handle?.close().catch(() => undefined);
      resolve(code);
    };

    const renewTimer = setInterval(() => {
      let ok = false;
      try { ok = lease.renew(); } catch (error) { ctx.log.error(`lease renewal failed: ${errorMessage(error)}`); }
      if (!ok) {
        ctx.log.error('Daemon lease lost; shutting down.');
        void stop(1);
      }
    }, LEASE_RENEW_MS);

    process.once('SIGINT', () => void stop(0));
    process.once('SIGTERM', () => void stop(0));
  });
}
