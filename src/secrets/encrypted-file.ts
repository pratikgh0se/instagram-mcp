import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AppError } from '../errors.js';
import { writePrivateFile } from '../config/load.js';
import { assertSecretValue, type SecretKind, type TokenStore } from './types.js';

interface Entry { iv: string; tag: string; ct: string }
interface FileShape { v: 1; salt?: string; entries: Record<string, Entry> }

/**
 * AES-256-GCM encrypted JSON file (mode 0600). Key: INSTAGRAM_MCP_MASTER_KEY (base64, 32 bytes) or,
 * alternatively, scrypt of INSTAGRAM_MCP_PASSPHRASE with a per-file random salt. The entry name is
 * bound as GCM associated data so entries cannot be swapped.
 */
export class EncryptedFileTokenStore implements TokenStore {
  readonly backend = 'encrypted-file' as const;
  readonly readOnly = false;

  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  private load(): FileShape {
    if (!existsSync(this.file)) return { v: 1, entries: {} };
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as FileShape;
      if (data.v !== 1 || typeof data.entries !== 'object') throw new Error('bad shape');
      return data;
    } catch (cause) {
      throw new AppError('CONFIG_INVALID', `Encrypted secrets file ${this.file} is corrupt.`, { cause });
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
      }
      return scryptSync(pass, Buffer.from(file.salt, 'base64'), 32);
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
      const d = createDecipheriv('aes-256-gcm', this.key(file, false), Buffer.from(entry.iv, 'base64'));
      d.setAAD(Buffer.from(name));
      d.setAuthTag(Buffer.from(entry.tag, 'base64'));
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
    const file = this.load();
    const name = this.name(scope, kind);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key(file, true), iv);
    c.setAAD(Buffer.from(name));
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    file.entries[name] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
    writePrivateFile(this.file, JSON.stringify(file));
  }

  async delete(scope: string, kind: SecretKind): Promise<void> {
    const file = this.load();
    delete file.entries[this.name(scope, kind)];
    writePrivateFile(this.file, JSON.stringify(file));
  }
}
