// MedSumAI backend: one Cloudflare Worker replacing the public n8n webhooks.
//   POST /summarize  { topic, level? }          -> Markdown summary
//   POST /chat       { question, summary }      -> Markdown answer
//   GET  /health                                -> "ok"
// Secrets (set in the Cloudflare dashboard, never in code): OPENAI_API_KEY, IP_SALT. Optional: NCBI_API_KEY.

import { searchPubMed } from './pubmed.js';
import { buildSummaryMessages, buildChatMessages, assembleSummary, DEFAULT_LEVEL, LEVELS } from './prompt.js';
export { Limiter } from './limiter.js';

const ALLOWED_ORIGINS = ['https://medsumai.com', 'https://www.medsumai.com', 'https://mitrapatel1909.github.io'];
const MAX_BODY_BYTES = 40_000;

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

function limitsFor(env) {
  return {
    summarize: { minute: num(env.SUMMARIZE_PER_MINUTE, 3), hour: num(env.SUMMARIZE_PER_HOUR, 12), day: num(env.SUMMARIZE_PER_DAY_GLOBAL, 800) },
    chat: { minute: num(env.CHAT_PER_MINUTE, 8), hour: num(env.CHAT_PER_HOUR, 40), day: num(env.CHAT_PER_DAY_GLOBAL, 3000) },
  };
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const h = { Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(request, status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request), ...extra } });
}
function markdown(request, text) {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request) } });
}

async function visitorKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const data = new TextEncoder().encode(`${env.IP_SALT || 'msai'}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hit(env, name, limit, windowSec) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName(name));
  const res = await stub.fetch('https://limiter/hit', { method: 'POST', body: JSON.stringify({ limit, windowSec }) });
  return res.json();
}

// Per-visitor limits first, so a single abuser cannot use up the shared daily budget.
async function checkLimits(env, action, who) {
  const L = limitsFor(env)[action];
  const day = new Date().toISOString().slice(0, 10);
  const checks = [
    [`${action}:m:${who}`, L.minute, 60],
    [`${action}:h:${who}`, L.hour, 3600],
    [`${action}:day:${day}`, L.day, 86400],
  ];
  for (const [name, limit, windowSec] of checks) {
    const r = await hit(env, name, limit, windowSec);
    if (!r.ok) return { ok: false, retryAfter: r.retryAfter, global: name.includes(':day:') };
  }
  return { ok: true };
}

async function readBody(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) return { error: 'Request too large.' };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'Request too large.' };
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? { body } : { error: 'Invalid request.' };
  } catch {
    return { error: 'Invalid request.' };
  }
}

export function validTopic(t) {
  if (typeof t !== 'string') return null;
  const topic = t.replace(/\s+/g, ' ').trim();
  if (topic.length < 3 || topic.length > 200) return null;
  if ((topic.match(/\p{L}/gu) || []).length < 3) return null; // needs real words
  return topic;
}

async function callOpenAI(env, messages, maxTokens, fetchImpl = fetch) {
  const model = env.MODEL || 'gpt-5-mini';
  const payload = { model, messages, max_completion_tokens: maxTokens };
  if (/^(gpt-5|o\d)/.test(model)) payload.reasoning_effort = env.REASONING_EFFORT || 'minimal';
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(70_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text || !text.trim()) throw new Error('OpenAI returned no text');
  return text;
}

async function handleSummarize(request, env, deps) {
  const { body, error } = await readBody(request);
  if (error) return json(request, 400, { error });
  const topic = validTopic(body.topic);
  if (!topic) return json(request, 400, { error: 'Please enter a medical or biology topic (3 to 200 characters).' });
  const level = Object.hasOwn(LEVELS, body.level) ? body.level : DEFAULT_LEVEL;

  const lim = await checkLimits(env, 'summarize', await visitorKey(request, env));
  if (!lim.ok) {
    const msg = lim.global ? 'MedSumAI has reached its free daily limit. Please come back tomorrow.' : 'Too many requests. Please wait a bit and try again.';
    return json(request, 429, { error: msg }, { 'Retry-After': String(lim.retryAfter) });
  }

  let articles;
  try {
    articles = await searchPubMed(topic, { fetchImpl: deps.fetchImpl, apiKey: env.NCBI_API_KEY });
  } catch {
    return json(request, 502, { error: 'PubMed is not responding right now. Please try again shortly.' });
  }
  if (!articles.length) {
    // No model call, so a topic with no research costs nothing.
    return markdown(
      request,
      `## No studies found\nI could not find PubMed abstracts for **${topic.replace(/[*_`<>[\]]/g, '')}**. Try a more specific medical term, check the spelling, or search a broader topic.`
    );
  }
  try {
    const text = await callOpenAI(env, buildSummaryMessages(topic, articles, level), 1800, deps.fetchImpl);
    return markdown(request, assembleSummary(text, articles));
  } catch {
    return json(request, 502, { error: 'The summarizer is temporarily unavailable. Please try again in a few minutes.' });
  }
}

async function handleChat(request, env, deps) {
  const { body, error } = await readBody(request);
  if (error) return json(request, 400, { error });
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (question.length < 2 || question.length > 500) return json(request, 400, { error: 'Please ask a shorter question (up to 500 characters).' });
  if (summary.length < 20 || summary.length > 14_000) return json(request, 400, { error: 'Summary missing or too long.' });

  const lim = await checkLimits(env, 'chat', await visitorKey(request, env));
  if (!lim.ok) {
    const msg = lim.global ? 'MedSumAI has reached its free daily limit. Please come back tomorrow.' : 'Too many requests. Please wait a bit and try again.';
    return json(request, 429, { error: msg }, { 'Retry-After': String(lim.retryAfter) });
  }
  try {
    return markdown(request, await callOpenAI(env, buildChatMessages(question, summary), 700, deps.fetchImpl));
  } catch {
    return json(request, 502, { error: 'The summarizer is temporarily unavailable. Please try again in a few minutes.' });
  }
}

export function makeHandler(deps = { fetchImpl: (...a) => fetch(...a) }) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (request.method === 'GET' && url.pathname === '/health') return new Response('ok', { headers: corsHeaders(request) });

    // Only the real site may call the API from a browser. (Other clients can still try, which is what the limits are for.)
    const origin = request.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(request, 403, { error: 'Origin not allowed.' });

    try {
      if (request.method === 'POST' && url.pathname === '/summarize') return await handleSummarize(request, env, deps);
      if (request.method === 'POST' && url.pathname === '/chat') return await handleChat(request, env, deps);
    } catch {
      return json(request, 500, { error: 'Something went wrong. Please try again.' });
    }
    return json(request, 404, { error: 'Not found.' });
  };
}

export default { fetch: makeHandler() };
