import { AppError } from '../errors.js';
import type { AccountConfig, Config, LoginPath } from './schema.js';

export interface ResolvedAccount {
  alias: string;
  login: LoginPath;
  ig_user_id: string | null;
  page_id: string | null;
  token_in_header: boolean;
  is_default: boolean;
}

function toResolved(config: Config, a: AccountConfig): ResolvedAccount {
  const def = defaultAccountAlias(config);
  return {
    alias: a.alias,
    login: a.login,
    ig_user_id: a.ig_user_id ?? null,
    page_id: a.page_id ?? null,
    token_in_header: config.token_in_header,
    is_default: def !== null && def.toLowerCase() === a.alias.toLowerCase()
  };
}

export function defaultAccountAlias(config: Config): string | null {
  if (config.default_account) return config.default_account;
  if (config.accounts.length === 1) return config.accounts[0]!.alias;
  return null;
}

export function listAccounts(config: Config): ResolvedAccount[] {
  return config.accounts.map((a) => toResolved(config, a));
}

/** Resolve an alias (or ig_user_id) to a configured account; absent alias means the default account. */
export function resolveAccount(config: Config, alias?: string | null): ResolvedAccount {
  if (alias) {
    const hit = config.accounts.find((a) => a.alias === alias);
    if (!hit) {
      const allowed = config.accounts.map((a) => a.alias);
      throw new AppError('ACCOUNT_NOT_ALLOWED', `Account "${alias}" is not configured.`, {
        action: `Use one of: ${allowed.join(', ') || '(none configured; run `instagram-mcp accounts add`)'}.`,
        details: { allowed }
      });
    }
    return toResolved(config, hit);
  }
  const def = defaultAccountAlias(config);
  if (def) return resolveAccount(config, def);
  if (config.accounts.length === 0) {
    throw new AppError('CONFIG_INVALID', 'No Instagram account is configured.', {
      action: 'Run `instagram-mcp accounts add --alias <name> --login instagram` then `instagram-mcp auth set-token --account <name>`.'
    });
  }
  throw new AppError('CONFIG_INVALID', 'Several accounts are configured and none is the default; pass "account".', {
    action: `Set default_account in the config, or pass account as one of: ${config.accounts.map((a) => a.alias).join(', ')}.`
  });
}
