import { execFile, spawn } from 'node:child_process';
import { AppError } from '../errors.js';
import { redact } from '../redact.js';
import { assertSecretValue, type SecretKind, type TokenStore } from './types.js';

const SECURITY = '/usr/bin/security';

function service(): string {
  return process.env.INSTAGRAM_MCP_KEYCHAIN_SERVICE || 'instagram-mcp';
}

/** `security` gets only PATH and HOME: never the master key, tokens or other secrets from our environment. */
function minimalEnv(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };
}

/** Quote one argument for the `security -i` command parser (double quotes, backslash escapes). */
function q(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(SECURITY, args, { encoding: 'utf8', env: minimalEnv() }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code: error ? ((error as unknown as { code: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

/**
 * macOS Keychain via the `security` CLI.
 *
 * Writes use `security -i` (interactive mode) and send the add-generic-password command on STDIN,
 * so the secret never appears in argv or the process listing. Reads pass only service/account in
 * argv; the secret comes back on stdout. Limitation: items created this way carry no per-app ACL, so any process
 * running as the same user can read them with `security find-generic-password -w` without a prompt. Limitation: macOS only; the secret briefly lives in this
 * process's memory and the `security` child's stdin pipe.
 */
export class KeychainTokenStore implements TokenStore {
  readonly backend = 'keychain' as const;
  readonly readOnly = false;

  private account(scope: string, kind: SecretKind): string {
    return `${scope}:${kind}`;
  }

  async get(scope: string, kind: SecretKind): Promise<string | undefined> {
    this.assertPlatform();
    const res = await run(['find-generic-password', '-s', service(), '-a', this.account(scope, kind), '-w']);
    if (res.code === 44) return undefined; // errSecItemNotFound
    if (res.code !== 0) throw this.fail('read', res.stderr);
    const value = res.stdout.replace(/\r?\n$/, '');
    return value || undefined;
  }

  async set(scope: string, kind: SecretKind, value: string): Promise<void> {
    this.assertPlatform();
    assertSecretValue(value);
    const line = `add-generic-password -U -s ${q(service())} -a ${q(this.account(scope, kind))} -w ${q(value)}\n`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'pipe', 'pipe'], env: minimalEnv() });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        // `security -i` exits 0 even when a command fails; failures are reported on stderr.
        if (code !== 0 || /security:|error|SecKeychain/i.test(stderr)) reject(this.fail('write', stderr));
        else resolve();
      });
      child.stdin.end(line);
    });
  }

  async delete(scope: string, kind: SecretKind): Promise<void> {
    this.assertPlatform();
    const res = await run(['delete-generic-password', '-s', service(), '-a', this.account(scope, kind)]);
    if (res.code !== 0 && res.code !== 44) throw this.fail('delete', res.stderr);
  }

  private assertPlatform(): void {
    if (process.platform !== 'darwin') {
      throw new AppError('CONFIG_INVALID', 'The keychain backend is only available on macOS.', {
        action: 'Set secrets.backend to "encrypted-file" (needs INSTAGRAM_MCP_MASTER_KEY) or "env".'
      });
    }
  }

  private fail(op: string, stderr: string): AppError {
    return new AppError('CONFIG_INVALID', `Keychain ${op} failed: ${redact(stderr.trim()) || 'unknown error'}`, {
      action: 'Check that the login keychain is unlocked, or choose another secrets.backend.'
    });
  }
}
