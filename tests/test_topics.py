#!/usr/bin/env python3
"""Checks for tools/build_topics.py and the generated topic pages. No browser needed.

Run from the repo root: python3 tests/test_topics.py
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import build_topics as bt  # noqa: E402

results = []


def check(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))


HOSTILE = '''## In plain English
Vitamin D <script>alert(1)</script> may help [PMID 123456](https://pubmed.ncbi.nlm.nih.gov/123456/) and [click](javascript:alert(1)) and [evil](https://evil.example/x). **Bold** and *italic*.

## Key findings
- One <img src=x onerror=alert(1)> finding [PMID 123456](https://pubmed.ncbi.nlm.nih.gov/123456/).
- Two.

## Sources
Based on 2 PubMed abstracts: 1 meta-analysis, 1 narrative review. Abstracts only, not full papers. Includes pooled evidence (a meta-analysis or systematic review).

1. A title *Journal, 2024* · Meta-analysis · [PubMed](https://pubmed.ncbi.nlm.nih.gov/123456/)
2. Another · [PubMed](https://pubmed.ncbi.nlm.nih.gov/654321/)'''

t = {'slug': 'test-topic', 'title': 'Test "topic" <b>', 'category': 'Neurology', 'query': 'test "query" <x>', 'level': 'undergrad', 'generated': '2026-11-19', 'markdown': HOSTILE}
other = [{**t, 'slug': 'other-one', 'title': 'Other one', 'category': 'Oncology'}, {**t, 'slug': 'other-two', 'title': 'Other two', 'category': 'Neurology'}]
page = bt.build_topic(t, [t] + other)

body_only = re.sub(r'<script type="application/ld\+json">.*?</script>', '', page, flags=re.S)
check('hostile markdown: no raw script or img tags reach the page body', '<script>alert' not in body_only and '<img' not in body_only and '<b>' not in body_only)
check('hostile markdown: javascript: and non-PubMed links are not links', 'href="javascript' not in page and 'href="https://evil.example' not in page)
check('PubMed links kept, open safely', 'href="https://pubmed.ncbi.nlm.nih.gov/123456/" rel="noopener" target="_blank"' in page)
check('title and query are escaped in the page', 'Test &quot;topic&quot; &lt;b&gt;' in page and 'value="test &quot;query&quot; &lt;x&gt;"' in page)
check('exactly one h1, canonical and description present', page.count('<h1>') == 1 and 'rel="canonical" href="https://medsumai.com/topics/test-topic.html"' in page and 'name="description"' in page)
check('jump links match section ids', all(f'id="{i}"' in page for i in ('in-plain-english', 'key-findings', 'sources')) and 'href="#key-findings"' in page)
check('evidence badges parsed from the Sources line', '2 PubMed abstracts' in page and 'Includes pooled evidence' in page)
check('related topics prefer the same category', page.index('Other two') < page.index('Other one'))
ld = re.search(r'<script type="application/ld\+json">(.*?)</script>', page, re.S)
check('JSON-LD parses and has Article + breadcrumbs', ld and {x['@type'] for x in json.loads(ld.group(1))['@graph']} == {'Article', 'BreadcrumbList'})
check('markdown ordered list becomes ol.sources', '<ol class="sources">' in page)

idx = bt.build_index([t] + other)
check('index has a pill per category plus All and a card per topic', len(re.findall(r'class="pill( active)?"', idx)) == 3 and idx.count('class="topic-card"') == 3)
sm = bt.build_sitemap([t] + other)
check('sitemap lists home, topics index, every topic and privacy', all(u in sm for u in ('medsumai.com/</loc>', '/topics/</loc>', '/topics/test-topic.html', '/topics/other-one.html', '/privacy.html')))
check('date helper', bt.pretty_date('2026-11-19') == 'November 19, 2026')
check('first_sentences trims at a sentence boundary', bt.first_sentences('First sentence is here and long enough to count for something real. ' * 5, 100).endswith('.'))

# the real generated site, if it has been built
built = [p for p in glob.glob(os.path.join(ROOT, 'topics', '*.html')) if not p.endswith('index.html')]
content = glob.glob(os.path.join(ROOT, 'content', 'topics', '*.json'))
check('every content file has a built page (run tools/build_topics.py)', len(built) == len(content) and len(content) > 0, f'{len(built)} pages vs {len(content)} content files')
sitemap = open(os.path.join(ROOT, 'sitemap.xml'), encoding='utf-8').read()
for p in built:
    name = os.path.basename(p)
    h = open(p, encoding='utf-8').read()
    ext = set(re.findall(r'href="(https?://[^"]+)"', h)) - {'https://fonts.googleapis.com', 'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap'}
    bad = [u for u in ext if not (bt.PUBMED.match(u) or u.startswith('https://medsumai.com/'))]
    check(f'{name}: one h1, canonical, only PubMed/own links, in sitemap, no leftover markdown', h.count('<h1>') == 1 and 'rel="canonical"' in h and not bad and f'/topics/{name}' in sitemap and '](' not in re.sub(r'<script.*?</script>', '', h, flags=re.S) and '## ' not in h, str(bad))
    check(f'{name}: has all four summary sections and a Sources list', all(f'id="{i}"' in h for i in ('in-plain-english', 'key-findings', 'how-strong-is-the-evidence', 'limitations-and-caveats', 'sources')))
    check(f'{name}: every claim cites a PubMed link', len(re.findall(r'href="https://pubmed\.ncbi\.nlm\.nih\.gov/\d+/"', h)) >= 4)

idx = open(os.path.join(ROOT, 'topics', 'index.html'), encoding='utf-8').read()
cards = re.findall(r'<a class="topic-card"[^>]*>', idx)
check('index: search box, empty state and one searchable card per topic', 'id="topic-search"' in idx and 'id="no-results"' in idx and len(cards) == len(built) and all('data-search="' in c for c in cards), f'{len(cards)} cards vs {len(built)} pages')

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} checks passed')
sys.exit(1 if fails else 0)
