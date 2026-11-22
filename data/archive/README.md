# Cache Flow market archive

Written by the collector on every run. Files are CSV (UTF-8, comma-separated, quoted where needed); finished months are
gzip-compressed (`.csv.gz`). Multi-value cells use `|` between values. Times are UTC ISO-8601.

## YYYY-MM-postings.csv — one row per posting, when first seen
| Column | Meaning |
|---|---|
| uid | Stable id: `<source_id>:<posting id>`. Joins to the other files. |
| first_seen | When Cache Flow first saw the posting (the month in the file name). |
| posted_at | Posting date the employer's system gives, when it gives one. |
| employer, source_id, ats | Who posted it and which board it came from. |
| sector, company_type | From Cache Flow's employer list (company_type: big, security, advisory, growth, aggregator). |
| title | Posting title as published. |
| categories | Cache Flow job categories (pmm, partner, strategy, sales, ci, …); empty when none fit. |
| seniority | 0–7 from the title (0 = unknown). |
| workplace, us, remote_us | remote / hybrid / onsite; US role; remote open to US. |
| states, locations | US states named; first two location strings. |
| base_min, base_max | Stated BASE pay range in USD per year. Empty when none is stated. |
| pay_kind | base, ote_only (only OTE / total comp stated), predicted (aggregator estimate) or none. |
| ote_min, ote_max | Stated OTE range when there is one. |
| skills | Up to 10 skill tags found in the posting. |
| duplicate_of | Set when the same role is also listed on another board; skip these to count roles once. |
| url | Link to the posting. |
| summary | Up to ~280 characters from the role section (not the full description). Postings backfilled from the first snapshot have one only when their description was stored. |

## YYYY-MM-closed.csv — one row when a posting disappears
uid, closed_at, first_seen, days_open, employer, title, basis. A closure means the collector stopped finding the posting;
it is not evidence that anyone was hired. Failed or partial scans never close anything. basis says how it was established:
| basis | Meaning |
|---|---|
| complete_scan | The whole board was read in one successful run and no longer lists it. |
| complete_pass | A full-list pass over several runs (Google, Microsoft, AWS, Oracle) began after it was last seen and finished cleanly without it. |
| complete_search | A search that had returned it was later read to its end without it (Workday, SmartRecruiters, Phenom, Avature, Cisco). |
| unseen_window | Older rule for rows saved before searches were tracked: unseen for longer than a full rotation. |
| unverified_expired | No scan could confirm it for 30 days (source blocked or failing). Treat as unknown, not as closed. |
For time-to-close analysis use the verified bases only (the first three).

## YYYY-MM-changes.csv — one row when a known posting changes
change is one of: `pay` (stated base range changed; was/now as min-max or pay kind), `title`, `reposted` (the
posting date moved; was/now are the dates), `reopened` (a closed posting came back; was = when it closed).

## sources.csv — coverage
When each source first returned roles. Use it to compare like with like: a jump in postings in the week a big employer
was added is new coverage, not market growth.

## weekly.csv — rollup, rebuilt every run
One row per week (Monday, UTC) x sector x job category, including `all` rows for each. Postings with duplicate_of are
skipped; a posting with several categories counts under each.
| Column | Meaning |
|---|---|
| new_postings | Postings first seen that week. |
| new_same_store | The same, counting only sources already collected before that week began. Use this for trends. |
| closed, closed_verified, median_days_open | Postings that closed that week; those closed on verified evidence; median days open (verified closures only). |
| with_base_pay, median_base_min, median_base_max | New postings stating a base range, and the medians of those ranges. |
| ote_only, remote_us | New postings stating only OTE; new postings open to remote work in the US. |
| employers_hiring | Distinct employers with a new posting that week. |

The first week of the archive is a backfill of everything open at the time, so its new_postings is not a weekly
figure; new_same_store is 0 for it by design.
