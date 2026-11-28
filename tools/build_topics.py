#!/usr/bin/env python3
"""Build the public topic pages from content/topics/*.json.

Each JSON file: {slug, title, category, query, level, generated (YYYY-MM-DD), markdown}
where `markdown` is exactly what the MedSumAI summarizer returned (four sections + Sources).

Writes topics/<slug>.html, topics/index.html and sitemap.xml. Run from the repo root:
    python3 tools/build_topics.py
Everything is escaped; only links to pubmed.ncbi.nlm.nih.gov are kept as links.
"""
import glob
import html
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://medsumai.com'
PUBMED = re.compile(r'^https://pubmed\.ncbi\.nlm\.nih\.gov/\d{1,9}/?$')
CATEGORY_ORDER = ['Neurology', 'Mental health', 'Cardiovascular', 'Oncology', 'Infectious disease', 'Immunology', 'Genetics', 'Endocrinology', 'Nutrition & lifestyle']


def esc(s):
    return html.escape(s, quote=True)


def inline(text):
    """Escape, then re-apply the few inline forms the summarizer uses."""
    out = []
    pos = 0
    for m in re.finditer(r'\[([^\]]+)\]\(([^)\s]+)\)', text):
        out.append(fmt_plain(text[pos:m.start()]))
        label, url = m.group(1), m.group(2)
        if PUBMED.match(url):
            out.append(f'<a href="{esc(url)}" rel="noopener" target="_blank">{esc(label)}</a>')
        else:
            out.append(esc(label))
        pos = m.end()
    out.append(fmt_plain(text[pos:]))
    return ''.join(out)


def fmt_plain(t):
    t = esc(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'<em>\1</em>', t)
    return t


def slugify(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def render_markdown(md):
    """Return (html, headings[(id, text)]). Handles ## headings, bullets, numbered lists, paragraphs."""
    lines = md.replace('\r', '').strip().split('\n')
    out, headings = [], []
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            i += 1
            continue
        h = re.match(r'^#{2,3}\s+(.*)$', line)
        if h:
            text = h.group(1).strip()
            hid = slugify(text)
            headings.append((hid, text))
            out.append(f'<h2 id="{hid}">{inline(text)}</h2>')
            i += 1
            continue
        if re.match(r'^\s*[-*]\s+', line):
            items = []
            while i < len(lines) and re.match(r'^\s*[-*]\s+', lines[i]):
                items.append(re.sub(r'^\s*[-*]\s+', '', lines[i]).strip())
                i += 1
            out.append('<ul>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ul>')
            continue
        if re.match(r'^\s*\d+\.\s+', line):
            items = []
            while i < len(lines) and re.match(r'^\s*\d+\.\s+', lines[i]):
                items.append(re.sub(r'^\s*\d+\.\s+', '', lines[i]).strip())
                i += 1
            out.append('<ol class="sources">' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ol>')
            continue
        para = [line.strip()]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#{2,3}\s|\s*[-*]\s|\s*\d+\.\s)', lines[i]):
            para.append(lines[i].strip())
            i += 1
        out.append(f'<p>{inline(" ".join(para))}</p>')
    return '\n'.join(out), headings


def section_text(md, name):
    m = re.search(r'^##\s+' + re.escape(name) + r'\s*\n(.*?)(?=^##\s|\Z)', md, re.S | re.M)
    return m.group(1).strip() if m else ''


def strip_md(t):
    t = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', t)
    t = re.sub(r'\[PMID[^\]]*\]', '', t)
    t = re.sub(r'[*_`]', '', t)
    return re.sub(r'\s+', ' ', t).strip()


def first_sentences(t, limit):
    t = strip_md(t)
    t = re.sub(r'\s+([.,;:])', r'\1', t)
    if len(t) <= limit:
        return t
    cut = t[:limit]
    end = max(cut.rfind('. '), cut.rfind('; '))
    return (cut[:end + 1] if end > 60 else cut.rsplit(' ', 1)[0] + '…').strip()


def evidence_facts(md):
    src = section_text(md, 'Sources')
    n = re.search(r'Based on (\d+) PubMed abstract', src)
    types = re.search(r'abstracts?: (.*?)\. Abstracts only', src)
    note = None
    for k in ('Includes pooled evidence', 'Includes clinical trials, but no pooled analysis', 'No trials or pooled analyses'):
        if k in src:
            note = {'Includes pooled evidence': 'Includes pooled evidence (meta-analysis or systematic review)',
                    'Includes clinical trials, but no pooled analysis': 'Includes clinical trials, no pooled analysis',
                    'No trials or pooled analyses': 'Background reviews only: no trials or pooled analyses'}[k]
            break
    return (int(n.group(1)) if n else None), (types.group(1) if types else None), note


def pretty_date(d):
    y, m, day = d.split('-')
    names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    return f'{names[int(m) - 1]} {int(day)}, {y}'


# Same font URL on every page of the site. /site.css and /site.js (tokens, header, footer, theme toggle) are shared too.
FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com"/>'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>'
    '<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>'
)


def head(title, desc, canonical, extra=''):
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="theme-color" content="#2d6a4f"/>
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}"/>
  <link rel="canonical" href="{esc(canonical)}"/>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
  <link rel="icon" href="/favicon.ico" sizes="32x32"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="{esc(title)}"/>
  <meta property="og:description" content="{esc(desc)}"/>
  <meta property="og:url" content="{esc(canonical)}"/>
  <meta property="og:site_name" content="MedSumAI"/>
  <meta property="og:image" content="{SITE}/og-image.png"/>
  <meta name="twitter:card" content="summary_large_image"/>
  {FONTS}
  <link rel="stylesheet" href="/site.css"/>
  <script src="/site.js"></script>
  <link rel="stylesheet" href="/topics/topics.css"/>
{extra}</head>'''


def site_header(current=None):
    """The header every page of the site shares. `current` marks the page's own nav link."""
    def link(href, label, key, cls=''):
        c = f' class="{cls}"' if cls else ''
        cur = ' aria-current="page"' if current == key else ''
        return f'    <a{c} href="{href}"{cur}>{label}</a>\n'
    return (
        '<a class="skip-link" href="#main">Skip to main content</a>\n'
        '<header class="site-header">\n'
        '  <a class="brand" href="/" aria-label="MedSumAI home">\n'
        '    <span class="logo">Med<span>Sum</span>AI</span>\n'
        '    <span class="tagline">Biomedical Research Summarizer</span>\n'
        '  </a>\n'
        '  <nav class="topnav" aria-label="Main">\n'
        + link('/topics/', 'Topics', 'topics')
        + link('/compare', 'Compare', 'compare', 'nav-cta')
        + link('/methodology.html', 'How it works', 'how')
        + link('/#shop', 'Study Guides', 'guides')
        + '    <button class="theme-toggle" id="themeToggle" type="button" title="Toggle dark mode" aria-label="Toggle dark mode">\U0001F319</button>\n'
        '  </nav>\n'
        '</header>'
    )


def site_footer():
    return '''<footer class="site-footer">
  <div class="footer-links">
    <a href="/">Home</a><a href="/topics/">Topics</a><a href="/compare">Compare</a><a href="/methodology.html">How it works</a><a href="/privacy.html">Privacy</a><a href="https://github.com/mitrapatel1909/MedSum-AI" target="_blank" rel="noopener">GitHub</a>
  </div>
  <p>Powered by <a href="https://pubmed.ncbi.nlm.nih.gov/" target="_blank" rel="noopener">PubMed</a> &amp; OpenAI. For education only. Not medical advice.</p>
  <p>Summaries are written by AI from PubMed abstracts and can contain mistakes. Talk to a qualified clinician about your health.</p>
</footer>'''


def build_topic(t, all_topics):
    md = t['markdown'].strip()
    body, headings = render_markdown(md)
    plain = section_text(md, 'In plain English')
    desc = first_sentences(plain, 155)
    n, types, note = evidence_facts(md)
    url = f"{SITE}/topics/{t['slug']}.html"
    title = f"{t['title']}: what the research says | MedSumAI"
    related = [x for x in all_topics if x['slug'] != t['slug']]
    related.sort(key=lambda x: (x['category'] != t['category'], x['title']))
    related = related[:3]
    ld = json.dumps({
        '@context': 'https://schema.org',
        '@graph': [
            {'@type': 'Article', 'headline': f"{t['title']}: what the research says", 'description': desc,
             'datePublished': t['generated'], 'dateModified': t['generated'], 'inLanguage': 'en',
             'author': {'@type': 'Organization', 'name': 'MedSumAI'}, 'publisher': {'@type': 'Organization', 'name': 'MedSumAI', 'url': SITE + '/'},
             'mainEntityOfPage': url, 'about': t['title']},
            {'@type': 'BreadcrumbList', 'itemListElement': [
                {'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': SITE + '/'},
                {'@type': 'ListItem', 'position': 2, 'name': 'Topics', 'item': SITE + '/topics/'},
                {'@type': 'ListItem', 'position': 3, 'name': t['title'], 'item': url}]},
        ]}, ensure_ascii=False).replace('</', '<\\/')
    badges = [f'<span class="chip">{esc(t["category"])}</span>']
    if n:
        badges.append(f'<span class="chip">{n} PubMed abstract{"s" if n != 1 else ""}</span>')
    if note:
        badges.append(f'<span class="chip chip-accent">{esc(note)}</span>')
    toc = ''.join(f'<li><a href="#{hid}">{esc(txt)}</a></li>' for hid, txt in headings)
    rel = ''.join(f'<a class="rel-card" href="/topics/{x["slug"]}.html"><span class="rel-cat">{esc(x["category"])}</span><span class="rel-title">{esc(x["title"])}</span></a>' for x in related)
    q = esc(t['query'])
    page = head(title, desc, url, f'  <script type="application/ld+json">{ld}</script>\n') + f'''
<body>
{site_header('topics')}
<main id="main" class="page-wrap topic">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span>›</span> <a href="/topics/">Topics</a> <span>›</span> <span aria-current="page">{esc(t["title"])}</span></nav>
  <span class="page-label">What the research says</span>
  <h1>{esc(t["title"])}</h1>
  <div class="badges">{"".join(badges)}</div>
  <p class="byline">AI summary of PubMed abstracts, written for {esc({"high_school": "high school", "undergrad": "college undergraduate", "premed": "pre-med"}.get(t.get("level", "undergrad"), "college undergraduate"))} readers. Generated {pretty_date(t["generated"])}. Research keeps changing: check the linked sources.</p>
  <nav class="toc" aria-label="On this page"><strong>On this page</strong><ul>{toc}</ul></nav>
  <article class="summary">
{body}
  </article>
  <section class="cta" aria-labelledby="cta-h">
    <h2 id="cta-h">Go deeper on this topic</h2>
    <p>Get a fresh summary at your reading level, ask follow-up questions, make flashcards and export them to Anki. You can also paste a PubMed link, PMID or DOI.</p>
    <form action="/" method="get" class="cta-form">
      <label class="sr-only" for="topic-q">Research topic or paper</label>
      <input id="topic-q" name="topic" type="text" value="{q}" maxlength="200"/>
      <button type="submit" class="btn">Summarize →</button>
    </form>
  </section>
  <section aria-labelledby="rel-h"><h2 id="rel-h" class="small-h">More topics</h2><div class="rel-grid">{rel}</div></section>
</main>
{site_footer()}
</body>
</html>
'''
    return page


def search_blob(t, snippet):
    text = ' '.join([t['title'], t['category'], t['query'], t['slug'].replace('-', ' '), snippet])
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]+', ' ', text.lower())).strip()


def build_index(topics):
    cats = [c for c in CATEGORY_ORDER if any(t['category'] == c for t in topics)]
    cats += sorted({t['category'] for t in topics} - set(cats))
    pills = '<button type="button" class="pill active" data-cat="all" aria-pressed="true">All</button>' + ''.join(
        f'<button type="button" class="pill" data-cat="{esc(c)}" aria-pressed="false">{esc(c)}</button>' for c in cats)
    cards = ''
    for t in sorted(topics, key=lambda x: x['title']):
        snippet = first_sentences(section_text(t['markdown'], 'In plain English'), 170)
        n, _, note = evidence_facts(t['markdown'])
        cards += f'''<a class="topic-card" href="/topics/{t["slug"]}.html" data-cat="{esc(t["category"])}" data-search="{esc(search_blob(t, snippet))}">
  <span class="rel-cat">{esc(t["category"])}</span>
  <span class="card-title">{esc(t["title"])}</span>
  <span class="card-snip">{esc(snippet)}</span>
  <span class="card-meta">{(str(n) + " abstracts · ") if n else ""}{esc(pretty_date(t["generated"]))}</span>
</a>
'''
    desc = 'Plain-English summaries of real medical research on common pre-med and AP Biology topics, each linked to its PubMed sources.'
    ld = json.dumps({'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Research topics explained', 'url': SITE + '/topics/', 'description': desc}).replace('</', '<\\/')
    script = '''<script>
(function(){
  var pills=[].slice.call(document.querySelectorAll('.pill')), cards=[].slice.call(document.querySelectorAll('.topic-card'));
  var box=document.getElementById('topic-search'), empty=document.getElementById('no-results'), count=document.getElementById('result-count'), clear=document.getElementById('search-clear');
  var cat='all';
  function norm(s){return (s||'').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\\s+/g,' ').trim()}
  function apply(){
    var q=norm(box.value), words=q?q.split(' '):[], shown=0;
    cards.forEach(function(card){
      var hay=card.getAttribute('data-search');
      var ok=(cat==='all'||card.getAttribute('data-cat')===cat)&&words.every(function(w){return hay.indexOf(w)!==-1});
      card.hidden=!ok; if(ok)shown++;
    });
    empty.hidden=shown!==0; clear.hidden=!box.value;
    count.textContent=shown+(shown===1?' topic':' topics');
    var qs=box.value.trim(); if(empty.hidden===false){document.getElementById('empty-q').textContent=qs; document.getElementById('empty-link').href='/?topic='+encodeURIComponent(qs)}
  }
  pills.forEach(function(p){p.addEventListener('click',function(){
    pills.forEach(function(x){x.classList.remove('active');x.setAttribute('aria-pressed','false')});
    p.classList.add('active');p.setAttribute('aria-pressed','true');
    cat=p.getAttribute('data-cat'); apply();
  })});
  box.addEventListener('input',apply);
  clear.addEventListener('click',function(){box.value='';apply();box.focus()});
  var init=new URLSearchParams(location.search).get('q'); if(init){box.value=init.slice(0,100)}
  apply();
})();
</script>'''
    return head('Research topics explained in plain English | MedSumAI', desc, SITE + '/topics/', f'  <script type="application/ld+json">{ld}</script>\n') + f'''
<body>
{site_header('topics')}
<main id="main" class="page-wrap topic">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span>›</span> <span aria-current="page">Topics</span></nav>
  <span class="page-label">Browse</span>
  <h1>Research topics, <em>explained.</em></h1>
  <p class="lead">Real studies from PubMed, summarized in plain English with the sources linked. Pick a topic, or <a href="/">summarize your own</a>.</p>
  <div class="search-row" role="search">
    <label class="sr-only" for="topic-search">Search topics</label>
    <input id="topic-search" type="search" placeholder="Search topics, e.g. diabetes, sleep, CRISPR" autocomplete="off" maxlength="100"/>
    <button type="button" id="search-clear" class="search-clear" aria-label="Clear search" hidden>×</button>
  </div>
  <div class="pills" role="group" aria-label="Filter by category">{pills}</div>
  <p id="result-count" class="result-count" aria-live="polite"></p>
  <div id="no-results" class="no-results" hidden>
    <p>No topics match "<strong id="empty-q"></strong>" yet.</p>
    <p><a id="empty-link" href="/">Summarize it with MedSumAI →</a> It takes about 10 seconds and links the PubMed sources.</p>
  </div>
  <div class="topic-grid">
{cards}  </div>
</main>
{site_footer()}
{script}
</body>
</html>
'''


# Hand-written pages that are not generated from content/topics. Keep these here: the sitemap is rewritten on every build,
# so anything not listed would silently disappear from it.
STATIC_PAGES = [
    (SITE + '/compare', '2026-11-24', 'monthly', '0.9'),
    (SITE + '/methodology.html', '2026-11-24', 'yearly', '0.4'),
    (SITE + '/privacy.html', '2026-11-24', 'yearly', '0.3'),
]


def build_sitemap(topics):
    urls = [(SITE + '/', '2026-11-19', 'weekly', '1.0'), (SITE + '/topics/', max(t['generated'] for t in topics), 'weekly', '0.8')]
    urls += [(f"{SITE}/topics/{t['slug']}.html", t['generated'], 'monthly', '0.7') for t in sorted(topics, key=lambda x: x['slug'])]
    urls += STATIC_PAGES
    body = ''.join(f'  <url>\n    <loc>{u}</loc>\n    <lastmod>{d}</lastmod>\n    <changefreq>{c}</changefreq>\n    <priority>{p}</priority>\n  </url>\n' for u, d, c, p in urls)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{body}</urlset>\n'


def main():
    topics = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'content', 'topics', '*.json'))):
        t = json.load(open(path, encoding='utf-8'))
        for k in ('slug', 'title', 'category', 'query', 'generated', 'markdown'):
            if not t.get(k):
                sys.exit(f'{path}: missing {k}')
        if not re.fullmatch(r'[a-z0-9-]+', t['slug']):
            sys.exit(f'{path}: bad slug')
        if '## Sources' not in t['markdown'] or '## In plain English' not in t['markdown']:
            sys.exit(f'{path}: markdown does not look like a MedSumAI summary')
        topics.append(t)
    if not topics:
        sys.exit('no topics found in content/topics')
    os.makedirs(os.path.join(ROOT, 'topics'), exist_ok=True)
    for t in topics:
        open(os.path.join(ROOT, 'topics', t['slug'] + '.html'), 'w', encoding='utf-8').write(build_topic(t, topics))
    open(os.path.join(ROOT, 'topics', 'index.html'), 'w', encoding='utf-8').write(build_index(topics))
    open(os.path.join(ROOT, 'sitemap.xml'), 'w', encoding='utf-8').write(build_sitemap(topics))
    print(f'built {len(topics)} topic pages, topics/index.html and sitemap.xml')


if __name__ == '__main__':
    main()
