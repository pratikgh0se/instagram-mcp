import type { LoginPath } from '../config/index.js';

/**
 * Resumable video upload (rupload.facebook.com), facebook login path only. The publish unit implements
 * this; the interface and URL resolution live here so the foundation fixes the seam.
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
  const host = env.INSTAGRAM_MCP_RUPLOAD_URL?.trim().replace(/\/+$/, '') || 'https://rupload.facebook.com';
  return `${host}/ig-api-upload/${version}`;
}

export function supportsRupload(login: LoginPath): boolean {
  return login === 'facebook';
}
