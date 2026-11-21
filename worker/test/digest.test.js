import test from 'node:test';
import assert from 'node:assert/strict';
import { isoWeek, pickTopic, topicList, DEFAULT_TOPICS, renderDigest, runDigest, handleUnsubscribe, sendAll } from '../src/digest.js';
import { makeHandler, scheduled } from '../src/index.js';
import { makeFetch, makeLimiterNs } from './fixtures.js';

const TOKEN = '123e4567-e89b-12d3-a456-426614174000';
const MD = `## In plain English
Trials suggest it helps. [PMID 11111111](https://pubmed.ncbi.nlm.nih.gov/11111111/) <script>alert(1)</script> [click](https://evil.example/x)

## Key findings
- Risk fell by 12% in a meta-analysis. [PMID 11111111](https://pubmed.ncbi.nlm.nih.gov/11111111/)
- A second finding.
- A third finding.
- A fourth finding that should be cut.

## Sources
Based on 2 PubMed abstracts: 1 meta-analysis, 1 observational study. Abstracts only.

1. Something. [PubMed](https://pubmed.ncbi.nlm.nih.gov/11111111/)`;

const baseEnv = (extra = {}) => ({ SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_KEY: 'svc', OPENAI_API_KEY: 'sk', LIMITER: makeLimiterNs(), ...extra });

function recorder({ recipients = [{ email: 'a@x.com', unsubscribe_token: TOKEN }], resendStatus = 200, unsubResult = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rpc/digest_recipients')) return new Response(JSON.stringify(recipients), { status: 200 });
    if (String(url).includes('/rpc/unsubscribe_by_token')) return new Response(JSON.stringify(unsubResult), { status: 200 });
    if (String(url).includes('api.resend.com')) return new Response('{}', { status: resendStatus });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl, resendCalls: () => calls.filter((c) => c.url.includes('resend.com')) };
}
const deps = (rec, once = (() => { const seen = new Set(); return async (k) => (seen.has(k) ? false : (seen.add(k), true)); })()) => ({ fetchImpl: rec.fetchImpl, summarize: async () => ({ markdown: MD }), once });

test('isoWeek handles year boundaries and pickTopic is stable within a week', () => {
  assert.equal(isoWeek(new Date('2026-01-01T12:00:00Z')).key, '2026-W01');
  assert.equal(isoWeek(new Date('2021-01-03T12:00:00Z')).key, '2020-W53');
  const t = DEFAULT_TOPICS;
  assert.equal(pickTopic(t, new Date('2026-11-16T01:00:00Z')), pickTopic(t, new Date('2026-11-22T23:00:00Z')));
  assert.ok(t.includes(pickTopic(t, new Date('2026-11-23T01:00:00Z'))));
  assert.deepEqual(topicList({ DIGEST_TOPICS: 'a topic | another one' }), ['a topic', 'another one']);
});

test('renderDigest escapes everything, keeps only PubMed links, shows 3 findings and the unsubscribe link', () => {
  const m = renderDigest({ topic: 'x <img src=x onerror=alert(1)>', markdown: MD, unsubscribeUrl: `https://api.medsumai.com/unsubscribe?token=${TOKEN}`, week: '2026-W47' });
  assert.ok(!m.html.includes('<script>') && !m.html.includes('<img src=x'));
  assert.ok(!m.html.includes('evil.example'));
  assert.equal((m.html.match(/<li /g) || []).length, 3);
  assert.ok(!m.html.includes('fourth finding'));
  assert.match(m.html, new RegExp(`unsubscribe\\?token=${TOKEN}`));
  assert.match(m.html, /not medical advice/i);
  assert.match(m.text, /Unsubscribe: https:\/\/api\.medsumai\.com\/unsubscribe/);
  const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(links.every((l) => /^https:\/\/(pubmed\.ncbi\.nlm\.nih\.gov|medsumai\.com|api\.medsumai\.com)(\/|$)/.test(l)), links.join(' '));
});

test('digest does nothing unless enabled, and is a dry run unless DIGEST_DRY_RUN is exactly "false"', async () => {
  const rec = recorder();
  assert.deepEqual(await runDigest(baseEnv(), deps(rec)), { skipped: 'disabled' });
  assert.deepEqual(await runDigest(baseEnv({ DIGEST_ENABLED: 'false' }), deps(rec)), { skipped: 'disabled' });
  for (const dry of [undefined, 'true', 'FALSE', '0', '']) {
    const r = await runDigest(baseEnv({ DIGEST_ENABLED: 'true', DIGEST_DRY_RUN: dry, RESEND_API_KEY: 'k', DIGEST_FROM: 'a@b.c' }), deps(rec));
    assert.equal(r.dryRun, true, `dry run for ${dry}`);
    assert.equal(r.recipients, 1);
  }
  assert.equal(rec.resendCalls().length, 0, 'no email was sent');
});

test('live send: one message per subscriber with unsubscribe headers, and only once per week', async () => {
  const rec = recorder({ recipients: [{ email: 'a@x.com', unsubscribe_token: TOKEN }, { email: 'b@x.com', unsubscribe_token: '223e4567-e89b-12d3-a456-426614174000' }] });
  const env = baseEnv({ DIGEST_ENABLED: 'true', DIGEST_DRY_RUN: 'false', RESEND_API_KEY: 'rk', DIGEST_FROM: 'MedSumAI <digest@medsumai.com>' });
  const d = deps(rec);
  const now = new Date('2026-11-23T16:00:00Z');
  const r = await runDigest(env, d, now);
  assert.equal(r.sent, 2);
  const body = JSON.parse(rec.resendCalls()[0].init.body);
  assert.equal(body.length, 2);
  assert.equal(body[0].to[0], 'a@x.com');
  assert.match(body[0].headers['List-Unsubscribe'], new RegExp(TOKEN));
  assert.match(body[1].html, /223e4567-e89b-12d3-a456-426614174000/);
  assert.ok(!body[0].html.includes('b@x.com'));
  assert.equal(body[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(rec.resendCalls()[0].init.headers.Authorization, 'Bearer rk');
  const again = await runDigest(env, d, now);
  assert.deepEqual(again, { skipped: 'already sent this week', week: r.week });
  assert.equal(rec.resendCalls().length, 1);
});

test('live send needs its settings, skips bad summaries and empty lists, and batches by 100', async () => {
  const rec = recorder();
  const live = { DIGEST_ENABLED: 'true', DIGEST_DRY_RUN: 'false' };
  assert.deepEqual((await runDigest(baseEnv(live), deps(rec))).missing, ['RESEND_API_KEY', 'DIGEST_FROM']);
  const full = baseEnv({ ...live, RESEND_API_KEY: 'k', DIGEST_FROM: 'a@b.c' });
  assert.equal((await runDigest(full, { ...deps(rec), summarize: async () => ({ error: 'x' }) })).skipped, 'no usable summary');
  assert.equal((await runDigest(full, { ...deps(rec), summarize: async () => ({ markdown: '## No studies found' }) })).skipped, 'no usable summary');
  const none = recorder({ recipients: [] });
  assert.equal((await runDigest(full, deps(none))).skipped, 'no subscribers');
  const msgs = Array.from({ length: 205 }, (_, i) => ({ to: [`u${i}@x.com`] }));
  const big = recorder();
  assert.equal(await sendAll(full, msgs, big.fetchImpl), 205);
  assert.deepEqual(big.resendCalls().map((c) => JSON.parse(c.init.body).length), [100, 100, 5]);
  const failing = recorder({ resendStatus: 500 });
  await assert.rejects(() => sendAll(full, msgs.slice(0, 3), failing.fetchImpl), /send 500/);
});

test('unsubscribe: GET only shows a confirm button, POST unsubscribes, bad tokens never reach the database', async () => {
  const rec = recorder();
  const env = baseEnv();
  const get = await handleUnsubscribe(new Request(`https://api.test/unsubscribe?token=${TOKEN}`), env, { fetchImpl: rec.fetchImpl });
  assert.match(await get.text(), /Yes, unsubscribe me/);
  assert.equal(rec.calls.length, 0, 'a link scanner opening the link changes nothing');
  const post = await handleUnsubscribe(new Request(`https://api.test/unsubscribe?token=${TOKEN}`, { method: 'POST' }), env, { fetchImpl: rec.fetchImpl });
  assert.match(await post.text(), /You are unsubscribed/);
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(JSON.parse(rec.calls[0].init.body), { p_token: TOKEN });
  assert.equal(rec.calls[0].init.headers.apikey, 'svc');
  for (const bad of ['', 'abc', "' or 1=1 --", TOKEN + 'x']) {
    const r = await handleUnsubscribe(new Request(`https://api.test/unsubscribe?token=${encodeURIComponent(bad)}`, { method: 'POST' }), env, { fetchImpl: rec.fetchImpl });
    assert.match(await r.text(), /not valid/);
  }
  assert.equal(rec.calls.length, 1);
  const xss = await handleUnsubscribe(new Request(`https://api.test/unsubscribe?token=${encodeURIComponent('"><script>alert(1)</script>')}`), env, { fetchImpl: rec.fetchImpl });
  assert.ok(!(await xss.text()).includes('<script>alert'));
});

test('the Worker serves /unsubscribe to mail clients (no Origin) and one-click POSTs, with the page not indexable', async () => {
  const rec = recorder();
  const h = makeHandler({ fetchImpl: rec.fetchImpl });
  const res = await h(new Request(`https://api.test/unsubscribe?token=${TOKEN}`, { method: 'POST', headers: { 'CF-Connecting-IP': '9.9.9.9' } }), baseEnv());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /unsubscribed/);
  const page = await h(new Request(`https://api.test/unsubscribe?token=${TOKEN}`), baseEnv());
  assert.match(await page.text(), /noindex/);
});

test('admin preview: hidden without the token, never sends, and returns the email HTML', async () => {
  const rec = recorder();
  const f = makeFetch({ openaiText: '## In plain English\nTrials suggest it helps. [PMID 11111111]\n\n## Key findings\n- Risk fell. [PMID 11111111]' });
  const fetchImpl = async (url, init) => (String(url).includes('sb.test') || String(url).includes('resend') ? rec.fetchImpl(url, init) : f(url, init));
  const h = makeHandler({ fetchImpl });
  const env = baseEnv({ DIGEST_ADMIN_TOKEN: 'secret-token-123', RESEND_API_KEY: 'k', DIGEST_FROM: 'a@b.c', DIGEST_DRY_RUN: 'false' });
  const req = (auth) => new Request('https://api.test/admin/digest-preview', { method: 'POST', headers: auth ? { Authorization: auth } : {} });
  assert.equal((await h(req(), env)).status, 404);
  assert.equal((await h(req('Bearer wrong-token-12345'), env)).status, 404);
  assert.equal((await h(req('Bearer secret-token-123'), { ...env, DIGEST_ADMIN_TOKEN: undefined })).status, 404);
  const ok = await h(req('Bearer secret-token-123'), env);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.dryRun, true, JSON.stringify(body).slice(0, 300));
  assert.match(body.html, /Unsubscribe/);
  assert.equal(rec.resendCalls().length, 0);
});

test('scheduled handler is inert by default', async () => {
  const rec = recorder();
  const r = await scheduled({}, baseEnv(), {}, { fetchImpl: rec.fetchImpl });
  assert.deepEqual(r, { skipped: 'disabled' });
  assert.equal(rec.calls.length, 0);
});
