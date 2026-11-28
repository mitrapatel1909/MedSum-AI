// What POST /compare trusts from the model, and what it does not.
//
// The model reads the abstracts and writes five short fields per paper plus the synthesis text, and says which
// papers each agreement and disagreement comes from. That is all that is taken from it. Which papers are in the
// comparison, their order, and every title, year, journal and link come from the PubMed records the reader's
// selection resolved to.
//
// If the model's papers are not exactly those papers, each one once, the whole answer is rejected rather than
// repaired. A table that quietly shows a different paper, or leaves one out, is worse than an error the reader
// can retry.
//
// Which papers a point comes from is the opposite case: it is checked only to the extent that it can be (the
// papers have to be among the selected ones) and anything else is dropped, never rejected. A point that names no
// paper is still a point; it is just shown without one.

export const COMPARE_FIELDS = ['study_type', 'population', 'methods', 'main_finding', 'limitations'];
// What the model writes for each agreement and disagreement: the sentence, and the PMIDs of the papers behind it.
export const POINT_FIELDS = ['point', 'pmids'];

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

// "11111111", 11111111 and "PMID: 11111111" all name the same paper. Anything else names nothing.
const pmidOf = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().replace(/^PMID:?\s*/i, '') : '');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every PMID-sized number written in v, however the model wrote them: ["1", 2], "PMID: 1, 2", "1; 2".
// A run of ten or more digits is not a PMID, and neither is anything inside a longer number.
function pmidsIn(v) {
  const s = Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').join(' ') : typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  return s.match(/(?<!\d)\d{1,9}(?!\d)/g) || [];
}

// One agreement or disagreement: the text the reader sees, and which of the selected papers it names.
// order is the selected PMIDs in the order the reader chose them, so what comes back is only selected papers,
// each once, in that order, whatever the model wrote. A plain string (the older answer shape) names no paper.
function pointOf(item, order) {
  if (!isObject(item)) return { text: text(item, MAX_ITEM), pmids: [] };
  const named = new Set([...pmidsIn(item.pmids), ...pmidsIn(item.pmid)]);
  return { text: text(item.point ?? item.text ?? item.claim, MAX_ITEM), pmids: order.filter((p) => named.has(p)) };
}

// Points with no text are dropped along with whatever papers they named, so the text and paper lists stay in step.
function pointsOf(v, order) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const item of v) {
    const point = pointOf(item, order);
    if (point.text) out.push(point);
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

// The prompt asks for { summary, agreements, disagreements }. A bare string is an older answer shape, and
// it is the summary.
// agreements and disagreements stay lists of plain text, as they always were. When at least one point names a
// selected paper, cited_pmids sits beside them: for each list, one list of PMIDs per point, in the same order.
// Without any, the key is left out altogether, so an answer that names no papers looks exactly as it did before.
function synthesisOf(v, order) {
  if (typeof v === 'string' && v.trim()) v = { summary: v };
  if (!isObject(v)) return null;
  const agreements = pointsOf(v.agreements, order);
  const disagreements = pointsOf(v.disagreements, order);
  const synthesis = { summary: text(v.summary, MAX_SUMMARY), agreements: agreements.map((p) => p.text), disagreements: disagreements.map((p) => p.text) };
  const all = [...agreements, ...disagreements];
  if (all.some((p) => p.pmids.length)) {
    synthesis.cited_pmids = { agreements: agreements.map((p) => p.pmids), disagreements: disagreements.map((p) => p.pmids) };
  }
  return { synthesis, points: { total: all.length, unnamed: all.filter((p) => !p.pmids.length).length } };
}

// parsed: what the model returned, already JSON-parsed. articles: the PubMed records for the reader's
// selection, in the order they chose them.
// Returns { ok: true, comparison, points } or { ok: false, reason }, and never throws on any parsed JSON.
// points counts the agreements and disagreements, and how many of them named none of the selected papers.
// reason is one of: format, unselected_pmid, duplicate_pmid, missing_pmid, empty_paper. Nothing about which
// papers a point names can be a reason: that is dropped, not rejected.
export function validateComparison(parsed, articles) {
  const reject = (reason) => ({ ok: false, reason });

  if (!isObject(parsed) || !Array.isArray(parsed.papers) || !Array.isArray(parsed.research_gaps)) return reject('format');
  const synthesis = synthesisOf(parsed.synthesis, articles.map((a) => a.pmid));
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
  return { ok: true, comparison: { papers, synthesis: synthesis.synthesis, research_gaps: list(parsed.research_gaps) }, points: synthesis.points };
}
