import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticles, decodeEntities, classifyStudy } from '../src/pubmed.js';
import { linkCitations, assembleSummary, evidenceLine } from '../src/prompt.js';
import { makeHandler, validTopic } from '../src/index.js';
import { XML, makeFetch, makeLimiterNs } from './fixtures.js';

const ORIGIN = 'https://medsumai.com';
const env = (extra = {}) => ({ OPENAI_API_KEY: 'sk-test', IP_SALT: 's', LIMITER: makeLimiterNs(), ...extra });
const post = (path, body, headers = {}) =>
  new Request('https://api.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '1.2.3.4', ...headers }, body: JSON.stringify(body) });

test('parseArticles reads fields, joins labelled abstract, skips articles without abstract', () => {
  const a = parseArticles(XML);
  assert.equal(a.length, 2);
  assert.equal(a[0].pmid, '11111111');
  assert.equal(a[0].title, 'Vitamin D & immunity: a meta-analysis of 12 trials.');
  assert.match(a[0].abstract, /^BACKGROUND: Vitamin D may affect immune function\. RESULTS: Risk fell by 12% \(95% CI 0\.8-0\.95; p < 0\.01\)/);
  assert.equal(a[0].journal, 'Journal of Tests');
  assert.equal(a[0].year, '2023');
  assert.equal(a[0].studyType, 'Meta-analysis');
  assert.equal(a[1].year, '2021'); // from MedlineDate
  assert.equal(a[1].studyType, 'Observational study');
});

test('decodeEntities handles named and numeric entities, ampersand last', () => {
  assert.equal(decodeEntities('a &amp;lt; b &#946; &#x3b1;'), 'a &lt; b β α');
});

test('classifyStudy picks the strongest design', () => {
  assert.equal(classifyStudy(['Journal Article', 'Review', 'Systematic Review']), 'Systematic review');
  assert.equal(classifyStudy(['Journal Article']), 'Research article');
});

test('linkCitations links valid PMIDs and drops invented ones', () => {
  const arts = parseArticles(XML);
  const out = linkCitations('Risk fell [PMID 11111111]. Fake claim [PMID 99999999]. Both [PMIDs 11111111, 22222222].', arts);
  assert.match(out, /\[PMID 11111111\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/11111111\/\)\./);
  assert.ok(!out.includes('99999999'));
  assert.match(out, /\[PMID 22222222\]\(https/);
});

test('assembleSummary appends code-generated sources and evidence line', () => {
  const arts = parseArticles(XML);
  const out = assembleSummary('## In plain English\nHello [PMID 11111111]', arts);
  assert.match(out, /## Sources\nBased on 2 PubMed abstracts: 1 meta-analysis, 1 observational study\./);
  assert.match(out, /1\. Vitamin D & immunity/);
  assert.equal(evidenceLine([arts[0]]).startsWith('Based on 1 PubMed abstract:'), true);
});

test('validTopic', () => {
  assert.equal(validTopic('  CRISPR   gene  therapy '), 'CRISPR gene therapy');
  assert.equal(validTopic('ab'), null);
  assert.equal(validTopic('12345 !!!'), null);
  assert.equal(validTopic('x'.repeat(201)), null);
  assert.equal(validTopic({}), null);
});

test('summarize: happy path returns markdown with verified sources, calls OpenAI once', async () => {
  const f = makeFetch({ openaiText: '## In plain English\nIt works [PMID 11111111] [PMID 00000000].' });
  const res = await makeHandler({ fetchImpl: f })(post('/summarize', { topic: 'vitamin D immunity', level: 'premed' }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const text = await res.text();
  assert.match(text, /\[PMID 11111111\]\(https/);
  assert.ok(!text.includes('00000000'));
  assert.match(text, /## Sources/);
  const oa = f.calls.filter((c) => c.url.includes('openai'));
  assert.equal(oa.length, 1);
  const payload = JSON.parse(oa[0].init.body);
  assert.equal(payload.model, 'gpt-5-mini');
  assert.equal(payload.reasoning_effort, 'minimal');
  assert.match(payload.messages[1].content, /pre-med or medical student/);
  assert.equal(oa[0].init.headers.Authorization, 'Bearer sk-test');
});

test('summarize: no PubMed results means no OpenAI call', async () => {
  const f = makeFetch({ ids: { esearchresult: { idlist: [] } } });
  const res = await makeHandler({ fetchImpl: f })(post('/summarize', { topic: 'zzzzqqqq nonsense' }), env());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /No studies found/);
  assert.equal(f.calls.filter((c) => c.url.includes('openai')).length, 0);
});

test('summarize: bad input and bad origin rejected before any outside call', async () => {
  const f = makeFetch();
  const h = makeHandler({ fetchImpl: f });
  assert.equal((await h(post('/summarize', { topic: 'a' }), env())).status, 400);
  assert.equal((await h(post('/summarize', { topic: 'valid topic' }, { Origin: 'https://evil.example' }), env())).status, 403);
  const bad = new Request('https://api.test/summarize', { method: 'POST', headers: { Origin: ORIGIN }, body: 'not json' });
  assert.equal((await h(bad, env())).status, 400);
  assert.equal(f.calls.length, 0);
});

test('summarize: per-minute limit returns 429 with Retry-After, before PubMed/OpenAI', async () => {
  const f = makeFetch();
  const h = makeHandler({ fetchImpl: f });
  const e = env({ SUMMARIZE_PER_MINUTE: '2' });
  assert.equal((await h(post('/summarize', { topic: 'vitamin D' }), e)).status, 200);
  assert.equal((await h(post('/summarize', { topic: 'vitamin D' }), e)).status, 200);
  const before = f.calls.length;
  const res = await h(post('/summarize', { topic: 'vitamin D' }), e);
  assert.equal(res.status, 429);
  assert.ok(res.headers.get('Retry-After'));
  assert.equal(f.calls.length, before);
});

test('limits are per visitor: another IP is unaffected', async () => {
  const h = makeHandler({ fetchImpl: makeFetch() });
  const e = env({ SUMMARIZE_PER_MINUTE: '1' });
  assert.equal((await h(post('/summarize', { topic: 'vitamin D' }), e)).status, 200);
  assert.equal((await h(post('/summarize', { topic: 'vitamin D' }), e)).status, 429);
  assert.equal((await h(post('/summarize', { topic: 'vitamin D' }, { 'CF-Connecting-IP': '9.9.9.9' }), e)).status, 200);
});

test('global daily cap stops everyone and says so', async () => {
  const h = makeHandler({ fetchImpl: makeFetch() });
  const e = env({ SUMMARIZE_PER_DAY_GLOBAL: '1' });
  assert.equal((await h(post('/summarize', { topic: 'vitamin D' }), e)).status, 200);
  const res = await h(post('/summarize', { topic: 'vitamin D' }, { 'CF-Connecting-IP': '5.5.5.5' }), e);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /daily limit/);
});

test('no raw IP is stored: limiter keys contain only a hash', async () => {
  const e = env();
  await makeHandler({ fetchImpl: makeFetch() })(post('/summarize', { topic: 'vitamin D' }), e);
  for (const k of e.LIMITER._store.keys()) assert.ok(!k.includes('1.2.3.4'), k);
});

test('upstream failures give friendly 502s, never raw errors', async () => {
  const h = makeHandler({ fetchImpl: makeFetch({ openaiStatus: 500 }) });
  const r1 = await h(post('/summarize', { topic: 'vitamin D' }), env());
  assert.equal(r1.status, 502);
  assert.ok(!JSON.stringify(await r1.json()).includes('OpenAI'));
  const h2 = makeHandler({ fetchImpl: makeFetch({ pubmedStatus: 503 }) });
  assert.equal((await h2(post('/summarize', { topic: 'vitamin D' }), env())).status, 502);
});

test('chat: validates and answers', async () => {
  const f = makeFetch({ openaiText: 'Short answer [PMID 11111111].' });
  const h = makeHandler({ fetchImpl: f });
  const summary = '## In plain English\nVitamin D may help immunity. '.repeat(3);
  assert.equal((await h(post('/chat', { question: '', summary }), env())).status, 400);
  assert.equal((await h(post('/chat', { question: 'q?', summary: 'short' }), env())).status, 400);
  assert.equal((await h(post('/chat', { question: 'x'.repeat(501), summary }), env())).status, 400);
  const res = await h(post('/chat', { question: 'Is it safe?', summary }), env());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Short answer/);
});

test('CORS preflight, health, 404', async () => {
  const h = makeHandler({ fetchImpl: makeFetch() });
  const pre = await h(new Request('https://api.test/summarize', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env());
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(await (await h(new Request('https://api.test/health'), env())).text(), 'ok');
  assert.equal((await h(post('/nope', {}), env())).status, 404);
});
