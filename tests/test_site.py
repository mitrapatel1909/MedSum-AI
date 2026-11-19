# Browser tests for the static site. The network is stubbed: no real backend, Supabase or PubMed is called.
# Run:  pip install playwright && playwright install chromium && python3 tests/test_site.py
import json, os, sys, time, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PORT = 8765
OUT = os.environ.get('SHOTS_DIR', '/tmp/medsumai-shots')
os.makedirs(OUT, exist_ok=True)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a, **k: None
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}
calls = []          # (kind, payload)
state = {'webhook_mode': 'ok', 'webhook_delay': 0}
results = []


def check(name, cond, extra=''):
    results.append((name, bool(cond), extra))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))


def route(r):
    req = r.request
    url = req.url
    if url.startswith(f'http://127.0.0.1:{PORT}'):
        return r.continue_()
    if req.method == 'OPTIONS':
        return r.fulfill(status=204, headers=CORS)
    if '/rest/v1/rpc/' in url:
        fn = url.split('/rpc/')[1].split('?')[0]
        body = req.post_data or '{}'
        calls.append(('rpc:' + fn, json.loads(body)))
        payload = {'get_search_count': '51', 'record_search': '52', 'subscribe': ''}.get(fn, 'null')
        return r.fulfill(status=200 if payload else 204, headers={**CORS, 'content-type': 'application/json'}, body=payload)
    if 'api.medsumai.com/summarize' in url:
        calls.append(('webhook:search', json.loads(req.post_data or '{}')))
        if state['webhook_delay']:
            time.sleep(state['webhook_delay'])
        if state['webhook_mode'] == 'fail':
            return r.fulfill(status=500, headers=CORS, body='boom')
        if state['webhook_mode'] == 'limit':
            return r.fulfill(status=429, headers={**CORS, 'content-type': 'application/json'}, body=json.dumps({'error': 'Too many requests. Please wait a bit and try again.'}))
        if state['webhook_mode'] == 'daily':
            return r.fulfill(status=429, headers={**CORS, 'content-type': 'application/json'}, body=json.dumps({'error': 'MedSumAI has reached its free daily limit. Please come back tomorrow.'}))
        return r.fulfill(status=200, headers={**CORS, 'content-type': 'text/plain'}, body='## Summary\n\nTest summary text.')
    if 'api.medsumai.com/chat' in url:
        calls.append(('webhook:chat', json.loads(req.post_data or '{}')))
        return r.fulfill(status=200, headers={**CORS, 'content-type': 'text/plain'}, body='Follow-up answer.')
    if 'railway.app' in url or '/webhook/' in url:
        calls.append(('LEGACY_BACKEND', url))
        return r.fulfill(status=500, headers=CORS, body='legacy backend must not be called')
    if 'drive.google.com' in url:
        calls.append(('drive', url))
        return r.fulfill(status=200, body='ok', headers={'content-type': 'text/html'})
    # fonts / CDN scripts / analytics: not needed offline
    ctype = 'application/javascript' if url.split('?')[0].endswith('.js') else 'text/plain'
    return r.fulfill(status=200, body='', headers={**CORS, 'content-type': ctype})


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None, headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
    ctx.route('**/*', route)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)

    page.goto(f'http://127.0.0.1:{PORT}/index.html')
    page.wait_for_timeout(800)
    check('1 page loads without JS errors', not errors, '; '.join(errors)[:300])
    check('1 invented stat gone', 'Researchers Helped' not in page.content())
    check('1 counter hidden while count < 1000', not page.is_visible('#statSearchesItem'))
    check('1 counter fetched via get_search_count RPC', any(k == 'rpc:get_search_count' for k, _ in calls))
    check('1 skip link + main landmark present', page.locator('a.skip-link').count() == 1 and page.locator('main#main').count() == 1)
    check('1 no Daily Feed link in nav', page.locator('nav a[href="news.html"]').count() == 0)
    page.screenshot(path=f'{OUT}/home-desktop.png')

    # 2. successful search
    page.fill('#topicInput', 'immunity')
    page.click('#searchBtn')
    page.wait_for_selector('#resultBox.visible', timeout=8000)
    page.wait_for_timeout(400)
    check('2 search posts topic + default level to the new API', ('webhook:search', {'topic': 'immunity', 'level': 'undergrad'}) in calls)
    check('2 page no longer mentions the old backend', 'railway' not in page.content().lower() and 'n8n' not in page.content().lower())
    check('2 legacy n8n/Railway backend never called', not any(k == 'LEGACY_BACKEND' for k, _ in calls))
    check('2 record_search RPC called with topic', ('rpc:record_search', {'p_topic': 'immunity'}) in calls)
    check('2 disclaimer visible inside result', page.is_visible('#resultBox .result-disclaimer'))
    check('2 result box receives focus', page.evaluate("document.activeElement && document.activeElement.id") == 'resultBox')
    page.screenshot(path=f'{OUT}/result-desktop.png', full_page=False)

    # 2b. follow-up chat
    page.fill('#chatInput', 'what were the key findings?')
    page.click('.chat-input-row button')
    page.wait_for_function("document.querySelectorAll('#chatMessages .chat-msg').length >= 2 && !document.querySelector('#chatMessages .typing')", timeout=5000)
    check('2b follow-up chat works', any(k == 'webhook:chat' for k, _ in calls))

    # 3. server error shows a clear message
    state['webhook_mode'] = 'fail'
    page.fill('#topicInput', 'diabetes')
    page.click('#searchBtn')
    page.wait_for_selector('#errorBox.visible', timeout=8000)
    msg = page.inner_text('#errorBox')
    check('3 HTTP 500 -> "temporarily unavailable" message', 'temporarily unavailable' in msg, msg)
    state['webhook_mode'] = 'limit'
    page.fill('#topicInput', 'rate limited')
    page.click('#searchBtn')
    page.wait_for_function("document.getElementById('errorBox').classList.contains('visible') && document.getElementById('errorBox').textContent.includes('Too many requests')", timeout=8000)
    check('3b server 429 message shown verbatim', 'Please wait a bit and try again.' in page.inner_text('#errorBox'), page.inner_text('#errorBox'))
    state['webhook_mode'] = 'daily'
    page.click('#searchBtn')
    page.wait_for_function("document.getElementById('errorBox').textContent.includes('daily limit')", timeout=8000)
    check('3c global daily-limit message shown', 'come back tomorrow' in page.inner_text('#errorBox'), page.inner_text('#errorBox'))
    state['webhook_mode'] = 'ok'

    # 3d. reading level is sent and remembered
    page.select_option('#levelSelect', 'premed')
    page.fill('#topicInput', 'level test')
    page.click('#searchBtn')
    page.wait_for_selector('#resultBox.visible', timeout=8000)
    check('3d chosen level is sent to the API', ('webhook:search', {'topic': 'level test', 'level': 'premed'}) in calls)
    page.reload()
    page.wait_for_timeout(500)
    check('3d level is remembered after reload', page.input_value('#levelSelect') == 'premed', page.input_value('#levelSelect'))
    page.select_option('#levelSelect', 'undergrad')

    # 4. loading progress: last step must not show "done" while still waiting
    state['webhook_delay'] = 8
    page.fill('#topicInput', 'slow topic')
    page.click('#searchBtn')
    page.wait_for_timeout(7700)
    cls = page.get_attribute('#step4', 'class')
    check('4 last loading step still active while waiting (not falsely done)', 'active' in cls and 'done' not in cls, cls)
    page.wait_for_selector('#resultBox.visible', timeout=15000)
    state['webhook_delay'] = 0

    # 5. newsletter
    calls.clear()
    page.fill('#subscribeEmail', 'not-an-email')
    page.click('.subscribe-btn')
    page.wait_for_timeout(300)
    check('5 invalid email blocked client-side (no RPC)', not any(k == 'rpc:subscribe' for k, _ in calls))
    page.fill('#subscribeEmail', 'Student@Example.com')
    page.click('.subscribe-btn')
    page.wait_for_function("document.querySelector('.subscribe-btn').textContent.includes('Subscribed')", timeout=4000)
    check('5 subscribe goes through subscribe RPC', ('rpc:subscribe', {'p_email': 'Student@Example.com'}) in calls)

    # 6. study guide modal (soft email gate)
    calls.clear()
    page.locator('.buy-btn').first.click()
    page.wait_for_selector('#guideModal.visible')
    check('6 guide modal opens with the right title', page.inner_text('#guideTitle') == 'Get the Immune System guide', page.inner_text('#guideTitle'))
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/guide-modal.png')
    with ctx.expect_page() as pop:
        page.click('.guide-skip')
    popup = pop.value
    popup.wait_for_load_state('domcontentloaded')
    check('6 skip: PDF still opens, nothing subscribed', 'drive.google.com' in popup.url and not any(k == 'rpc:subscribe' for k, _ in calls), popup.url)
    popup.close()
    check('6 modal closed after download', not page.is_visible('#guideModal'))

    page.locator('.buy-btn').nth(1).click()
    page.wait_for_selector('#guideModal.visible')
    page.click('#guideSubmitBtn')
    check('6 empty email -> inline error, modal stays', page.is_visible('#guideError') and page.is_visible('#guideModal'))
    page.fill('#guideEmail', 'bio@example.org')
    with ctx.expect_page() as pop2:
        page.click('#guideSubmitBtn')
    pop2.value.close()
    page.wait_for_timeout(400)
    check('6 with email: subscribes and opens PDF', ('rpc:subscribe', {'p_email': 'bio@example.org'}) in calls)

    # 7. keyboard + a11y
    page.locator('.buy-btn').first.click()
    page.wait_for_selector('#guideModal.visible')
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    check('7 Escape closes the guide modal', not page.is_visible('#guideModal'))
    page.click('.faq-question >> nth=0')
    check('7 FAQ aria-expanded=true when open', page.get_attribute('.faq-question >> nth=0', 'aria-expanded') == 'true')
    page.click('.faq-question >> nth=0')
    check('7 FAQ aria-expanded=false when closed', page.get_attribute('.faq-question >> nth=0', 'aria-expanded') == 'false')
    check('7 dialogs are labelled', page.locator('[role=dialog][aria-modal=true]').count() == 4)
    check('7 close buttons have accessible names', page.locator('.modal-close:not([aria-label])').count() == 0)

    # 8. existing login modal still works
    page.click('.user-btn:has-text("Log in")')
    page.wait_for_selector('#authModal.visible')
    check('8 login modal opens', True)
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    check('8 Escape closes login modal', not page.is_visible('#authModal'))

    # 9. counter appears once large enough
    page.evaluate("showSearchCount(1530)")
    check('9 counter shows "1.5k" when >= 1000', page.is_visible('#statSearchesItem') and page.inner_text('#statSearches') == '1.5k', page.inner_text('#statSearches'))

    # 10. mobile layout screenshot
    m = ctx.new_page()
    m.set_viewport_size({'width': 390, 'height': 844})
    m.goto(f'http://127.0.0.1:{PORT}/index.html')
    m.wait_for_timeout(800)
    m.screenshot(path=f'{OUT}/home-mobile.png')
    overflow = m.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")
    check('10 no horizontal overflow on a 390px phone', not overflow)

    check('11 no JS errors during the whole session', not [e for e in errors], '; '.join(errors)[:300])

    # 12. head metadata on the main page
    h = ctx.new_page()
    h.goto(f'http://127.0.0.1:{PORT}/index.html')
    attr = lambda sel, a: h.get_attribute(sel, a)
    check('12 canonical is medsumai.com', attr('link[rel=canonical]', 'href') == 'https://medsumai.com/')
    check('12 og:url + og:image + twitter:image set',
          attr('meta[property="og:url"]', 'content') == 'https://medsumai.com/'
          and attr('meta[property="og:image"]', 'content') == 'https://medsumai.com/og-image.png'
          and attr('meta[name="twitter:image"]', 'content') == 'https://medsumai.com/og-image.png')
    check('12 favicon links present', h.locator('link[rel=icon]').count() == 2)
    for f in ('favicon.svg', 'favicon.ico', 'og-image.png', 'robots.txt', 'sitemap.xml'):
        st = ctx.request.get(f'http://127.0.0.1:{PORT}/{f}').status
        check(f'12 /{f} is served (200)', st == 200, str(st))

    # 13. Daily Feed page: missing news.json must show the friendly paused message
    n = ctx.new_page()
    n.goto(f'http://127.0.0.1:{PORT}/news.html')
    n.wait_for_timeout(1200)
    txt = n.inner_text('#feedContent')
    check('13 news page shows friendly paused message', 'taking a break' in txt and 'news.json' not in txt and 'n8n' not in txt, txt[:120])
    check('13 news page is noindex', n.get_attribute('meta[name=robots]', 'content').startswith('noindex'))
    check('13 news page no longer claims "updated daily"', 'pdated daily' not in n.content())

    # 14. privacy page
    q = ctx.new_page()
    q.goto(f'http://127.0.0.1:{PORT}/privacy.html')
    body = q.inner_text('body')
    check('14 privacy page discloses hashed-IP rate limiting', 'hashed' in body and 'Last updated: November 2026' in body)
    check('14 privacy canonical is medsumai.com', q.get_attribute('link[rel=canonical]', 'href') == 'https://medsumai.com/privacy.html')
    browser.close()

httpd.shutdown()
fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)}/{len(results)} checks passed')
sys.exit(1 if fails else 0)
