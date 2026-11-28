// POST /compare: what happens to the model's answer before it reaches the reader.
// PubMed and the model are fakes (see fixtures.js). The two usable PubMed papers there are
// 11111111 (a meta-analysis) and 22222222 (a cohort study); 33333333 has no abstract.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateComparison, COMPARE_FIELDS } from '../src/compare.js';
import { buildCompareMessages } from '../src/prompt.js';
import { parseArticles } from '../src/pubmed.js';
import { makeHandler } from '../src/index.js';
import { XML, makeFetch, makeLimiterNs } from './fixtures.js';

// Rejections are logged; keep the test output quiet and let one test read what was logged.
mock.method(console, 'warn', () => {});

const ORIGIN = 'https://medsumai.com';
const env = () => ({ OPENAI_API_KEY: 'sk-test', IP_SALT: 's', LIMITER: makeLimiterNs() });
const post = (path, body) =>
  new Request('https://api.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });

const ARTICLES = parseArticles(XML); // 11111111, then 22222222

const row = (pmid, over = {}) => ({
  pmid,
  study_type: 'Randomized controlled trial',
  population: `Population ${pmid}`,
  methods: `Methods ${pmid}`,
  main_finding: `Finding ${pmid}`,
  limitations: `Limits ${pmid}`,
  ...over,
});
const SYNTHESIS = { summary: 'Both studies point the same way.', agreements: ['Both report a benefit.'], disagreements: ['The size of the effect differs.'] };
const answer = (papers, over = {}) => ({ papers, synthesis: SYNTHESIS, research_gaps: ['Long-term follow-up is missing.', 'Children were not studied.'], ...over });
const BOTH = () => [row('11111111'), row('22222222')];

const MISMATCH = 'The comparison did not match the papers you selected. Please try again.';
const FORMAT = 'The comparison returned an unexpected format. Please try again.';

// Sends a selection to /compare with the model answering `modelAnswer` (an object, or raw text).
async function ask(modelAnswer, pmids = ['11111111', '22222222']) {
  const f = makeFetch({ openaiText: typeof modelAnswer === 'string' ? modelAnswer : JSON.stringify(modelAnswer) });
  const res = await makeHandler({ fetchImpl: f })(post('/compare', { pmids }), env());
  return { res, body: await res.json() };
}

// ── What the reader gets ──────────────────────────────────────────────────────

test('compare: the comparison holds exactly the selected papers, in the order they were selected', async () => {
  // The model lists them one way; the reader chose 22222222 first.
  const { res, body } = await ask(answer(BOTH()), ['22222222', '11111111']);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Object.keys(body.comparison), ['papers', 'synthesis', 'research_gaps']);
  assert.deepEqual(body.comparison.papers.map((p) => p.pmid), ['22222222', '11111111']);
  assert.deepEqual(body.comparison.papers[0], {
    pmid: '22222222',
    title: 'A cohort study.',
    year: '2021',
    journal: 'Other Journal',
    url: 'https://pubmed.ncbi.nlm.nih.gov/22222222/',
    study_type: 'Randomized controlled trial',
    population: 'Population 22222222',
    methods: 'Methods 22222222',
    main_finding: 'Finding 22222222',
    limitations: 'Limits 22222222',
  });
  assert.deepEqual(body.comparison.synthesis, SYNTHESIS);
  assert.deepEqual(body.comparison.research_gaps, ['Long-term follow-up is missing.', 'Children were not studied.']);
});

test('compare: a title, year, journal or link written by the model is ignored', async () => {
  const lies = { title: 'Invented title', year: '1999', journal: 'Journal of Lies', url: 'https://evil.example/paper' };
  const { res, body } = await ask(answer([row('11111111', lies), row('22222222', lies)]));
  assert.equal(res.status, 200);
  const [a, b] = body.comparison.papers;
  assert.equal(a.title, 'Vitamin D & immunity: a meta-analysis of 12 trials.');
  assert.equal(a.year, '2023');
  assert.equal(a.journal, 'Journal of Tests');
  assert.equal(a.url, 'https://pubmed.ncbi.nlm.nih.gov/11111111/');
  assert.equal(b.url, 'https://pubmed.ncbi.nlm.nih.gov/22222222/');
  assert.doesNotMatch(JSON.stringify(body), /Invented|Journal of Lies|evil\.example|1999/);
});

test('compare: a PMID written as a number, padded, or with a PMID prefix still names the paper', async () => {
  const { res, body } = await ask(answer([row('11111111', { pmid: 11111111 }), row('22222222', { pmid: ' PMID: 22222222 ' })]));
  assert.equal(res.status, 200);
  assert.deepEqual(body.comparison.papers.map((p) => p.pmid), ['11111111', '22222222']);
});

// ── What is rejected ──────────────────────────────────────────────────────────

const mismatched = [
  ['a paper that was not selected is added', answer([...BOTH(), row('99999999', { main_finding: 'Cures everything' })])],
  ['a different paper stands in for a selected one', answer([row('11111111'), row('99999999', { main_finding: 'Cures everything' })])],
  ['a selected paper is left out', answer([row('11111111')])],
  ['a paper is listed twice', answer([row('11111111'), row('11111111')])],
  ['there are no papers at all', answer([])],
  ['a paper has no PMID', answer([row('11111111'), { ...row('22222222'), pmid: undefined }])],
  ['a PMID is not a PMID', answer([row('11111111'), row('22222222', { pmid: 'second paper' })])],
];
for (const [name, model] of mismatched) {
  test(`compare: rejected when ${name}`, async () => {
    const { res, body } = await ask(model);
    assert.equal(res.status, 502);
    assert.deepEqual(body, { error: MISMATCH });
  });
}

const malformed = [
  ['the answer is a list', [row('11111111'), row('22222222')]],
  ['papers is not a list', answer(BOTH(), { papers: 'none' })],
  ['a paper entry is null', answer([row('11111111'), null])],
  ['a paper entry is plain text', answer([row('11111111'), '22222222'])],
  ['there is no synthesis', answer(BOTH(), { synthesis: undefined })],
  ['the synthesis is a list', answer(BOTH(), { synthesis: ['Both agree.'] })],
  ['the synthesis is blank text', answer(BOTH(), { synthesis: '   ' })],
  ['research_gaps is missing', answer(BOTH(), { research_gaps: undefined })],
  ['research_gaps is text', answer(BOTH(), { research_gaps: 'none' })],
  ['a paper has nothing extracted', answer([row('11111111'), { pmid: '22222222' }])],
];
for (const [name, model] of malformed) {
  test(`compare: an unusable answer (${name}) is a friendly 502, not a crash`, async () => {
    const { res, body } = await ask(model);
    assert.equal(res.status, 502);
    assert.deepEqual(body, { error: FORMAT });
  });
}

test('compare: nothing the model made up for a rejected answer is sent to the reader', async () => {
  const { body } = await ask(answer([...BOTH(), row('99999999', { title: 'Made-up trial', main_finding: 'Cures everything' })], { research_gaps: ['Made-up gap'] }));
  assert.deepEqual(Object.keys(body), ['error']);
  assert.doesNotMatch(JSON.stringify(body), /Made-up|Cures everything|99999999/);
});

test('compare: a rejection is logged with its reason and none of the model text', async () => {
  console.warn.mock.resetCalls();
  await ask(answer([row('11111111'), row('99999999', { main_finding: 'Cures everything' })]));
  await ask(answer(BOTH(), { synthesis: undefined }));
  const lines = console.warn.mock.calls.map((c) => c.arguments.join(' '));
  assert.deepEqual(lines, ['compare: model answer rejected (unselected_pmid)', 'compare: model answer rejected (format)']);
});

test('compare: a paper PubMed has no abstract for is left out, and the model cannot add it back', async () => {
  const three = ['11111111', '22222222', '33333333']; // 33333333 has no abstract, so only two are compared
  const invented = await ask(answer([...BOTH(), row('33333333', { main_finding: 'Invented from nothing' })]), three);
  assert.equal(invented.res.status, 502);
  assert.deepEqual(invented.body, { error: MISMATCH });
  const honest = await ask(answer(BOTH()), three);
  assert.equal(honest.res.status, 200);
  assert.deepEqual(honest.body.comparison.papers.map((p) => p.pmid), ['11111111', '22222222']);
});

// ── How the model's text is cleaned (validateComparison directly) ─────────────

test('validateComparison: extracted text is made safe to show, not rewritten', () => {
  const long = 'alpha beta gamma '.repeat(100);
  const r = validateComparison(
    answer([
      row('11111111', { population: '  Adults \n\t with   obesity\u0000 ', methods: 42, main_finding: ['Weight fell', 'BMI fell'], limitations: { note: 'an object' }, study_type: null }),
      row('22222222', { methods: long, population: 'p < 0.05 & <b>kept</b> as written' }),
    ]),
    ARTICLES
  );
  assert.equal(r.ok, true);
  const [a, b] = r.comparison.papers;
  assert.equal(a.population, 'Adults with obesity');
  assert.equal(a.methods, '42');
  assert.equal(a.main_finding, 'Weight fell; BMI fell');
  assert.equal(a.limitations, '');
  assert.equal(a.study_type, 'Meta-analysis'); // the model gave none, so PubMed's own label is used
  assert.ok(b.methods.length <= 601 && /(alpha|beta|gamma)…$/.test(b.methods), 'a long value is cut at a word and marked');
  assert.equal(b.population, 'p < 0.05 & <b>kept</b> as written'); // markup is the page's job to escape; it is not edited here
});

test('validateComparison: lists keep only readable text, and stop at 8 items', () => {
  const many = Array.from({ length: 12 }, (_, i) => `Point ${i + 1}`);
  const r = validateComparison(
    answer(BOTH(), { synthesis: { summary: 'Summary.', agreements: ['Point 1', '', '   ', null, 7, { a: 1 }, 'Point 2'], disagreements: many }, research_gaps: many }),
    ARTICLES
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.comparison.synthesis.agreements, ['Point 1', '7', 'Point 2']);
  assert.equal(r.comparison.synthesis.disagreements.length, 8);
  assert.equal(r.comparison.research_gaps.length, 8);
  assert.equal(r.comparison.research_gaps[7], 'Point 8');
});

test('validateComparison: a bare-text synthesis is the summary, and missing parts are empty, not errors', () => {
  const text = validateComparison(answer(BOTH(), { synthesis: 'Both agree.' }), ARTICLES);
  assert.deepEqual(text.comparison.synthesis, { summary: 'Both agree.', agreements: [], disagreements: [] });
  const bare = validateComparison(answer(BOTH(), { synthesis: {} }), ARTICLES);
  assert.deepEqual(bare.comparison.synthesis, { summary: '', agreements: [], disagreements: [] });
});

test('validateComparison: keys the model adds are dropped', () => {
  const r = validateComparison({ ...answer([row('11111111', { extraction: { x: 1 }, url: 'https://x.test' }), row('22222222')]), debug: 'x', notes: ['y'] }, ARTICLES);
  assert.deepEqual(Object.keys(r.comparison), ['papers', 'synthesis', 'research_gaps']);
  assert.deepEqual(Object.keys(r.comparison.papers[0]), ['pmid', 'title', 'year', 'journal', 'url', ...COMPARE_FIELDS]);
});

test('validateComparison: reports why it said no', () => {
  const why = (m) => validateComparison(m, ARTICLES).reason;
  assert.equal(why(null), 'format');
  assert.equal(why(answer([...BOTH(), row('99999999')])), 'unselected_pmid');
  assert.equal(why(answer([row('11111111'), row('11111111')])), 'duplicate_pmid');
  assert.equal(why(answer([row('11111111')])), 'missing_pmid');
  assert.equal(why(answer([row('11111111'), { pmid: '22222222' }])), 'empty_paper');
});

// ── The prompt and the validator must agree ───────────────────────────────────

test('the prompt asks for exactly the keys the validator reads (a new key in one must be added to the other)', () => {
  const system = buildCompareMessages(ARTICLES)[0].content;
  const asked = [...new Set([...system.matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]))].sort();
  const read = ['papers', 'pmid', ...COMPARE_FIELDS, 'synthesis', 'summary', 'agreements', 'disagreements', 'research_gaps'].sort();
  assert.deepEqual(asked, read);
});
