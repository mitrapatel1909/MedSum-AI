# MedSumAI

**Medical research, explained simply.** Built for pre-med and AP Bio students: type a topic, and MedSumAI finds the real articles on PubMed and writes a cited plain-language summary at your reading level, with an evidence snapshot and flashcards you can export to Anki. Free to use, no signup needed.

**Live site:** https://medsumai.com

> Educational use only. Summaries are written by AI and can contain mistakes. Always check the linked PubMed sources, and talk to a qualified clinician about health decisions. This is not medical advice.

## What it does

- **Search:** Searches PubMed for a topic and summarizes the abstracts it finds, at a reading level you choose (high school, college or pre-med), with a validated PubMed citation link for each article
- **Topics library:** 17 curated topic pages with pre-generated educational summaries — ADHD treatment, Alzheimer disease, antibiotic resistance, cancer immunotherapy, concussion recovery in teens, CRISPR gene therapy for sickle cell disease, early peanut introduction, GLP-1 drugs and obesity, gut microbiome, health effects of sleep deprivation, intermittent fasting, long COVID, migraine prevention (CGRP drugs), mRNA vaccines, statins and LDL cholesterol, type 2 diabetes treatment, and vitamin D and depression
- **Evidence Snapshot:** A plain-language description of the study types and consistency found in the retrieved abstracts — not a formal systematic review or clinical evidence grade, but a transparent account of what was actually retrieved from PubMed
- **Flashcards:** Exportable Anki-style flashcards from any summary
- Follow-up chat about the summary you just generated
- Optional free accounts: save summaries to "My Summaries"
- Light and dark mode

## Source and methodology limitations

Summaries use PubMed abstracts only, not full-text articles. The Evidence Snapshot is a plain-language description of retrieved study types — it is not a validated clinical grading system. See [medsumai.com/methodology.html](https://medsumai.com/methodology.html) for the full explanation.

## How it is built

| Piece | What it does |
|---|---|
| Static site (`index.html`, `privacy.html`, `news.html`) | The whole frontend: plain HTML, CSS and JavaScript, no build step |
| GitHub Pages + Cloudflare | Hosting and the `medsumai.com` domain |
| Cloudflare Worker (`worker/`, served at `api.medsumai.com`) | The backend: PubMed search, abstract parsing, the OpenAI call, per-visitor rate limits and a daily spending cap |
| Supabase | Accounts (Auth), saved summaries, the public summary counter, mailing list |
| Cloudflare Web Analytics | Cookieless visit statistics |

### Request flow

```
Browser ── topic + level ──► Worker ─► limits ─► PubMed search ─► fetch abstracts ─► OpenAI ─► Markdown
Browser ◄── summary (rendered with marked + DOMPurify) ◄───────────────────────────────────────┘
Browser ── record_search(topic) ──► Supabase (server-side counter and log)
```

The model writes the prose. The code adds what it can verify: citations are checked against the PMIDs that were actually fetched (invented ones are dropped), and the Sources section and study-type counts are generated from PubMed's own metadata.

## Database and security

The browser only talks to Supabase through the public anon key, so everything it can reach has to be safe to expose:

- `saved_summaries`: row-level security, each user can only see and change their own rows
- `searches`, `search_stats`, `subscriptions`, `usage_limits`: **no direct access** from the browser. The site uses three narrow, validated, rate-limited functions instead: `record_search`, `get_search_count` and `subscribe`
- Rate limiting identifies visitors by a salted hash of their IP address (never the raw address), and expired entries are deleted automatically

The SQL lives in [`supabase/migrations`](supabase/migrations) and is meant to be applied in order. Migration `002` removes the old open table access and must only be applied once the frontend that uses the functions is live.

## The Worker (backend)

Source in [`worker/src`](worker/src), tests in [`worker/test`](worker/test) (`cd worker && npm test`), bundled output in `worker/dist/worker.js` (`npm run build`).

- `POST /summarize` `{ topic, level? }` returns Markdown. Send `Accept: application/x-ndjson` to get a stream instead: one JSON object per line, `{event:"stage",stage:"search"|"abstracts"|"write",count?}` as each step really happens, then `{event:"done",markdown}` or `{event:"error",error}`. Validation and rate-limit errors are still plain JSON before the stream starts. The page uses this for its loading steps. `POST /chat` `{ question, summary }` returns Markdown. `GET /health` returns `ok`.
- **Limits** (per visitor, by salted IP hash, plus a shared daily cap) are enforced before any PubMed or OpenAI call: 3/min and 12/hour per visitor for summaries, 8/min and 40/hour for chat, 800 summaries and 3,000 chat messages per day overall. Flashcards (`POST /flashcards {summary}`, returns `{cards:[{front,back}]}`) are limited to 3/min and 15/hour per visitor and 600/day overall. Change them with the `SUMMARIZE_PER_MINUTE`, `SUMMARIZE_PER_HOUR`, `SUMMARIZE_PER_DAY_GLOBAL`, `CHAT_PER_MINUTE`, `CHAT_PER_HOUR`, `CHAT_PER_DAY_GLOBAL`, `CARDS_PER_MINUTE`, `CARDS_PER_HOUR` and `CARDS_PER_DAY_GLOBAL` variables in the Worker settings. Counters live in a Durable Object and delete themselves when their window ends.
- Browsers may only call it from medsumai.com (CORS allow-list in `src/index.js`). This is not a security boundary by itself, because other clients can still call the API; the limits are what protect the bill.
- A search that finds no PubMed articles never calls OpenAI.
- **Secrets** are set in Cloudflare (Workers & Pages, medsumai-api, Settings, Variables and Secrets), never in the repo: `OPENAI_API_KEY` (required), `IP_SALT` (random, already set), `NCBI_API_KEY` (optional, raises PubMed's rate limit). Optional variables: `MODEL` (default `gpt-5-mini`), `REASONING_EFFORT` (default `minimal`).
- Deploying: `npm run build`, then upload `dist/worker.js` as the Worker `medsumai-api` with a Durable Object binding named `LIMITER` (class `Limiter`). Re-uploads must keep the existing secrets.

## Weekly digest email (built, switched off)

Once a week the Worker can write a cited summary on a rotating topic (the same pipeline as the site) and email it to active subscribers. Nothing runs until you turn it on:

1. Create a free [Resend](https://resend.com) account, verify the sending domain (add the DNS records it shows), and make an API key.
2. In Cloudflare (Worker `medsumai-api`, Settings, Variables and Secrets) add secrets `SUPABASE_SERVICE_KEY` (Supabase, Settings, API, `service_role`; never put it in the repo or the browser), `RESEND_API_KEY` and `DIGEST_ADMIN_TOKEN` (any long random string), and variables `SUPABASE_URL`, `DIGEST_FROM` (for example `MedSumAI <digest@yourdomain>`), `DIGEST_ENABLED=true`. Leave `DIGEST_DRY_RUN` unset: anything other than exactly `false` is a preview that sends nothing.
3. Preview: `curl -X POST https://api.medsumai.com/admin/digest-preview -H "Authorization: Bearer <DIGEST_ADMIN_TOKEN>"` returns this week's topic, the recipient count and the email HTML. This route can never send.
4. Send a test to yourself first, then set `DIGEST_DRY_RUN=false` and add a Cron Trigger (for example `0 16 * * 2`, Tuesdays 16:00 UTC). A once-per-week guard in the Durable Object stops double sends.

Each email has an unsubscribe link (a confirm page, so link scanners cannot unsubscribe anyone) and the one-click `List-Unsubscribe` header. Migration `20261120000001` adds the per-subscriber token; the two functions it creates are callable only with the service key. Change the topic rotation with `DIGEST_TOPICS` (topics separated by `|`).

## Tests

- `cd worker && npm test`: unit tests for the Worker (PubMed parsing, citation checking, limits, validation, error handling, weekly digest and unsubscribe).
- `python3 tests/test_site.py`: browser tests for the site with the network stubbed (needs Playwright and Chromium).

## Known limitations

- **The Daily Feed (`news.html`) is paused.** It reads `news.json` from this repo, which the old n8n workflow wrote and is no longer being generated. The page shows a "taking a break" message and is set to `noindex`. When the generator is running again, remove the `noindex` meta tag in `news.html`, add the page back to `sitemap.xml`, and re-add the link in the site header.
- Summaries use abstracts only, not full papers, and are not graded for study quality.

## Settings to check outside this repo

- Supabase → Authentication → URL configuration: `https://medsumai.com` should be in the redirect allow-list
- Supabase → Authentication → password protection: leaked-password protection needs the Pro plan; it is off on the Free plan
- Cloudflare → Workers & Pages → medsumai-api: `OPENAI_API_KEY` secret is set, and an OpenAI monthly spending limit is configured as a second safety net

## Running it locally

There is no build step. Serve the folder with any static server (for example `python3 -m http.server`) and open `index.html`. Search calls the live backend at `api.medsumai.com`, which only accepts browser requests from medsumai.com, so searching does not work from a local server. The browser tests stub the backend instead.

## Notes

The GitHub repository is named `MedSum-AI` (with a hyphen); the product is MedSumAI (no hyphen). Mixing the two up has broken links before, so check which one a URL needs before editing it.
