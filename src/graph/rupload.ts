import { createReadStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { AppError } from '../errors.js';
import { redact } from '../redact.js';
import type { LoginPath } from '../config/index.js';
import { checkUrlOverride } from '../config/load.js';
import { mapMetaError, type MetaErrorBody } from './errors.js';

/**
 * Resumable video upload (rupload.facebook.com), facebook login path only. One POST, never retried:
 * a failure is a definite failure of the (not yet published) container, never an ambiguous outcome.
 */
export interface RuploadUploadInput {
  /** Container id returned by POST /{ig_user_id}/media with upload_type=resumable. */
  containerId: string;
  filePath: string;
  fileSize: number;
  /** Byte offset to resume from (default 0). */
  offset?: number;
}

export interface RuploadClient {
  upload(input: RuploadUploadInput): Promise<{ success: boolean }>;
}

export function ruploadBaseUrl(version: string, env: NodeJS.ProcessEnv = process.env): string {
  const host = checkUrlOverride('INSTAGRAM_MCP_RUPLOAD_URL', env.INSTAGRAM_MCP_RUPLOAD_URL, env)?.replace(/\/+$/, '') || 'https://rupload.facebook.com';
  return `${host}/ig-api-upload/${version}`;
}

export function supportsRupload(login: LoginPath): boolean {
  return login === 'facebook';
}

const RUPLOAD_TIMEOUT_MS = 120_000;

export interface RuploadClientOptions {
  version: string;
  /** Access token; sent as `Authorization: OAuth <token>`. */
  token: string;
  env?: NodeJS.ProcessEnv;
}

function transient(message: string): AppError {
  // Deliberately no details.ambiguous: the upload is not a publish step.
  return new AppError('UPSTREAM_TRANSIENT', redact(message), { retryable: true });
}

export function createRuploadClient(opts: RuploadClientOptions): RuploadClient {
  return {
    upload(input) {
      const offset = input.offset ?? 0;
      const url = new URL(`${ruploadBaseUrl(opts.version, opts.env)}/${input.containerId}`);
      const transport = url.protocol === 'http:' ? http : https;
      const length = Math.max(0, input.fileSize - offset);
      return new Promise((resolve, reject) => {
        const fail = (error: AppError): void => reject(error);
        const req = transport.request(
          url,
          {
            method: 'POST',
            timeout: RUPLOAD_TIMEOUT_MS,
            headers: {
              authorization: `OAuth ${opts.token}`,
              offset: String(offset),
              file_size: String(input.fileSize),
              'content-type': 'application/octet-stream',
              'content-length': String(length)
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('error', () => fail(transient('rupload response failed')));
            res.on('end', () => {
              const status = res.statusCode ?? 0;
              let json: { success?: boolean; error?: MetaErrorBody } | undefined;
              try {
                json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof json;
              } catch {
                json = undefined;
              }
              if (status >= 200 && status < 300 && !json?.error) {
                if (json?.success === true) return resolve({ success: true });
                return fail(new AppError('UPSTREAM_REJECTED', 'Resumable upload was not confirmed by Meta.', { details: { http_status: status } }));
              }
              fail(mapMetaError(status, json?.error));
            });
          }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (error) => fail(transient(`rupload network error: ${error.message}`)));
        const file = createReadStream(input.filePath, { start: offset });
        file.on('error', (error) => req.destroy(error));
        file.pipe(req);
      });
    }
  };
}
