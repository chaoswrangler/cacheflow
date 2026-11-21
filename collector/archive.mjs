// Market archive: a compact, append-only record of every posting Cache Flow has seen, for trend analysis.
//   data/archive/YYYY-MM-postings.csv  one row when a posting is first seen (month of first sighting)
//   data/archive/YYYY-MM-closed.csv    one row when it disappears (month of closing)
//   data/archive/sources.csv           when each source was first collected, so trends can compare the same employers over time
// Past months are compressed to .csv.gz at the first run of a new month. Append-only text keeps git history small.
// The first run with no archive backfills from the roles already in jobs.json (first sighting = first_observed).
import { readFile, writeFile, appendFile, readdir, unlink, mkdir, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { roleBlurb } from '../assets/shared/core.mjs';

export const POSTING_COLS = ['uid', 'first_seen', 'posted_at', 'employer', 'source_id', 'ats', 'sector', 'company_type', 'title', 'categories', 'seniority',
  'workplace', 'us', 'remote_us', 'states', 'locations', 'base_min', 'base_max', 'pay_kind', 'ote_min', 'ote_max', 'skills', 'duplicate_of', 'url', 'summary'];
export const CLOSED_COLS = ['uid', 'closed_at', 'first_seen', 'days_open', 'employer', 'title'];
export const SOURCE_COLS = ['source_id', 'employer', 'ats', 'first_collected'];

const cell = v => {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvRow = (cols, o) => cols.map(c => cell(o[c])).join(',') + '\n';
const exists = p => access(p).then(() => true, () => false);
const month = iso => String(iso || '').slice(0, 7);
const STATE = /,\s*([A-Z]{2})\b/;

function postingRow(j, emp) {
  const s = j.salary || {};
  const base = s.min != null && !['ote_only', 'predicted'].includes(s.kind);
  return {
    uid: j.uid, first_seen: j.first_observed, posted_at: j.posted_at, employer: j.employer, source_id: j.source_id, ats: j.ats,
    sector: emp?.sector, company_type: emp?.type, title: j.title, categories: j.functions || [], seniority: j.seniority,
    workplace: j.workplace, us: j.us, remote_us: j.remote_us,
    states: [...new Set((j.locations || []).map(l => (l.match(STATE) || [])[1]).filter(Boolean))],
    locations: (j.locations || []).slice(0, 2),
    base_min: base ? s.min : null, base_max: base ? s.max : null,
    pay_kind: !j.salary ? 'none' : s.kind === 'ote_only' ? 'ote_only' : s.kind === 'predicted' ? 'predicted' : 'base',
    ote_min: s.ote?.min ?? null, ote_max: s.ote?.max ?? null,
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

export async function archiveRun({ dataDir, jobs, nowIso, registry, sources = [] }) {
  const dir = join(dataDir, 'archive');
  const fresh = !(await exists(dir));
  await mkdir(dir, { recursive: true });
  const empBySource = new Map();
  for (const e of registry?.employers || []) for (const s of e.sources || []) empBySource.set(s.id, e);

  // compress finished months
  let rolled = 0;
  for (const f of await readdir(dir)) {
    const m = f.match(/^(\d{4}-\d{2})-(postings|closed)\.csv$/);
    if (m && m[1] < month(nowIso)) { await writeFile(join(dir, f + '.gz'), gzipSync(await readFile(join(dir, f)))); await unlink(join(dir, f)); rolled++; }
  }

  // new postings (first seen this run) and closings (closed this run); a fresh archive takes everything known so far
  const isNew = j => fresh ? !!j.first_observed : j.first_observed === nowIso;
  const isClosed = j => j.status === 'closed' && (fresh ? !!j.closed_at : j.closed_at === nowIso);
  const byMonth = (list, key) => list.reduce((m, r) => { const k = month(r[key]); (m[k] ||= []).push(r); return m; }, {});
  const added = jobs.filter(isNew).sort((a, b) => a.first_observed.localeCompare(b.first_observed) || a.uid.localeCompare(b.uid))
    .map(j => postingRow(j, empBySource.get(j.source_id)));
  const closed = jobs.filter(isClosed).map(j => ({ uid: j.uid, closed_at: j.closed_at, first_seen: j.first_observed,
    days_open: j.first_observed ? Math.round((new Date(j.closed_at) - new Date(j.first_observed)) / 864e5 * 10) / 10 : null, employer: j.employer, title: j.title }));
  for (const [m, rows] of Object.entries(byMonth(added, 'first_seen'))) await append(dir, `${m}-postings.csv`, POSTING_COLS, rows);
  for (const [m, rows] of Object.entries(byMonth(closed, 'closed_at'))) await append(dir, `${m}-closed.csv`, CLOSED_COLS, rows);
  // a backfill can write into past months: compress those too
  if (fresh) for (const f of await readdir(dir)) {
    const m = f.match(/^(\d{4}-\d{2})-(postings|closed)\.csv$/);
    if (m && m[1] < month(nowIso)) { await writeFile(join(dir, f + '.gz'), gzipSync(await readFile(join(dir, f)))); await unlink(join(dir, f)); }
  }

  // coverage: when each source first returned roles
  const sp = join(dir, 'sources.csv');
  const known = new Set((await exists(sp)) ? (await readFile(sp, 'utf8')).split('\n').slice(1).map(l => l.split(',')[0]).filter(Boolean) : []);
  const firstBySource = new Map();
  for (const j of jobs) if (j.first_observed && (!firstBySource.has(j.source_id) || j.first_observed < firstBySource.get(j.source_id))) firstBySource.set(j.source_id, j.first_observed);
  const newSources = [...firstBySource].filter(([id]) => !known.has(id)).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, at]) => ({ source_id: id, employer: empBySource.get(id)?.employer || sources.find(s => s.id === id)?.employer || '', ats: id.split(':')[0], first_collected: fresh ? at : nowIso }));
  await append(dir, 'sources.csv', SOURCE_COLS, newSources);

  return { added: fresh ? 0 : added.length, closed: fresh ? 0 : closed.length, backfilled: fresh ? added.length + closed.length : 0, rolled, sources: newSources.length };
}
