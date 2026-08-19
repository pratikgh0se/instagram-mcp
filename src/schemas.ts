import { z } from 'zod';

export const accountInput = z.object({ account_id: z.string().min(1) });
export const analyticsToolInput = accountInput.extend({
  target: z.enum(['account', 'media']), media_id: z.string().min(1).optional(),
  metrics: z.array(z.string().min(1)).min(1), period: z.enum(['day', 'week', 'days_28', 'lifetime']).optional(),
  since: z.string().datetime().optional(), until: z.string().datetime().optional()
});
export const analyticsInput = analyticsToolInput.superRefine((value, ctx) => { if (value.target === 'media' && !value.media_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'media_id is required for media analytics.' }); });
export const listMediaInput = accountInput.extend({ limit: z.number().int().min(1).max(100).optional() });
export const listCommentsInput = accountInput.extend({ media_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() });
export const publishInput = accountInput.extend({
  media_kind: z.enum(['image', 'reel', 'carousel', 'story']),
  assets: z.array(z.object({ url: z.string().url(), media_type: z.enum(['image', 'video']), cover_url: z.string().url().optional() })).min(1),
  caption: z.string().max(2200).optional(), publish_intent: z.literal('public'), confirm: z.literal(true), idempotency_key: z.string().min(16)
});
export const replyInput = accountInput.extend({ comment_id: z.string().min(1), message: z.string().min(1).max(2200), confirm: z.boolean() });
export const moderationInput = accountInput.extend({ comment_id: z.string().min(1), action: z.enum(['hide', 'unhide', 'delete']), confirm: z.boolean() });
export type AnalyticsInput = z.infer<typeof analyticsInput>;
