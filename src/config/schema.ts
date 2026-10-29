import { z } from 'zod';

export const loginPathSchema = z.enum(['instagram', 'facebook']);
export type LoginPath = z.infer<typeof loginPathSchema>;

/** Action names usable in policy.disabled_actions (contract 1.13.1). */
export const ACTION_NAMES = [
  'publish', 'delete_media', 'set_comments_enabled', 'comment_actions', 'reply_mention',
  'send_message', 'set_messaging_profile', 'respond_collab_invite'
] as const;

export const accountSchema = z.object({
  alias: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'alias must match ^[a-z0-9][a-z0-9_-]{0,31}$'),
  login: loginPathSchema,
  ig_user_id: z.string().min(1).nullish(),
  page_id: z.string().min(1).nullish()
});
export type AccountConfig = z.infer<typeof accountSchema>;

export const secretsBackendSchema = z.enum(['keychain', 'encrypted-file', 'env']);
export type SecretsBackend = z.infer<typeof secretsBackendSchema>;

export const defaultBackend = (): SecretsBackend => (process.platform === 'darwin' ? 'keychain' : 'encrypted-file');

export const configSchema = z.strictObject({
  graph_api_version: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),
  default_account: z.string().nullish(),
  accounts: z.array(accountSchema).default([]),
  app: z.object({ app_id: z.string().nullish() }).default({}),
  secrets: z.object({ backend: secretsBackendSchema.default(defaultBackend()) }).default({ backend: defaultBackend() }),
  policy: z
    .object({
      read_only: z.boolean().default(false),
      dry_run: z.boolean().default(false),
      disabled_actions: z.array(z.enum(ACTION_NAMES)).default([]),
      approval_ttl_seconds: z.number().int().min(1).max(86400).default(600),
      allow_human_agent_tag: z.boolean().default(false)
    })
    .default({ read_only: false, dry_run: false, disabled_actions: [], approval_ttl_seconds: 600, allow_human_agent_tag: false }),
  media_host: z
    .object({ public_base_url: z.string().url().nullish().transform((v) => (v ? v.replace(/\/+$/, '') : v)), port: z.number().int().min(1).max(65535).default(8766) })
    .default({ public_base_url: null, port: 8766 }),
  http: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(0).max(65535).default(8765),
      allow_remote: z.boolean().default(false),
      allowed_origins: z.array(z.string()).default([]),
      allowed_hosts: z.array(z.string()).default([])
    })
    .default({ host: '127.0.0.1', port: 8765, allow_remote: false, allowed_origins: [], allowed_hosts: [] }),
  scheduler: z
    .object({
      container_lead_minutes: z.number().int().min(0).max(1380).default(10),
      missed_grace_minutes: z.number().int().min(0).default(60)
    })
    .default({ container_lead_minutes: 10, missed_grace_minutes: 60 }),
  webhooks: z
    .object({ enabled: z.boolean().default(false), path: z.string().default('/webhooks/instagram') })
    .default({ enabled: false, path: '/webhooks/instagram' }),
  snapshots: z.object({ daily_hour_local: z.number().int().min(0).max(23).default(6) }).default({ daily_hour_local: 6 }),
  token_in_header: z.boolean().default(false),
  downloads_dir: z.string().nullish()
});

export type Config = z.infer<typeof configSchema>;
