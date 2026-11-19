export const XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID Version="1">11111111</PMID>
<Article><Journal><ISSN>1</ISSN><JournalIssue><PubDate><Year>2023</Year></PubDate></JournalIssue><Title>Journal of Tests</Title></Journal>
<ArticleTitle>Vitamin D &amp; immunity: a <i>meta-analysis</i> of 12 trials.</ArticleTitle>
<Abstract><AbstractText Label="BACKGROUND">Vitamin D may affect immune function.</AbstractText><AbstractText Label="RESULTS">Risk fell by 12% (95% CI 0.8-0.95; p &lt; 0.01) in n=4,000 adults.</AbstractText></Abstract>
<PublicationTypeList><PublicationType UI="D1">Journal Article</PublicationType><PublicationType UI="D2">Meta-Analysis</PublicationType></PublicationTypeList>
</Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID Version="1">22222222</PMID>
<Article><Journal><JournalIssue><PubDate><MedlineDate>2021 Jan-Feb</MedlineDate></PubDate></JournalIssue><Title>Other Journal</Title></Journal>
<ArticleTitle>A cohort study.</ArticleTitle>
<Abstract><AbstractText>Plain abstract with no label.</AbstractText></Abstract>
<PublicationTypeList><PublicationType>Journal Article</PublicationType><PublicationType>Observational Study</PublicationType></PublicationTypeList>
</Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID Version="1">33333333</PMID>
<Article><Journal><Title>No Abstract Journal</Title></Journal><ArticleTitle>No abstract here.</ArticleTitle></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

export const SEARCH_JSON = { esearchresult: { idlist: ['22222222', '11111111', '33333333'] } };

// A fake fetch that serves PubMed and OpenAI and records every call.
export function makeFetch({ openaiText = 'ok', openaiStatus = 200, ids = SEARCH_JSON, strongIds = [], strongStatus = 200, xml = XML, pubmedStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('esearch.fcgi')) {
      if (decodeURIComponent(u).includes('[pt]')) {
        // the evidence-first pass (meta-analyses / systematic reviews / RCTs)
        return strongStatus === 200 ? new Response(JSON.stringify({ esearchresult: { idlist: strongIds } }), { status: 200 }) : new Response('x', { status: strongStatus });
      }
      return pubmedStatus === 200 ? new Response(JSON.stringify(ids), { status: 200 }) : new Response('x', { status: pubmedStatus });
    }
    if (u.includes('efetch.fcgi')) return new Response(xml, { status: 200 });
    if (u.includes('api.openai.com')) {
      if (openaiStatus !== 200) return new Response('{}', { status: openaiStatus });
      return new Response(JSON.stringify({ choices: [{ message: { content: openaiText } }] }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  fn.calls = calls;
  return fn;
}

// In-memory stand-in for the Limiter Durable Object namespace.
export function makeLimiterNs() {
  const store = new Map();
  return {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (_u, init) => {
        const { limit, windowSec, cost = 1 } = JSON.parse(init.body);
        const now = Date.now();
        let rec = store.get(id);
        if (!rec || now - rec.start >= windowSec * 1000) rec = { start: now, count: 0 };
        if (rec.count + cost > limit) return Response.json({ ok: false, retryAfter: 5 });
        rec.count += cost;
        store.set(id, rec);
        return Response.json({ ok: true });
      },
    }),
    _store: store,
  };
}
