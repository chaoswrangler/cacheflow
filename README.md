# Cache Flow

Résumé-aware job search served from GitHub Pages and refreshed by GitHub Actions. It reads jobs from employers' own hiring systems, scores them against a résumé, and ties every date and salary to its source.

## Stack

| | |
|---|---|
| Language | JavaScript (ES2022 modules), HTML, CSS |
| Frameworks | None. No build step, no bundler, no `package.json`. |
| Collector runtime | Node.js 22 (built-in `fetch`, `node:fs`, `node:crypto`). No npm dependencies. |
| Browser libraries | pdf.js 4.10 and mammoth 1.13, vendored in `assets/vendor/` (no CDN), used only to read uploaded résumés |
| Hosting | GitHub Pages (static files) |
| Scheduling | GitHub Actions, woken hourly; `collector/gate.mjs` collects when a slot is due (6am, 10am, 2pm and 6pm ET, every day) |
| Storage | JSON files in `data/`, committed by the workflow. `git log data/` is the audit trail. |
| Email (optional) | Resend HTTP API |


### AI job alerts (new-roles files)

After each collection the collector writes `data/ai/`:

- `index.txt` / `index.json`: today's files and their role counts.
- `new/<category>.txt`: open roles first found in the last 24 hours, one file per job category (larger categories split into parts of about 150 KB, so an AI assistant can read each part in full). One role per line: title, employer, locations, workplace, pay, categories, level, posting date, date found, requisition, Cache Flow skill tags and the official posting link. No description text: postings are untrusted, and the files must stay small.
- `new-roles.csv`: the same roles in one CSV (each role once), for spreadsheets. Cells that would start with `=`, `+`, `-` or `@` get a leading `'` so they can't run as formulas.

On the Discover page, **AI job alerts** builds a prompt from the viewer's filters for a recurring task in their own assistant (Claude, ChatGPT, Gemini and so on). The prompt points at `index.txt`, so it keeps working as file parts change. Filters and résumé stay with the viewer.

### Collector watchdog

`.github/workflows/watchdog.yml` runs at :47 past each hour (6am–7pm ET). It checks that the latest slot (6am, 10am, 2pm, 6pm ET) was collected:

- **Slot missed** (75+ minutes late, nothing running): it starts a catch-up collection (digest included, as a scheduled run would), and the watchdog run is marked failed with the reason.
- **Collection run failed**: the watchdog run is marked failed once, with a link to the failed run. It doesn't retry a failed run.
- **On time or still running**: it passes.

A failed watchdog run triggers GitHub's standard failed-workflow notification (GitHub → Settings → Notifications → Actions). No email service or secrets are needed.

## Architecture

| Path | Runs in | Role |
|---|---|---|
| `index.html`, `assets/app.js`, `assets/styles.css` | Browser | The app. Loads `data/*.json`; résumé parsing, matching and the tracker all run client-side. |
| `assets/shared/core.mjs` | Browser and Node | Shared rules: salary parsing, currency and base-vs-OTE handling, dates, location and state eligibility, job categories, a 200-skill dictionary (security plus sales, partnerships, marketing and product), scoring, plus the Greenhouse/Lever/Ashby adapters. |
| `assets/shared/resume.mjs` | Browser | Résumé text to skills, titles, credentials and suggested job categories |
| `assets/prompt.mjs` | Browser | "Prompt for your AI": turns the current criteria into a self-contained search brief for any web-browsing LLM (no name or contact details) |
| `collector/gate.mjs` | Actions | Hourly check that collects only when a New York-time slot is due |
| `collector/collect.mjs` | Actions | Fetches every source, normalizes, merges with history, writes `data/jobs.json` and `data/status.json` |
| `collector/lib/adapters-server.mjs` | Actions | Server-only adapters: SmartRecruiters, Workable, Workday CXS, Eightfold, Oracle HCM, Phenom, Cisco RSS, Amazon, Comeet, Google Careers, Radancy, BambooHR (company careers list), Avature (IBM, Deloitte, Booz Allen, Bain; search page and fields discovered from a real job link), company HTML pages |
| `collector/lib/seeds.mjs` | Actions | Finds job boards for seed companies and checks they belong to the company |
| `collector/lib/http.mjs` | Actions | Per-host pacing, retries, backoff |
| `collector/digest.mjs` | Actions | Emails subscribers their new matches |

## Data

| File | Contents |
|---|---|
| `data/sources.json` | Employer registry: sector, company type, team size where known, and one or more sources with a `verification` block. 438 employers, 432 sources. |
| `data/discovered.json` | Employers the seed probe found and verified. Read alongside `sources.json`. |
| `data/seeds.json` | 819 candidate companies (YC directory, VC portfolios). Not collected directly. |
| `data/jobs.json` | Normalized roles with history: posting, updated and first-seen dates, salary with its source text, closed and stale flags |
| `data/status.json` | Last result per source (ok, empty, partial, http_403, …) and resume offsets for chunked scans |

## Market archive

Every collection adds to `data/archive/`, a compact record of every posting Cache Flow has seen, for trend analysis (hiring by employer and category, time to close, pay ranges, remote share, skills):

| File | One row per |
|---|---|
| `YYYY-MM-postings.csv` | posting, written when it is first seen: employer, sector, company type, title, job categories, seniority, location, remote, stated base range (or OTE only), skills, link and a brief role summary (≤280 characters from the role section, never the full description) |
| `YYYY-MM-closed.csv` | posting that disappeared: when it closed and how many days it was open |
| `sources.csv` | source, with the date it was first collected, so trends can compare the same employers over time instead of counting new coverage as market growth |

Also written: `YYYY-MM-changes.csv` (pay, title, repost and reopen events for known postings), `weekly.csv` (rollup by week × sector × job category with new and closed counts, a same-store count, median stated base, OTE-only and remote shares, employers hiring) and `README.md` (column guide). The Sources page links to them. Files are append-only, which keeps git history small. Finished months are compressed to `.csv.gz` (open with any spreadsheet after unzipping, or DuckDB/pandas directly). The first run backfills from the roles already in `jobs.json`. Like the rest of `data/`, the archive is published with the site.

## Collection rules

- **Workday has its own client.** One active request per Workday tenant, 8–12 s apart, sent with Node's built-in `https.request` (same honest user agent as every other request). Plain 429s honor `Retry-After` with bounded backoff.
- **Bot checks are access controls.** When a site's Cloudflare protection answers with `cf-mitigated` (a challenge), the collector records the source as `blocked_challenge`, makes no retries and no further requests to that site in the run, and keeps the previous roles. It does not change how it identifies itself to get past the check. A source refused (403 or bot check) three runs in a row pauses and retries weekly.
- Per-host pacing with randomized delays. `Retry-After` is honored. 429 and 5xx get bounded exponential backoff; 403 and 404 are never retried.
- **Scan states.** Each source's status says whether its inventory was read completely (`inventory`: complete, partial or failed) separately from the HTTP result. `last_success_at` moves only on a complete scan; a partial one updates `last_data_at`. `last_complete_scan_at` is the most recent scan that covered the whole list, and only such evidence closes roles (`can_close`). `run.selection_limited` means the run was asked for only some sources; `run.incomplete_sources` counts sources that didn't finish.
- **Closing a role** needs evidence that covered it, recorded as `closed_basis`: the whole board read in one run (`complete_scan`); a multi-run full-list pass that began after the role was last seen and finished cleanly (`complete_pass`: Google, Microsoft, AWS, Oracle); or a search that had returned it, read to its end without it (`complete_search`: Workday, SmartRecruiters, Phenom, Avature, Cisco). Searches stopped by a result limit, a failed page or a refusal never close anything, and the source note flags the coverage gap. A role no scan has confirmed for 30 days closes as `unverified_expired`, which the archive keeps apart from verified closures. Partial runs flag unreached roles `stale` (open, unverified).
- **Sudden drops.** If a board that returned 20+ roles suddenly returns under half as many, closures are held for one run and the source note raises an alert; a second scan that agrees closes them.
- **AWS pay.** Amazon states base pay as one line per location (`USA, NY, New York - 169,000.00 - 228,600.00 USD annually`); every line is read and the New York line is preferred. When the search data lacks the statement, the posting's own page is read for relevant roles (up to 40 a run); found pay is reused, and a page with none is re-checked after 14 days.
- **EU-hosted Greenhouse boards.** If neither job-board API address answers, the collector reads the board's public page (job-boards.eu.greenhouse.io/<token>) and its job pages instead. Network failures now name the cause (DNS, refused, reset, TLS) in the source note.
- **Workday** saves the search and offset where a refusal stopped it; the next run resumes there (one page of overlap) before moving on with the rotation.
- **Refusal details.** Every 403/429 is recorded in the source's status (`last_refusal`) and summarized in its note: successful requests before it this run, Retry-After and any RateLimit-* headers, server and request-id headers, and the body type (JSON, empty, HTML challenge/denial) with a short tag-stripped excerpt. That tells a quota apart from a bot check or a plain denial. The collector identifies itself honestly and never imitates a browser.
- **Job categories** follow common industry groupings: Product & program management · Marketing & GTM · Sales & customer success · Strategy & business operations (Chief of Staff is here) · Consulting & advisory (its own practice) · Security practitioners (SOC, detection & IR, threat intel, security engineering, GRC) · AI, engineering & data · Corporate functions. Executive level is a seniority choice (VP & executive), not a category.
- **Jobs data in shards.** `data/jobs.json` holds the run metadata and a list of shard files; the roles are in `data/jobs/jobs-0.json` … `jobs-7.json`, split by source. The single file had reached 64 MB, and GitHub refuses files over 100 MB, which would stop collection from saving. The app and collector read both layouts.
- **Full lists instead of keyword searches.** Workday employers (except Accenture, whose US list is beyond Workday's 2,000-result paging limit) read their whole US list. Phenom sites (Cisco, Adobe, BCG, PwC) page through their full listing from a saved offset, 120 pages a run. Bosch reads its full US list. Keyword searches had capped these at 30–60 results per search.
- **Retry-After.** A 429 asking for up to 60 seconds is waited out and retried. A longer wait is not retried: the source gets `next_eligible_at` and is skipped (`deferred`) until then. While a request waits to retry it gives up its shared slot, so one throttled site can't hold up the others.
- **Stored details** are reused while recent; relevant roles are re-read after 30 days (pay or remote terms can change without a title change), within each source's detail budget, new roles first.
- **Duplicates.** On one board, postings with different requisition IDs are separate openings even with the same title and city. `dup_basis` says whether a group was matched by requisition ID or by title and location.
- **Microsoft (Eightfold)** runs on a request budget: each run reads up to 6 pages of the US-filtered full list, then 5 keyword-search pages (breadth-first, the least recently scanned search first), then up to 3 detail records for new or changed relevant roles. Progress is saved per list and per search (offset, count, last scan, complete) in `status.json`, and a resumed list re-reads 2 rows so shifted listings aren't skipped. A 403/429 stops Microsoft for the run and keeps the progress; one retry honors a short Retry-After. If the location filter errors or matches nothing, the reader falls back to the unfiltered list (US decided locally) and remembers it. A role is closed only after a complete US pass that started after it was last seen, and after 14 days unseen.
- **Microsoft throttling.** Microsoft refuses after a handful of requests per run and gives no Retry-After. Each run asks at most 14 times (10 list pages, 2 searches, 2 details), 60-80 seconds apart, stops at the first refusal and saves its place, so the ~131-page US list is covered over successive runs. Sources can also opt into a rest after a throttled run (`throttle_cooldown_hours`, doubling to 24h); Microsoft doesn't, because each run starts fresh.
- **Microsoft trial of /api/apply/v2/jobs.** Eightfold's other listing endpoint (undocumented; suggested in research) is tried for the full US list with 100 per request (`try_apply_v2`). If it answers with more than 10 roles per request it's kept, which would cover the whole list in about 14 requests; if it fails or returns 10 or fewer, it's switched off and the reader stays on `/api/pcsx/search`. The source note says which happened.
- **Google Careers** treats the full US list (location = United States, about 88 pages) as the inventory, walked from a page checkpoint (95 pages a run, so normally one pass per run; one page of overlap on resume). Six priority searches top up between passes. Each record is schema-checked (numeric id, plain-text title, location strings). A pass closes roles only if it reached the end cleanly: a page that mostly fails the check, or a pass that ends well short of the page's own total or the last pass, is not used for closures.
- Roles that fit no job category are stored as **Other roles** (off by default in the category picker), not dropped. AWS is the exception (`drop_uncategorized`) because of the size of its US list.
- Only base pay counts. OTE, bonus, equity and estimates are excluded. Ranges in other currencies, and implausible amounts (over $1.5M), are ignored.
- Dates stay distinct: posted, updated (may be a refresh), relative ("3 days ago"), first observed, last seen, plus a repost flag.
- Cross-source duplicates are grouped by requisition ID or by title plus a shared city.
- Job descriptions are treated as untrusted text.

## Running your own copy

For maintainers: fork the repo, then edit data files and repo settings. Nothing here happens in the app's interface.

### Deploy

1. Push the repo. Public repos get free Actions minutes.
2. **Settings → Pages:** deploy from branch `main`, root.
3. **Settings → Actions → General → Workflow permissions:** Read and write.
4. **Actions → Collect jobs → Run workflow.** GitHub drops and delays cron runs, so the workflow wakes hourly and `collector/gate.mjs` collects only when the latest slot hasn't been collected. A missed wake-up is made up within the hour, and slots stay on New York time across daylight saving.

Collector flags (workflow input, or `node collector/collect.mjs …` locally):

| Flag | Effect |
|---|---|
| `--only=gh:okta,wd:proofpoint` | Run only these source IDs |
| `--ats=greenhouse,ashby` | Run only these ATS types |
| `--limit=10` | First N sources |
| `--probe` | Look for boards for unresolved employers; writes `data/probe-results.json`. Changes nothing. |
| `--seed-probe --seed-batch=N` | Run only the seed probe |

Each full run also checks 40 seed companies (`seed_probe_batch` in `collector/config.json`).

### Adding an employer

Open any role's Apply page and read the host: `job-boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`, `jobs.ashbyhq.com/<slug>`, `<tenant>.wd5.myworkdayjobs.com/<site>`. Add a source to `data/sources.json` and commit; the next run collects it:

```json
{ "id": "gh:acme", "ats": "greenhouse", "slug": "acme",
  "verification": { "status": "unverified_config", "method": "From an Apply URL" } }
```

### Email alerts (optional)

Add repo secrets `RESEND_API_KEY`, `ALERT_FROM`, `DIGEST_SALT`, `SITE_URL` and `SUBSCRIBERS` (a JSON array). Subscriber emails live only in the secret; `data/digest-state.json` stores salted hashes.

### Tests

```
node collector/test/run-tests.mjs
```

238 offline tests against mocked API responses. The workflow runs them before every collection.

## Dependencies and security

- Two third-party files, both vendored and both browser-only: pdf.js 4.10.38 (fixes CVE-2024-4367; loaded with `isEvalSupported: false`) and mammoth 1.13.0 (fixes CVE-2025-11849). They load only when a résumé is dropped. Licenses are in `assets/vendor/`.
- The collector imports only Node built-ins, so there is no dependency tree to audit or lock.
- The workflow's only outside code is `actions/checkout` and `actions/setup-node`, pinned to commit SHAs.

## Limits

- Prototype with US data only. Home location is a US state, pay rules assume USD, and postings based outside the US are dropped. The aim is global coverage; each new country needs its own sources, currency and pay-transparency handling, and work-eligibility rules.

- LinkedIn can't be read automatically. Use its PDF profile export and the generated search links.
- Sources marked `unverified_config` or `experimental` are confirmed only by a live run. Check the Sources page afterwards.
- Company size comes from YC team-size data, so most non-YC employers have none.
- Statuses (To do, Applied, Not interested) are stored in the browser only. Use backup and restore to move them between devices.
