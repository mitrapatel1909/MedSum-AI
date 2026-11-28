# Browser tests for the shared design system (every page) and the Compare page. The network is stubbed:
# no real backend, Supabase or PubMed is called.
# Run:  pip install playwright && playwright install chromium && python3 tests/test_pages.py
import functools, glob, http.server, json, os, socketserver, sys, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PORT = 8766
OUT = os.environ.get('SHOTS_DIR', '/tmp/medsumai-shots')
os.makedirs(OUT, exist_ok=True)
BASE = f'http://127.0.0.1:{PORT}'

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a, **k: None
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

results = []


def check(name, cond, extra=''):
    results.append((name, bool(cond), extra))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))


# ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
topic_pages = sorted(p for p in glob.glob(os.path.join(ROOT, 'topics', '*.html')) if not p.endswith('index.html'))
PAGES = [
    ('home', '/index.html', None),
    ('compare', '/compare.html', '/compare'),
    ('methodology', '/methodology.html', '/methodology.html'),
    ('privacy', '/privacy.html', None),
    ('news', '/news.html', None),
    ('topics index', '/topics/', '/topics/'),
    ('topic page', '/topics/' + os.path.basename(topic_pages[0]), '/topics/'),
]

CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}
JSON_H = {**CORS, 'content-type': 'application/json'}

# 12 papers: enough that the list scrolls (so the sticky selection bar matters) and that the 5-paper limit can be hit.
PAPERS = [
    {'pmid': '31000001', 'title': 'Once-weekly semaglutide in adults with overweight or obesity', 'year': '2021', 'studyType': 'Randomized controlled trial', 'journal': 'N Engl J Med', 'snippet': 'Adults with a BMI of 30 or more were randomized to weekly semaglutide or placebo for 68 weeks.'},
    {'pmid': '31000002', 'title': 'GLP-1 use and gastrointestinal events <img src=x onerror=alert(1)>', 'year': '2022', 'studyType': 'Cohort study', 'journal': 'Lancet <b>Diabetes</b>', 'snippet': ''},
    {'pmid': '31000003', 'title': 'GLP-1 receptor agonists and body weight: a meta-analysis', 'year': '2023', 'studyType': 'Meta-analysis', 'journal': 'BMJ', 'snippet': 'Pooled 24 trials.'},
] + [
    {'pmid': str(31000010 + i), 'title': f'GLP-1 agonist study number {i}', 'year': str(2012 + i), 'studyType': ['Randomized controlled trial', 'Cohort study', 'Review'][i % 3], 'journal': 'Test Journal', 'snippet': 'A short snippet about the study.'}
    for i in range(9)
]


def cmp_paper(n, study_type, url, **kw):
    ex = {'study_type': study_type, 'population': f'Population {n}', 'methods': f'Methods {n}', 'main_finding': f'Finding {n}', 'limitations': f'Limits {n}'}
    ex.update(kw)
    return {'title': f'Compared paper {n}', 'year': str(2019 + n), 'journal': f'Journal {n}', 'url': url, 'extraction': ex}


SYN = {'summary': 'Across designs, the studies agree that the drugs reduce weight.', 'agreements': ['All report weight loss.'], 'disagreements': ['The size of the effect differs.']}
COMPARISONS = {
    'ok': {'comparison': {
        'papers': [
            cmp_paper(1, 'Randomized controlled trial', 'https://pubmed.ncbi.nlm.nih.gov/31000001/'),
            cmp_paper(2, 'Cohort study', 'javascript:alert(1)', population='Registry <script>alert(2)</script>'),
            cmp_paper(3, 'Meta-analysis', 'https://evil.example/x', limitations=''),
        ],
        'synthesis': SYN, 'research_gaps': ['Long-term safety beyond two years.', 'Few adolescents were studied.']}},
    # "RCT" and "Randomized controlled trial" are the same design: no "designs differ" warning.
    'same': {'comparison': {
        'papers': [cmp_paper(1, 'RCT', 'https://pubmed.ncbi.nlm.nih.gov/31000001/'), cmp_paper(2, 'Randomized controlled trial', 'https://pubmed.ncbi.nlm.nih.gov/31000010/')],
        'synthesis': SYN, 'research_gaps': []}},
    'nosyn': {'comparison': {'papers': [cmp_paper(1, 'Cohort study', 'https://pubmed.ncbi.nlm.nih.gov/31000001/'), cmp_paper(2, 'Cohort study', 'https://pubmed.ncbi.nlm.nih.gov/31000002/')]}},
    'wide': {'comparison': {
        'papers': [cmp_paper(i, ['Randomized controlled trial', 'Cohort study', 'Meta-analysis'][i % 3], f'https://pubmed.ncbi.nlm.nih.gov/3100000{i}/') for i in range(1, 6)],
        'synthesis': SYN, 'research_gaps': ['One gap.']}},
}

calls = []   # (kind, payload)
held = []    # routes the test chose not to answer yet
state = {'search': 'ok', 'compare': 'ok'}


def answer_search(r, mode):
    if mode == 'abort':
        return r.abort()
    if mode == 'fail':
        return r.fulfill(status=500, headers=CORS, body='boom')
    if mode == 'empty':
        return r.fulfill(status=200, headers=JSON_H, body=json.dumps({'papers': [], 'message': 'No PubMed abstracts matched. Try a broader term.'}))
    if mode == 'empty-nomsg':
        return r.fulfill(status=200, headers=JSON_H, body=json.dumps({'papers': []}))
    return r.fulfill(status=200, headers=JSON_H, body=json.dumps({'papers': PAPERS}))


def answer_compare(r, mode):
    if mode == 'abort':
        return r.abort()
    if mode == '502':
        return r.fulfill(status=502, headers=JSON_H, body=json.dumps({'error': 'The summarizer is temporarily unavailable. Please try again in a few minutes.'}))
    if mode == '429':
        return r.fulfill(status=429, headers=CORS, body='slow down')
    if mode == 'empty':
        return r.fulfill(status=200, headers=JSON_H, body=json.dumps({'comparison': {'papers': []}}))
    return r.fulfill(status=200, headers=JSON_H, body=json.dumps(COMPARISONS[mode]))


def route(r):
    req = r.request
    url = req.url
    if url.startswith(BASE):
        return r.continue_()
    if req.method == 'OPTIONS':
        return r.fulfill(status=204, headers=CORS)
    if '/rest/v1/rpc/' in url:
        return r.fulfill(status=200, headers=JSON_H, body='0')
    if 'api.medsumai.com/compare/search' in url:
        calls.append(('search', json.loads(req.post_data or '{}')))
        if state['search'] == 'hold':
            held.append(r)
            return None
        return answer_search(r, state['search'])
    if 'api.medsumai.com/compare' in url:
        calls.append(('compare', json.loads(req.post_data or '{}')))
        if state['compare'] == 'hold':
            held.append(r)
            return None
        return answer_compare(r, state['compare'])
    if 'api.medsumai.com/summarize' in url:
        calls.append(('summarize', json.loads(req.post_data or '{}')))
        if state.get('summarize') == 'fail':
            return r.fulfill(status=500, headers=CORS, body='boom')
        md = ('## In plain English\n\nA short overview. [PMID 11111111](https://pubmed.ncbi.nlm.nih.gov/11111111/)\n\n'
              '## Key findings\n\n- First finding.\n- Second finding.\n\n'
              '## How strong is the evidence?\n\nMixed.\n\n'
              '## Limitations and caveats\n\n- Short trials.\n\n'
              '## Sources\nBased on 2 PubMed abstracts: 1 meta-analysis, 1 randomized controlled trial. Abstracts only, not full papers.\n\n'
              '1. Title one *Journal A, 2023* · Meta-analysis · [PubMed](https://pubmed.ncbi.nlm.nih.gov/11111111/)\n'
              '2. Title two *Journal B, 2021* · Randomized controlled trial · [PubMed](https://pubmed.ncbi.nlm.nih.gov/22222222/)')
        return r.fulfill(status=200, headers={**CORS, 'content-type': 'text/plain'}, body=md)
    if 'api.medsumai.com/chat' in url:
        return r.fulfill(status=200, headers={**CORS, 'content-type': 'text/plain'}, body='Follow-up answer.')
    ctype = 'application/javascript' if url.split('?')[0].endswith('.js') else 'text/plain'
    return r.fulfill(status=200, body='', headers={**CORS, 'content-type': ctype})


def release(mode_fn, mode):
    while held:
        mode_fn(held.pop(0), mode)


# ── In-page scans ───────────────────────────────────────────────────────────────────────────────
# Text contrast (WCAG AA: 4.5, or 3 for large text) against the nearest solid backgrounds. Elements sitting on a
# gradient/image, decorative (aria-hidden) text and hidden text are skipped. Optional root selector.
CONTRAST_JS = r"""(rootSel) => {
  // Chrome serialises color-mix() as oklab(...), so let the browser itself turn any CSS colour into sRGB:
  // paint it over black and over white and solve for colour and alpha.
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', {willReadFrequently: true});
  function parse(c) {
    if (!c) return null;
    const px = base => { g.fillStyle = base; g.fillRect(0, 0, 1, 1); g.fillStyle = c; g.fillRect(0, 0, 1, 1); return g.getImageData(0, 0, 1, 1).data; };
    const k = px('#000'), w = px('#fff');
    const a = 1 - ((w[0] - k[0]) + (w[1] - k[1]) + (w[2] - k[2])) / (3 * 255);
    if (a <= 0.004) return {r:0,g:0,b:0,a:0};
    return {r: Math.min(255, k[0] / a), g: Math.min(255, k[1] / a), b: Math.min(255, k[2] / a), a};
  }
  const over = (t, b) => { const a = t.a + b.a * (1 - t.a); if (!a) return {r:0,g:0,b:0,a:0}; return {r:(t.r*t.a + b.r*b.a*(1-t.a))/a, g:(t.g*t.a + b.g*b.a*(1-t.a))/a, b:(t.b*t.a + b.b*b.a*(1-t.a))/a, a}; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const canvas = dark ? {r:15,g:20,b:18,a:1} : {r:245,g:242,b:236,a:1};
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  const out = [], seen = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (el.closest('.sr-only, .skip-link, script, style, noscript, [hidden], .hidden, [aria-hidden="true"]')) continue;
    const chain = []; let skip = false, opacity = 1;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      opacity *= parseFloat(s.opacity);
      if (s.backgroundImage !== 'none') { skip = true; break; }
      const bg = parse(s.backgroundColor);
      if (bg && bg.a > 0) chain.push(bg);
    }
    if (skip || opacity < 0.5) continue;
    let bg = canvas;
    for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg);
    const fg0 = parse(cs.color); if (!fg0) continue;
    const rt = ratio(over({...fg0, a: fg0.a * opacity}, bg), bg);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight) || 400;
    const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
    if (rt < need) out.push((el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '')) + ' "' + n.nodeValue.trim().slice(0, 28) + '" ' + rt.toFixed(2) + ':1');
  }
  return [...new Set(out)];
}"""

# Dark mode only: solid near-white boxes are almost always a hard-coded light background.
BRIGHT_JS = r"""() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', {willReadFrequently: true});
  const parse = c => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return {r: d[0], g: d[1], b: d[2], a: d[3] / 255}; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b); };
  const out = [];
  document.querySelectorAll('body *').forEach(el => {
    const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return;
    const r = el.getBoundingClientRect(); if (r.width < 24 || r.height < 12) return;
    if (el.closest('.sr-only, .skip-link, .hidden, [hidden]')) return;
    const bg = parse(s.backgroundColor); if (!bg || bg.a < 0.9) return;
    if (lum(bg) > 0.6) out.push(el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '') + ' ' + s.backgroundColor);
  });
  return [...new Set(out)];
}"""

SETTLE_JS = """async () => {
  const done = document.getAnimations().filter(a => { const t = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming(); return t && isFinite(t.endTime); });
  await Promise.allSettled(done.map(a => a.finished));
}"""

PAGE_FACTS_JS = r"""() => {
  const head = document.querySelector('head script[src="/site.js"]');
  return {
    title: document.title,
    lang: document.documentElement.lang,
    viewport: !!document.querySelector('meta[name=viewport]'),
    robots: (document.querySelector('meta[name=robots]') || {}).content || '',
    css: !!document.querySelector('link[rel=stylesheet][href="/site.css"]'),
    jsInHead: !!head, jsBlocking: !!head && !head.defer && !head.async,
    headers: document.querySelectorAll('header.site-header').length,
    footers: document.querySelectorAll('footer.site-footer').length,
    mains: document.querySelectorAll('main#main').length,
    skip: (document.querySelector('a.skip-link') || {getAttribute: () => null}).getAttribute('href'),
    h1: document.querySelectorAll('h1').length,
    toggles: document.querySelectorAll('.theme-toggle').length,
    inlineToggle: [...document.querySelectorAll('.theme-toggle')].some(b => b.hasAttribute('onclick')),
    nav: [...document.querySelectorAll('.topnav a')].map(a => a.getAttribute('href')),
    current: [...document.querySelectorAll('.topnav a[aria-current="page"]')].map(a => a.getAttribute('href')),
    footerLinks: [...document.querySelectorAll('.site-footer .footer-links a')].map(a => a.getAttribute('href')),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
}"""


def new_context(browser, width, height, theme=None, extra_init=None):
    ctx = browser.new_context(viewport={'width': width, 'height': height})
    if theme:
        ctx.add_init_script(f"try{{localStorage.setItem('theme','{theme}')}}catch(e){{}}")
    if extra_init:
        ctx.add_init_script(extra_init)
    ctx.route('**/*', route)
    return ctx


def watch(page, errors):
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)


def contrast(page, root=None):
    page.evaluate(SETTLE_JS)
    return page.evaluate(CONTRAST_JS, root)


def header_bottom(page):
    return page.evaluate("Math.max(0, document.querySelector('.site-header').getBoundingClientRect().bottom)")


def rect(page, sel):
    return page.evaluate("(s) => { const r = document.querySelector(s).getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, right: r.right}; }", sel)


def in_view(page, sel):
    """True when the element sits fully inside the viewport and not under the sticky header."""
    rc = rect(page, sel)
    vh = page.evaluate('window.innerHeight')
    return rc['top'] >= header_bottom(page) - 1 and rc['bottom'] <= vh + 1


# ── Compare helpers ─────────────────────────────────────────────────────────────────────────────
def goto_compare(page, query=''):
    page.goto(f'{BASE}/compare.html{query}')
    page.wait_for_selector('#examplePills .pill')


def do_search(page, topic='GLP-1 drugs and obesity'):
    page.fill('#topicInput', topic)
    page.click('#searchBtn')
    page.wait_for_selector('#step2:not(.hidden)', timeout=8000)


def pick(page, n, start=0):
    for i in range(start, start + n):
        page.locator('.paper-item .paper-title').nth(i).click()


def run_compare(page, n=3, mode='ok'):
    state['compare'] = mode
    pick(page, n)
    page.click('#compareBtn')
    page.wait_for_selector('#step3:not(.hidden)', timeout=8000)


def to_step2(page, topic='GLP-1 drugs and obesity'):
    state['search'] = 'ok'
    goto_compare(page)
    do_search(page, topic)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None, headless=True, args=['--no-sandbox'])

    # ═══ S. Shared design system on every page ══════════════════════════════════════════════════
    errors = []
    ctx = new_context(browser, 1280, 900)
    page = ctx.new_page()
    watch(page, errors)
    facts = {}
    for name, url, current in PAGES:
        page.goto(BASE + url)
        page.wait_for_timeout(250)
        f = page.evaluate(PAGE_FACTS_JS)
        facts[name] = f
        check(f'S {name}: loads without JS errors', not errors, '; '.join(errors)[:200])
        errors.clear()
        check(f'S {name}: uses the shared stylesheet and a blocking script in <head>', f['css'] and f['jsInHead'] and f['jsBlocking'])
        check(f'S {name}: one header, one footer, one main, a skip link that points at it', f['headers'] == 1 and f['footers'] == 1 and f['mains'] == 1 and f['skip'] == '#main', str(f))
        check(f'S {name}: one theme button, wired by the shared script (no inline handler)', f['toggles'] == 1 and not f['inlineToggle'])
        check(f'S {name}: has lang, viewport meta and exactly one h1', f['lang'] == 'en' and f['viewport'] and f['h1'] == 1, f"{f['lang']} {f['viewport']} h1={f['h1']}")
        check(f'S {name}: nav starts with Topics, Compare, How it works', f['nav'][:3] == ['/topics/', '/compare', '/methodology.html'], str(f['nav']))
        check(f'S {name}: the current page is marked in the nav', f['current'] == ([current] if current else []), str(f['current']))
    ref = facts['home']['footerLinks']
    check('S footer links are identical on every page', all(f['footerLinks'] == ref for f in facts.values()), str({k: v['footerLinks'] for k, v in facts.items() if v['footerLinks'] != ref}))
    titles = [f['title'] for f in facts.values()]
    check('S every page has its own title', len(set(titles)) == len(titles) and all(titles), str(titles))
    check('S the paused Daily Feed stays out of the nav and out of search', 'noindex' in facts['news']['robots'] and not any('news' in h for f in facts.values() for h in f['nav']))

    # Theme: one key shared by every page, applied before first paint, carried across pages.
    page.goto(BASE + '/index.html')
    page.evaluate("localStorage.clear()")
    page.reload()
    page.click('.theme-toggle')
    check('S theme: toggling sets dark, remembers it and reports it to assistive tech', page.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark' and page.evaluate("localStorage.getItem('theme')") == 'dark' and page.get_attribute('.theme-toggle', 'aria-pressed') == 'true')
    carried = []
    for name, url, _ in PAGES[1:]:
        page.goto(BASE + url, wait_until='domcontentloaded')
        carried.append((name, page.evaluate("document.documentElement.getAttribute('data-theme')")))
    check('S theme: dark carries to every other page without a flash', all(t == 'dark' for _, t in carried), str(carried))
    page.click('.theme-toggle')
    check('S theme: toggling back stores light', page.evaluate("document.documentElement.getAttribute('data-theme')") is None and page.evaluate("localStorage.getItem('theme')") == 'light')
    ctx.close()

    ctx = new_context(browser, 1280, 900, extra_init="try{if(!localStorage.getItem('theme')){localStorage.setItem('msai_theme','dark')}}catch(e){}")
    page = ctx.new_page()
    page.goto(BASE + '/methodology.html')
    check('S theme: a choice saved under the old Methodology key is still honoured', page.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark')
    ctx.close()

    # Keyboard focus is visible on every page.
    ctx = new_context(browser, 1280, 900)
    page = ctx.new_page()
    bad = []
    for name, url, _ in PAGES:
        page.goto(BASE + url)
        page.keyboard.press('Tab')
        page.keyboard.press('Tab')
        ring = page.evaluate("(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; })()")
        if not ring:
            bad.append(name)
    check('S keyboard focus shows a visible ring on every page', not bad, str(bad))
    ctx.close()

    # Layout and colour in both themes at desktop and phone widths.
    for theme in ('light', 'dark'):
        for width, height in ((1280, 900), (390, 844)):
            ctx = new_context(browser, width, height, theme)
            page = ctx.new_page()
            watch(page, errors)
            over, low, bright = [], [], []
            for name, url, _ in PAGES:
                page.goto(BASE + url)
                page.wait_for_timeout(250)
                if page.evaluate(PAGE_FACTS_JS)['overflow'] > 0:
                    over.append(name)
                low += [f'{name}: {x}' for x in contrast(page)]
                if theme == 'dark':
                    bright += [f'{name}: {x}' for x in page.evaluate(BRIGHT_JS)]
            check(f'S {theme} {width}px: no page scrolls sideways', not over, str(over))
            check(f'S {theme} {width}px: all text meets WCAG AA contrast', not low, '; '.join(low)[:400])
            if theme == 'dark':
                check(f'S dark {width}px: no hard-coded light boxes', not bright, '; '.join(bright)[:300])
            check(f'S {theme} {width}px: no JS errors on any page', not errors, '; '.join(errors)[:200])
            errors.clear()
            ctx.close()

    # Hover states (these used to be pale backgrounds in both themes, or white text on the light-green accent).
    for theme in ('light', 'dark'):
        ctx = new_context(browser, 1280, 900, theme)
        page = ctx.new_page()
        page.goto(BASE + '/index.html')
        bad = []
        for label, sel in (('Summarize', '#searchBtn'), ('Sign up', '.user-btn.primary'), ('topic pill', '.pill')):
            page.locator(sel).first.hover()
            page.wait_for_timeout(450)        # let the background transition finish
            bad += [f'{label}: {x}' for x in contrast(page, sel)]
        check(f'S {theme}: hovered buttons on the home page stay readable', not bad, '; '.join(bad))
        page.goto(BASE + '/compare.html')
        page.hover('#searchBtn')
        page.wait_for_timeout(450)
        res = contrast(page, '#searchBtn')
        check(f'S {theme}: hovered Search button on Compare stays readable', not res, str(res))
        ctx.close()

    # Page-specific details.
    ctx = new_context(browser, 390, 844)
    page = ctx.new_page()
    page.goto(BASE + '/privacy.html')
    cells = page.evaluate("[...document.querySelectorAll('.policy-table td')].map(td => { const r = td.getBoundingClientRect(); return {w: r.width, right: r.right, vis: td.offsetWidth > 0}; })")
    check('S privacy: the data table stacks on a phone, every cell visible and inside the screen', cells and all(c['vis'] and c['right'] <= 390 + 1 for c in cells), str(cells[:2]))
    ctx.close()

    # ═══ C. Compare page ═══════════════════════════════════════════════════════════════════════
    errors.clear()
    ctx = new_context(browser, 1280, 900, extra_init="window.__copied = null; Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (t) => { window.__copied = t; }}, configurable: true});")
    page = ctx.new_page()
    watch(page, errors)
    goto_compare(page)

    check('C1 first screen: one primary action, example topics and the step tracker', page.locator('#searchBtn').count() == 1 and page.locator('#examplePills .pill').count() >= 4 and page.locator('ol.steps li').count() == 3)
    check('C1 step tracker marks step 1 as current', page.get_attribute('#st1', 'aria-current') == 'step')
    check('C1 compare is not reachable before a search', not page.is_visible('#step2') and not page.is_visible('#step3'))

    # Empty / too-short topic: a helpful message, no request.
    page.fill('#topicInput', 'ab')
    page.click('#searchBtn')
    check('C2 a too-short topic gets a helpful alert and no request', page.is_visible('#errorBox') and 'at least 3' in page.inner_text('#errorBox') and page.get_attribute('#errorBox', 'role') == 'alert' and not calls)
    check('C2 focus goes back to the topic box', page.evaluate("document.activeElement.id") == 'topicInput')

    # Search: loading state, results, focus.
    state['search'] = 'hold'
    page.fill('#topicInput', 'GLP-1 drugs and obesity')
    page.click('#searchBtn')
    page.wait_for_timeout(300)
    check('C3 while searching: skeleton shown, button disabled, status announced', page.is_visible('#searchLoading') and page.is_disabled('#searchBtn') and 'Searching' in page.inner_text('#searchStatus'))
    page.press('#topicInput', 'Enter')
    page.press('#topicInput', 'Enter')
    page.wait_for_timeout(150)
    release(answer_search, 'ok')
    page.wait_for_selector('#step2:not(.hidden)')
    check('C3 pressing Enter again while a search is running does not send a second request', sum(1 for k, _ in calls if k == 'search') == 1, str(calls))
    check('C3 the search sends just the topic', ('search', {'topic': 'GLP-1 drugs and obesity'}) in calls)
    state['search'] = 'ok'
    check('C3 step 1 is replaced by step 2 and the tracker moves on', not page.is_visible('#step1') and page.get_attribute('#st2', 'aria-current') == 'step' and page.inner_text('#snum1').strip() == '✓')
    check('C3 the results heading says how many papers and gets focus', '12 papers found' in page.inner_text('#searchResultLabel').lower() and page.evaluate("document.activeElement.id") == 'searchResultLabel')
    check('C3 the skeleton and status are cleared', not page.is_visible('#searchLoading') and page.inner_text('#searchStatus') == '' and not page.is_disabled('#searchBtn'))
    check('C3 each paper shows its year, design and journal', page.locator('.paper-item').count() == 12 and '2021' in page.inner_text('.paper-item >> nth=0') and 'Randomized controlled trial' in page.inner_text('.paper-item >> nth=0') and 'N Engl J Med' in page.inner_text('.paper-item >> nth=0'))
    check('C3 paper titles are text, never markup', page.locator('#paperList img, #paperList b, #paperList script').count() == 0 and '<img' in page.inner_text('.paper-item >> nth=1'))
    links = page.evaluate("[...document.querySelectorAll('#paperList a.paper-link')].map(a => [a.href, a.target, a.rel])")
    check('C3 PubMed links go to the right article in a new tab', len(links) == 12 and links[0][0] == 'https://pubmed.ncbi.nlm.nih.gov/31000001/' and all(t == '_blank' and 'noopener' in r for _, t, r in links))
    check('C3 the selection bar is on screen without scrolling (long list)', in_view(page, '#selectionBar') and in_view(page, '#compareBtn'))
    page.evaluate('window.scrollTo(0, 0)')
    check('C3 ... and stays on screen at the top of the page', in_view(page, '#selectionBar'))
    page.evaluate(SETTLE_JS)
    page.screenshot(path=f'{OUT}/compare-step2-desktop.png')

    # Selecting papers.
    check('C4 nothing selected: compare disabled and the hint says what to do', page.is_disabled('#compareBtn') and page.inner_text('#selHint') == 'Pick at least 2' and page.inner_text('#selCount') == '0 of 5 selected' and not page.is_visible('#clearBtn'))
    pick(page, 1)
    check('C4 one selected: still disabled, asks for one more', page.is_disabled('#compareBtn') and page.inner_text('#selHint') == 'Pick at least 1 more' and page.locator('.paper-item.selected').count() == 1)
    pick(page, 1, 1)
    check('C4 two selected: compare enabled', not page.is_disabled('#compareBtn') and page.inner_text('#selHint') == 'Ready to compare' and page.is_visible('#clearBtn'))
    pick(page, 3, 2)
    check('C4 five selected: the limit is stated', page.inner_text('#selCount') == '5 of 5 selected' and 'Maximum' in page.inner_text('#selHint'))
    pick(page, 1, 5)
    check('C4 a sixth paper is refused with a message next to the button, not at the top of the page', page.inner_text('#selCount') == '5 of 5 selected' and 'up to 5' in page.inner_text('#selHint') and not page.locator('.paper-cb >> nth=5').is_checked() and not page.is_visible('#errorBox') and in_view(page, '#selHint'))
    page.click('#clearBtn')
    check('C4 Clear empties the selection and disables compare again', page.locator('.paper-item.selected').count() == 0 and page.is_disabled('#compareBtn') and page.inner_text('#selCount') == '0 of 5 selected')
    page.focus('.paper-cb >> nth=3')
    page.keyboard.press('Space')
    check('C4 papers can be picked with the keyboard', page.locator('.paper-cb >> nth=3').is_checked() and page.inner_text('#selCount') == '1 of 5 selected')
    page.click('#clearBtn')

    # Compare: loading, results, focus and scroll position.
    state['compare'] = 'hold'
    pick(page, 3)
    page.click('#compareBtn')
    page.wait_for_timeout(300)
    check('C5 while comparing: a skeleton replaces the list and the tracker is on step 3', page.is_visible('#compareLoading') and not page.is_visible('#step2') and page.get_attribute('#st3', 'aria-current') == 'step' and 'Fetching' in page.inner_text('#compareLoadingText'))
    release(answer_compare, 'ok')
    page.wait_for_selector('#step3:not(.hidden)')
    page.wait_for_timeout(200)
    check('C5 the request sends exactly the picked PMIDs', ('compare', {'pmids': ['31000001', '31000002', '31000003']}) in calls, str(calls[-1]))
    check('C5 the skeleton goes away and the results get focus', not page.is_visible('#compareLoading') and page.evaluate("document.activeElement.id") == 'step3')
    top = rect(page, '#step3')['top'] - header_bottom(page)
    check('C5 the page lands on the top of the results (no overshoot past them)', -1 <= top <= 120, f'step3 is {top}px below the header')
    # table
    check('C5 table: one column per paper plus a label column', page.locator('#compTable thead th[scope=col]').count() == 4)
    rows = page.evaluate("[...document.querySelectorAll('#compTable tbody th[scope=row]')].map(t => t.firstChild.textContent)")
    check('C5 table: rows are study type, population, methods, key finding, limitations', rows == ['Study type', 'Population', 'Methods', 'Key finding', 'Limitations'], str(rows))
    check('C5 table: missing values show a dash, not a blank', page.inner_text('#compTable tbody tr:last-child td:last-child') == '—')
    check('C5 table: different designs are flagged on the study-type row and in a note', page.locator('#compTable tr.differs').count() == 1 and 'designs differ' in page.inner_text('#compTable tr.differs th').lower() and page.is_visible('#designNote') and 'cohort study' in page.inner_text('#designNote').lower())
    hrefs = page.evaluate("[...document.querySelectorAll('#compTable a.col-link')].map(a => a.href)")
    check('C5 only a real PubMed URL becomes a link (javascript: and other sites are plain text)', hrefs == ['https://pubmed.ncbi.nlm.nih.gov/31000001/'], str(hrefs))
    check('C5 untrusted text is never turned into markup', page.locator('#step3 img, #step3 script').count() == 0 and '<script>' in page.inner_text('#compTable') and not page.evaluate("document.querySelector('#step3').innerHTML.includes('javascript:')"))
    check('C5 synthesis, agreement and difference blocks render', 'agree that the drugs reduce weight' in page.inner_text('#synthesisSummary') and 'where studies agree' in page.inner_text('#agreeDisagree').lower() and 'where studies differ' in page.inner_text('#agreeDisagree').lower())
    check('C5 research gaps are numbered', page.locator('.gap-item .gap-num').all_inner_texts() == ['G1', 'G2'])
    check('C5 the limits notice is present', 'abstracts only' in page.inner_text('#step3 .limits').lower())
    check('C5 desktop shows the table, not the phone cards', page.is_visible('#tableWrap') and not page.is_visible('#compCards'))
    page.evaluate(SETTLE_JS)
    page.screenshot(path=f'{OUT}/compare-results-desktop.png')

    # Copy.
    page.click('#copyBtn')
    page.wait_for_timeout(150)
    text = page.evaluate('window.__copied') or ''
    check('C6 Copy confirms on the button and for screen readers', page.inner_text('#copyBtn') == 'Copied ✓' and 'copied' in page.inner_text('#copyStatus').lower())
    check('C6 the copied text names the topic, each paper and the AI-synthesis caveat', 'Comparison: GLP-1 drugs and obesity' in text and '1. Compared paper 1' in text and '3. Compared paper 3' in text and 'Synthesis (AI interpretation)' in text and text.rstrip().endswith('Not medical advice.'), text[:120])
    check('C6 the copied text links only the valid PubMed URL', 'https://pubmed.ncbi.nlm.nih.gov/31000001/' in text and 'evil.example' not in text and 'javascript:' not in text)
    page.wait_for_timeout(2400)
    check('C6 the button goes back to its normal label', page.inner_text('#copyBtn') == 'Copy comparison' and page.inner_text('#copyStatus') == '')

    # Navigation between steps.
    page.click('#changeSelBtn')
    check('C7 Change selection returns to the list with the picks kept', page.is_visible('#step2') and not page.is_visible('#step3') and page.locator('.paper-item.selected').count() == 3 and not page.is_disabled('#compareBtn'))
    check('C7 ... and the tracker goes back to step 2', page.get_attribute('#st2', 'aria-current') == 'step' and page.inner_text('#snum3').strip() == '3')
    page.click('#backBtn')
    check('C7 New search returns to step 1 with the cursor in the topic box', page.is_visible('#step1') and not page.is_visible('#step2') and page.evaluate("document.activeElement.id") == 'topicInput')
    do_search(page, 'statins LDL cholesterol')
    check('C7 a new search starts with nothing selected', page.locator('.paper-item.selected').count() == 0 and page.is_disabled('#compareBtn'))
    run_compare(page, 2)
    page.click('#newSearchBtn')
    check('C7 New search from the results works too', page.is_visible('#step1') and not page.is_visible('#step3'))

    # Same design, written two ways, is not a "designs differ" warning.
    do_search(page)
    run_compare(page, 2, 'same')
    check('C8 "RCT" and "Randomized controlled trial" count as the same design', page.locator('#compTable tr.differs').count() == 0 and not page.is_visible('#designNote'))
    check('C8 no gaps and no agreement lists: the page says so instead of leaving empty boxes', 'No research gaps' in page.inner_text('#gapList') and page.locator('#agreeDisagree > div').count() == 2)
    page.click('#newSearchBtn')
    do_search(page)
    run_compare(page, 2, 'nosyn')
    check('C8 a missing synthesis shows a plain fallback sentence', 'No overall synthesis' in page.inner_text('#synthesisSummary') and page.locator('#agreeDisagree > div').count() == 0)
    page.click('#newSearchBtn')

    # Wide table: scroll hint.
    do_search(page)
    run_compare(page, 5, 'wide')
    wide = page.evaluate("(() => { const w = document.getElementById('tableWrap'); return w.scrollWidth > w.clientWidth + 2; })()")
    if wide:
        check('C9 a table wider than its box tells the reader to scroll sideways', page.is_visible('#scrollHint'))
        page.evaluate("document.getElementById('tableWrap').scrollLeft = 300")
        page.wait_for_timeout(150)
        check('C9 the hint goes away once they have', not page.is_visible('#scrollHint'))
    else:
        check('C9 a table that fits shows no scroll hint', not page.is_visible('#scrollHint'))
    check('C9 the scrollable table can be reached with the keyboard', page.get_attribute('#tableWrap', 'tabindex') == '0' and page.get_attribute('#tableWrap', 'role') == 'region')
    page.click('#newSearchBtn')

    # Prefill from a link.
    goto_compare(page, '?topic=GLP-1%20drugs')
    check('C10 ?topic= pre-fills the box and waits for the reader to search', page.input_value('#topicInput') == 'GLP-1 drugs' and not page.is_visible('#step2'))
    check('C11 no JS errors through the whole flow', not errors, '; '.join(errors)[:300])
    ctx.close()

    # Errors: each says what happened and what to do, in view, with the reader's work kept.
    errors.clear()
    ctx = new_context(browser, 1280, 900)
    page = ctx.new_page()
    watch(page, errors)
    cases = [
        ('search', 'fail', 'Something went wrong on our side', 'C12 a server error while searching'),
        ('search', 'abort', 'Couldn’t reach MedSumAI', 'C12 no connection while searching'),
        ('search', 'empty', 'No PubMed abstracts matched', 'C12 no results (the server explains)'),
        ('search', 'empty-nomsg', 'No PubMed abstracts found for that topic', 'C12 no results (default explanation)'),
    ]
    for kind, mode, expect, label in cases:
        state['search'] = mode
        goto_compare(page)
        page.fill('#topicInput', 'zzzz')
        page.click('#searchBtn')
        page.wait_for_selector('#errorBox:not(.hidden)')
        check(f'{label}: says what to do, stays on step 1, can retry, and is on screen', expect in page.inner_text('#errorBox') and page.is_visible('#step1') and not page.is_disabled('#searchBtn') and not page.is_visible('#searchLoading') and in_view(page, '#errorBox'), page.inner_text('#errorBox'))
    state['search'] = 'ok'
    page.fill('#topicInput', 'statins')
    page.click('#searchBtn')
    page.wait_for_selector('#step2:not(.hidden)')
    check('C12 a retry after an error works and clears the message', not page.is_visible('#errorBox'))
    page.click('#backBtn')

    for mode, expect, label in (('502', 'temporarily unavailable', 'C13 the comparison service is down'), ('429', 'Too many requests', 'C13 rate limited'), ('abort', 'Couldn’t reach MedSumAI', 'C13 no connection'), ('empty', 'came back empty', 'C13 an empty comparison')):
        state['search'] = 'ok'
        goto_compare(page)
        do_search(page)
        pick(page, 2)
        page.evaluate('window.scrollTo(0, document.body.scrollHeight)')   # the reader is far down the list when it fails
        state['compare'] = mode
        page.click('#compareBtn')
        page.wait_for_selector('#errorBox:not(.hidden)')
        page.wait_for_timeout(300)
        check(f'C13 {label}: message in view, list back with the picks, retry possible', expect in page.inner_text('#errorBox') and in_view(page, '#errorBox') and page.is_visible('#step2') and not page.is_visible('#compareLoading') and page.inner_text('#selCount') == '2 of 5 selected' and not page.is_disabled('#compareBtn') and page.get_attribute('#st2', 'aria-current') == 'step', f'{page.inner_text("#errorBox")!r} top={rect(page, "#errorBox")["top"]:.0f}')
    state['compare'] = 'ok'
    page.click('#compareBtn')
    page.wait_for_selector('#step3:not(.hidden)')
    check('C13 retrying after a failed comparison works', not page.is_visible('#errorBox') and page.locator('#compTable thead th[scope=col]').count() == 4)
    check('C13 no JS errors while handling failures', not errors, '; '.join(errors)[:300])
    ctx.close()

    # Phones: one card per paper instead of a five-column table, and the same behaviour.
    errors.clear()
    ctx = new_context(browser, 390, 844)
    page = ctx.new_page()
    watch(page, errors)
    to_step2(page)
    check('C14 phone: the list fits the screen width', page.evaluate("document.documentElement.scrollWidth <= window.innerWidth") and in_view(page, '#compareBtn'))
    page.evaluate(SETTLE_JS)
    page.screenshot(path=f'{OUT}/compare-step2-phone.png')
    run_compare(page, 3)
    page.wait_for_timeout(200)
    check('C14 phone: results are one card per paper, not a table', page.is_visible('#compCards') and page.locator('#compCards article').count() == 3 and not page.is_visible('#tableWrap') and [t.lower() for t in page.locator('#compCards article:first-child dt').all_inner_texts()] == ['study type', 'population', 'methods', 'key finding', 'limitations'])
    check('C14 phone: nothing scrolls sideways', page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    check('C14 phone: only valid PubMed links in the cards', page.evaluate("[...document.querySelectorAll('#compCards a.col-link')].map(a => a.href)") == ['https://pubmed.ncbi.nlm.nih.gov/31000001/'])
    top = rect(page, '#step3')['top'] - header_bottom(page)
    check('C14 phone: lands on the top of the results', -1 <= top <= 120, f'{top}px')
    page.evaluate(SETTLE_JS)
    page.screenshot(path=f'{OUT}/compare-results-phone.png')
    page.click('#changeSelBtn')
    page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    state['compare'] = '502'
    page.click('#compareBtn')
    page.wait_for_selector('#errorBox:not(.hidden)')
    page.wait_for_timeout(300)
    check('C14 phone: a failure is on screen too', in_view(page, '#errorBox') and page.is_visible('#step2'), str(rect(page, '#errorBox')))
    check('C14 phone: no JS errors', not errors, '; '.join(errors)[:300])
    state['compare'] = 'ok'
    ctx.close()

    # Every Compare state, in both themes and at both widths, passes the colour checks.
    for theme in ('light', 'dark'):
        for width, height in ((1280, 900), (390, 844)):
            ctx = new_context(browser, width, height, theme)
            page = ctx.new_page()
            problems = []

            def scan(label):
                problems.extend(f'{label}: {x}' for x in contrast(page))
                if theme == 'dark':
                    problems.extend(f'{label}: bright box {x}' for x in page.evaluate(BRIGHT_JS))

            state['search'] = 'ok'
            goto_compare(page)
            scan('step 1')
            page.fill('#topicInput', 'x')
            page.click('#searchBtn')
            scan('step 1 error')
            do_search(page)
            pick(page, 5)
            pick(page, 1, 5)
            scan('step 2 with five picks and the limit message')
            page.click('#clearBtn')
            pick(page, 3)
            state['compare'] = 'ok'
            page.click('#compareBtn')
            page.wait_for_selector('#step3:not(.hidden)')
            scan('step 3 results')
            page.click('#changeSelBtn')
            state['compare'] = '502'
            page.click('#compareBtn')
            page.wait_for_selector('#errorBox:not(.hidden)')
            scan('step 2 after a failed comparison')
            state['compare'] = 'ok'
            check(f'C15 compare, {theme} {width}px: every state passes the contrast checks (step 1, 2, 3 and errors)', not problems, '; '.join(problems)[:500])
            if theme == 'dark' and width == 1280:
                page.click('#compareBtn')
                page.wait_for_selector('#step3:not(.hidden)')
                page.evaluate(SETTLE_JS)
                page.screenshot(path=f'{OUT}/compare-results-dark.png')
            ctx.close()

    # ═══ H. Home page states (the parts only reachable by interacting) ═══════════════════════════
    for theme in ('light', 'dark'):
        for width, height in ((1280, 900), (390, 844)):
            ctx = new_context(browser, width, height, theme)
            page = ctx.new_page()
            problems = []

            def scan_home(label, root=None):
                problems.extend(f'{label}: {x}' for x in contrast(page, root))

            state['summarize'] = 'ok'
            page.goto(BASE + '/index.html')
            page.fill('#topicInput', 'immunity')
            page.click('#searchBtn')
            page.wait_for_selector('#resultBox.visible', timeout=8000)
            page.wait_for_timeout(300)
            scan_home('results dashboard')
            page.fill('#chatInput', 'what were the key findings?')
            page.press('#chatInput', 'Enter')
            page.wait_for_function("document.querySelectorAll('#chatMessages .chat-msg').length >= 2 && !document.querySelector('#chatMessages .typing')", timeout=5000)
            scan_home('follow-up chat')
            state['summarize'] = 'fail'
            page.click('#searchBtn')
            page.wait_for_selector('#errorBox.visible', timeout=8000)
            scan_home('error box', '#errorBox')
            state['summarize'] = 'ok'
            page.click('.user-btn:has-text("Log in")')
            page.wait_for_selector('#authModal.visible')
            page.click('#signupTab')
            page.wait_for_timeout(250)
            scan_home('sign-in dialog', '#authModal')
            check(f'H home, {theme} {width}px: results, chat, error box and sign-in dialog pass the contrast checks', not problems, '; '.join(problems)[:500])
            if theme == 'dark' and width == 1280:
                page.keyboard.press('Escape')
                page.evaluate("document.querySelector('.subscribe-bar').scrollIntoView({block: 'center'})")
                page.wait_for_timeout(200)
                page.screenshot(path=f'{OUT}/home-subscribe-dark.png')
            ctx.close()

    browser.close()

httpd.shutdown()
fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} checks passed')
sys.exit(1 if fails else 0)
