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
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'MedSumAI/1.0 (https://medsumai.com)' } });
    if (res.ok) return res;
    lastStatus = res.status;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`PubMed request failed (${lastStatus})`);
}

export async function searchPubMed(topic, { fetchImpl = fetch, apiKey, retmax = 10, maxArticles = 8 } = {}) {
  const common = `tool=medsumai&email=${encodeURIComponent('hello@medsumai.com')}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`;
  const searchUrl = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${retmax}&term=${encodeURIComponent(topic)}&${common}`;
  const sres = await getWithRetry(searchUrl, fetchImpl);
  const sjson = await sres.json();
  const ids = (sjson && sjson.esearchresult && sjson.esearchresult.idlist) || [];
  if (!ids.length) return [];
  const fetchUrl = `${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=${ids.join(',')}&${common}`;
  const fres = await getWithRetry(fetchUrl, fetchImpl);
  const articles = parseArticles(await fres.text());
  // Keep PubMed's relevance order.
  articles.sort((a, b) => ids.indexOf(a.pmid) - ids.indexOf(b.pmid));
  return articles.slice(0, maxArticles);
}
