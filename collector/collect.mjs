#!/usr/bin/env node
// Job Radar collector. Runs in GitHub Actions (or locally: `node collector/collect.mjs`).
// Pulls every configured source, normalizes, preserves history, and writes data/jobs.json + data/status.json.
//
//   --only=gh:okta,wd:proofpoint   run only these source ids
//   --tier=heavy                   only employers in a tier (heavy | named | core)
//   --ats=greenhouse,ashby         only these ATS types
//   --seed-probe [--seed-batch=N]  look for job boards of seed companies (data/seeds.json) only
//   --probe                        try to discover ATS boards for unresolved employers (writes data/probe-results.json, does not edit sources)
//   --limit=N                      cap number of sources (smoke tests)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Http } from './lib/http.mjs';
import { ADAPTERS, AGGREGATORS, atsLinks } from './lib/adapters-server.mjs';
import { enrichJob, weekWindow, relativePosted, norm, classifyFunctions } from '../assets/shared/core.mjs';
import { seedProbe } from './lib/seeds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const readJSON = async (p, fb) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fb; } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function run({ fetchImpl, env = process.env, now = new Date(), dataDir = DATA, argv = args, cfgOverride = {} } = {}) {
  const cfg = { ...(await readJSON(join(ROOT, 'collector/config.json'), {})), ...cfgOverride };
  const registry = await readJSON(join(dataDir, 'sources.json'), { employers: [] });
  // companies found by the seed probe (data/discovered.json) are collected like registry employers
  const discovered = await readJSON(join(dataDir, 'discovered.json'), { schema: 1, employers: [] });
  { const names = new Set(registry.employers.map(e => norm(e.employer))), ids = new Set(registry.employers.flatMap(e => e.sources.map(x => x.id)));
    for (const e of discovered.employers || []) if (!names.has(norm(e.employer)) && !e.sources.some(x => ids.has(x.id))) registry.employers.push(e); }
  const prevJobs = await readJSON(join(dataDir, 'jobs.json'), { jobs: [] });
  const prevStatus = await readJSON(join(dataDir, 'status.json'), { sources: [] });
  const http = new Http({ ...cfg.http, minDelay: cfg.http?.minDelayMs, maxDelay: cfg.http?.maxDelayMs, userAgent: cfg.user_agent, fetchImpl, log, hostRules: cfg.host_rules || [] });
  const startedAt = now.toISOString();
  const opt = { workdayDetailCap: cfg.workday_detail_cap || 40, eightfoldMaxPerQuery: cfg.eightfold_max_per_query || 30, eightfoldScanPages: cfg.eightfold_scan_pages_per_run || 40, phenomMaxPerQuery: cfg.phenom_max_per_query || 30, workdayMaxPerQuery: cfg.workday_max_per_query || 60, maxPerQuery: cfg.max_per_query || 200, detailCap: cfg.detail_cap_per_source || 80, ghPayTransparency: !!cfg.greenhouse_pay_transparency, ghPayCap: cfg.greenhouse_pay_cap_per_board || 15 };

  // run counter (drives search rotation) and prior jobs per source (lets adapters skip re-fetching known details)
  const runSeq = (prevStatus.run?.seq || 0) + 1;
  opt.runSeq = runSeq; opt.queryRotation = cfg.workday_query_rotation || 1; opt.rotateMinQueries = cfg.workday_rotate_min_queries || 7;
  opt.prevStatusById = new Map(prevStatus.sources.map(x => [x.id, x]));
  opt.prevBySource = new Map();
  for (const j of prevJobs.jobs) { if (j.status === 'closed') continue; (opt.prevBySource.get(j.source_id) || opt.prevBySource.set(j.source_id, new Map()).get(j.source_id)).set(String(j.uid).slice(j.source_id.length + 1), j); }

  if (argv.probe) return probe(registry, http, dataDir);
  const runSeeds = async batch => {
    const seeds = await readJSON(join(dataDir, 'seeds.json'), null);
    if (!seeds?.seeds?.length || !batch) return null;
    const state = await readJSON(join(dataDir, 'seed-state.json'), {});
    const regNames = new Set(registry.employers.filter(e => !e.discovered).map(e => norm(e.employer).replace(/ /g, '')));
    const res = await seedProbe({ seeds, discovered, state, http, now, batch, registryNames: regNames, log });
    discovered.schema = 1; discovered.updated_at = now.toISOString();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'discovered.json'), JSON.stringify(discovered, null, 1));
    await writeFile(join(dataDir, 'seed-state.json'), JSON.stringify(state, null, 1));
    log(`seed probe: ${res.done} companies checked, ${res.added} boards added (${state.progress.found} found so far of ${state.progress.seeds} seeds)`);
    return res;
  };
  if (argv['seed-probe']) return { seeds: await runSeeds(Number(argv['seed-batch']) || cfg.seed_probe_batch || 40) };

  // ----- choose sources
  const only = argv.only ? new Set(String(argv.only).split(',')) : null;
  const atsOnly = argv.ats ? new Set(String(argv.ats).split(',')) : null;
  const tasks = [];
  for (const e of registry.employers) {
    if (argv.tier && e.tier !== argv.tier) continue;
    for (const s of e.sources) {
      if (only && !only.has(s.id)) continue;
      if (atsOnly && !atsOnly.has(s.ats)) continue;
      tasks.push({ e, s });
    }
  }
  if (argv.limit) tasks.splice(Number(argv.limit));
  log(`sources selected: ${tasks.length}`);

  const prevStatusById = new Map(prevStatus.sources.map(s => [s.id, s]));
  const statuses = [];
  const fresh = new Map(); // source_id -> enriched jobs
  const closeHours = new Map(); // per-source wait before an unseen role in a chunked scan is closed
  const partialIds = new Set(), rotatedIds = new Set(); // refused part-way / searched a rotating subset
  await Promise.all(tasks.map(async ({ e, s }) => {
    const base = { id: s.id, employer: e.employer, ats: s.ats, tier: e.tier, verification: s.verification?.status, checked_at: new Date().toISOString() };
    const adapter = ADAPTERS[s.ats];
    if (!adapter) {
      statuses.push({ ...base, result: s.ats === 'link_only' ? 'link_only' : 'not_fetchable', message: s.verification?.method || '', jobs_total: 0, jobs_stored: 0,
                      last_success_at: prevStatusById.get(s.id)?.last_success_at || null });
      return;
    }
    let out;
    try { out = await adapter(s, e, http, opt); }
    catch (err) { out = { result: 'adapter_error', jobs: [], note: String(err?.message || err) }; }
    const REUSE = ['locations', 'workplace', 'us', 'remote_us', 'elig_text', 'posted_at', 'posted_kind', 'salary', 'kw', 'excerpt', 'req_id', 'url', 'functions', 'eng_review', 'seniority'];
    const enriched = (out.jobs || []).map(j => {
      if (!j.posted_at && j.posted_text) { const d = relativePosted(j.posted_text, now); if (d) { j.posted_at = d + 'T12:00:00.000Z'; j.posted_kind = 'relative_approx'; } }
      const e2 = enrichJob(j);
      if (j.reuse) { // details were read on an earlier run: carry them forward instead of fetching again
        const pj = j.reuse; for (const k of REUSE) if (pj[k] !== undefined && k !== 'functions' && k !== 'eng_review' && k !== 'seniority') e2[k] = pj[k];
        e2.details_from = pj.details_from || pj.last_seen || null;
      }
      return e2;
    });
    // Full-list sweeps (AWS, Google, Microsoft, Oracle) return every posting. Roles whose title fits no job category can
    // never appear in results (the page re-checks titles), so they aren't stored; the next sweep picks them up if categories grow.
    const outOfScope = j => out.rotated && !s.keep_uncategorized && !j.eng_review && !classifyFunctions(j.title).functions.length;
    const skippedScope = enriched.filter(outOfScope).length;
    const stored = enriched.filter(j => (cfg.store_non_us || j.us !== false) && !outOfScope(j));
    if (skippedScope) out.note = `${out.note || ''}${out.note ? '; ' : ''}${skippedScope} roles outside every job category not stored`;
    const ok = out.result === 'ok' || out.result === 'empty' || out.result === 'partial';
    if (ok) fresh.set(s.id, stored);
    if (out.result === 'partial') partialIds.add(s.id);
    if (out.rotated) rotatedIds.add(s.id);
    if (out.close_after_hours) closeHours.set(s.id, out.close_after_hours);
    const prev = prevStatusById.get(s.id);
    statuses.push({ ...base, result: out.result, http_status: out.status ?? null, message: out.note || '', fields: out.fields || prev?.fields || null,
      jobs_total: (out.jobs || []).length, jobs_stored: stored.length,
      // a run refused before any results keeps its place, so the next run continues instead of starting over
      resume_offset: out.resume_offset ?? (ok ? null : prev?.resume_offset ?? null), us_facet: out.us_facet ?? prev?.us_facet ?? null,
      last_success_at: ok ? base.checked_at : (prev?.last_success_at || null),
      consecutive_failures: ok ? 0 : (prev?.consecutive_failures || 0) + 1 });
    log(`${out.result.padEnd(14)} ${s.id} → ${(out.jobs || []).length} jobs`);
  }));

  // ----- aggregators (discovery only)
  const aggStatus = [];
  for (const [name, fn] of Object.entries(AGGREGATORS)) {
    let out; try { out = await fn(cfg.aggregators, http, env); } catch (err) { out = { result: 'adapter_error', jobs: [], note: String(err) }; }
    const id = `agg:${name}`;
    const enriched = out.jobs.map(j => { if (!j.posted_at && j.posted_text) { const d = relativePosted(j.posted_text, now); if (d) { j.posted_at = d + 'T12:00:00.000Z'; j.posted_kind = 'relative_approx'; } } return enrichJob(j); });
    if (out.result === 'ok') fresh.set(id, enriched);
    aggStatus.push({ id, employer: '(aggregator)', ats: name, result: out.result, jobs_total: out.jobs.length, jobs_stored: enriched.length, checked_at: new Date().toISOString(), message: out.note || '' });
  }

  // ----- merge with history
  const nowIso = new Date().toISOString();
  const ranIds = new Set([...tasks.map(t => t.s.id), ...aggStatus.map(a => a.id)]);
  const prevByUid = new Map(prevJobs.jobs.map(j => [j.uid, j]));
  const merged = [];
  for (const [sid, list] of fresh) for (const j of list) {
    const p = prevByUid.get(j.uid);
    j.first_observed = p?.first_observed || nowIso;
    j.last_seen = nowIso;
    j.status = 'open';
    if (p && p.posted_at && j.posted_at && p.posted_at.slice(0, 10) !== j.posted_at.slice(0, 10)) {
      j.date_history = [...(p.date_history || []), { was: p.posted_at, seen: nowIso }].slice(-5);
      j.reposted = true;
    } else if (p?.date_history) { j.date_history = p.date_history; j.reposted = p.reposted; }
    merged.push(j); prevByUid.delete(j.uid);
  }
  const cutoff = Date.now() - (cfg.history_days || 21) * 864e5;
  for (const p of prevByUid.values()) {
    if (fresh.has(p.source_id) && (partialIds.has(p.source_id) || rotatedIds.has(p.source_id)) && p.status !== 'closed') {
      // only part of this source was searched: unseen roles stay open. Refused runs flag them; rotation closes
      // a role only once it has gone unseen for longer than a full rotation.
      const unseenH = (Date.now() - new Date(p.last_seen).getTime()) / 36e5;
      if (!partialIds.has(p.source_id) && unseenH > (closeHours.get(p.source_id) || cfg.rotation_close_hours || 30)) merged.push({ ...p, status: 'closed', closed_at: nowIso });
      else merged.push(partialIds.has(p.source_id) ? { ...p, stale: true, stale_since: p.stale_since || nowIso } : p);
    } else if (!ranIds.has(p.source_id) || !fresh.has(p.source_id)) {
      // source not run this time, or failed: keep the role, flag it as unrefreshed
      merged.push({ ...p, stale: ranIds.has(p.source_id) ? true : p.stale || false, stale_since: ranIds.has(p.source_id) ? (p.stale_since || nowIso) : p.stale_since });
    } else if (p.status !== 'closed') merged.push({ ...p, status: 'closed', closed_at: nowIso });
    else if (new Date(p.closed_at).getTime() > cutoff) merged.push(p);
  }

  // ----- duplicate groups across sources (e.g. Microsoft's main site and Microsoft AI's board): same employer and
  // requisition ID, or same employer + title with a city in common (location formats differ between systems)
  const STOP = new Set(['united', 'states', 'usa', 'remote', 'multiple', 'locations', 'hybrid', 'office', 'onsite', 'other']);
  const cities = j => new Set((j.locations || []).flatMap(l => String(l).split(/\s*[,;|/–-]\s*/)).map(x => norm(x).trim()).filter(x => x.length > 3 && !STOP.has(x) && !/^[a-z]{2}$/.test(x)));
  const byTitle = new Map();
  for (const j of merged) { const k = `${norm(j.employer).split(' ')[0]}|${norm(j.title)}`; (byTitle.get(k) || byTitle.set(k, []).get(k)).push(j); }
  const groups = [];
  for (const list of byTitle.values()) {
    const left = list.slice();
    while (left.length) {
      const g = [left.shift()]; let grew = true;
      while (grew) { grew = false;
        for (let i = left.length - 1; i >= 0; i--) {
          const c = left[i];
          const hit = g.some(x => x.source_id === c.source_id
            // same board: only the exact old rule (same title + same first location)
            ? norm((x.locations || [])[0] || '') === norm((c.locations || [])[0] || '')
            // different boards: same requisition ID, or a city in common, or neither lists a location
            : (x.req_id && c.req_id && norm(x.req_id) === norm(c.req_id)) || (!x.locations?.length && !c.locations?.length) ||
              [...cities(x)].some(t => cities(c).has(t)) || norm((x.locations || [])[0] || '') === norm((c.locations || [])[0] || ''));
          if (hit) { g.push(c); left.splice(i, 1); grew = true; }
        }
      }
      groups.push(g);
    }
  }
  for (const g of groups) if (g.length > 1) {
    const officialFirst = g.slice().sort((a, b) => (a.source_class === 'official' ? 0 : 1) - (b.source_class === 'official' ? 0 : 1));
    for (const j of g) { j.dup_count = g.length; j.dup_of = j === officialFirst[0] ? null : officialFirst[0].uid; }
  }

  const win = weekWindow(now);
  const allStatus = [...statuses, ...aggStatus];
  // keep status rows for sources not run this time
  const known = new Set(registry.employers.flatMap(e => e.sources.map(x => x.id)));
  for (const s of prevStatus.sources) if (!allStatus.find(x => x.id === s.id) && (known.has(s.id) || s.id.startsWith('agg:'))) allStatus.push(s); // drop rows for sources removed from the registry
  allStatus.sort((a, b) => a.employer.localeCompare(b.employer) || a.id.localeCompare(b.id));

  const summary = allStatus.reduce((acc, s) => { acc[s.result] = (acc[s.result] || 0) + 1; return acc; }, {});
  const finishedAt = new Date().toISOString();
  const jobsOut = { schema: 1, generated_at: finishedAt, window: win, counts: { open: merged.filter(j => j.status === 'open').length, closed_recent: merged.filter(j => j.status === 'closed').length, stale: merged.filter(j => j.stale).length }, jobs: merged };
  const statusOut = { schema: 1, generated_at: finishedAt, run: { seq: runSeq, started_at: startedAt, finished_at: finishedAt, sources_run: tasks.length, http: http.stats, partial: !!(only || atsOnly || argv.tier || argv.limit) }, summary, sources: allStatus };
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'jobs.json'), JSON.stringify(jobsOut));
  await writeFile(join(dataDir, 'status.json'), JSON.stringify(statusOut, null, 1));
  log(`done: ${jobsOut.counts.open} open jobs, summary ${JSON.stringify(summary)}`);
  // a small batch of seed companies each full run; their boards are collected from the next run
  const seedRes = !statusOut.run.partial ? await runSeeds(cfg.seed_probe_batch ?? 40) : null;
  return { jobsOut, statusOut, seedRes };
}

// ----- discovery probe: suggests boards, a human approves them into sources.json
async function probe(registry, http, dataDir) {
  const targets = registry.employers.filter(e => e.sources.every(s => !['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'amazon', 'eightfold', 'oracle_hcm', 'cisco_rss', 'phenom', 'comeet', 'radancy', 'google_careers', 'company_html'].includes(s.ats) || /unresolved|unverified/.test(s.verification?.status || '')));
  const results = [];
  for (const e of targets) {
    // Strongest evidence: ATS links on the employer's own careers page.
    const fromPage = [];
    if (e.careers_url) {
      const r = await http.text(e.careers_url);
      if (r.ok) fromPage.push(...atsLinks(r.data).map(x => ({ ...x, evidence: `linked from ${e.careers_url}` })));
    }
    // Named candidates (e.g. from a researched roster) are checked first, on their stated ATS only, and the
    // board's own company name is reported so a same-named different employer (slug collision) is caught.
    const named = e.sources.flatMap(x => x.candidates || []);
    const checked = [];
    for (const c of named) {
      const url = { greenhouse: `https://boards-api.greenhouse.io/v1/boards/${c.slug}`, ashby: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.slug)}`,
        lever: `https://api.lever.co/v0/postings/${c.slug}?mode=json&limit=3`, workable: `https://apply.workable.com/api/v1/widget/accounts/${c.slug}`,
        smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${c.slug}/postings?limit=3` }[c.ats];
      if (!url) continue;
      const r = await http.json(url);
      const D = r.ok ? r.data : null;
      const board_name = D ? (D.name || D.content?.[0]?.company?.name || null) : null;
      const sample_titles = D ? (D.jobs || D.content || (Array.isArray(D) ? D : [])).slice(0, 3).map(j => j.title || j.text || j.name).filter(Boolean) : [];
      const count = D ? (D.jobs?.length ?? D.totalFound ?? (Array.isArray(D) ? D.length : null)) : null;
      checked.push({ ats: c.ats, slug: c.slug, source: c.source || null, result: r.ok ? 'reachable' : `http_${r.status || r.error}`, board_name, jobs_seen: count, sample_titles, url,
        identity_check: board_name ? (norm(board_name).includes(norm(e.employer).split(' ')[0]) ? 'name matches' : `CHECK: board says "${board_name}"`) : 'board does not report a company name; compare the sample titles' });
    }
    const base = e.employer.toLowerCase().replace(/\.ai$/, 'ai').replace(/&/g, 'and');
    const cands = [...new Set([base.replace(/[^a-z0-9]/g, ''), base.replace(/[^a-z0-9]+/g, '-'), base.replace(/\s+(security|inc|labs|ai|health)$/, '').replace(/[^a-z0-9]/g, '')])]
      .filter(c => !named.some(n => n.slug.toLowerCase() === c));
    const found = [];
    for (const c of cands) {
      const checks = [
        ['greenhouse', `https://boards-api.greenhouse.io/v1/boards/${c}`, d => d?.name],
        ['lever', `https://api.lever.co/v0/postings/${c}?mode=json&limit=1`, d => Array.isArray(d) && d.length ? d[0]?.text && '(has postings)' : null],
        ['ashby', `https://api.ashbyhq.com/posting-api/job-board/${c}`, d => Array.isArray(d?.jobs) ? `${d.jobs.length} jobs` : null],
        ['smartrecruiters', `https://api.smartrecruiters.com/v1/companies/${c}/postings?limit=1`, d => d?.totalFound > 0 ? `${d.totalFound} postings` : null],
        ['workable', `https://apply.workable.com/api/v1/widget/accounts/${c}`, d => d?.name],
      ];
      for (const [ats, url, ok] of checks) {
        const r = await http.json(url);
        const sig = r.ok ? ok(r.data) : null;
        if (sig) found.push({ ats, slug: c, evidence: String(sig), url });
      }
    }
    results.push({ employer: e.employer, careers_url: e.careers_url || null, from_careers_page: fromPage, named_candidates: checked, candidates_tried: cands, found, note: found.length ? 'Confirm the board name matches the employer before adding to sources.json (slug collisions happen).' : 'No public board found under guessed names. Find the ATS from an Apply link on the careers page.' });
    if (!e.careers_url) results[results.length - 1].next_step = 'Add careers_url for this employer (its official careers page) so the probe can read real Apply links.';
    log(`probe ${e.employer}: page ${fromPage.map(f => f.ats + ':' + f.slug).join(', ') || '-'} | named ${checked.map(c => c.ats + ':' + c.slug + '=' + c.result).join(', ') || '-'} | guesses ${found.map(f => f.ats + ':' + f.slug).join(', ') || 'none'}`);
  }
  await writeFile(join(dataDir, 'probe-results.json'), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 1));
  return { results };
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch(e => { console.error(e); process.exit(1); });
