#!/usr/bin/env node
import { runDaemon } from './daemon/index.js';
import { accounts, app, auth, doctor, httpToken, scheduler, serve, version, webhooks } from './cli/commands.js';
import { AppError, isAppError } from './errors.js';
import { errorMessage } from './redact.js';

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith('-')) {
    if (first === '--version' || first === '-v') return version();
    return serve(argv);
  }
  switch (first) {
    case 'serve': return serve(rest);
    case 'auth': return auth(rest);
    case 'accounts': return accounts(rest);
    case 'app': return app(rest);
    case 'http-token': return httpToken(rest);
    case 'doctor': return doctor(rest);
    case 'version': return version();
    case 'daemon': return runDaemon(rest);
    case 'scheduler': return scheduler(rest);
    case 'webhooks': return webhooks(rest);
    default:
      throw new AppError('INVALID_INPUT', `Unknown command "${first}". Commands: serve, daemon, scheduler, webhooks, auth, accounts, app, http-token, doctor, version.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Startup/CLI failures: one line on stderr, nothing on stdout, exit 1.
    const message = isAppError(error) ? `${error.code}: ${errorMessage(error)}${error.action ? ` (${error.action})` : ''}` : errorMessage(error);
    process.stderr.write(`instagram-mcp: ${message.replace(/\s*\n\s*/g, ' ')}\n`);
    process.exit(1);
  }
);
