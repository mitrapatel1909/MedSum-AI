// POST /compare: what happens to the model's answer before it reaches the reader.
// PubMed and the model are fakes (see fixtures.js). The two usable PubMed papers there are
// 11111111 (a meta-analysis) and 22222222 (a cohort study); 33333333 has no abstract.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateComparison, COMPARE_FIELDS, POINT_FIELDS } from '../src/compare.js';
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

// ── Which papers each point comes from ────────────────────────────────────────
// Every agreement and disagreement is asked to name the selected papers it rests on. What is said is checked as
// far as it can be (the papers must be among the selected ones) and the rest is dropped. None of it can make an
// answer fail.

const point = (text, pmids) => ({ point: text, pmids });
const synth = (agreements, disagreements = []) => ({ summary: 'Summary.', agreements, disagreements });
const pointsAnswer = (agreements, disagreements) => answer(BOTH(), { synthesis: synth(agreements, disagreements) });
const cited = (agreements, disagreements) => validateComparison(pointsAnswer(agreements, disagreements), ARTICLES).comparison.synthesis.cited_pmids;

test('compare: each agreement and disagreement says which of the selected papers it comes from', async () => {
  const model = pointsAnswer(
    [point('Both report a benefit.', ['11111111', '22222222']), point('Only the review looked at doses.', ['11111111'])],
    [point('The size of the effect differs.', ['22222222', '11111111'])]
  );
  const { res, body } = await ask(model);
  assert.equal(res.status, 200);
  assert.deepEqual(body.comparison.synthesis, {
    summary: 'Summary.',
    agreements: ['Both report a benefit.', 'Only the review looked at doses.'],
    disagreements: ['The size of the effect differs.'],
    cited_pmids: { agreements: [['11111111', '22222222'], ['11111111']], disagreements: [['11111111', '22222222']] },
  });
});

test('compare: the papers a point names come back in the order the reader selected them', async () => {
  const { body } = await ask(pointsAnswer([point('Both report a benefit.', ['11111111', '22222222'])]), ['22222222', '11111111']);
  assert.deepEqual(body.comparison.papers.map((p) => p.pmid), ['22222222', '11111111']);
  assert.deepEqual(body.comparison.synthesis.cited_pmids.agreements, [['22222222', '11111111']]);
});

test('compare: an answer that names no papers is exactly what it was before this existed', async () => {
  const { res, body } = await ask(answer(BOTH()));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body.comparison.synthesis), ['summary', 'agreements', 'disagreements']);
  assert.deepEqual(body.comparison.synthesis, SYNTHESIS);
});

test('compare: a paper that was not selected is dropped from a point, and the point stays', async () => {
  const { res, body } = await ask(pointsAnswer([point('Both report a benefit.', ['99999999', '11111111', '22222222']), point('A claim about nothing selected.', ['99999999'])]));
  assert.equal(res.status, 200);
  assert.deepEqual(body.comparison.synthesis.agreements, ['Both report a benefit.', 'A claim about nothing selected.']);
  assert.deepEqual(body.comparison.synthesis.cited_pmids, { agreements: [['11111111', '22222222'], []], disagreements: [] });
  assert.doesNotMatch(JSON.stringify(body), /99999999/);
});

test('compare: when no point names a selected paper there is no cited_pmids at all, and the answer still stands', async () => {
  const { res, body } = await ask(pointsAnswer([point('Both report a benefit.', ['99999999']), point('Another.', [])], [point('Differs.', undefined)]));
  assert.equal(res.status, 200);
  assert.deepEqual(body.comparison.synthesis, { summary: 'Summary.', agreements: ['Both report a benefit.', 'Another.'], disagreements: ['Differs.'] });
});

test('compare: a point naming papers is counted in the log when others name none, without any of the text', async () => {
  console.warn.mock.resetCalls();
  await ask(pointsAnswer([point('Secret wording A.', ['11111111']), point('Secret wording B.', [])], [point('Secret wording C.', ['99999999'])]));
  await ask(pointsAnswer([point('Named.', ['11111111', '22222222'])]));
  await ask(answer(BOTH())); // the older shape names nothing: 2 points, both unnamed
  const lines = console.warn.mock.calls.map((c) => c.arguments.join(' '));
  assert.deepEqual(lines, ['compare: 2 of 3 points named no selected paper', 'compare: 2 of 2 points named no selected paper']);
  assert.doesNotMatch(lines.join(' '), /Secret|1111|9999/);
});

test('validateComparison: PMIDs may be numbers, prefixed, padded, or listed in one string', () => {
  const both = [['11111111', '22222222']];
  for (const written of [
    ['11111111', '22222222'],
    [11111111, 22222222],
    ['PMID: 11111111', 'PMID 22222222'],
    [' 11111111 ', '\n22222222\n'],
    '11111111, 22222222',
    'PMID: 11111111; PMID: 22222222',
    '11111111 and 22222222',
    ['PMID11111111', 'PMID22222222'],
  ]) {
    assert.deepEqual(cited([point('Both.', written)]).agreements, both, JSON.stringify(written));
  }
});

test('validateComparison: a number is a PMID only when it stands alone', () => {
  // Two nine-digit PMIDs, and a longer number that is just those two written back to back.
  const nine = [{ ...ARTICLES[0], pmid: '123456789' }, { ...ARTICLES[1], pmid: '987654321' }];
  const named = (pmids) => validateComparison(answer([row('123456789'), row('987654321')], { synthesis: synth([point('x', pmids)]) }), nine).comparison.synthesis.cited_pmids;
  assert.equal(named('123456789987654321'), undefined);
  assert.equal(named('1234567890'), undefined); // ten digits: not 123456789 with a stray 0
  assert.deepEqual(named('PMID:123456789.').agreements, [['123456789']]);
  assert.equal(named(['2021', '3', '1.5']), undefined);
});

test('validateComparison: the same paper named twice is named once', () => {
  assert.deepEqual(cited([point('x', ['22222222', 22222222, 'PMID: 22222222'])]).agreements, [['22222222']]);
});

test('validateComparison: a plain-text point is still a point, and can sit beside ones that name papers', () => {
  const r = validateComparison(pointsAnswer(['A plain sentence.', point('A sentence with a paper.', ['22222222'])], ['Plain again.']), ARTICLES);
  assert.deepEqual(r.comparison.synthesis.agreements, ['A plain sentence.', 'A sentence with a paper.']);
  assert.deepEqual(r.comparison.synthesis.cited_pmids, { agreements: [[], ['22222222']], disagreements: [[]] });
});

test('validateComparison: text and papers stay in step when a point has to be dropped', () => {
  const r = validateComparison(
    pointsAnswer([point('', ['11111111']), point('   ', ['11111111']), null, 7, point('Kept.', ['22222222']), { pmids: ['11111111'] }, { point: { not: 'text' }, pmids: ['11111111'] }]),
    ARTICLES
  );
  assert.deepEqual(r.comparison.synthesis.agreements, ['7', 'Kept.']);
  assert.deepEqual(r.comparison.synthesis.cited_pmids.agreements, [[], ['22222222']]);
});

test('validateComparison: the 8-point limit applies to the papers too', () => {
  const many = Array.from({ length: 12 }, (_, i) => point(`Point ${i + 1}`, [i % 2 ? '11111111' : '22222222']));
  const s = validateComparison(pointsAnswer(many, many), ARTICLES).comparison.synthesis;
  assert.equal(s.agreements.length, 8);
  assert.equal(s.cited_pmids.agreements.length, 8);
  assert.equal(s.disagreements.length, 8);
  assert.equal(s.cited_pmids.disagreements.length, 8);
  assert.deepEqual(s.cited_pmids.agreements[7], ['11111111']);
});

test('validateComparison: other names for the sentence and the papers are understood, and nothing else is kept', () => {
  const r = validateComparison(
    pointsAnswer([
      { text: 'Said as text.', pmid: '11111111' },
      { claim: 'Said as a claim.', pmids: 22222222 },
      { point: 'Extras.', pmids: ['11111111'], quote: 'Invented quote', confidence: 0.99, url: 'https://evil.example/x' },
    ]),
    ARTICLES
  );
  assert.deepEqual(r.comparison.synthesis.agreements, ['Said as text.', 'Said as a claim.', 'Extras.']);
  assert.deepEqual(r.comparison.synthesis.cited_pmids.agreements, [['11111111'], ['22222222'], ['11111111']]);
  assert.doesNotMatch(JSON.stringify(r.comparison), /Invented quote|0\.99|evil\.example/);
});

test('validateComparison: the sentence is cleaned like any other model text, whatever it is called', () => {
  const messy = '  Both \n report\u0000 a   benefit. ';
  const s = validateComparison(pointsAnswer([point(messy, ['11111111']), point('word '.repeat(200), ['22222222']), { text: messy, pmids: ['11111111'] }, { claim: messy, pmids: ['11111111'] }]), ARTICLES).comparison.synthesis;
  assert.equal(s.agreements[0], 'Both report a benefit.');
  assert.ok(s.agreements[1].length <= 501 && s.agreements[1].endsWith('…'));
  assert.deepEqual(s.agreements.slice(2), ['Both report a benefit.', 'Both report a benefit.']);
  assert.deepEqual(s.cited_pmids.agreements, [['11111111'], ['22222222'], ['11111111'], ['11111111']]);
});

test('validateComparison: nothing the model writes about the papers behind a point can make the answer fail', () => {
  for (const pmids of [null, undefined, '', 'none', 5, true, {}, [], [null], [{}], [['11111111']], [[]], { 11111111: true }, ['PMID'], [false, 0]]) {
    const r = validateComparison(pointsAnswer([point('Still here.', pmids)], [{ point: 'And here.', pmids }]), ARTICLES);
    assert.equal(r.ok, true, JSON.stringify(pmids));
    assert.deepEqual(r.comparison.synthesis.agreements, ['Still here.']);
    assert.deepEqual(r.comparison.synthesis.disagreements, ['And here.']);
    assert.equal('cited_pmids' in r.comparison.synthesis, false, JSON.stringify(pmids));
  }
});

test('validateComparison: says how many points there were and how many named no selected paper', () => {
  const count = (a, d) => validateComparison(pointsAnswer(a, d), ARTICLES).points;
  assert.deepEqual(count([point('a', ['11111111']), point('b', []), 'c'], [point('d', ['99999999']), point('e', ['22222222'])]), { total: 5, unnamed: 3 });
  assert.deepEqual(count([], []), { total: 0, unnamed: 0 });
  assert.deepEqual(validateComparison(answer(BOTH(), { synthesis: 'Both agree.' }), ARTICLES).points, { total: 0, unnamed: 0 });
});

// ── The prompt and the validator must agree ───────────────────────────────────

test('the prompt asks for exactly the keys the validator reads (a new key in one must be added to the other)', () => {
  const system = buildCompareMessages(ARTICLES)[0].content;
  const asked = [...new Set([...system.matchAll(/"([a-z_]+)"\s*:/g)].map((m) => m[1]))].sort();
  const read = ['papers', 'pmid', ...COMPARE_FIELDS, 'synthesis', 'summary', 'agreements', 'disagreements', ...POINT_FIELDS, 'research_gaps'].sort();
  assert.deepEqual(asked, read);
});

test('the prompt tells the model to name the papers behind each point, from the PMIDs it was given', () => {
  const system = buildCompareMessages(ARTICLES)[0].content;
  assert.match(system, /list in pmids the PMID of each paper that point rests on/);
  assert.match(system, /only PMIDs that appear in <articles>/);
  // The model-facing JSON is not the page-facing one: cited_pmids is made by the code, never asked for.
  assert.doesNotMatch(system, /cited_pmids/);
});
