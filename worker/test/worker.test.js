import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArticles, decodeEntities, classifyStudy, cleanTerm, searchPubMed, parseInput, fetchPaper } from '../src/pubmed.js';
import { linkCitations, assembleSummary, evidenceLine, evidenceNote, pluralize, parseCards } from '../src/prompt.js';
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

// ── evidence-first retrieval ───────────────────────────────────────────────
const efetchIds = (f) => new URL(f.calls.find((c) => c.url.includes('efetch.fcgi')).url).searchParams.get('id').split(',');

test('cleanTerm removes PubMed field/grouping syntax', () => {
  assert.equal(cleanTerm('  cancer [tiab]  (immunotherapy) '), 'cancer tiab immunotherapy');
  assert.equal(cleanTerm('[] ()'), '');
});

test('searchPubMed: evidence-pass results come first, duplicates removed, one efetch', async () => {
  const f = makeFetch({ strongIds: ['11111111'], ids: { esearchresult: { idlist: ['22222222', '11111111'] } } });
  const arts = await searchPubMed('vitamin D', { fetchImpl: f });
  assert.deepEqual(arts.map((a) => a.pmid), ['11111111', '22222222']);
  assert.deepEqual(efetchIds(f), ['11111111', '22222222']);
  assert.equal(f.calls.filter((c) => c.url.includes('efetch.fcgi')).length, 1);
  // the evidence pass asks for pooled analyses and trials from the last 10 years
  const strongCall = f.calls.find((c) => decodeURIComponent(c.url).includes('[pt]'));
  const q = decodeURIComponent(strongCall.url);
  assert.match(q, /meta-analysis\[pt\]/);
  assert.match(q, /randomized controlled trial\[pt\]/);
  assert.match(q, new RegExp(`"${new Date().getUTCFullYear() - 10}"\\[dp\\]`));
});

test('searchPubMed: if the evidence pass fails, ordinary results are still returned', async () => {
  const f = makeFetch({ strongStatus: 500 });
  const arts = await searchPubMed('vitamin D', { fetchImpl: f });
  assert.equal(arts.length, 2);
});

test('searchPubMed: if the ordinary search fails, it throws', async () => {
  await assert.rejects(searchPubMed('vitamin D', { fetchImpl: makeFetch({ pubmedStatus: 503 }) }), /PubMed request failed/);
});

test('searchPubMed: a topic that cleans to nothing makes no request', async () => {
  const f = makeFetch();
  assert.deepEqual(await searchPubMed('[] ()', { fetchImpl: f }), []);
  assert.equal(f.calls.length, 0);
});

test('evidenceNote reads the study mix honestly', () => {
  const a = (studyType) => ({ studyType });
  assert.match(evidenceNote([a('Narrative review'), a('Meta-analysis')]), /pooled evidence/);
  assert.match(evidenceNote([a('Randomized controlled trial'), a('Narrative review')]), /clinical trials, but no pooled/);
  assert.match(evidenceNote([a('Narrative review'), a('Research article')]), /treat this as background, not proof/);
});

test('summary Sources section includes the evidence note', () => {
  const arts = parseArticles(XML); // meta-analysis + observational
  assert.match(assembleSummary('## x', arts), /Includes pooled evidence/);
});

test('pluralize handles the labels we produce', () => {
  assert.equal(pluralize('meta-analysis'), 'meta-analyses');
  assert.equal(pluralize('cohort study'), 'cohort studies');
  assert.equal(pluralize('case-control study'), 'case-control studies');
  assert.equal(pluralize('randomized controlled trial'), 'randomized controlled trials');
  assert.equal(pluralize('narrative review'), 'narrative reviews');
});

test('evidence line uses correct plurals', () => {
  const a = (studyType) => ({ studyType });
  assert.match(evidenceLine([a('Meta-analysis'), a('Meta-analysis'), a('Cohort study'), a('Cohort study'), a('Case report')]), /2 meta-analyses, 2 cohort studies, 1 case report\./);
});

test('searchPubMed retries a 429 and then succeeds', async () => {
  let n = 0;
  const base = makeFetch();
  const flaky = async (url, init) => {
    if (String(url).includes('efetch.fcgi') && n++ < 1) return new Response('slow down', { status: 429 });
    return base(url, init);
  };
  const arts = await searchPubMed('vitamin D', { fetchImpl: flaky });
  assert.equal(arts.length, 2);
  assert.equal(n, 2);
});

test('parseInput recognises PMIDs, PubMed links and DOIs, and ignores topics', () => {
  assert.deepEqual(parseInput('39552387'), { kind: 'pmid', value: '39552387' });
  assert.deepEqual(parseInput('PMID: 39552387'), { kind: 'pmid', value: '39552387' });
  assert.deepEqual(parseInput('https://pubmed.ncbi.nlm.nih.gov/39552387/'), { kind: 'pmid', value: '39552387' });
  assert.deepEqual(parseInput('pubmed.ncbi.nlm.nih.gov/39552387/?term=x'), { kind: 'pmid', value: '39552387' });
  assert.deepEqual(parseInput('https://www.ncbi.nlm.nih.gov/pubmed/12345678'), { kind: 'pmid', value: '12345678' });
  assert.deepEqual(parseInput('10.1017/S0033291724001234'), { kind: 'doi', value: '10.1017/S0033291724001234' });
  assert.deepEqual(parseInput('doi:10.1038/s41586-020-2649-2'), { kind: 'doi', value: '10.1038/s41586-020-2649-2' });
  assert.deepEqual(parseInput('https://doi.org/10.1038/s41586-020-2649-2.'), { kind: 'doi', value: '10.1038/s41586-020-2649-2' });
  assert.equal(parseInput('vitamin D and depression'), null);
  assert.equal(parseInput('COVID-19 2021'), null);
  assert.equal(parseInput('https://evil.example/pubmed.ncbi.nlm.nih.gov/123'), null);
  assert.equal(parseInput(''), null);
});

test('summarize: pasted PMID fetches that one paper (no search) and summarizes it', async () => {
  const f = makeFetch({ openaiText: 'Finding [PMID 11111111].' });
  const res = await makeHandler({ fetchImpl: f })(post('/summarize', { topic: 'https://pubmed.ncbi.nlm.nih.gov/11111111/' }), env());
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /pubmed\.ncbi\.nlm\.nih\.gov\/11111111/);
  assert.match(body, /Based on 1 PubMed abstract/);
  assert.equal(f.calls.filter((c) => c.url.includes('esearch')).length, 0);
  assert.equal(f.calls.filter((c) => c.url.includes('api.openai.com')).length, 1);
  const sent = JSON.parse(f.calls.find((c) => c.url.includes('api.openai.com')).init.body);
  assert.match(sent.messages[1].content, /one specific paper \(PMID 11111111\)/);
});

test('summarize: pasted DOI is resolved with a quoted [AID] search', async () => {
  const f = makeFetch({ ids: { esearchresult: { idlist: ['11111111'] } } });
  const res = await makeHandler({ fetchImpl: f })(post('/summarize', { topic: 'doi:10.1000/abc.123' }), env());
  assert.equal(res.status, 200);
  const search = f.calls.find((c) => c.url.includes('esearch'));
  assert.match(decodeURIComponent(search.url), /"10\.1000\/abc\.123"\[AID\]/);
});

test('summarize: unknown DOI says not found, with no OpenAI call', async () => {
  const f = makeFetch({ ids: { esearchresult: { idlist: [] } } });
  const res = await makeHandler({ fetchImpl: f })(post('/summarize', { topic: '10.1000/nope' }), env());
  assert.match(await res.text(), /Paper not found/);
  assert.equal(f.calls.filter((c) => c.url.includes('api.openai.com')).length, 0);
});

test('summarize: paper with no abstract is explained, not invented', async () => {
  const xml = XML.slice(XML.indexOf('<PubmedArticle><MedlineCitation><PMID Version="1">33333333'));
  const f = makeFetch({ xml: '<PubmedArticleSet>' + xml });
  const res = await makeHandler({ fetchImpl: f })(post('/summarize', { topic: '33333333' }), env());
  assert.match(await res.text(), /No abstract available/);
  assert.equal(f.calls.filter((c) => c.url.includes('api.openai.com')).length, 0);
});

test('summarize: pasted paper still counts against the rate limit', async () => {
  const h = makeHandler({ fetchImpl: makeFetch() });
  const e = env({ SUMMARIZE_PER_MINUTE: '1' });
  assert.equal((await h(post('/summarize', { topic: '22222222' }), e)).status, 200);
  assert.equal((await h(post('/summarize', { topic: '22222222' }), e)).status, 429);
});

const CARD_TEXT = `Q: What did the meta-analysis find?
A: Small reductions in depressive symptoms [PMID 11111111](https://pubmed.ncbi.nlm.nih.gov/11111111/).

Q: What is a meta-analysis?
A: A study that pools results from many trials. [PMID 11111111]

Q: Why is this only background?
A: Abstracts cannot show everything.
It also has limits.

Q: bad
A: x`;

test('parseCards parses Q/A blocks, strips citations, drops malformed cards', () => {
  const cards = parseCards(CARD_TEXT);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].back, 'Small reductions in depressive symptoms.');
  assert.equal(cards[1].back, 'A study that pools results from many trials.');
  assert.equal(cards[2].back, 'Abstracts cannot show everything. It also has limits.');
  assert.deepEqual(parseCards('nonsense'), []);
});

const SUMMARY = '## In plain English\n' + 'Vitamin D may modestly reduce depressive symptoms. '.repeat(8);

test('flashcards: returns JSON cards, one OpenAI call, same origin and limits rules', async () => {
  const f = makeFetch({ openaiText: CARD_TEXT });
  const h = makeHandler({ fetchImpl: f });
  const e = env({ CARDS_PER_MINUTE: '1' });
  const res = await h(post('/flashcards', { summary: SUMMARY }), e);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cards.length, 3);
  assert.equal(f.calls.filter((c) => c.url.includes('api.openai.com')).length, 1);
  assert.equal((await h(post('/flashcards', { summary: SUMMARY }), e)).status, 429);
  assert.equal((await h(post('/flashcards', { summary: 'short' }), env())).status, 400);
  assert.equal((await h(post('/flashcards', { summary: SUMMARY }, { Origin: 'https://evil.example' }), env())).status, 403);
});

test('flashcards: unusable model output gives a friendly 502', async () => {
  const f = makeFetch({ openaiText: 'I cannot do that.' });
  const res = await makeHandler({ fetchImpl: f })(post('/flashcards', { summary: SUMMARY }), env());
  assert.equal(res.status, 502);
});

const NDJSON = { Accept: 'application/x-ndjson' };
const lines = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

test('summarize stream: real stages in order, then the same markdown as the plain response', async () => {
  const f = makeFetch({ openaiText: 'Finding [PMID 11111111].' });
  const res = await makeHandler({ fetchImpl: f })(post('/summarize', { topic: 'vitamin D immunity' }, NDJSON), env());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /x-ndjson/);
  const ev = await lines(res);
  assert.deepEqual(ev.map((e) => e.stage || e.event), ['search', 'abstracts', 'write', 'done']);
  assert.equal(ev[1].count, 2);
  const plain = await (await makeHandler({ fetchImpl: makeFetch({ openaiText: 'Finding [PMID 11111111].' }) })(post('/summarize', { topic: 'vitamin D immunity' }), env())).text();
  assert.equal(ev[3].markdown, plain);
});

test('summarize stream: no results ends with done and never reaches the writing stage', async () => {
  const f = makeFetch({ ids: { esearchresult: { idlist: [] } } });
  const ev = await lines(await makeHandler({ fetchImpl: f })(post('/summarize', { topic: 'zzzzqqqq nonsense' }, NDJSON), env()));
  assert.deepEqual(ev.map((e) => e.stage || e.event), ['search', 'done']);
  assert.match(ev[1].markdown, /No studies found/);
});

test('summarize stream: upstream failure is an error event; limits and bad input stay plain JSON errors', async () => {
  const bad = makeFetch({ openaiStatus: 500 });
  const ev = await lines(await makeHandler({ fetchImpl: bad })(post('/summarize', { topic: 'vitamin D' }, NDJSON), env()));
  assert.equal(ev.at(-1).event, 'error');
  assert.doesNotMatch(JSON.stringify(ev), /sk-test|OpenAI 500/);
  const h = makeHandler({ fetchImpl: makeFetch() });
  assert.equal((await h(post('/summarize', { topic: 'a' }, NDJSON), env())).status, 400);
  const e = env({ SUMMARIZE_PER_MINUTE: '1' });
  await (await h(post('/summarize', { topic: 'vitamin D' }, NDJSON), e)).text();
  const limited = await h(post('/summarize', { topic: 'vitamin D' }, NDJSON), e);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('content-type'), /json/);
});

// ─── Compare feature tests ────────────────────────────────────────────────────

// The shape the prompt asks for and compare.html reads. (compare.test.js covers what happens when the model strays from it.)
const COMPARE_JSON = {
  papers: [
    { pmid: '11111111', study_type: 'Meta-analysis', population: 'About 4,000 adults', methods: 'Pooled 12 trials', main_finding: 'Risk fell 12%', limitations: 'Doses differed between trials' },
    { pmid: '22222222', study_type: 'Cohort study', population: 'Adults', methods: 'Observational follow-up', main_finding: 'Positive correlation', limitations: 'Confounding is possible' },
  ],
  synthesis: {
    summary: 'Both papers support vitamin D benefits.',
    agreements: [{ point: 'Both report a benefit.', pmids: ['11111111', '22222222'] }],
    disagreements: [{ point: 'The size of the effect differs.', pmids: ['11111111', '22222222'] }],
  },
  research_gaps: ['Long-term RCTs needed', 'Paediatric populations understudied'],
};

test('compare/search: happy path returns 10 papers from PubMed', async () => {
  const f = makeFetch();
  const res = await makeHandler({ fetchImpl: f })(post('/compare/search', { topic: 'vitamin D immunity' }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const { papers } = await res.json();
  assert.ok(Array.isArray(papers));
  assert.ok(papers.length > 0);
  assert.ok(papers.every((p) => p.pmid && p.title));
  // confirm cache is disabled
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('compare/search: missing or bad topic returns 400 without hitting PubMed', async () => {
  const f = makeFetch();
  const h = makeHandler({ fetchImpl: f });
  const r1 = await h(post('/compare/search', { topic: 'ab' }), env());
  assert.equal(r1.status, 400);
  const r2 = await h(post('/compare/search', {}), env());
  assert.equal(r2.status, 400);
  assert.equal(f.calls.filter((c) => c.url.includes('ncbi')).length, 0);
});

test('compare: happy path with 2 valid PMIDs returns structured comparison', async () => {
  const f = makeFetch({ openaiText: JSON.stringify(COMPARE_JSON) });
  const res = await makeHandler({ fetchImpl: f })(post('/compare', { pmids: ['11111111', '22222222'] }), env());
  assert.equal(res.status, 200);
  const { comparison } = await res.json();
  assert.ok(Array.isArray(comparison.papers));
  assert.equal(comparison.papers.length, 2);
  assert.equal(comparison.synthesis.summary, 'Both papers support vitamin D benefits.');
  assert.deepEqual(comparison.synthesis.agreements, ['Both report a benefit.']);
  // each point also says which of the selected papers it comes from
  assert.deepEqual(comparison.synthesis.cited_pmids, { agreements: [['11111111', '22222222']], disagreements: [['11111111', '22222222']] });
  assert.ok(Array.isArray(comparison.research_gaps));
  // titles / years should come from PubMed metadata
  const p = comparison.papers.find((x) => x.pmid === '11111111');
  assert.equal(p.title, 'Vitamin D & immunity: a meta-analysis of 12 trials.');
  assert.equal(p.main_finding, 'Risk fell 12%');
});

test('compare: duplicate PMIDs are de-duplicated; 1 unique PMID returns 400', async () => {
  const f = makeFetch();
  const res = await makeHandler({ fetchImpl: f })(post('/compare', { pmids: ['11111111', '11111111', '11111111'] }), env());
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /2 to 5/);
});

test('compare: invalid PMIDs (non-numeric) are stripped; too few valid → 400', async () => {
  const f = makeFetch();
  const h = makeHandler({ fetchImpl: f });
  // all invalid
  const r1 = await h(post('/compare', { pmids: ['abc', 'xyz', '!!!'] }), env());
  assert.equal(r1.status, 400);
  // one valid, one invalid → still only 1 valid → 400
  const r2 = await h(post('/compare', { pmids: ['11111111', 'notapmid'] }), env());
  assert.equal(r2.status, 400);
});

test('compare: abstracts missing for fetched papers → 400 with descriptive message', async () => {
  // XML with no <Abstract> blocks → parseArticles returns 0 usable articles
  const noAbstractXml = `<?xml version="1.0"?><PubmedArticleSet>
    <PubmedArticle><MedlineCitation><PMID Version="1">11111111</PMID>
    <Article><Journal><Title>J</Title></Journal><ArticleTitle>T</ArticleTitle></Article>
    </MedlineCitation></PubmedArticle>
    <PubmedArticle><MedlineCitation><PMID Version="1">22222222</PMID>
    <Article><Journal><Title>J</Title></Journal><ArticleTitle>T2</ArticleTitle></Article>
    </MedlineCitation></PubmedArticle>
  </PubmedArticleSet>`;
  const f = makeFetch({ xml: noAbstractXml });
  const res = await makeHandler({ fetchImpl: f })(post('/compare', { pmids: ['11111111', '22222222'] }), env());
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /abstract/i);
});

test('compare: malformed JSON from OpenAI returns 502', async () => {
  const f = makeFetch({ openaiText: 'not json at all' });
  const res = await makeHandler({ fetchImpl: f })(post('/compare', { pmids: ['11111111', '22222222'] }), env());
  assert.equal(res.status, 502);
  const { error } = await res.json();
  assert.match(error, /parse/i);
  // must not leak raw model output or API key
  assert.doesNotMatch(error, /sk-test|not json/i);
});

test('compare: rate limit is enforced per visitor', async () => {
  // COMPARE_PER_MINUTE=1 → second request in same window is 429
  const e = env({ COMPARE_PER_MINUTE: '1' });
  const h = makeHandler({ fetchImpl: makeFetch({ openaiText: JSON.stringify(COMPARE_JSON) }) });
  const first = await h(post('/compare/search', { topic: 'vitamin D' }), e);
  assert.equal(first.status, 200);
  const second = await h(post('/compare/search', { topic: 'vitamin D' }), e);
  assert.equal(second.status, 429);
  assert.match(second.headers.get('content-type'), /json/);
  assert.ok(second.headers.get('Retry-After'));
});
