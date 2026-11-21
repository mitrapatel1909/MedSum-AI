// Weekly digest: pick this week's topic, write a cited summary with the normal pipeline,
// and email it to active subscribers. Disabled unless DIGEST_ENABLED === 'true', and it only
// really sends when DIGEST_DRY_RUN === 'false' (anything else previews without sending).

const SITE = 'https://medsumai.com';
const API = 'https://api.medsumai.com';
const PUBMED = /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d{1,9}\/?$/;

export const DEFAULT_TOPICS = [
  'vitamin D and depression',
  'type 2 diabetes treatment',
  'antibiotic resistance',
  'Alzheimer disease treatment',
  'cancer immunotherapy',
  'CRISPR gene therapy sickle cell disease',
  'gut microbiome health',
  'sleep deprivation health effects',
  'intermittent fasting',
  'hypertension treatment',
  'long COVID',
  'GLP-1 drugs obesity',
];

export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week, key: `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}` };
}

export function topicList(env) {
  const raw = (env.DIGEST_TOPICS || '').split('|').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TOPICS;
}

export function pickTopic(topics, date) {
  const { year, week } = isoWeek(date);
  return topics[(year * 53 + week) % topics.length];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let out = '';
  let pos = 0;
  const plain = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    out += plain(text.slice(pos, m.index));
    out += PUBMED.test(m[2]) ? `<a href="${esc(m[2])}" style="color:#2d6a4f">${esc(m[1])}</a>` : esc(m[1]);
    pos = m.index + m[0].length;
  }
  return out + plain(text.slice(pos));
}

function section(md, name) {
  const m = md.match(new RegExp('^##\\s+' + name + '\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))', 'm'));
  return m ? m[1].trim() : '';
}

const stripMd = (t) => t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[PMID[^\]]*\]/g, '').replace(/[*_`]/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\s+/g, ' ').trim();

// Turn the summarizer's Markdown into a short, safe email.
export function renderDigest({ topic, markdown, unsubscribeUrl, week }) {
  const plain = section(markdown, 'In plain English');
  const findings = section(markdown, 'Key findings').split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '')).slice(0, 3);
  const evidence = section(markdown, 'Sources').split('\n')[0] || '';
  const prefill = `${SITE}/?topic=${encodeURIComponent(topic)}`;
  const subject = `This week: what the research says about ${topic}`;
  const bullets = findings.map((f) => `<li style="margin:0 0 10px">${inline(f)}</li>`).join('');
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f5f2ec;font-family:Georgia,'Times New Roman',serif;color:#1a1a18">
<div style="max-width:600px;margin:0 auto;padding:24px 20px">
<p style="font:600 13px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#2d6a4f;margin:0 0 6px">MedSumAI weekly &middot; ${esc(week)}</p>
<h1 style="font-size:28px;line-height:1.2;margin:0 0 16px;font-weight:400">${esc(topic)}: what the research says</h1>
<p style="font-size:17px;line-height:1.6;margin:0 0 18px">${inline(plain)}</p>
${bullets ? `<h2 style="font-size:19px;margin:22px 0 8px;font-weight:400">Key findings</h2><ul style="font-size:16px;line-height:1.55;padding-left:20px;margin:0 0 18px">${bullets}</ul>` : ''}
<p style="font:13px/1.5 Arial,sans-serif;color:#6b6b63;margin:0 0 22px">${esc(stripMd(evidence))}</p>
<p style="margin:0 0 28px"><a href="${esc(prefill)}" style="display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;font:500 15px Arial,sans-serif;padding:12px 22px;border-radius:10px">Summarize this at your level &rarr;</a></p>
<hr style="border:0;border-top:1px solid #ddd9d0;margin:0 0 16px"/>
<p style="font:12px/1.55 Arial,sans-serif;color:#6b6b63;margin:0">AI-written summary of PubMed abstracts. It can contain mistakes and is not medical advice. Check the sources on <a href="${SITE}" style="color:#6b6b63">medsumai.com</a>.<br/>You get this because you joined the MedSumAI mailing list. <a href="${esc(unsubscribeUrl)}" style="color:#6b6b63">Unsubscribe</a>.</p>
</div></body></html>`;
  const text = `${topic}: what the research says\n\n${stripMd(plain)}\n\n${findings.map((f) => '- ' + stripMd(f)).join('\n')}\n\n${stripMd(evidence)}\n\nSummarize this at your level: ${prefill}\n\nAI-written summary of PubMed abstracts. Not medical advice.\nUnsubscribe: ${unsubscribeUrl}\n`;
  return { subject, html, text };
}

export const unsubscribeUrl = (token) => `${API}/unsubscribe?token=${token}`;

function supabaseHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
}

export async function fetchRecipients(env, fetchImpl) {
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/digest_recipients`, { method: 'POST', headers: supabaseHeaders(env), body: '{}' });
  if (!res.ok) throw new Error(`recipients ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r.email === 'string' && /^[0-9a-f-]{36}$/i.test(r.unsubscribe_token)) : [];
}

export async function unsubscribeByToken(env, token, fetchImpl) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token || '')) return { ok: false, reason: 'invalid' };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return { ok: false, reason: 'unavailable' };
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/unsubscribe_by_token`, { method: 'POST', headers: supabaseHeaders(env), body: JSON.stringify({ p_token: token }) });
  if (!res.ok) return { ok: false, reason: 'unavailable' };
  return { ok: true, changed: (await res.json()) === true };
}

// Resend's batch endpoint takes up to 100 messages per call.
export async function sendAll(env, messages, fetchImpl) {
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const res = await fetchImpl('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100)),
    });
    if (!res.ok) throw new Error(`send ${res.status} after ${sent} sent`);
    sent += Math.min(100, messages.length - i);
  }
  return sent;
}

// deps: { fetchImpl, summarize(topic) -> {markdown} | {error}, once(key) -> boolean (true the first time) }
export async function runDigest(env, deps, now = new Date()) {
  if (env.DIGEST_ENABLED !== 'true') return { skipped: 'disabled' };
  const live = env.DIGEST_DRY_RUN === 'false';
  const { key } = isoWeek(now);
  const topic = pickTopic(topicList(env), now);
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', ...(live ? ['RESEND_API_KEY', 'DIGEST_FROM'] : [])].filter((k) => !env[k]);
  if (missing.length) return { skipped: 'missing settings', missing };

  const r = await deps.summarize(topic);
  if (r.error || !r.markdown || !r.markdown.includes('## In plain English')) return { skipped: 'no usable summary', topic };
  const recipients = await fetchRecipients(env, deps.fetchImpl);

  if (!live) {
    const preview = renderDigest({ topic, markdown: r.markdown, unsubscribeUrl: unsubscribeUrl('00000000-0000-0000-0000-000000000000'), week: key });
    return { dryRun: true, week: key, topic, recipients: recipients.length, subject: preview.subject, html: preview.html };
  }
  if (!recipients.length) return { skipped: 'no subscribers', week: key, topic };
  if (!(await deps.once(`digest:${key}`))) return { skipped: 'already sent this week', week: key };

  const messages = recipients.map((rc) => {
    const url = unsubscribeUrl(rc.unsubscribe_token);
    const mail = renderDigest({ topic, markdown: r.markdown, unsubscribeUrl: url, week: key });
    return {
      from: env.DIGEST_FROM, to: [rc.email], subject: mail.subject, html: mail.html, text: mail.text,
      headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    };
  });
  const sent = await sendAll(env, messages, deps.fetchImpl);
  return { sent, week: key, topic };
}

const page = (title, body) => new Response(
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex"/><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;background:#f5f2ec;color:#1a1a18;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-weight:500;font-size:1.4rem">${esc(title)}</h1>${body}</main></body></html>`,
  { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
);

// GET shows a confirm button (so link scanners can't unsubscribe anyone); POST does it (also the one-click header).
export async function handleUnsubscribe(request, env, deps) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  if (request.method === 'POST') {
    const r = await unsubscribeByToken(env, token, deps.fetchImpl);
    if (r.reason === 'invalid') return page('That link is not valid', '<p>Check that you copied the whole link from the email.</p>');
    if (!r.ok) return page('Please try again later', '<p>We could not process that right now.</p>');
    return page('You are unsubscribed', '<p>You will not get the weekly MedSumAI email anymore. <a href="https://medsumai.com">Back to MedSumAI</a></p>');
  }
  if (!/^[0-9a-f-]{36}$/i.test(token)) return page('That link is not valid', '<p>Check that you copied the whole link from the email.</p>');
  return page('Unsubscribe from the weekly email?', `<form method="POST" action="/unsubscribe?token=${esc(token)}"><button style="background:#2d6a4f;color:#fff;border:0;border-radius:10px;padding:12px 22px;font-size:1rem;cursor:pointer">Yes, unsubscribe me</button></form><p style="color:#6b6b63;font-size:.85rem">Changed your mind? Just close this page.</p>`);
}
