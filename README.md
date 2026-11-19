# Cache Flow

A resume-aware job search that runs on **GitHub Pages + GitHub Actions**. Each user can:

- upload a resume (PDF/DOCX/TXT) or a LinkedIn "Save to PDF" export; it's parsed **locally in the browser**
- pick functions, industries, security verticals, minimum **base** salary, home location/metro and a posting window
- see scored matches, with base that **starts** at the minimum kept separate from base that only **reaches** it
- audit every source: how it was verified, the last result (ok / empty / 403 / 404 / timeout), and which fields it exposes
- sign up for email alerts with their own criteria (optional)

## How it works

| Piece | Where it runs | What it does |
|---|---|---|
| `index.html`, `assets/` | GitHub Pages (static) | The app. Reads `data/*.json`. Can live-check Greenhouse/Lever/Ashby boards straight from the browser. |
| `collector/collect.mjs` | GitHub Actions (cron) | Pulls every source in `data/sources.json` with polite pacing, normalizes, keeps history, writes `data/jobs.json` + `data/status.json`, commits. |
| `collector/digest.mjs` | GitHub Actions | Emails each subscriber their **new** matches via Resend. |
| `assets/shared/core.mjs` | both | One copy of the rules: salary parsing (base vs OTE), dates, location/state eligibility, function tagging, scoring. |

GitHub Pages can't run code. The Action does the fetching and commits the results, and Pages serves them. Each run is a commit, so `git log data/` is the audit trail.

### Adapters
Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Workday CXS (Salesforce, CrowdStrike, Proofpoint), Amazon/AWS (`search.json`), Cisco RSS, Oracle Recruiting Cloud (Oracle, JPMorgan Chase), Eightfold (Microsoft, **experimental**), plus optional Adzuna and SerpApi (Google Jobs) for discovery. Google and Palo Alto Networks are link-only (no public feed).

### Collection rules
- One request at a time per host, randomized 0.7–1.8 s gaps, 6 hosts in parallel at most
- Bounded exponential backoff on 429/5xx/timeouts, `Retry-After` honored, **no retry on 403/404**
- A failed refresh **keeps** the previous roles and flags them `stale`; closed roles are kept 21 days
- Date fields stay distinct: original posting date, Workday start date, relative ("posted 3 days ago", approximate), `updated` (may be a refresh), first observed, last seen, and a repost flag when a posting date changes
- Duplicates across sources are grouped, and the official copy is preferred over aggregator copies

## Deploy

1. Create a repo and push this folder. Public repos get unlimited Actions minutes.
2. **Settings → Pages** → Deploy from branch → `main` / root.
3. **Settings → Actions → General → Workflow permissions** → *Read and write*.
4. **Actions → Collect jobs → Run workflow**. The first full run takes roughly 20–45 min; after that it runs on the schedule in `.github/workflows/collect.yml`.

Useful flags (workflow input or local `node collector/collect.mjs …`):
`--tier=heavy` · `--ats=greenhouse,ashby` · `--only=gh:okta,wd:proofpoint` · `--limit=10` · `--probe`

`--probe` tries to find boards for unresolved employers and writes suggestions to `data/probe-results.json` for you to review. Nothing is added automatically.

## Email alerts (optional)

1. Create a [Resend](https://resend.com) account and verify a sending domain.
2. Add repo secrets: `RESEND_API_KEY`, `ALERT_FROM` (e.g. `Cache Flow <alerts@yourdomain.com>`), `DIGEST_SALT` (random string), `SITE_URL`, optional `ALERT_REPLY_TO`.
3. For self-serve requests, create a Formspree (or similar) form and set `signup_endpoint` in `data/site.json`. Each request arrives as JSON: email, time zone, criteria and skills.
4. Put approved requests in the `SUBSCRIBERS` secret as a JSON array. Remove an entry to unsubscribe.

Subscriber emails live only in the secret. The public `data/digest-state.json` holds salted hashes and job IDs.

## Adding employers

Click **Apply** on any role and read the host: `job-boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`, `jobs.ashbyhq.com/<slug>`, `<tenant>.wd5.myworkdayjobs.com/<site>`. Add a source to that employer in `data/sources.json`:

```json
{ "id": "wd:acme", "ats": "workday", "host": "acme.wd5.myworkdayjobs.com", "tenant": "acme", "site": "AcmeCareers",
  "queries": ["product manager", "partner"], "verification": { "status": "unverified_config", "method": "From Apply URL" } }
```

## Roster

`data/sources.json` has 340 employers and 351 sources. It was seeded from a prior 327-endpoint feed scan (164 Greenhouse feeds that returned data, 53 Ashby endpoints that returned 403 from the scanning environment, 110 Greenhouse identifiers that returned 404) plus big-tech careers systems researched 2026-11-19. Every source carries a `verification` block. **The roster is not exhaustive**; the Sources tab lists every gap.

## Tests

```
node collector/test/run-tests.mjs
```
Offline tests use mocked responses shaped like each API. They cover base vs OTE, starts vs reaches, geo ranges, hourly pay, state eligibility for any state, the Monday→today window across time zones, Workday detail dates, 403/404 handling, retry/backoff, history preservation and the email digest. The workflow runs them before every collection.

## Limits
- LinkedIn profiles and LinkedIn job search can't be read automatically. Use the PDF export and the generated search links.
- Workday tenants for Salesforce and CrowdStrike, Oracle's site, ServiceNow's SmartRecruiters ID and Microsoft's Eightfold endpoint are **unconfirmed** until the first run. Check the Sources tab after it.
- The browser live check depends on each ATS allowing cross-site requests. If one is blocked, the app says so; that is not a "no jobs" result.
