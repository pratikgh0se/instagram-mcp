import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import type { ActionSpec } from './registry.js';

/** Throws POLICY_DENIED when the action may not run under the current policy (read_only / disabled_actions). */
export function assertPolicyAllows(ctx: AppContext, action: Pick<ActionSpec, 'name' | 'policyKey'>): void {
  const policy = ctx.config.policy;
  const disabled: string[] = policy.disabled_actions;
  if (policy.read_only) {
    throw new AppError('POLICY_DENIED', 'Policy read_only is enabled; write actions are blocked.', {
      action: 'Set policy.read_only to false in the config to allow writes.',
      details: { action: action.name, reason: 'read_only' }
    });
  }
  const key = action.policyKey ?? action.name;
  if (disabled.includes(key) || disabled.includes(action.name)) {
    throw new AppError('POLICY_DENIED', `Action "${key}" is disabled by policy.disabled_actions.`, {
      action: `Remove "${key}" from policy.disabled_actions in the config to allow it.`,
      details: { action: action.name, reason: 'disabled_action' }
    });
  }
}

export function isDryRun(ctx: AppContext): boolean {
  return ctx.config.policy.dry_run;
}
