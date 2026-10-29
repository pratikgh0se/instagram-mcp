import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, constants as fsc, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { AppError } from '../errors.js';
import { writePrivateFile } from '../config/load.js';
import { registerSecret } from '../redact.js';
import { assertSecretValue, type SecretKind, type TokenStore } from './types.js';

interface Entry { iv: string; tag: string; ct: string }
interface Kdf { N: number; r: number; p: number }
interface FileShape { v: 1; salt?: string; kdf?: Kdf; entries: Record<string, Entry> }

const TAG_BYTES = 16;
/** Parameters for newly created passphrase files (N=2^17, r=8: about 128 MiB of memory per derivation). */
const NEW_KDF: Kdf = { N: 1 << 17, r: 8, p: 1 };
/** Files written before the kdf field existed used Node's scrypt defaults. They stay readable (and keep these parameters on rewrite). */
const LEGACY_KDF: Kdf = { N: 1 << 14, r: 8, p: 1 };

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * AES-256-GCM encrypted JSON file (mode 0600). Key: INSTAGRAM_MCP_MASTER_KEY (base64, 32 bytes) or,
 * alternatively, scrypt of INSTAGRAM_MCP_PASSPHRASE with a per-file random salt. The entry name is
 * bound as GCM associated data so entries cannot be swapped. Tags must be the full 16 bytes.
 * Read-modify-write cycles hold an exclusive lock file (`<file>.lock`, O_EXCL, stale after 30 s).
 */
export class EncryptedFileTokenStore implements TokenStore {
  readonly backend = 'encrypted-file' as const;
  readonly readOnly = false;
  private derived?: { id: string; key: Buffer };

  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    registerSecret(this.env.INSTAGRAM_MCP_MASTER_KEY?.trim());
    registerSecret(this.env.INSTAGRAM_MCP_PASSPHRASE);
  }

  private load(): FileShape {
    if (!existsSync(this.file)) return { v: 1, entries: {} };
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as FileShape;
      if (data.v !== 1 || typeof data.entries !== 'object' || data.entries === null) throw new Error('bad shape');
      return data;
    } catch (cause) {
      throw new AppError('CONFIG_INVALID', `Encrypted secrets file ${this.file} is corrupt.`, { cause });
    }
  }

  private withLock<T>(fn: () => T): T {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number;
    for (;;) {
      try {
        fd = openSync(lock, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), 0o600);
        writeSync(fd, String(process.pid));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; }
        } catch { continue; /* lock vanished: retry */ }
        if (Date.now() > deadline) {
          throw new AppError('INTERNAL', `Could not lock ${this.file} (held by another process).`, {
            action: `If no instagram-mcp process is running, delete ${lock}.`
          });
        }
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  private key(file: FileShape, createSalt: boolean): Buffer {
    const raw = this.env.INSTAGRAM_MCP_MASTER_KEY?.trim();
    if (raw) {
      const key = Buffer.from(raw, 'base64');
      if (key.length !== 32) {
        throw new AppError('CONFIG_INVALID', 'INSTAGRAM_MCP_MASTER_KEY must be base64 of exactly 32 bytes.', {
          action: 'Generate one with: openssl rand -base64 32'
        });
      }
      return key;
    }
    const pass = this.env.INSTAGRAM_MCP_PASSPHRASE;
    if (pass) {
      if (!file.salt) {
        if (!createSalt) throw new AppError('AUTH_FAILED', 'Encrypted secrets file has no passphrase salt.');
        file.salt = randomBytes(16).toString('base64');
        file.kdf = { ...NEW_KDF };
      }
      const kdf = file.kdf ?? LEGACY_KDF;
      if (![kdf.N, kdf.r, kdf.p].every((n) => Number.isInteger(n) && n > 0) || (kdf.N & (kdf.N - 1)) !== 0 || kdf.N > 1 << 20) {
        throw new AppError('CONFIG_INVALID', `Encrypted secrets file ${this.file} has invalid kdf parameters.`);
      }
      const id = `${file.salt}:${kdf.N}:${kdf.r}:${kdf.p}`;
      if (this.derived?.id !== id) {
        this.derived = { id, key: scryptSync(pass, Buffer.from(file.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }) };
      }
      return this.derived.key;
    }
    throw new AppError('CONFIG_INVALID', 'The encrypted-file backend needs INSTAGRAM_MCP_MASTER_KEY.', {
      action: 'Export INSTAGRAM_MCP_MASTER_KEY=$(openssl rand -base64 32) and keep it somewhere safe.'
    });
  }

  private name(scope: string, kind: SecretKind): string {
    return `${scope}:${kind}`;
  }

  async get(scope: string, kind: SecretKind): Promise<string | undefined> {
    const file = this.load();
    const name = this.name(scope, kind);
    const entry = file.entries[name];
    if (!entry) return undefined;
    try {
      const tag = Buffer.from(entry.tag, 'base64');
      if (tag.length !== TAG_BYTES) throw new Error(`GCM tag must be ${TAG_BYTES} bytes`);
      const d = createDecipheriv('aes-256-gcm', this.key(file, false), Buffer.from(entry.iv, 'base64'), { authTagLength: TAG_BYTES });
      d.setAAD(Buffer.from(name));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(Buffer.from(entry.ct, 'base64')), d.final()]).toString('utf8');
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('AUTH_FAILED', 'Could not decrypt stored secret (wrong master key?).', {
        action: 'Check INSTAGRAM_MCP_MASTER_KEY, or re-run `instagram-mcp auth set-token`.',
        cause
      });
    }
  }

  async set(scope: string, kind: SecretKind, value: string): Promise<void> {
    assertSecretValue(value);
    this.withLock(() => {
      const file = this.load();
      const name = this.name(scope, kind);
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', this.key(file, true), iv, { authTagLength: TAG_BYTES });
      c.setAAD(Buffer.from(name));
      const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      file.entries[name] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
      writePrivateFile(this.file, JSON.stringify(file));
    });
  }

  async delete(scope: string, kind: SecretKind): Promise<void> {
    this.withLock(() => {
      const file = this.load();
      delete file.entries[this.name(scope, kind)];
      writePrivateFile(this.file, JSON.stringify(file));
    });
  }
}
