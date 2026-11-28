// What POST /compare trusts from the model, and what it does not.
//
// The model reads the abstracts and writes five short fields per paper plus the synthesis text. That is all
// that is taken from it. Which papers are in the comparison, their order, and every title, year, journal and
// link come from the PubMed records the reader's selection resolved to.
//
// If the model's papers are not exactly those papers, each one once, the whole answer is rejected rather than
// repaired. A table that quietly shows a different paper, or leaves one out, is worse than an error the reader
// can retry.

export const COMPARE_FIELDS = ['study_type', 'population', 'methods', 'main_finding', 'limitations'];

// A field is meant to be one sentence; these only stop a runaway answer from reaching the page.
const MAX_FIELD = 600;
const MAX_SUMMARY = 1200;
const MAX_ITEM = 500;
const MAX_ITEMS = 8;

// Strings are kept; numbers become strings; a list of strings is joined (a model sometimes lists limitations).
// Anything else (null, an object, a boolean) counts as "nothing was said". Control characters and runs of
// whitespace become one space, and a long value is cut at a word with an ellipsis so it is visibly cut.
function text(v, max) {
  let s;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else if (Array.isArray(v)) s = v.filter((x) => typeof x === 'string' || typeof x === 'number').join('; ');
  else return '';
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s.,;:]+$/, '') + '…';
}

function list(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = text(item, MAX_ITEM);
    if (s) out.push(s);
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

// The prompt asks for { summary, agreements, disagreements }. A bare string is an older answer shape, and
// it is the summary.
function synthesisOf(v) {
  if (typeof v === 'string' && v.trim()) v = { summary: v };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return { summary: text(v.summary, MAX_SUMMARY), agreements: list(v.agreements), disagreements: list(v.disagreements) };
}

// "11111111", 11111111 and "PMID: 11111111" all name the same paper. Anything else names nothing.
const pmidOf = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().replace(/^PMID:?\s*/i, '') : '');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// parsed: what the model returned, already JSON-parsed. articles: the PubMed records for the reader's
// selection, in the order they chose them.
// Returns { ok: true, comparison } or { ok: false, reason }, and never throws on any parsed JSON.
// reason is one of: format, unselected_pmid, duplicate_pmid, missing_pmid, empty_paper.
export function validateComparison(parsed, articles) {
  const reject = (reason) => ({ ok: false, reason });

  if (!isObject(parsed) || !Array.isArray(parsed.papers) || !Array.isArray(parsed.research_gaps)) return reject('format');
  const synthesis = synthesisOf(parsed.synthesis);
  if (!synthesis) return reject('format');

  const selected = new Set(articles.map((a) => a.pmid));
  const extracted = new Map();
  for (const p of parsed.papers) {
    if (!isObject(p)) return reject('format');
    const pmid = pmidOf(p.pmid);
    if (!selected.has(pmid)) return reject('unselected_pmid');
    if (extracted.has(pmid)) return reject('duplicate_pmid');
    extracted.set(pmid, p);
  }
  // Every entry is a different selected paper, so the counts match only when every selected paper is there.
  if (extracted.size !== selected.size) return reject('missing_pmid');

  const papers = [];
  for (const a of articles) {
    const p = extracted.get(a.pmid);
    const row = { pmid: a.pmid, title: a.title, year: a.year, journal: a.journal, url: a.url };
    for (const f of COMPARE_FIELDS) row[f] = text(p[f], MAX_FIELD);
    // A row that says nothing about the paper is a failed answer, not a comparison.
    if (!row.population && !row.methods && !row.main_finding && !row.limitations) return reject('empty_paper');
    if (!row.study_type) row.study_type = a.studyType;
    papers.push(row);
  }
  return { ok: true, comparison: { papers, synthesis, research_gaps: list(parsed.research_gaps) } };
}
