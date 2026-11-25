// MedSumAI backend: one Cloudflare Worker replacing the public n8n webhooks.
//   POST /summarize  { topic, level? }          -> Markdown summary
//   POST /chat       { question, summary }      -> Markdown answer
//   GET  /health                                -> "ok"
//   GET/POST /unsubscribe?token=...              -> weekly email unsubscribe page
//   POST /admin/digest-preview (Bearer token)    -> dry-run of the weekly email, never sends
// Secrets (set in the Cloudflare dashboard, never in code): OPENAI_API_KEY, IP_SALT. Optional: NCBI_API_KEY.

import { searchPubMed, parseInput, fetchPaper, fetchPapersByPmids } from './pubmed.js';
import { buildSummaryMessages, buildChatMessages, buildCardMessages, parseCards, assembleSummary, buildCompareMessages, DEFAULT_LEVEL, LEVELS } from './prompt.js';
import { runDigest, handleUnsubscribe } from './digest.js';
export { Limiter } from './limiter.js';

const ALLOWED_ORIGINS = ['https://medsumai.com', 'https://www.medsumai.com', 'https://mitrapatel1909.github.io'];
const MAX_BODY_BYTES = 40_000;

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

function limitsFor(env) {
  return {
    summarize: { minute: num(env.SUMMARIZE_PER_MINUTE, 3), hour: num(env.SUMMARIZE_PER_HOUR, 12), day: num(env.SUMMARIZE_PER_DAY_GLOBAL, 800) },
    chat: { minute: num(env.CHAT_PER_MINUTE, 8), hour: num(env.CHAT_PER_HOUR, 40), day: num(env.CHAT_PER_DAY_GLOBAL, 3000) },
    cards: { minute: num(env.CARDS_PER_MINUTE, 3), hour: num(env.CARDS_PER_HOUR, 15), day: num(env.CARDS_PER_DAY_GLOBAL, 600) },
    compare: { minute: num(env.COMPARE_PER_MINUTE, 2), hour: num(env.COMPARE_PER_HOUR, 8), day: num(env.COMPARE_PER_DAY_GLOBAL, 300) },
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
  const paper = typeof body.topic === 'string' ? parseInput(body.topic) : null;
  const topic = paper ? 'one specific paper' : validTopic(body.topic);
  if (!topic) return json(request, 400, { error: 'Please enter a medical or biology topic (3 to 200 characters).' });
  const level = Object.hasOwn(LEVELS, body.level) ? body.level : DEFAULT_LEVEL;

  const lim = await checkLimits(env, 'summarize', await visitorKey(request, env));
  if (!lim.ok) {
    const msg = lim.global ? 'MedSumAI has reached its free daily limit. Please come back tomorrow.' : 'Too many requests. Please wait a bit and try again.';
    return json(request, 429, { error: msg }, { 'Retry-After': String(lim.retryAfter) });
  }

  const job = { env, deps, topic, paper, level };
  const wantsStream = (request.headers.get('Accept') || '').includes('application/x-ndjson');
  if (!wantsStream) {
    const r = await runSummary(job);
    return r.error ? json(request, r.status, { error: r.error }) : markdown(request, r.markdown);
  }

  // Streamed: one JSON object per line, so the page can show real progress.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {});
  (async () => {
    try {
      const r = await runSummary(job, (e) => send({ event: 'stage', ...e }));
      await send(r.error ? { event: 'error', error: r.error } : { event: 'done', markdown: r.markdown });
    } catch {
      await send({ event: 'error', error: 'Something went wrong. Please try again.' });
    } finally {
      writer.close().catch(() => {});
    }
  })();
  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request) },
  });
}

// The real work. Returns { markdown } or { status, error }. emit() reports progress as it happens.
async function runSummary({ env, deps, topic, paper, level }, emit = () => {}) {
  emit({ stage: 'search', paper: Boolean(paper) });
  let articles;
  try {
    if (paper) {
      const r = await fetchPaper(paper, { fetchImpl: deps.fetchImpl, apiKey: env.NCBI_API_KEY });
      if (!r.article) {
        return {
          markdown: r.reason === 'no_abstract'
            ? '## No abstract available\nThat paper is on PubMed but has no abstract, and MedSumAI only summarizes abstracts. Try searching its topic instead.'
            : '## Paper not found\nI could not find that paper on PubMed. Check the PMID, DOI or link, or search its topic instead.',
        };
      }
      articles = [r.article];
    } else {
      articles = await searchPubMed(topic, { fetchImpl: deps.fetchImpl, apiKey: env.NCBI_API_KEY });
    }
  } catch {
    return { status: 502, error: 'PubMed is not responding right now. Please try again shortly.' };
  }
  if (!articles.length) {
    // No model call, so a topic with no research costs nothing.
    return { markdown: `## No studies found\nI could not find PubMed abstracts for **${topic.replace(/[*_`<>[\]]/g, '')}**. Try a more specific medical term, check the spelling, or search a broader topic.` };
  }
  emit({ stage: 'abstracts', count: articles.length });
  emit({ stage: 'write' });
  try {
    const text = await callOpenAI(env, buildSummaryMessages(paper ? `one specific paper (PMID ${articles[0].pmid}): ${articles[0].title}` : topic, articles, level), 1800, deps.fetchImpl);
    return { markdown: assembleSummary(text, articles) };
  } catch {
    return { status: 502, error: 'The summarizer is temporarily unavailable. Please try again in a few minutes.' };
  }
}

// ── Compare Research endpoints ────────────────────────────────────────────────

// POST /compare/search  { topic }
// Returns the first 10 PubMed papers for a topic so the user can select 3-5 to compare.
async function handleCompareSearch(request, env, deps) {
  const { body, error } = await readBody(request);
  if (error) return json(request, 400, { error });
  const topic = validTopic(body.topic);
  if (!topic) return json(request, 400, { error: 'Please enter a medical or biology topic (3 to 200 characters).' });

  const lim = await checkLimits(env, 'compare', await visitorKey(request, env));
  if (!lim.ok) {
    const msg = lim.global ? 'MedSumAI has reached its free daily limit. Please come back tomorrow.' : 'Too many requests. Please wait a bit and try again.';
    return json(request, 429, { error: msg }, { 'Retry-After': String(lim.retryAfter) });
  }

  let articles;
  try {
    articles = await searchPubMed(topic, { fetchImpl: deps.fetchImpl, apiKey: env.NCBI_API_KEY, maxArticles: 10 });
  } catch {
    return json(request, 502, { error: 'PubMed is not responding right now. Please try again shortly.' });
  }
  if (!articles.length) return json(request, 200, { papers: [], message: `No PubMed abstracts found for "${topic}". Try a different topic.` });

  const papers = articles.map((a) => ({
    pmid: a.pmid,
    title: a.title,
    year: a.year,
    journal: a.journal,
    studyType: a.studyType,
    url: a.url,
    snippet: a.abstract.slice(0, 180).replace(/\s+\S*$/, '') + '…',
  }));
  return json(request, 200, { papers }, { 'Cache-Control': 'no-store' });
}

// POST /compare  { pmids: ['12345678', ...] }   (3–5 PMIDs)
// Fetches abstracts, extracts structured data, returns comparison JSON.
async function handleCompare(request, env, deps) {
  const { body, error } = await readBody(request);
  if (error) return json(request, 400, { error });

  const rawPmids = Array.isArray(body.pmids) ? body.pmids : [];
  const pmids = [...new Set(rawPmids.map((p) => String(p || '').trim()).filter((p) => /^\d{1,9}$/.test(p)))];
  if (pmids.length < 2 || pmids.length > 5) return json(request, 400, { error: 'Please select 2 to 5 papers to compare.' });

  const lim = await checkLimits(env, 'compare', await visitorKey(request, env));
  if (!lim.ok) {
    const msg = lim.global ? 'MedSumAI has reached its free daily limit. Please come back tomorrow.' : 'Too many requests. Please wait a bit and try again.';
    return json(request, 429, { error: msg }, { 'Retry-After': String(lim.retryAfter) });
  }

  let articles;
  try {
    articles = await fetchPapersByPmids(pmids, { fetchImpl: deps.fetchImpl, apiKey: env.NCBI_API_KEY });
  } catch {
    return json(request, 502, { error: 'PubMed is not responding right now. Please try again shortly.' });
  }
  if (articles.length < 2) return json(request, 400, { error: 'Could not retrieve abstracts for enough of the selected papers. Please try different papers.' });

  let rawJson;
  try {
    rawJson = await callOpenAI(env, buildCompareMessages(articles), 2400, deps.fetchImpl);
  } catch {
    return json(request, 502, { error: 'The comparison engine is temporarily unavailable. Please try again in a few minutes.' });
  }

  let parsed;
  try {
    // Strip markdown code fences the model may add despite instructions
    const cleaned = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return json(request, 502, { error: 'Could not parse the comparison. Please try again.' });
  }

  if (!parsed || !Array.isArray(parsed.papers) || !parsed.synthesis || !Array.isArray(parsed.research_gaps)) {
    return json(request, 502, { error: 'The comparison returned an unexpected format. Please try again.' });
  }

  // Enrich each extracted paper with the original PubMed metadata
  const byPmid = new Map(articles.map((a) => [a.pmid, a]));
  for (const p of parsed.papers) {
    const orig = byPmid.get(String(p.pmid));
    if (orig) Object.assign(p, { title: orig.title, year: orig.year, journal: orig.journal, url: orig.url });
  }

  return json(request, 200, { comparison: parsed }, { 'Cache-Control': 'no-store' });
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

async function handleCards(request, env, deps) {
  const { body, error } = await readBody(request);
  if (error) return json(request, 400, { error });
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (summary.length < 200 || summary.length > 14000) return json(request, 400, { error: 'Summary missing or too long.' });
  const lim = await checkLimits(env, 'cards', await visitorKey(request, env));
  if (!lim.ok) {
    const msg = lim.global ? 'MedSumAI has reached its free daily limit. Please come back tomorrow.' : 'Too many requests. Please wait a bit and try again.';
    return json(request, 429, { error: msg }, { 'Retry-After': String(lim.retryAfter) });
  }
  try {
    const cards = parseCards(await callOpenAI(env, buildCardMessages(summary), 1500, deps.fetchImpl));
    if (cards.length < 3) return json(request, 502, { error: 'Could not make flashcards from that summary. Please try again.' });
    return json(request, 200, { cards }, { 'Cache-Control': 'no-store' });
  } catch {
    return json(request, 502, { error: 'The summarizer is temporarily unavailable. Please try again in a few minutes.' });
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function digestDeps(env, deps) {
  return {
    fetchImpl: deps.fetchImpl,
    summarize: (topic) => runSummary({ env, deps, topic, paper: null, level: DEFAULT_LEVEL }),
    once: async (key) => (await hit(env, key, 1, 8 * 86400)).ok,
  };
}

// Preview only: forces a dry run, so this route can never send email, and needs the admin token.
async function handleDigestPreview(request, env, deps) {
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.DIGEST_ADMIN_TOKEN || !timingSafeEqual(auth, env.DIGEST_ADMIN_TOKEN)) return json(request, 404, { error: 'Not found.' });
  try {
    const r = await runDigest({ ...env, DIGEST_ENABLED: 'true', DIGEST_DRY_RUN: 'true' }, digestDeps(env, deps));
    return json(request, 200, r, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json(request, 502, { error: 'Preview failed.' });
  }
}

export function makeHandler(deps = { fetchImpl: (...a) => fetch(...a) }) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (request.method === 'GET' && url.pathname === '/health') return new Response('ok', { headers: corsHeaders(request) });

    // Email links and one-click unsubscribe come from mail clients, not from the site, so they skip the origin check.
    if (url.pathname === '/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) return handleUnsubscribe(request, env, deps);
    if (request.method === 'POST' && url.pathname === '/admin/digest-preview') return handleDigestPreview(request, env, deps);

    // Only the real site may call the API from a browser. (Other clients can still try, which is what the limits are for.)
    const origin = request.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(request, 403, { error: 'Origin not allowed.' });

    try {
      if (request.method === 'POST' && url.pathname === '/summarize') return await handleSummarize(request, env, deps);
      if (request.method === 'POST' && url.pathname === '/chat') return await handleChat(request, env, deps);
      if (request.method === 'POST' && url.pathname === '/flashcards') return await handleCards(request, env, deps);
      if (request.method === 'POST' && url.pathname === '/compare/search') return await handleCompareSearch(request, env, deps);
      if (request.method === 'POST' && url.pathname === '/compare') return await handleCompare(request, env, deps);
    } catch {
      return json(request, 500, { error: 'Something went wrong. Please try again.' });
    }
    return json(request, 404, { error: 'Not found.' });
  };
}

const defaultDeps = { fetchImpl: (...a) => fetch(...a) };
export async function scheduled(event, env, ctx, deps = defaultDeps) {
  // Does nothing unless DIGEST_ENABLED=true, and only sends when DIGEST_DRY_RUN=false.
  const result = await runDigest(env, digestDeps(env, deps));
  console.log('digest', JSON.stringify({ ...result, html: undefined }));
  return result;
}

export default { fetch: makeHandler(), scheduled: (event, env, ctx) => ctx.waitUntil(scheduled(event, env, ctx)) };
