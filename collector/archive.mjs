// Market archive: a compact, append-only record of every posting Cache Flow has seen, for trend analysis.
//   data/archive/YYYY-MM-postings.csv  one row when a posting is first seen (month of first sighting)
//   data/archive/YYYY-MM-closed.csv    one row when it disappears (month of closing)
//   data/archive/YYYY-MM-changes.csv   one row when a known posting changes: base pay, title, reposted, reopened
//   data/archive/sources.csv           when each source was first collected (coverage), so trends can compare like with like
//   data/archive/weekly.csv            rollup by week x sector x job category, rebuilt every run from the files above
//   data/archive/README.md             column guide
// Past months are compressed to .csv.gz at the first run of a new month. Append-only text keeps git history small.
// The first run with no archive backfills from the roles already in jobs.json (first sighting = first_observed).
import { readFile, writeFile, appendFile, readdir, unlink, mkdir, access } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { roleBlurb } from '../assets/shared/core.mjs';

export const POSTING_COLS = ['uid', 'first_seen', 'posted_at', 'employer', 'source_id', 'ats', 'sector', 'company_type', 'title', 'categories', 'seniority',
  'workplace', 'us', 'remote_us', 'states', 'locations', 'base_min', 'base_max', 'pay_kind', 'ote_min', 'ote_max', 'skills', 'duplicate_of', 'url', 'summary'];
export const CLOSED_COLS = ['uid', 'closed_at', 'first_seen', 'days_open', 'employer', 'title'];
export const CHANGE_COLS = ['uid', 'changed_at', 'employer', 'title', 'change', 'was', 'now'];
export const SOURCE_COLS = ['source_id', 'employer', 'ats', 'first_collected'];
export const WEEKLY_COLS = ['week', 'sector', 'category', 'new_postings', 'new_same_store', 'closed', 'median_days_open', 'with_base_pay', 'median_base_min', 'median_base_max',
  'ote_only', 'remote_us', 'employers_hiring'];

const cell = v => {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvRow = (cols, o) => cols.map(c => cell(o[c])).join(',') + '\n';
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return head ? body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) : [];
}
const exists = p => access(p).then(() => true, () => false);
const month = iso => String(iso || '').slice(0, 7);
const STATE = /,\s*([A-Z]{2})\b/;
const payOf = j => {
  const s = j.salary || {};
  const base = s.min != null && !['ote_only', 'predicted'].includes(s.kind);
  return { base_min: base ? s.min : null, base_max: base ? s.max : null,
    pay_kind: !j.salary ? 'none' : s.kind === 'ote_only' ? 'ote_only' : s.kind === 'predicted' ? 'predicted' : 'base' };
};
const payText = p => p.pay_kind === 'base' ? `${p.base_min}-${p.base_max}` : p.pay_kind;

function postingRow(j, emp) {
  const s = j.salary || {};
  return {
    uid: j.uid, first_seen: j.first_observed, posted_at: j.posted_at, employer: j.employer, source_id: j.source_id, ats: j.ats,
    sector: emp?.sector, company_type: emp?.type, title: j.title, categories: j.functions || [], seniority: j.seniority,
    workplace: j.workplace, us: j.us, remote_us: j.remote_us,
    states: [...new Set((j.locations || []).map(l => (l.match(STATE) || [])[1]).filter(Boolean))],
    locations: (j.locations || []).slice(0, 2),
    ...payOf(j), ote_min: s.ote?.min ?? null, ote_max: s.ote?.max ?? null,
    skills: (j.kw || []).slice(0, 10).map(k => (typeof k === 'string' ? k : k?.k || k?.name || '')).filter(Boolean),
    duplicate_of: j.dup_of || null, url: j.url,
    summary: j._blurb ?? (j.excerpt ? roleBlurb(j.excerpt) : ''),
  };
}

async function append(dir, name, cols, rows) {
  if (!rows.length) return;
  const p = join(dir, name);
  const head = (await exists(p)) ? '' : cols.join(',') + '\n';
  await appendFile(p, head + rows.map(r => csvRow(cols, r)).join(''));
}
async function compressFinished(dir, nowIso) {
  let n = 0;
  for (const f of await readdir(dir)) {
    const m = f.match(/^(\d{4}-\d{2})-(postings|closed|changes)\.csv$/);
    if (m && m[1] < month(nowIso)) { await writeFile(join(dir, f + '.gz'), gzipSync(await readFile(join(dir, f)))); await unlink(join(dir, f)); n++; }
  }
  return n;
}
async function readKind(dir, kind) {
  const out = [];
  for (const f of (await readdir(dir)).sort()) {
    if (!new RegExp(`^\\d{4}-\\d{2}-${kind}\\.csv(\\.gz)?$`).test(f)) continue;
    const buf = await readFile(join(dir, f));
    out.push(...parseCsv((f.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')));
  }
  return out;
}

// Monday (UTC) of the week a timestamp falls in, as YYYY-MM-DD
export function weekOf(iso) {
  const d = new Date(iso); if (isNaN(d)) return null;
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
const median = a => { const v = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };

// Weekly rollup. A posting counts once per job category it has (and under "all"). Duplicates across boards are skipped.
// new_same_store counts only postings from sources already collected before that week began, so growth in
// Cache Flow's coverage doesn't read as market growth.
export function weeklyRollup(postings, closed, sources) {
  const firstCollected = new Map(sources.map(s => [s.source_id, s.first_collected]));
  const byUid = new Map(postings.map(p => [p.uid, p]));
  const groups = new Map();
  const g = (week, sector, category) => {
    const k = `${week}\u0000${sector}\u0000${category}`;
    if (!groups.has(k)) groups.set(k, { week, sector, category, n: 0, same: 0, closed: 0, days: [], base: 0, mins: [], maxs: [], ote: 0, remote: 0, emps: new Set() });
    return groups.get(k);
  };
  const cats = p => ['all', ...(p.categories ? p.categories.split('|') : ['uncategorized'])];
  for (const p of postings) {
    if (p.duplicate_of) continue;
    const week = weekOf(p.first_seen); if (!week) continue;
    const fc = firstCollected.get(p.source_id), same = fc && weekOf(fc) < week;
    for (const sector of ['all', p.sector || 'unknown']) for (const c of cats(p)) {
      const x = g(week, sector, c);
      x.n++; if (same) x.same++; x.emps.add(p.employer);
      if (p.pay_kind === 'base' && p.base_min) { x.base++; x.mins.push(+p.base_min); x.maxs.push(+(p.base_max || p.base_min)); }
      if (p.pay_kind === 'ote_only') x.ote++;
      if (p.remote_us === 'true') x.remote++;
    }
  }
  for (const c of closed) {
    const p = byUid.get(c.uid); if (!p || p.duplicate_of) continue;
    const week = weekOf(c.closed_at); if (!week) continue;
    for (const sector of ['all', p.sector || 'unknown']) for (const cat of cats(p)) { const x = g(week, sector, cat); x.closed++; if (c.days_open !== '') x.days.push(+c.days_open); }
  }
  return [...groups.values()].sort((a, b) => a.week.localeCompare(b.week) || a.sector.localeCompare(b.sector) || a.category.localeCompare(b.category))
    .map(x => ({ week: x.week, sector: x.sector, category: x.category, new_postings: x.n, new_same_store: x.same, closed: x.closed, median_days_open: median(x.days),
      with_base_pay: x.base, median_base_min: median(x.mins), median_base_max: median(x.maxs), ote_only: x.ote, remote_us: x.remote, employers_hiring: x.emps.size }));
}

export async function archiveRun({ dataDir, jobs, nowIso, registry, sources = [], prevById = new Map() }) {
  const dir = join(dataDir, 'archive');
  await mkdir(dir, { recursive: true });
  const fresh = !(await readdir(dir)).some(f => /-postings\.csv(\.gz)?$/.test(f)); // no ledger yet: backfill
  const empBySource = new Map();
  for (const e of registry?.employers || []) for (const s of e.sources || []) empBySource.set(s.id, e);

  const rolled = await compressFinished(dir, nowIso);

  // new postings (first seen this run) and closings (closed this run); a fresh archive takes everything known so far
  const isNew = j => fresh ? !!j.first_observed : j.first_observed === nowIso;
  const isClosed = j => j.status === 'closed' && (fresh ? !!j.closed_at : j.closed_at === nowIso);
  const byMonth = (list, key) => list.reduce((m, r) => { const k = month(r[key]); (m[k] ||= []).push(r); return m; }, {});
  const added = jobs.filter(isNew).sort((a, b) => a.first_observed.localeCompare(b.first_observed) || a.uid.localeCompare(b.uid))
    .map(j => postingRow(j, empBySource.get(j.source_id)));
  const closed = jobs.filter(isClosed).map(j => ({ uid: j.uid, closed_at: j.closed_at, first_seen: j.first_observed,
    days_open: j.first_observed ? Math.round((new Date(j.closed_at) - new Date(j.first_observed)) / 864e5 * 10) / 10 : null, employer: j.employer, title: j.title }));

  // changes to postings already in the ledger
  const changes = [];
  if (!fresh) for (const j of jobs) {
    const p = prevById.get(j.uid); if (!p || isNew(j)) continue;
    const base = { uid: j.uid, changed_at: nowIso, employer: j.employer, title: j.title };
    if (p.status === 'closed' && j.status === 'open') changes.push({ ...base, change: 'reopened', was: p.closed_at, now: nowIso });
    if (j.status !== 'open') continue;
    const a = payOf(p), b = payOf(j);
    if (j.salary && payText(a) !== payText(b)) changes.push({ ...base, change: 'pay', was: payText(a), now: payText(b) });
    if (p.title && p.title !== j.title) changes.push({ ...base, change: 'title', was: p.title, now: j.title });
    const last = (j.date_history || []).at(-1);
    if (last && last.seen === nowIso) changes.push({ ...base, change: 'reposted', was: last.was, now: j.posted_at });
  }

  for (const [m, rows] of Object.entries(byMonth(added, 'first_seen'))) await append(dir, `${m}-postings.csv`, POSTING_COLS, rows);
  for (const [m, rows] of Object.entries(byMonth(closed, 'closed_at'))) await append(dir, `${m}-closed.csv`, CLOSED_COLS, rows);
  await append(dir, `${month(nowIso)}-changes.csv`, CHANGE_COLS, changes);
  if (fresh) await compressFinished(dir, nowIso); // a backfill can write into past months

  // coverage: when each source first returned roles
  const sp = join(dir, 'sources.csv');
  const known = new Set((await exists(sp)) ? parseCsv(await readFile(sp, 'utf8')).map(r => r.source_id) : []);
  const firstBySource = new Map();
  for (const j of jobs) if (j.first_observed && (!firstBySource.has(j.source_id) || j.first_observed < firstBySource.get(j.source_id))) firstBySource.set(j.source_id, j.first_observed);
  const newSources = [...firstBySource].filter(([id]) => !known.has(id)).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, at]) => ({ source_id: id, employer: empBySource.get(id)?.employer || sources.find(s => s.id === id)?.employer || '', ats: id.split(':')[0], first_collected: fresh ? at : nowIso }));
  await append(dir, 'sources.csv', SOURCE_COLS, newSources);

  // weekly rollup, rebuilt from the whole ledger
  const [P, Cl, S] = [await readKind(dir, 'postings'), await readKind(dir, 'closed'), parseCsv(await readFile(sp, 'utf8').catch(() => ''))];
  const weekly = weeklyRollup(P, Cl, S);
  await writeFile(join(dir, 'weekly.csv'), WEEKLY_COLS.join(',') + '\n' + weekly.map(r => csvRow(WEEKLY_COLS, r)).join(''));
  await writeFile(join(dir, 'README.md'), GUIDE);

  return { added: fresh ? 0 : added.length, closed: fresh ? 0 : closed.length, changes: changes.length, backfilled: fresh ? added.length + closed.length : 0, rolled, sources: newSources.length, weeks: new Set(weekly.map(w => w.week)).size };
}

const GUIDE = `# Cache Flow market archive

Written by the collector on every run. Files are CSV (UTF-8, comma-separated, quoted where needed); finished months are
gzip-compressed (\`.csv.gz\`). Multi-value cells use \`|\` between values. Times are UTC ISO-8601.

## YYYY-MM-postings.csv — one row per posting, when first seen
| Column | Meaning |
|---|---|
| uid | Stable id: \`<source_id>:<posting id>\`. Joins to the other files. |
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
uid, closed_at, first_seen, days_open, employer, title. A posting is closed only after a complete scan of its board no
longer lists it; failed or partial scans never close anything.

## YYYY-MM-changes.csv — one row when a known posting changes
change is one of: \`pay\` (stated base range changed; was/now as min-max or pay kind), \`title\`, \`reposted\` (the
posting date moved; was/now are the dates), \`reopened\` (a closed posting came back; was = when it closed).

## sources.csv — coverage
When each source first returned roles. Use it to compare like with like: a jump in postings in the week a big employer
was added is new coverage, not market growth.

## weekly.csv — rollup, rebuilt every run
One row per week (Monday, UTC) x sector x job category, including \`all\` rows for each. Postings with duplicate_of are
skipped; a posting with several categories counts under each.
| Column | Meaning |
|---|---|
| new_postings | Postings first seen that week. |
| new_same_store | The same, counting only sources already collected before that week began. Use this for trends. |
| closed, median_days_open | Postings that closed that week, and how long they had been open. |
| with_base_pay, median_base_min, median_base_max | New postings stating a base range, and the medians of those ranges. |
| ote_only, remote_us | New postings stating only OTE; new postings open to remote work in the US. |
| employers_hiring | Distinct employers with a new posting that week. |

The first week of the archive is a backfill of everything open at the time, so its new_postings is not a weekly
figure; new_same_store is 0 for it by design.
`;
