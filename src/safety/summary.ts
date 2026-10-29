/**
 * Server-written, plain-language summary of a stored approval preview. Used as `summary` in every preflight result and as
 * the elicitation message at approve. Built only from the stored (already redacted) preview; never from agent prose.
 */
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const cut = (v: unknown, n = 200): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}...` : s;
};

function fileLine(label: string, f: Rec): string {
  const sha = typeof f.sha256 === 'string' ? `${f.sha256.slice(0, 12)}...` : 'n/a';
  if (f.source === 'local') {
    return `${label}: LOCAL FILE ${cut(f.path, 300)} -> real path ${cut(f.real_path, 300)} (${f.bytes ?? '?'} bytes, sha256 ${sha})`;
  }
  return `${label}: URL ${cut(f.url, 300)}`;
}

function publishLines(p: Rec): string[] {
  const lines: string[] = [];
  lines.push(`Publish a ${cut(p.kind)}${p.scheduled === true ? ` SCHEDULED for ${cut(p.publish_at)}` : ' now'}.`);
  lines.push(`Caption (first 200 chars): ${p.caption === null || p.caption === undefined ? '(none)' : cut(p.caption)}`);
  if (Array.isArray(p.media)) for (const m of p.media) if (isRec(m)) lines.push(fileLine(`Media ${m.index ?? ''}`.trim(), m));
  if (isRec(p.cover)) lines.push(fileLine('Cover', p.cover));
  return lines;
}

function messageLines(p: Rec): string[] {
  const lines: string[] = [];
  lines.push(`Send a direct message (${cut(p.kind)}) to recipient ${cut(p.recipient_id)}.`);
  if (p.text !== null && p.text !== undefined) lines.push(`Text (first 200 chars): ${cut(p.text)}`);
  if (isRec(p.media)) lines.push(`Media (${cut(p.media.type)}): ${cut(p.media.url, 300)}`);
  if (Array.isArray(p.quick_replies)) lines.push(`Quick replies: ${p.quick_replies.map((q) => (isRec(q) ? `"${cut(q.title, 40)}" -> payload "${cut(q.payload, 80)}"` : '')).join('; ')}`);
  if (p.reply_to_mid) lines.push(`Reply to message: ${cut(p.reply_to_mid)}`);
  if (isRec(p.reaction)) lines.push(`Reaction: ${cut(p.reaction.action)} ${cut(p.reaction.emoji ?? '')} on message ${cut(p.reaction.message_id)}`);
  if (p.tag) lines.push(`Tag: ${cut(p.tag)}`);
  return lines;
}

export function summarizeApproval(input: { action: string; account: string; target?: string | null; preview: unknown }): string {
  const preview = isRec(input.preview) ? input.preview : {};
  let body: string[];
  if (input.action === 'publish') body = publishLines(preview);
  else if (input.action === 'send_message') body = messageLines(preview);
  else {
    body = [`Action: ${input.action}${input.target ? ` on ${input.target}` : ''}.`];
    for (const [k, v] of Object.entries(preview)) {
      if (v === null || v === undefined) continue;
      body.push(`${k}: ${cut(v)}`);
    }
  }
  return [`Action: ${input.action} | Account: ${input.account}`, ...body].join('\n');
}
