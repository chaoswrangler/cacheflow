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
| Scheduling | GitHub Actions, woken hourly; `collector/gate.mjs` collects when a slot is due (weekdays 6am, 10am, 2pm, 6pm ET; weekends 10am ET) |
| Storage | JSON files in `data/`, committed by the workflow. `git log data/` is the audit trail. |
| Email (optional) | Resend HTTP API |

## Architecture

| Path | Runs in | Role |
|---|---|---|
| `index.html`, `assets/app.js`, `assets/styles.css` | Browser | The app. Loads `data/*.json`; résumé parsing, matching and the tracker all run client-side. |
| `assets/shared/core.mjs` | Browser and Node | Shared rules: salary parsing, currency and base-vs-OTE handling, dates, location and state eligibility, job categories, a 200-skill dictionary (security plus sales, partnerships, marketing and product), scoring, plus the Greenhouse/Lever/Ashby adapters. |
| `assets/shared/resume.mjs` | Browser | Résumé text to skills, titles, credentials and suggested job categories |
| `assets/prompt.mjs` | Browser | "Prompt for your AI": turns the current criteria into a self-contained search brief for any web-browsing LLM (no name or contact details) |
| `collector/gate.mjs` | Actions | Hourly check that collects only when a New York-time slot is due |
| `collector/collect.mjs` | Actions | Fetches every source, normalizes, merges with history, writes `data/jobs.json` and `data/status.json` |
| `collector/lib/adapters-server.mjs` | Actions | Server-only adapters: SmartRecruiters, Workable, Workday CXS, Eightfold, Oracle HCM, Phenom, Cisco RSS, Amazon, Comeet, Google Careers, Radancy, Avature (IBM, Deloitte, Booz Allen, Bain; search page and fields discovered from a real job link), company HTML pages |
| `collector/lib/seeds.mjs` | Actions | Finds job boards for seed companies and checks they belong to the company |
| `collector/lib/http.mjs` | Actions | Per-host pacing, retries, backoff |
| `collector/digest.mjs` | Actions | Emails subscribers their new matches |

## Data

| File | Contents |
|---|---|
| `data/sources.json` | Employer registry: sector, company type, team size where known, and one or more sources with a `verification` block. 432 employers, 428 sources. |
| `data/discovered.json` | Employers the seed probe found and verified. Read alongside `sources.json`. |
| `data/seeds.json` | 819 candidate companies (YC directory, VC portfolios). Not collected directly. |
| `data/jobs.json` | Normalized roles with history: posting, updated and first-seen dates, salary with its source text, closed and stale flags |
| `data/status.json` | Last result per source (ok, empty, partial, http_403, …) and resume offsets for chunked scans |

## Collection rules

- Per-host pacing with randomized delays. `Retry-After` is honored. 429 and 5xx get bounded exponential backoff; 403 and 404 are never retried.
- A refused or partial run keeps the previous roles and flags them `stale`. Roles are closed only after a complete pass. Chunked scans (Microsoft, CrowdStrike) close a role only after it has gone unseen past a set window.
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

156 offline tests against mocked API responses. The workflow runs them before every collection.

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
