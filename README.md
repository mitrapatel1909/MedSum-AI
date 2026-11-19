# MedSumAI

**Medical research, explained simply.** MedSumAI takes any biomedical topic, finds real articles on PubMed, and writes a plain-language summary with links back to the sources. Free to use, no signup needed to search.

**Live site:** https://medsumai.com

> Educational use only. Summaries are written by AI and can contain mistakes. Always check the linked PubMed sources, and talk to a qualified clinician about health decisions. This is not medical advice.

## What it does

- Searches PubMed for a topic and summarizes the abstracts it finds, with a citation link for each article
- Follow-up chat about the summary you just generated
- Optional free accounts: save summaries to "My Summaries"
- Free PDF study guides (immune system, cell biology, genetics) with an optional email signup
- Light and dark mode

## How it is built

| Piece | What it does |
|---|---|
| Static site (`index.html`, `privacy.html`, `news.html`) | The whole frontend: plain HTML, CSS and JavaScript, no build step |
| GitHub Pages + Cloudflare | Hosting and the `medsumai.com` domain |
| n8n on Railway | Backend webhooks: PubMed search, article fetch, then an OpenAI model (currently GPT-5-Mini) writes the summary |
| Supabase | Accounts (Auth), saved summaries, the public summary counter, mailing list |
| Cloudflare Web Analytics | Cookieless visit statistics |

### Request flow

```
Browser ── topic ──► n8n webhook ─► PubMed search ─► fetch abstracts ─► OpenAI summary ─► Markdown
Browser ◄── summary (rendered with marked + DOMPurify) ◄────────────────────────────────┘
Browser ── record_search(topic) ──► Supabase (server-side counter and log)
```

## Database and security

The browser only talks to Supabase through the public anon key, so everything it can reach has to be safe to expose:

- `saved_summaries`: row-level security, each user can only see and change their own rows
- `searches`, `search_stats`, `subscriptions`, `usage_limits`: **no direct access** from the browser. The site uses three narrow, validated, rate-limited functions instead: `record_search`, `get_search_count` and `subscribe`
- Rate limiting identifies visitors by a salted hash of their IP address (never the raw address), and expired entries are deleted automatically

The SQL lives in [`supabase/migrations`](supabase/migrations) and is meant to be applied in order. Migration `002` removes the old open table access and must only be applied once the frontend that uses the functions is live.

## Known limitations

- **The n8n webhook URLs are public and unauthenticated** (they are visible in the page source). Anyone can call them directly. Fixing this means moving the backend behind a small authenticated, rate-limited proxy (for example a Cloudflare Worker).
- **The Daily Feed (`news.html`) is paused.** It reads `news.json` from this repo, which the old n8n workflow wrote and is no longer being generated. The page shows a "taking a break" message and is set to `noindex`. When the generator is running again, remove the `noindex` meta tag in `news.html`, add the page back to `sitemap.xml`, and re-add the link in the site header.
- Summaries use abstracts only, not full papers, and are not graded for study quality.

## Settings to check outside this repo

- Supabase → Authentication → URL configuration: `https://medsumai.com` should be in the redirect allow-list
- Supabase → Authentication → password protection: enable leaked-password protection
- n8n webhook CORS: allow `https://medsumai.com`

## Running it locally

There is no build step. Serve the folder with any static server (for example `python3 -m http.server`) and open `index.html`. Search needs the live backend, so it will only work if the n8n webhooks are reachable.

## Notes

The GitHub repository is named `MedSum-AI` (with a hyphen); the product is MedSumAI (no hyphen). Mixing the two up has broken links before, so check which one a URL needs before editing it.
