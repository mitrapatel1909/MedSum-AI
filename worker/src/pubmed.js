// PubMed E-utilities client: search for a topic, fetch abstracts, parse the XML.
// Workers have no DOMParser, so the XML is read with small, targeted regular expressions.

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function stripTags(s) {
  // Remove tags first, then decode entities, so a literal "&lt;" in the text stays text.
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// Most informative first.
const STUDY_TYPES = [
  ['Meta-Analysis', 'Meta-analysis'],
  ['Systematic Review', 'Systematic review'],
  ['Randomized Controlled Trial', 'Randomized controlled trial'],
  ['Clinical Trial', 'Clinical trial'],
  ['Practice Guideline', 'Guideline'],
  ['Guideline', 'Guideline'],
  ['Observational Study', 'Observational study'],
  ['Cohort Studies', 'Cohort study'],
  ['Case-Control Studies', 'Case-control study'],
  ['Case Reports', 'Case report'],
  ['Review', 'Narrative review'],
];

export function classifyStudy(pubTypes) {
  const set = new Set(pubTypes);
  for (const [raw, label] of STUDY_TYPES) if (set.has(raw)) return label;
  return 'Research article';
}

export function parseArticles(xml) {
  const blocks = xml.match(/<PubmedArticle[\s>][\s\S]*?<\/PubmedArticle>/g) || [];
  const articles = [];
  for (const b of blocks) {
    const pmid = (b.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1];
    if (!pmid) continue;
    const title = stripTags((b.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/) || [])[1] || '');
    const parts = [];
    const re = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g;
    let m;
    while ((m = re.exec(b))) {
      const label = (m[1].match(/Label="([^"]*)"/) || [])[1];
      const text = stripTags(m[2]);
      if (text) parts.push(label ? `${label}: ${text}` : text);
    }
    if (!parts.length) continue; // an abstract is the whole point
    const journal = stripTags((b.match(/<Title>([\s\S]*?)<\/Title>/) || [])[1] || '');
    const year =
      (b.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/) || [])[1] ||
      (b.match(/<PubDate>[\s\S]*?<MedlineDate>[^<]*?(\d{4})/) || [])[1] ||
      '';
    const pubTypes = [...b.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map((x) => stripTags(x[1]));
    articles.push({
      pmid,
      title,
      abstract: parts.join(' '),
      journal,
      year,
      studyType: classifyStudy(pubTypes),
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    });
  }
  return articles;
}

async function getWithRetry(url, fetchImpl) {
  let lastStatus = 0;
  const waits = [700, 1600]; // PubMed allows about 3 requests/second without an API key; back off when it says 429
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'MedSumAI/1.0 (https://medsumai.com)' } });
    if (res.ok) return res;
    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) break;
    if (attempt < waits.length) await new Promise((r) => setTimeout(r, waits[attempt] + Math.floor(Math.random() * 300)));
  }
  throw new Error(`PubMed request failed (${lastStatus})`);
}

// Strongest designs first. A broad topic searched by plain relevance is mostly narrative reviews,
// so we also run a second search restricted to pooled analyses and trials from the last 10 years.
const STRONG_FILTER = '(meta-analysis[pt] OR systematic review[pt] OR randomized controlled trial[pt])';

export function cleanTerm(topic) {
  // Square brackets and parentheses are PubMed field/grouping syntax; visitors do not get to use them.
  return topic.replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function esearch(term, retmax, common, fetchImpl) {
  const url = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${retmax}&term=${encodeURIComponent(term)}&${common}`;
  const res = await getWithRetry(url, fetchImpl);
  const json = await res.json();
  return (json && json.esearchresult && json.esearchresult.idlist) || [];
}

export async function searchPubMed(topic, { fetchImpl = (...a) => fetch(...a), apiKey, maxArticles = 8, strongCount = 4, now = new Date() } = {}) {
  const common = `tool=medsumai&email=${encodeURIComponent('hello@medsumai.com')}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
  const term = cleanTerm(topic);
  if (!term) return [];
  const since = now.getUTCFullYear() - 10;
  const [strong, general] = await Promise.allSettled([
    esearch(`(${term}) AND ${STRONG_FILTER} AND ("${since}"[dp] : "3000"[dp])`, strongCount, common, fetchImpl),
    esearch(term, 10, common, fetchImpl),
  ]);
  if (general.status === 'rejected') throw general.reason; // no baseline results: report the failure
  const strongIds = strong.status === 'fulfilled' ? strong.value : []; // the extra pass is best effort
  const ids = [...new Set([...strongIds, ...general.value])];
  if (!ids.length) return [];
  const fetchUrl = `${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=${ids.join(',')}&${common}`;
  const fres = await getWithRetry(fetchUrl, fetchImpl);
  const articles = parseArticles(await fres.text());
  // Stronger evidence first (in PubMed's relevance order), then everything else in relevance order.
  const rank = (a) => ids.indexOf(a.pmid) + (strongIds.includes(a.pmid) ? 0 : 1000);
  articles.sort((a, b) => rank(a) - rank(b));
  return articles.slice(0, maxArticles);
}

// Paste-a-paper input: a PubMed link, a bare PMID, or a DOI (bare, doi: prefix, or doi.org link).
export function parseInput(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return null;
  let m = t.match(/^(?:https?:\/\/)?(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{1,9})(?:[/?#].*)?$/i);
  if (m) return { kind: 'pmid', value: m[1] };
  m = t.match(/^(?:PMID:?\s*)?(\d{1,9})$/i);
  if (m) return { kind: 'pmid', value: m[1] };
  m = t.match(/^(?:(?:https?:\/\/)?(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[^\s"<>]+?)[.,;)]*$/i);
  if (m) return { kind: 'doi', value: decodeURIComponent(m[1]).replace(/["\\]/g, '') };
  return null;
}

// Returns { article } or { reason: 'not_found' | 'no_abstract' }.
export async function fetchPaper(input, { fetchImpl = (...a) => fetch(...a), apiKey } = {}) {
  const common = `tool=medsumai&email=${encodeURIComponent('hello@medsumai.com')}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
  let pmid = input.kind === 'pmid' ? input.value : null;
  if (!pmid) {
    const ids = await esearch(`"${input.value}"[AID]`, 1, common, fetchImpl);
    pmid = ids[0];
  }
  if (!pmid) return { reason: 'not_found' };
  const res = await getWithRetry(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=${pmid}&${common}`, fetchImpl);
  const xml = await res.text();
  const [article] = parseArticles(xml);
  if (article) return { article };
  return { reason: /<PubmedArticle[\s>]/.test(xml) ? 'no_abstract' : 'not_found' };
}
