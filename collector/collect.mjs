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
import { readJobs, writeJobs } from './lib/jobstore.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Http } from './lib/http.mjs';
import { ADAPTERS, AGGREGATORS, atsLinks } from './lib/adapters-server.mjs';
import { enrichJob, weekWindow, relativePosted, norm, classifyFunctions, roleBlurb } from '../assets/shared/core.mjs';
import { archiveRun } from './archive.mjs';
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
  const prevJobs = await readJobs(dataDir);
  const prevStatus = await readJSON(join(dataDir, 'status.json'), { sources: [] });
  const http = new Http({ ...cfg.http, minDelay: cfg.http?.minDelayMs, maxDelay: cfg.http?.maxDelayMs, userAgent: cfg.user_agent, fetchImpl, log, hostRules: cfg.host_rules || [] });
  const startedAt = now.toISOString();
  const opt = { now, detailMaxAgeDays: cfg.detail_max_age_days || 30, workdayDetailCap: cfg.workday_detail_cap || 40, eightfoldMaxPerQuery: cfg.eightfold_max_per_query || 30, eightfoldScanPages: cfg.eightfold_scan_pages_per_run || 40, phenomMaxPerQuery: cfg.phenom_max_per_query || 30, workdayMaxPerQuery: cfg.workday_max_per_query || 60, maxPerQuery: cfg.max_per_query || 200, detailCap: cfg.detail_cap_per_source || 80, ghPayTransparency: !!cfg.greenhouse_pay_transparency, ghPayCap: cfg.greenhouse_pay_cap_per_board || 15 };

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
  const unitInfo = new Map(), deferredIds = new Set(), holdIds = new Set(); // sources reporting per-search completeness; sources skipped on Retry-After
  const closeBefore = new Map(); // rotated sources that know when their last complete pass began: close only roles unseen since then
  await Promise.all(tasks.map(async ({ e, s }) => {
    const base = { id: s.id, employer: e.employer, ats: s.ats, tier: e.tier, verification: s.verification?.status, checked_at: now.toISOString() };
    const adapter = ADAPTERS[s.ats];
    if (!adapter) {
      statuses.push({ ...base, result: s.ats === 'link_only' ? 'link_only' : 'not_fetchable', message: s.verification?.method || '', jobs_total: 0, jobs_stored: 0,
                      last_success_at: prevStatusById.get(s.id)?.last_success_at || null });
      return;
    }
    // A source refused outright (403) on 3+ runs in a row is paused and retried weekly: a 403 means this method is
    // blocked, not that the employer has no jobs, and asking again 4 times a day only adds unwanted traffic.
    const pv = prevStatusById.get(s.id);
    const blockedRuns = pv && (pv.http_status === 403 || ['blocked_paused', 'blocked_challenge'].includes(pv.result)) ? (pv.blocked_runs || (pv.consecutive_failures || 0)) : 0;
    const lastTry = pv?.last_attempt_at || pv?.checked_at;
    if (!only && blockedRuns >= 3 && lastTry && now.getTime() - new Date(lastTry).getTime() < 7 * 864e5) {
      statuses.push({ ...pv, ...base, result: 'blocked_paused', http_status: 403, checked_at: pv.checked_at, last_attempt_at: lastTry, blocked_runs: blockedRuns,
        message: `${pv.bot_check || pv.result === 'blocked_challenge' ? 'Bot check (Cloudflare)' : 'Refused (403)'} on ${blockedRuns} runs in a row: this method is blocked from GitHub's servers. Paused; next attempt after ${new Date(new Date(lastTry).getTime() + 7 * 864e5).toISOString().slice(0, 10)}. Previous roles kept.` });
      return;
    }
    // A server that asked (Retry-After) for a longer wait than one run allows is left alone until that time.
    if (!only && pv?.next_eligible_at && now < new Date(pv.next_eligible_at)) {
      statuses.push({ ...pv, ...base, result: 'deferred', checked_at: pv.checked_at, last_attempt_at: lastTry,
        message: `Deferred: ${pv.throttle_runs ? `resting after ${pv.throttle_runs} throttled run${pv.throttle_runs === 1 ? '' : 's'} (429)` : 'the site asked the collector to wait (Retry-After)'} until ${pv.next_eligible_at.replace('T', ' ').slice(0, 16)} UTC. Previous roles kept. ${pv.message ? `Last result: ${pv.message}` : ''}`.trim() });
      deferredIds.add(s.id);
      return;
    }
    // per-source view of the shared client: records this source's own long Retry-After answers
    let deferMs = 0, okBefore = 0, refusal = null;
    const track = (r, u) => {
      if (r?.defer && r.retryAfterMs > deferMs) deferMs = r.retryAfterMs;
      if (r?.ok) { if (!refusal) okBefore++; }
      else if (r?.refusal && !refusal) { let path = ''; try { const x = new URL(u); path = x.host + x.pathname; } catch { /* keep blank */ }
        refusal = { at: now.toISOString(), status: r.status, request: path, ok_before: okBefore, attempts: r.attempts, ...r.refusal }; }
      return r; };
    const sh = Object.create(http);
    sh.json = (u, o) => http.json(u, o).then(r => track(r, u));
    sh.text = (u, o) => http.text(u, o).then(r => track(r, u));
    let out;
    try { out = await adapter(s, e, sh, opt); }
    catch (err) { out = { result: 'adapter_error', jobs: [], note: String(err?.message || err) }; }
    // Throttle cooldown (sources with throttle_cooldown_hours, e.g. Microsoft): a 429 with no usable Retry-After rests the
    // source for that many hours, doubling on each throttled run in a row (cap 24h), instead of asking again next hour.
    const throttled = out.status === 429 && !deferMs;
    const throttleRuns = throttled ? (pv?.throttle_runs || 0) + 1 : 0;
    if (throttled && s.throttle_cooldown_hours) deferMs = Math.min(24, s.throttle_cooldown_hours * 2 ** (throttleRuns - 1)) * 36e5;
    if (refusal) {
      const h = refusal.headers || {}, quota = Object.keys(h).filter(k => /ratelimit|rate-limit/.test(k));
      out.note = `${out.note || ''}${out.note ? '; ' : ''}refusal detail: HTTP ${refusal.status} after ${refusal.ok_before} successful request${refusal.ok_before === 1 ? '' : 's'} this run, ${refusal.body_kind} body${refusal.excerpt ? ` ("${refusal.excerpt.slice(0, 80)}")` : ''}, ${h['retry-after'] ? `Retry-After ${h['retry-after']}` : 'no Retry-After'}, ${quota.length ? quota.map(k => `${k}: ${h[k]}`).join(', ') : 'no RateLimit headers'}${h.server ? `, server ${h.server}` : ''}${h['cf-mitigated'] ? `, cf-mitigated ${h['cf-mitigated']}` : ''}`;
    }
    const nextEligible = deferMs ? new Date(now.getTime() + Math.min(deferMs, 7 * 864e5)).toISOString() : null;
    if (throttled && s.throttle_cooldown_hours) out.note = `${out.note || ''}; throttled ${throttleRuns} run${throttleRuns === 1 ? '' : 's'} in a row: resting until ${nextEligible.replace('T', ' ').slice(0, 16)} UTC`;
    if (nextEligible && !(throttled && s.throttle_cooldown_hours)) out.note = `${out.note || ''}${out.note ? '; ' : ''}the site asked for a ${Math.round(deferMs / 60000)}-minute wait (Retry-After): no retries this run; next attempt after ${nextEligible.replace('T', ' ').slice(0, 16)} UTC`;
    const siteUrl = s.host ? `https://${s.host}/` : (s.list_url || s.seed_url || s.base || s.board_url || null);
    const chal = siteUrl && http.challengeFor(siteUrl);
    if (chal && out.result !== 'ok' && out.result !== 'empty') {
      const got = (out.jobs || []).length;
      out = { ...out, result: got ? 'partial' : 'blocked_challenge', status: chal.status, bot_check: chal.mitigated,
        note: `Bot check: the site's Cloudflare protection refused the collector (HTTP ${chal.status}, cf-mitigated: ${chal.mitigated}). Retrying can't fix this, so no further requests were made to it this run. ${got ? `${got} roles fetched before the check are kept; ` : ''}previous roles kept. Not evidence of zero jobs.` };
    }
    const REUSE = ['locations', 'workplace', 'us', 'remote_us', 'elig_text', 'posted_at', 'posted_kind', 'salary', 'kw', 'excerpt', 'req_id', 'url', 'functions', 'eng_review', 'seniority'];
    const enriched = (out.jobs || []).map(j => {
      if (!j.posted_at && j.posted_text) { const d = relativePosted(j.posted_text, now); if (d) { j.posted_at = d + 'T12:00:00.000Z'; j.posted_kind = 'relative_approx'; } }
      const e2 = enrichJob(j);
      if (j.pay_checked_at) e2.pay_checked_at = j.pay_checked_at; // job page already checked for a pay statement
      if (out.units && j._units) e2.seen_units = j._units; // which searches returned it: a completed one may later close it
      if (!j.reuse && j.desc_text) { e2._blurb = roleBlurb(j.desc_text); e2.details_from = now.toISOString(); } // blurb: archive only, not written to jobs.json
      if (j.reuse) { // details were read on an earlier run: carry them forward instead of fetching again
        const pj = j.reuse; for (const k of REUSE) if (pj[k] !== undefined && k !== 'functions' && k !== 'eng_review' && k !== 'seniority') e2[k] = pj[k];
        e2.details_from = pj.details_from || pj.last_seen || null;
      }
      return e2;
    });
    // Full-list sweeps (AWS, Google, Microsoft, Oracle) return every posting. Roles whose title fits no job category can
    // never appear in results (the page re-checks titles), so they aren't stored; the next sweep picks them up if categories grow.
    // Uncategorized roles are stored as "Other roles" (off in the app by default). A source can opt out with
    // drop_uncategorized when its volume makes that impractical (AWS).
    const outOfScope = j => out.rotated && s.drop_uncategorized && !j.eng_review && classifyFunctions(j.title).functions.every(f => f === 'other');
    const skippedScope = enriched.filter(outOfScope).length;
    const stored = enriched.filter(j => (cfg.store_non_us || j.us !== false) && !outOfScope(j));
    if (skippedScope) out.note = `${out.note || ''}${out.note ? '; ' : ''}${skippedScope} roles outside every job category not stored (drop_uncategorized)`;
    const otherN = out.rotated ? stored.filter(j => !j.eng_review && classifyFunctions(j.title).functions.every(f => f === 'other')).length : 0;
    if (otherN) out.note = `${out.note || ''}${out.note ? '; ' : ''}${otherN} roles fit no job category and are stored as "Other roles"`;
    const ok = out.result === 'ok' || out.result === 'empty' || out.result === 'partial';
    const complete = out.result === 'ok' || out.result === 'empty';
    // A board that suddenly returns far fewer roles (a truncated or changed response) would close most of them at
    // once. Hold those closures for one run: if the next complete scan agrees, they close then.
    const prevTotal = pv?.jobs_total || 0, nowTotal = (out.jobs || []).length;
    let dropHold = null;
    if (complete && !out.rotated && !out.units && prevTotal >= 20 && nowTotal < prevTotal * 0.5) {
      if (!pv?.drop_hold) { dropHold = { from: prevTotal, to: nowTotal, at: now.toISOString() }; holdIds.add(s.id);
        out.note = `${out.note || ''}${out.note ? '; ' : ''}ALERT: ${nowTotal} roles vs ${prevTotal} last scan; closures held until the next scan confirms the drop`; }
      else out.note = `${out.note || ''}${out.note ? '; ' : ''}drop from ${pv.drop_hold.from} confirmed by a second scan; unseen roles closed`;
    }
    if (ok) fresh.set(s.id, stored);
    if (out.result === 'partial') partialIds.add(s.id);
    if (out.rotated) rotatedIds.add(s.id);
    if (out.units && ok) unitInfo.set(s.id, out.units);
    if (out.close_after_hours) closeHours.set(s.id, out.close_after_hours);
    if (out.close_before !== undefined) closeBefore.set(s.id, out.close_before);
    const prev = prevStatusById.get(s.id);
    statuses.push({ ...base, result: out.result, http_status: out.status ?? null, message: out.note || '', fields: out.fields || prev?.fields || null,
      jobs_total: (out.jobs || []).length, jobs_stored: stored.length,
      // a run refused before any results keeps its place, so the next run continues instead of starting over
      resume_offset: out.resume_offset ?? (ok ? null : prev?.resume_offset ?? null), us_facet: out.us_facet ?? prev?.us_facet ?? null,
      checkpoint: out.checkpoint ?? prev?.checkpoint ?? null,
      // complete = the run read everything it set out to read. A partial run still returned data (last_data_at)
      // but is not a successful sync and never closes roles by their absence.
      inventory: complete ? 'complete' : out.result === 'partial' ? 'partial' : 'failed',
      can_close: complete && (!out.rotated || closeBefore.get(s.id) != null || !!out.units),
      last_success_at: complete ? base.checked_at : (prev?.last_success_at || null),
      last_data_at: ok ? base.checked_at : (prev?.last_data_at || prev?.last_success_at || null),
      last_complete_scan_at: out.checkpoint?.last_full_cycle_end || (complete && !out.rotated ? base.checked_at : (prev?.last_complete_scan_at || null)),
      next_eligible_at: nextEligible, drop_hold: dropHold, throttle_runs: throttleRuns,
      last_refusal: refusal || prev?.last_refusal || null, // what the most recent 403/429 said (headers, body type, excerpt)
      consecutive_failures: complete ? 0 : (prev?.consecutive_failures || 0) + 1, last_attempt_at: base.checked_at,
      bot_check: out.bot_check || null,
      blocked_runs: (out.status === 403 || out.result === 'blocked_challenge') ? (prev?.blocked_runs || (prev?.http_status === 403 || prev?.result === 'blocked_challenge' ? prev?.consecutive_failures || 0 : 0)) + 1 : 0 });
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
  const nowIso = now.toISOString();
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
  const cutoff = now.getTime() - (cfg.history_days || 21) * 864e5;
  // Closing a role means a scan that covered it finished without it. How that was established is recorded
  // (closed_basis) so the archive can tell verified closures from expiries:
  //   complete_scan   the whole board was read in one successful run (Greenhouse, Lever, Ashby, ...)
  //   complete_pass   a multi-run full-list pass that began after the role was last seen finished cleanly
  //   complete_search a search that had returned the role was later read to its end without it
  //   unseen_window   older rotation rule (sources without pass tracking): unseen longer than a full rotation
  //   unverified_expired  not confirmed by any scan for unverified_close_days (default 30): closed, but unverified
  const expireDays = cfg.unverified_close_days || 30;
  const closeAs = (p, basis) => ({ ...p, status: 'closed', closed_at: nowIso, closed_basis: basis, stale: false });
  for (const p of prevByUid.values()) {
    const sid = p.source_id, unseenH = (now.getTime() - new Date(p.last_seen).getTime()) / 36e5;
    const expired = p.status !== 'closed' && unseenH > expireDays * 24;
    const ui = unitInfo.get(sid);
    if (fresh.has(sid) && holdIds.has(sid) && p.status !== 'closed') merged.push({ ...p, stale: true, stale_since: p.stale_since || nowIso });
    else if (fresh.has(sid) && (partialIds.has(sid) || rotatedIds.has(sid) || ui) && p.status !== 'closed') {
      // only part of this source was read: an unseen role closes only on evidence that covered it
      const cb = closeBefore.get(sid);
      const hoursOk = unseenH > (closeHours.get(sid) || cfg.rotation_close_hours || 30);
      let basis = null;
      if (closeBefore.has(sid)) { if (cb && new Date(p.last_seen) < new Date(cb) && hoursOk) basis = 'complete_pass'; }
      else if (ui) {
        const su = p.seen_units || [];
        if (su.some(u => ui.done[u] && new Date(p.last_seen) < new Date(ui.done[u]))) basis = 'complete_search';
        else if (!su.length && !partialIds.has(sid) && hoursOk && rotatedIds.has(sid) && !Object.keys(ui.incomplete).length) basis = 'unseen_window'; // rows saved before searches were tracked
      } else if (!partialIds.has(sid) && hoursOk) basis = 'unseen_window';
      if (!basis && expired) basis = 'unverified_expired';
      if (basis) merged.push(closeAs(p, basis));
      else {
        const unverified = partialIds.has(sid) || (ui && (p.seen_units || []).some(u => ui.incomplete[u]));
        merged.push(unverified ? { ...p, stale: true, stale_since: p.stale_since || nowIso } : p);
      }
    } else if (!ranIds.has(sid) || !fresh.has(sid) || deferredIds.has(sid)) {
      // source not run this time, deferred, or failed: keep the role, flag it as unrefreshed (until it expires)
      if (expired) merged.push(closeAs(p, 'unverified_expired'));
      else merged.push({ ...p, stale: ranIds.has(sid) ? true : p.stale || false, stale_since: ranIds.has(sid) ? (p.stale_since || nowIso) : p.stale_since });
    } else if (p.status !== 'closed') merged.push(closeAs(p, 'complete_scan'));
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
            // same board, different posting ids: separate openings unless the requisition id says otherwise.
            // Different req ids = different openings. No req ids on either: same title + same first location still groups.
            ? (x.req_id && c.req_id ? norm(x.req_id) === norm(c.req_id) : !x.req_id && !c.req_id && norm((x.locations || [])[0] || '') === norm((c.locations || [])[0] || ''))
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
    const byReq = g.every(x => x.req_id && norm(x.req_id) === norm(g[0].req_id));
    for (const j of g) { j.dup_count = g.length; j.dup_of = j === officialFirst[0] ? null : officialFirst[0].uid; j.dup_basis = byReq ? 'req_id' : 'title_location'; }
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
  const statusOut = { schema: 1, generated_at: finishedAt, run: { seq: runSeq, started_at: startedAt, finished_at: finishedAt, sources_run: tasks.length, http: http.stats,
    // selection_limited: this run was asked to collect only some sources (command-line flags).
    // incomplete_sources: sources that ran but did not finish (partial, refused, failed, deferred).
    selection_limited: !!(only || atsOnly || argv.tier || argv.limit),
    incomplete_sources: allStatus.filter(x => x.inventory && x.inventory !== 'complete' || x.result === 'deferred').length }, summary, sources: allStatus };
  await mkdir(dataDir, { recursive: true });
  // market archive: one row per posting when first seen, one when it closes (data/archive/, append-only)
  try { const a = await archiveRun({ dataDir, jobs: merged, nowIso, registry, sources: allStatus, prevById: new Map(prevJobs.jobs.map(j => [j.uid, j])) }); log(`archive: ${a.added} new, ${a.closed} closed, ${a.changes} changes${a.backfilled ? `, backfilled ${a.backfilled}` : ''}${a.rolled ? `, compressed ${a.rolled}` : ''}; weekly rollup ${a.weeks} week(s)`); }
  catch (err) { log(`archive failed (collection still saved): ${err?.message || err}`); }
  for (const j of merged) delete j._blurb;
  await writeJobs(dataDir, jobsOut); // data/jobs.json (metadata + shard list) and data/jobs/jobs-<n>.json
  await writeFile(join(dataDir, 'status.json'), JSON.stringify(statusOut, null, 1));
  log(`done: ${jobsOut.counts.open} open jobs, summary ${JSON.stringify(summary)}`);
  // a small batch of seed companies each full run; their boards are collected from the next run
  const seedRes = !statusOut.run.selection_limited ? await runSeeds(cfg.seed_probe_batch ?? 40) : null;
  return { jobsOut, statusOut, seedRes };
}

// ----- discovery probe: suggests boards, a human approves them into sources.json
async function probe(registry, http, dataDir) {
  const targets = registry.employers.filter(e => e.sources.every(s => !['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'amazon', 'eightfold', 'oracle_hcm', 'cisco_rss', 'phenom', 'comeet', 'radancy', 'google_careers', 'company_html', 'bamboohr', 'avature'].includes(s.ats) || /unresolved|unverified/.test(s.verification?.status || '')));
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
