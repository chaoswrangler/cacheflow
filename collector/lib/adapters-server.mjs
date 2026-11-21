// Adapters that only work server-side (no CORS) or need many paced requests.
import { ADAPTERS as BASE, htmlToText, relativePosted, classifyFunctions, FUNCTIONS, parseSalaries, chooseSalary, classifyWorkplace } from '../../assets/shared/core.mjs';

const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const fail = (r, extra = {}) => ({ result: r.error === 'timeout' ? 'timeout' : r.status ? `http_${r.status}` : (r.error || 'network_error'), status: r.status || null, jobs: [], note: r.detail || r.statusText || r.error || '', ...extra });
// Inventory units: each search (or list) an adapter pages through. A unit is "done" only when it was read to its end
// with no failed page and no result cap. Only a done unit may close a role it no longer returns; a capped, failed or
// skipped unit leaves its roles open. `done` records when the unit's scan started (a scan resumed from an earlier
// run started then), so a role seen in that earlier part is not mistaken for missing.
// Full-list sweeps that take several runs (AWS, Oracle): track when the current pass began and how many rows it read.
// A pass counts as complete (and may close roles not seen since it began) only if it began at the top in a tracked
// run, returned rows, and wasn't far shorter than the last complete pass.
export function sweepCycle(prevCk, { nowIso, fromStart, wrapped, rows }) {
  const ck = { ...(prevCk || {}) };
  if (fromStart) { ck.cycle_started = nowIso; ck.cycle_rows = 0; }
  ck.cycle_rows = (ck.cycle_rows || 0) + rows;
  let early = null;
  if (wrapped) {
    const expected = ck.last_full_cycle_rows || 0;
    if (!ck.cycle_started) early = 'this pass began before pass tracking, so it is not used for closures';
    else if (!ck.cycle_rows) early = 'pass returned no rows, not used for closures';
    else if (expected && ck.cycle_rows < 0.8 * expected) early = `pass ended early (${ck.cycle_rows} rows vs about ${expected}), not used for closures`;
    else { ck.last_full_cycle_start = ck.cycle_started; ck.last_full_cycle_end = nowIso; ck.last_full_cycle_rows = ck.cycle_rows; }
    ck.cycle_started = null; ck.cycle_rows = 0;
  }
  ck.updated_at = nowIso;
  return { ck, early };
}
// Details read on an earlier run are reused only while recent: employers revise pay, remote rules or requirements
// without changing a title. Relevant roles older than detail_max_age_days (default 30) are read again, within the
// same per-run detail budget.
export const detailStale = (pj, opt = {}) => {
  const at = pj?.details_from || pj?.first_observed; if (!at) return false;
  return relevantTitle(pj.title || '') && ((opt.now || new Date()) - new Date(at)) / 864e5 > (opt.detailMaxAgeDays || 30);
};
export function inventoryUnits() {
  const seen = new Map(), done = {}, incomplete = {};
  return {
    saw(u, id) { id = String(id); let s = seen.get(id); if (!s) seen.set(id, s = new Set()); s.add(u); },
    done(u, startedAt) { done[u] = startedAt; delete incomplete[u]; },
    incomplete(u, why) { incomplete[u] = why; delete done[u]; },
    of(id) { return [...(seen.get(String(id)) || [])]; },
    out() { return { done, incomplete }; },
    get anyIncomplete() { return Object.keys(incomplete).length > 0; },
  };
}
// ATS boards referenced on an employer's own careers page (Apply links, embeds). Evidence for --probe, never auto-added.
export function atsLinks(html) {
  const out = new Map(); const add = (ats, id, url) => { const k = `${ats}:${id}`; if (!out.has(k)) out.set(k, { ats, slug: id, evidence_url: url }); };
  const H = String(html || '');
  for (const m of H.matchAll(/https?:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/g)) if (!['embed', 'v1'].includes(m[1])) add('greenhouse', m[1].toLowerCase(), m[0]);
  for (const m of H.matchAll(/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9_-]+)/g)) add('greenhouse', m[1].toLowerCase(), m[0]);
  for (const m of H.matchAll(/https?:\/\/jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/g)) add('lever', m[1], m[0]);
  for (const m of H.matchAll(/https?:\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/g)) add('ashby', decodeURIComponent(m[1]), m[0]);
  for (const m of H.matchAll(/https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g)) add('workday', `${m[1]}/${m[3]}`, m[0]);
  for (const m of H.matchAll(/https?:\/\/www\.comeet\.com\/jobs\/([a-z0-9-]+)\/([0-9A-F.]+)/gi)) add('comeet', `${m[1]}/${m[2]}`, m[0]);
  for (const m of H.matchAll(/https?:\/\/apply\.workable\.com\/([A-Za-z0-9_-]+)/g)) if (m[1] !== 'api') add('workable', m[1], m[0]);
  for (const m of H.matchAll(/https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g)) add('smartrecruiters', m[1], m[0]);
  for (const m of H.matchAll(/https?:\/\/ats\.rippling\.com\/([A-Za-z0-9_-]+)/g)) add('rippling', m[1], m[0]);
  for (const m of H.matchAll(/https?:\/\/([a-z0-9-]+)\.applytojob\.com/g)) if (m[1] !== 'www') add('jazzhr', m[1], m[0]);
  for (const m of H.matchAll(/https?:\/\/jobs\.dayforcehcm\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/g)) add('dayforce', `${m[1]}/${m[2]}`, m[0]);
  for (const m of H.matchAll(/https?:\/\/jobs\.gem\.com\/([A-Za-z0-9_-]+)/g)) add('gem', m[1], m[0]);
  return [...out.values()];
}

// robots.txt: Disallow rules for "User-agent: *" plus Sitemap lines.
export function robotsRules(txt) {
  const out = { disallow: [], sitemaps: [], crawlDelay: null }; let applies = false, sawAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const [k, ...rest] = line.split(':'); const v = rest.join(':').trim(), key = k.trim().toLowerCase();
    if (key === 'sitemap') out.sitemaps.push(v);
    else if (key === 'user-agent') { if (!sawAgent || !applies) applies = v === '*'; sawAgent = true; }
    else if (applies && key === 'disallow' && v) out.disallow.push(v);
    else if (applies && key === 'crawl-delay') out.crawlDelay = Number(v) || null;
    else if (key !== 'user-agent') sawAgent = false;
  }
  return out;
}
// First schema.org JobPosting in a page's JSON-LD blocks.
export function jsonLdJob(html) {
  for (const m of String(html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d; try { d = JSON.parse(m[1].trim()); } catch { continue; }
    const items = [].concat(d['@graph'] || d);
    const jp = items.find(x => x && [].concat(x['@type']).includes('JobPosting'));
    if (jp) return jp;
  }
  return null;
}
const titleCase = s => String(s || '').replace(/\b\w/g, c => c.toUpperCase());

// Balanced JSON value starting at index i (array or object), skipping string contents.
function balancedAt(str, i) {
  let depth = 0, inStr = false, esc = false, q = '';
  for (let k = i; k < str.length; k++) {
    const c = str[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; }
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) return str.slice(i, k + 1);
  }
  return null;
}
// data payload of AF_initDataCallback({key: 'ds:1', ..., data: [...]})
export function afData(html, key) {
  const re = /AF_initDataCallback\(\s*\{/g; let m;
  while ((m = re.exec(String(html || '')))) {
    const head = html.slice(m.index, m.index + 80);
    if (!new RegExp(`^AF_initDataCallback\\(\\s*\\{\\s*key:\\s*'${key}'`).test(head)) continue;
    const d = html.indexOf('data:', m.index); if (d < 0) return null;
    const txt = balancedAt(html, html.indexOf('[', d)); if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
  }
  return null;
}
// Find job records by shape: [ '<long numeric id>', '<title>', ...fields ]
export function googleJobs(data) {
  const out = [];
  const walk = (a, depth) => {
    if (!Array.isArray(a) || depth > 6) return;
    if (typeof a[0] === 'string' && /^\d{10,}$/.test(a[0]) && typeof a[1] === 'string' && a[1].length > 3 && a[1].length < 200 && !/[<>]/.test(a[1])) { out.push(googleRecord(a)); return; }
    for (const x of a) walk(x, depth + 1);
  };
  walk(data, 0);
  return out;
}
// Schema check for a parsed Google record: a long numeric id, a plain-text title, and a list of place strings.
export function googleValid(g) {
  const why = [];
  if (!/^\d{10,}$/.test(String(g?.id || ''))) why.push('id');
  if (typeof g?.title !== 'string' || g.title.length < 4 || g.title.length > 200 || /[<>{}]|https?:/.test(g.title)) why.push('title');
  if (!Array.isArray(g?.locations) || g.locations.some(l => typeof l !== 'string')) why.push('locations');
  return { ok: !why.length, why };
}
function googleRecord(a) {
  const strings = [], arrays = [], stamps = [];
  const flat = (x, d) => { if (d > 5) return; if (typeof x === 'string') strings.push(x); else if (Array.isArray(x)) { arrays.push(x); if (x.length === 2 && Number.isInteger(x[0]) && x[0] > 1.5e9 && x[0] < 2.2e9) stamps.push(x[0]); x.forEach(y => flat(y, d + 1)); } };
  a.slice(2).forEach(x => flat(x, 0));
  const isPlace = t => typeof t === 'string' && t.length < 90 && !/[<>]|https?:/.test(t) && /^[A-Z][\w .'-]+(, [\w .'-]+){1,3}$/.test(t);
  const locations = [...new Set(arrays.filter(x => isPlace(x[0])).map(x => x[0]))].slice(0, 8);
  const text = htmlToText(strings.filter(t => /<\/?(p|li|ul|br|h\d)\b/i.test(t)).join('\n'));
  const company = strings.find(t => /^(Google|YouTube|Waymo|Mandiant|Fitbit|DeepMind|Google DeepMind|Google Cloud|Wing|Verily|X)$/.test(t)) || null;
  return { id: a[0], title: a[1], locations, text, company, ts: stamps.length ? new Date(Math.max(...stamps) * 1000).toISOString() : null };
}

// Pull `NAME = [ ... ]` out of an inline script, matching brackets while skipping string contents.
export function embeddedArray(html, name) {
  const at = String(html || '').search(new RegExp(name + '\\s*=\\s*\\['));
  if (at < 0) return null;
  const start = html.indexOf('[', at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}
// Detail pages are fetched only for non-broad categories (broad ones like software engineering get list data only).
const relevantTitle = t => { const c = classifyFunctions(t); return c.functions.some(f => !FUNCTIONS[f].broad) || c.eng_review; };
// US or unclear location: worth a detail request. Explicitly foreign ("Brazil - Remote", "Japan - Tokyo") is not.
const usText = s => classifyWorkplace({ locations: [String(s || '').replace(/---?/g, ', ')] }).us !== false;

// Find a Workday tenant's "United States" country facet in its own /jobs response. Facets can be nested
// (a location group holding a country facet), so walk the tree. Returns { [facetParameter]: [id] } or null.
export function workdayUSFacet(facets) {
  const walk = (list, param) => {
    for (const f of list || []) {
      const p = f.facetParameter || param;
      if (Array.isArray(f.values) && f.values.length) { const hit = walk(f.values, p); if (hit) return hit; }
      if (f.id && /^united states( of america)?$/i.test(String(f.descriptor || '').trim()) && /country|location/i.test(String(param || ''))) return { [param]: [f.id] };
    }
    return null;
  };
  return walk(facets, '');
}
export const ADAPTERS = {
  ...BASE,

  // Greenhouse plus the optional pay_transparency detail call for relevant jobs with no salary in text
  async greenhouse(src, emp, http, opt) {
    let out = await BASE.greenhouse(src, emp, http);
    // EU-hosted boards: if neither job-board API address answers, read the board's own public page
    // (job-boards.eu.greenhouse.io/<token>, the page job seekers browse) and its job pages instead.
    if (!['ok', 'empty'].includes(out.result) && src.board_url && /^https:\/\/job-boards(\.eu)?\.greenhouse\.io\/[^/]+\/?$/.test(src.board_url) && !/^http_4/.test(out.result)) {
      const token = src.board_url.replace(/\/$/, '').split('/').pop();
      const page = await ADAPTERS.company_html({ ...src, list_url: src.board_url.replace(/\/$/, ''), link_pattern: `^/${token}/jobs/\\d+$`, max_pages: 10, detail_cap: src.detail_cap }, emp, http, opt);
      if (['ok', 'partial'].includes(page.result)) {
        page.jobs.forEach(j => { j.ats = 'greenhouse'; });
        return { ...page, note: `job-board API unreachable (${out.note || out.result}); read the public board page instead: ${page.note}` };
      }
      out = { ...out, note: `${out.note}; public board page also failed (${page.result}: ${page.note})` };
    }
    if (out.result !== 'ok' || !opt.ghPayTransparency) return out;
    let n = 0;
    for (const j of out.jobs) {
      if (n >= opt.ghPayCap) break;
      if (!relevantTitle(j.title) || parseSalaries(j.desc_text).length) continue;
      n++;
      const r = await http.json(`https://${src._ghHost || (src.region === 'eu' ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io')}/v1/boards/${src.slug}/jobs/${j.ext_id}?pay_transparency=true`);
      const pr = r.ok && (r.data?.pay_input_ranges || []).find(p => !p.currency_type || /^usd$/i.test(p.currency_type)); // US-dollar range only
      if (pr && pr.min_cents) j.salary_struct = { min: pr.min_cents / 100, max: pr.max_cents / 100, period: 'year', kind: /base|salary/i.test((pr.title || '') + (pr.blurb || '')) ? 'base' : 'base_likely', src: 'structured', currency: pr.currency_type || null, snippet: `Greenhouse pay range: ${pr.title || ''}` };
    }
    out.note = n ? `pay_transparency checked for ${n} relevant jobs` : out.note;
    return out;
  },

  async smartrecruiters(src, emp, http, opt) {
    const company = src.company || src.slug;
    const seen = new Map();
    const queries = src.queries?.length ? src.queries : [''];
    let anyOk = false, lastFail = null;
    const U = inventoryUnits(), startedAt = (opt.now || new Date()).toISOString(), cap = src.max_results || opt.maxPerQuery;
    for (const q of queries) {
      let state = 'capped';
      for (let offset = 0; offset < cap; offset += 100) {
        const u = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=100&offset=${offset}` + (q ? `&q=${encodeURIComponent(q)}` : '') + (src.country ? `&country=${src.country}` : '');
        const r = await http.json(u);
        if (!r.ok) { lastFail = r; state = `page at ${offset} failed (${r.status || r.error})`; break; }
        anyOk = true;
        const list = r.data?.content || [];
        for (const p of list) { seen.set(p.id, p); U.saw(q || '*', p.id); }
        const total = Number(r.data?.totalFound);
        if (list.length < 100 || (Number.isFinite(total) && offset + 100 >= total)) { state = 'done'; break; }
      }
      if (state === 'done') U.done(q || '*', startedAt); else U.incomplete(q || '*', state === 'capped' ? `stopped at the ${cap}-result limit` : state);
    }
    if (!anyOk) return fail(lastFail || {});
    const jobs = [];
    let details = 0;
    for (const p of seen.values()) {
      const L = p.location || {};
      const j = { source_id: src.id, ats: 'smartrecruiters', employer: emp.employer, ext_id: p.id, req_id: p.refNumber || null, _units: U.of(p.id),
        title: p.name, url: `https://jobs.smartrecruiters.com/${company}/${p.id}`,
        locations: [L.fullLocation || [L.city, L.region, L.country].filter(Boolean).join(', ')].filter(Boolean),
        country: L.country || null, remote_hint: L.remote === true, workplace_hint: L.remote ? 'remote' : (L.hybrid ? 'hybrid' : null),
        department: p.department?.label || null, posted_at: iso(p.releasedDate), posted_kind: 'released', desc_text: '' };
      if (relevantTitle(j.title) && details < opt.detailCap) {
        details++;
        const d = await http.json(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${p.id}`);
        const sec = d.ok ? d.data?.jobAd?.sections || {} : {};
        j.desc_text = htmlToText([sec.jobDescription?.text, sec.qualifications?.text, sec.additionalInformation?.text].filter(Boolean).join('\n'));
      }
      jobs.push(j);
    }
    const inc = U.out().incomplete;
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, units: U.out(), note: `${seen.size} postings via ${queries.length} queries; ${details} detail pages${Object.keys(inc).length ? `; COVERAGE: ${Object.entries(inc).map(([k, v]) => `"${k === '*' ? 'all' : k}" ${v}`).join(', ')} (roles from those searches are kept, not closed)` : ''}`,
             fields: { posted_date: 'releasedDate', salary: 'detail text only', location: 'yes', remote: 'location.remote', req_id: 'refNumber' } };
  },

  async workable(src, emp, http) {
    const r = await http.json(`https://apply.workable.com/api/v1/widget/accounts/${src.slug}?details=true`);
    if (!r.ok) return fail(r);
    const list = r.data?.jobs || [];
    const jobs = list.map(j => ({ source_id: src.id, ats: 'workable', employer: emp.employer, ext_id: j.shortcode, title: j.title, url: j.url || j.application_url,
      locations: [[j.city, j.state, j.country].filter(Boolean).join(', ')].filter(Boolean), country: j.country || null,
      remote_hint: j.telecommuting === true, workplace_hint: j.telecommuting ? 'remote' : null,
      posted_at: iso(j.published_on || j.created_at), posted_kind: 'published', desc_text: htmlToText(j.description || '') }));
    return { result: jobs.length ? 'ok' : 'empty', status: r.status, jobs, fields: { posted_date: 'published_on', salary: 'text', location: 'yes', remote: 'telecommuting', req_id: 'no' } };
  },

  // BambooHR: a company's hosted careers page ({slug}.bamboohr.com/careers) loads its list from /careers/list
  // (JSON, no key). Description, posting date and pay sit on /careers/{id}/detail: read only for roles in a job
  // category, capped per run, and reused from earlier runs.
  async bamboohr(src, emp, http, opt = {}) {
    const base = `https://${src.slug}.bamboohr.com/careers`;
    const r = await http.json(`${base}/list`);
    if (!r.ok) return fail(r);
    const list = Array.isArray(r.data?.result) ? r.data.result : Array.isArray(r.data) ? r.data : null;
    if (!list) return { result: 'parse_error', status: r.status, jobs: [], note: 'No result array in /careers/list' };
    const prev = opt.prevBySource?.get(src.id) || new Map();
    let details = 0, reused = 0;
    const jobs = [];
    for (const p of list) {
      const L = p.location || p.atsLocation || {};
      const place = [L.city, L.state || L.province, L.country].map(x => String(x || '').trim()).filter(Boolean).join(', ');
      const remote = p.isRemote === true || /remote/i.test(p.locationType || '');
      const j = { source_id: src.id, ats: 'bamboohr', employer: emp.employer, ext_id: String(p.id), title: String(p.jobOpeningName || p.title || '').trim(), url: `${base}/${p.id}`,
        department: p.departmentLabel || null, locations: [place || (remote ? 'Remote' : '')].filter(Boolean), country: L.country || null,
        remote_hint: remote, workplace_hint: remote ? 'remote' : null, posted_kind: 'unknown', desc_text: '' };
      const pj = prev.get(j.ext_id);
      if (pj && !detailStale(pj, opt) && pj.title === j.title) { j.reuse = pj; reused++; jobs.push(j); continue; }
      if (relevantTitle(j.title) && details < (src.detail_cap || opt.detailCap || 40)) {
        details++;
        const d = await http.json(`${base}/${p.id}/detail`);
        const o = d.ok ? (d.data?.result?.jobOpening || d.data?.result || d.data || {}) : {};
        j.desc_text = htmlToText([o.description, o.compensation && `Compensation: ${o.compensation}`].filter(Boolean).join('\n'));
        if (o.datePosted) { j.posted_at = iso(o.datePosted); j.posted_kind = 'published'; }
      }
      jobs.push(j);
    }
    return { result: jobs.length ? 'ok' : 'empty', status: r.status, jobs, note: `${jobs.length} postings; ${details} detail pages read, ${reused} reused from earlier runs`,
      fields: { posted_date: 'detail datePosted (else first observed)', salary: 'detail compensation + text', location: 'yes', remote: 'isRemote', req_id: 'no' } };
  },

  // Comeet (Spark Hire Recruit): the public hosted board www.comeet.com/jobs/{slug}/{uid} embeds every
  // published position as COMPANY_POSITIONS_DATA. One page request per run; no token, no detail calls.
  // Comeet exposes only time_updated (no publish date), so posted_at stays empty and first-observed applies.
  async comeet(src, emp, http) {
    const board = src.board_url || `https://www.comeet.com/jobs/${src.slug}/${src.company_uid}`;
    const r = await http.text(board);
    if (!r.ok) return fail(r);
    const list = embeddedArray(r.data, 'COMPANY_POSITIONS_DATA');
    if (!Array.isArray(list)) return fail({ error: 'parse_error', detail: 'Comeet page without COMPANY_POSITIONS_DATA' });
    const jobs = list.filter(p => p && p.name && !p.is_talent_pool).map(p => {
      const L = p.location || {};
      const loc = L.name || [L.city, L.state, L.country].filter(Boolean).join(', ');
      const wt = String(p.workplace_type || '').toLowerCase();
      const details = (p.custom_fields?.details || p.details || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      const desc = htmlToText(details.map(d => `${d.name || ''}\n${d.value || ''}`).join('\n'));
      const j = { source_id: src.id, ats: 'comeet', employer: emp.employer, ext_id: p.uid, req_id: p.internal_use_custom_id || null,
        title: p.name, url: p.url_active_page || p.url_comeet_hosted_page || p.url_detected_page || `${board}/${encodeURIComponent((p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'))}/${p.uid}`,
        locations: loc ? [loc] : [], country: L.country || null,
        remote_hint: L.is_remote === true || wt === 'remote', workplace_hint: wt.includes('remote') ? 'remote' : wt.includes('hybrid') ? 'hybrid' : (wt.includes('site') || wt.includes('office')) ? 'onsite' : (L.is_remote ? 'remote' : null),
        department: p.department || null, posted_at: null, posted_kind: 'updated_only', updated_at: iso(p.time_updated), desc_text: desc };
      const sr = p.salary_range || p.salary;
      if (sr && Number(sr.min) > 0) j.salary_struct = { min: Number(sr.min), max: Number(sr.max) || Number(sr.min), period: 'year', kind: 'base_likely', src: 'structured', snippet: 'Comeet salary range' };
      return j;
    });
    return { result: jobs.length ? 'ok' : 'empty', status: r.status, jobs, note: `${jobs.length} published positions from the hosted board`,
             fields: { posted_date: 'time_updated only (first-observed date used)', salary: 'description text', location: 'location object', remote: 'workplace_type / is_remote', req_id: 'internal_use_custom_id' } };
  },

  // Google Careers (experimental): the public results page embeds its job list in an AF_initDataCallback 'ds:1'
  // block, 20 per page. Field positions aren't documented, so jobs are found by shape (long numeric id + title)
  // and fields by content. If the page doesn't match, the run reports what it saw instead of guessing.
  async google_careers(src, emp, http, opt) {
    // Inventory model: the full US list (location=United States, no keyword) is the primary source and is walked page
    // by page across runs from a saved checkpoint; a few keyword searches top up high-priority roles between passes.
    // Every record is schema-checked; a pass only counts as complete (and can close roles) if it reached the end
    // without refusals or parser failures.
    const base = 'https://www.google.com/about/careers/applications/jobs/results?hl=en_US&location=United%20States';
    const refused = r => [403, 429].includes(r?.status);
    const nowIso = (opt.now || new Date()).toISOString();
    const prevSt = opt.prevStatusById?.get(src.id) || {};
    const ck = JSON.parse(JSON.stringify(prevSt.checkpoint?.list ? prevSt.checkpoint : { list: { page: Number(prevSt.resume_offset) > 1 ? Number(prevSt.resume_offset) : 1 } }));
    const L = ck.list; L.page ||= 1;
    const PAGE = src.page_size || 20;
    const seen = new Map(); let pages = 0, lastFail = null, diag = '', cut = null;
    const chk = { records: 0, invalid: 0, noLoc: 0, noText: 0, badPages: 0 };
    const read = async url => {
      const r = await http.text(url);
      if (!r.ok) return { r };
      const block = afData(r.data, 'ds:1');
      if (!block) return { r, bad: `${r.data.length} bytes, AF_initDataCallback ${/AF_initDataCallback/.test(r.data) ? 'present but no ds:1 data' : 'absent'}` };
      const raw = googleJobs(block), found = [];
      for (const g of raw) {
        chk.records++;
        const v = googleValid(g);
        if (!v.ok) { chk.invalid++; continue; }
        if (!g.locations.length) chk.noLoc++;
        if (!g.text) chk.noText++;
        found.push(g);
      }
      const total = Array.isArray(block) && Number.isInteger(block[2]) && block[2] >= found.length ? block[2] : null;
      // a page whose records mostly fail the schema means the page layout changed: don't trust it
      const pageBad = raw.length > 0 && chk.invalid > 0 && (raw.length - found.length) / raw.length > 0.5;
      if (pageBad) chk.badPages++;
      pages++;
      return { r, found, rawN: raw.length, total, pageBad };
    };
    // 1) full US list from the checkpoint (one page of overlap when resuming, so roles shifted by new postings aren't skipped)
    let listPages = 0, newOnList = 0, shifted = 0, reachedEnd = false, earlyEnd = null;
    const budget = src.scan_pages_per_run || 45;
    if (src.full_scan) {
      let page = L.page > 1 ? L.page - 1 : 1;
      const overlapPage = L.page > 1 ? page : null; // already counted last run
      if (page === 1 && L.page === 1) { L.cycle_started = nowIso; L.cycle_bad = false; L.cycle_ids = 0; }
      let prevIds = null;
      while (listPages < budget) {
        const { r, found, rawN, total, pageBad, bad } = await read(`${base}&page=${page}`);
        if (!r.ok) { lastFail = r; if (refused(r)) cut = `full US list at page ${page}`; break; } // resumes at this page: no gap
        if (bad) { diag = `full US list page ${page}: ${bad}`; break; }
        listPages++;
        if (pageBad) L.cycle_bad = true;
        // page 1 of the whole US list can't be empty: a data block with no records there means the format changed
        if (page === 1 && !rawN) { diag = 'full US list page 1: data block present but no job records (format changed?)'; L.cycle_bad = true; break; }
        if (total) L.total = total;
        const ids = found.map(g => g.id);
        // some result pages repeat the last page instead of returning nothing: same ids as the previous page = end
        if (prevIds && ids.length && ids.every(id => prevIds.has(id))) { reachedEnd = true; break; }
        let fresh = 0;
        for (const g of found) { if (!seen.has(g.id)) { seen.set(g.id, g); fresh++; } else shifted++; }
        newOnList += fresh; if (page !== overlapPage) L.cycle_ids = (L.cycle_ids || 0) + found.length;
        prevIds = new Set(ids);
        if (rawN < PAGE) { reachedEnd = true; break; }
        page++;
      }
      if (reachedEnd) {
        // a pass that ends well short of the page's own total or of the last complete pass is not trusted for closures:
        // an empty page from a layout change would otherwise look like the end of the list
        const expected = L.total || ck.last_full_cycle_roles || 0;
        if (expected && (L.cycle_ids || 0) < 0.8 * expected) { L.cycle_bad = true; earlyEnd = `pass ended early (${L.cycle_ids || 0} rows vs about ${expected} expected), not used for closures`; }
        if (!L.cycle_bad && L.cycle_started) { ck.last_full_cycle_start = L.cycle_started; ck.last_full_cycle_end = nowIso; ck.last_full_cycle_roles = L.cycle_ids || newOnList; }
        L.last_pages = page; L.page = 1;
      } else if (!cut && !diag) L.page = page; // budget used up: resume here next run
      else L.page = Math.max(1, page);
    }
    // 2) a few high-priority searches (first page or two each), skipped once refused
    let searchPages = 0, searchNew = 0;
    if (!cut) search: for (const q of src.queries || []) {
      let lastIds = null;
      for (let page = 1; page <= (src.max_pages || 1); page++) {
        const { r, found, rawN, bad } = await read(`${base}&q=${encodeURIComponent(q)}&page=${page}`);
        if (!r.ok) { lastFail = r; if (refused(r)) { cut = `search "${q}"`; break search; } break; }
        if (bad) { diag ||= `search "${q}" page ${page}: ${bad}`; break; }
        searchPages++;
        // a page of already-seen roles doesn't mean later pages hold none; stop only at a short page or a repeated page
        let fresh = 0; for (const g of found) if (!seen.has(g.id)) { seen.set(g.id, g); fresh++; }
        searchNew += fresh;
        const ids = found.map(g => g.id).join();
        if (rawN < PAGE || (page > 1 && ids === lastIds)) break;
        lastIds = ids;
      }
    }
    ck.updated_at = nowIso;
    const invalidShare = chk.records ? chk.invalid / chk.records : 0;
    const parserNote = `parser check: ${chk.records} records, ${chk.invalid} failed the schema${chk.records ? ` (${Math.round(invalidShare * 100)}%)` : ''}, ${chk.noLoc} without a location, ${chk.noText} without description text${chk.badPages ? `; ${chk.badPages} page(s) mostly unreadable, so this pass can't close roles` : ''}`;
    if (!seen.size) {
      if (lastFail && !pages) return fail(lastFail, { note: `Google Careers refused or failed (${lastFail.status || lastFail.error}); previous roles kept.`, checkpoint: ck });
      // Google always has US openings: an HTTP 200 with no valid records is a parser failure, never "no jobs"
      return { result: pages ? 'parse_error' : 'experimental_failed', status: 200, jobs: [], checkpoint: ck, note: pages ? `${pages} pages read but no valid job records (${parserNote}${diag ? `; ${diag}` : ''}); previous roles kept` : `Google Careers page format not recognized: ${diag || 'no data block found'}; previous roles kept` };
    }
    const jobs = [...seen.values()].map(g => ({ source_id: src.id, ats: 'google_careers', employer: emp.employer, ext_id: g.id, title: g.title,
      url: `https://www.google.com/about/careers/applications/jobs/results/${g.id}-${g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      locations: g.locations, remote_hint: g.locations.some(l => /remote/i.test(l)), department: g.company && g.company !== 'Google' ? g.company : null,
      posted_at: null, posted_kind: g.ts ? 'updated_only' : 'unknown', updated_at: g.ts, desc_text: g.text }));
    const listState = !src.full_scan ? null : listPages
      ? `full US list: ${listPages} page${listPages === 1 ? '' : 's'} read${reachedEnd ? `, reached the end${L.cycle_bad ? ' (pass not clean, not used for closures)' : ' — pass complete'}` : `, next run resumes at page ${L.page} (one page of overlap)`}${L.total ? `; page reports ${L.total} US roles` : ''}`
      : 'full US list not read this run';
    const note = [`${jobs.length} roles from ${pages} result pages`, listState, `${searchPages} search pages (${(src.queries || []).length} priority searches) added ${searchNew} roles not on the list pages read`,
      shifted ? `${shifted} repeated rows across pages (listing shifted or overlap)` : null,
      ck.last_full_cycle_end ? `last complete US pass ${ck.last_full_cycle_end.slice(0, 10)} (${ck.last_full_cycle_roles} roles)` : 'no complete US pass yet, so nothing is closed',
      earlyEnd, parserNote, cut ? `REFUSED (${cut}: ${lastFail?.status}); stopped, progress saved` : null, diag || null, '(experimental parser)'].filter(Boolean).join('; ');
    const warn = invalidShare > 0.2 || chk.badPages > 0 || !!earlyEnd;
    return { result: cut ? 'partial' : warn ? 'partial' : 'ok', status: cut ? lastFail.status : 200, jobs, note, checkpoint: ck,
             resume_offset: !src.full_scan ? null : L.page, rotated: src.full_scan, close_before: !src.full_scan ? undefined : (ck.last_full_cycle_start || null),
             close_after_hours: !src.full_scan ? undefined : (src.close_after_hours || 96),
             fields: { posted_date: 'page timestamp treated as updated date; first-observed used', salary: 'description text (US base range is usually stated)', location: 'yes', remote: 'from location text', req_id: 'Google job id' } };
  },

  // Radancy / TalentBrew career sites (server-rendered, no JSON feed). Order: robots.txt check → sitemap job URLs
  // (fallback: /{lang}/search-jobs?p=N) → JobPosting JSON-LD on each relevant job page. Known postings are reused.
  async radancy(src, emp, http, opt) {
    const base = src.base.replace(/\/$/, ''), lang = src.lang || 'en';
    const refused = r => r.status === 429 || r.status === 403;
    const rb = await http.text(`${base}/robots.txt`);
    const rules = rb.ok ? robotsRules(rb.data) : { disallow: [], sitemaps: [] };
    const blocked = path => rules.disallow.some(d => d && path.startsWith(d));
    if (blocked(`/${lang}/job/`)) return { result: 'blocked_by_robots', status: 200, jobs: [], note: `robots.txt disallows /${lang}/job/ pages; not collected` };
    // 1) discover job URLs
    const found = new Map(); let via = '', lastFail = null, listGap = null;
    const addUrl = (u, title) => { const m = u.match(/\/job\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)/); if (m && !found.has(m[4])) found.set(m[4], { url: u.startsWith('http') ? u : base + u, slugTitle: title || m[2].replace(/-/g, ' '), slugCity: m[1].replace(/-/g, ' ') }); };
    for (const sm of (rules.sitemaps.length ? rules.sitemaps : [`${base}/sitemap.xml`]).slice(0, 3)) {
      const r = await http.text(sm); if (!r.ok) { lastFail = r; if (refused(r)) break; continue; }
      const locs = [...r.data.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
      const children = /<sitemapindex/i.test(r.data) ? locs.filter(l => /job/i.test(l)).slice(0, 10) : [];
      for (const c of children) { const cr = await http.text(c); if (cr.ok) for (const m of cr.data.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) addUrl(m[1]); else { listGap = `job sitemap ${c} failed (${cr.status || cr.error})`; if (refused(cr)) { lastFail = cr; break; } } }
      for (const l of locs) addUrl(l);
      if (found.size) { via = 'sitemap'; break; }
    }
    if (!found.size && !blocked(`/${lang}/search-jobs`)) {
      via = 'search pages';
      for (let p = 1; p <= (src.max_pages || 100); p++) {
        const r = await http.text(`${base}/${lang}/search-jobs?p=${p}`); if (!r.ok) { lastFail = r; if (p > 1) listGap = `search page ${p} failed (${r.status || r.error})`; break; }
        const before = found.size;
        for (const m of r.data.matchAll(/<a[^>]+href="([^"]*\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) addUrl(m[1], htmlToText(m[2]).split('\n')[0].trim() || null);
        if (found.size === before) break;
      }
    }
    if (!found.size) return lastFail ? fail(lastFail, { note: `Radancy ${base}: no job links found (${lastFail.status || lastFail.error})` }) : { result: 'empty', status: 200, jobs: [], note: `no job URLs in sitemap or search pages` };
    // 2) details from JSON-LD for relevant postings
    const prev = opt.prevBySource?.get(src.id) || new Map();
    const jobs = []; let details = 0, reused = 0, detailRefused = false;
    for (const [id, f] of found) {
      const j = { source_id: src.id, ats: 'radancy', employer: emp.employer, ext_id: id, title: titleCase(f.slugTitle), url: f.url, locations: [titleCase(f.slugCity)], posted_at: null, posted_kind: 'unknown', desc_text: '' };
      const pj = prev.get(id);
      if (pj && !detailStale(pj, opt) && pj.title) { j.title = pj.title; if (pj.excerpt || pj.posted_kind !== 'unknown') { j.reuse = pj; reused++; jobs.push(j); continue; } }
      if (relevantTitle(j.title) && !detailRefused && details < (src.detail_cap || opt.detailCap)) {
        details++;
        const r = await http.text(f.url);
        if (!r.ok) { if (refused(r)) detailRefused = true; jobs.push(j); continue; }
        const jp = jsonLdJob(r.data);
        if (jp) {
          j.title = htmlToText(jp.title || '') || j.title;
          j.desc_text = htmlToText(jp.description || '');
          const locs = [].concat(jp.jobLocation || []).map(l => [l?.address?.addressLocality, l?.address?.addressRegion, l?.address?.addressCountry?.name || l?.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean);
          if (locs.length) j.locations = locs;
          if (/telecommute/i.test(JSON.stringify(jp.jobLocationType || ''))) j.remote_hint = true;
          if (jp.datePosted) { j.posted_at = iso(jp.datePosted); j.posted_kind = 'json_ld_date_posted'; }
          j.req_id = jp.identifier?.value || jp.identifier || null;
          const bs = jp.baseSalary?.value; const unit = String(jp.baseSalary?.value?.unitText || '').toLowerCase();
          if (bs && Number(bs.minValue) > 0 && (!unit || unit === 'year')) j.salary_struct = { min: Number(bs.minValue), max: Number(bs.maxValue) || Number(bs.minValue), period: 'year', kind: 'base_likely', src: 'structured', snippet: 'JobPosting baseSalary' };
        }
      }
      jobs.push(j);
    }
    const partial = detailRefused || !!listGap;
    return { result: partial ? 'partial' : 'ok', status: 200, jobs,
      note: `${found.size} postings via ${via}; ${details} job pages read, ${reused} reused from earlier runs` + (detailRefused ? '; job-page reads refused part-way, the rest are read next run' : '') + (listGap ? `; listing incomplete (${listGap}): roles not seen are kept, not closed` : '') + (rules.crawlDelay ? `; robots crawl-delay ${rules.crawlDelay}s` : ''),
      fields: { posted_date: 'JSON-LD datePosted (job page)', salary: 'JSON-LD baseSalary or description text', location: 'JSON-LD jobLocation', remote: 'jobLocationType TELECOMMUTE', req_id: 'JSON-LD identifier' } };
  },

  // Avature-hosted careers sites (e.g. careers.ibm.com). Nothing is guessed: starting from a real job page (seed_url),
  // the search page is the link that page itself contains, the keyword field is read from the search form, and
  // paging follows the site's own next-page links. Job pages are read for JobPosting JSON-LD (title/location/date/pay).
  async avature(src, emp, http, opt) {
    const seed = new URL(src.seed_url), origin = seed.origin, refused = r => r.status === 429 || r.status === 403;
    const abs = h => { try { return new URL(h.replace(/&amp;/g, '&'), seed).href; } catch { return null; } };
    const rb = await http.text(`${origin}/robots.txt`);
    const rules = rb.ok ? robotsRules(rb.data) : { disallow: [], sitemaps: [] };
    const blocked = u => { const pth = new URL(u).pathname; return rules.disallow.some(d => d && pth.startsWith(d)); };
    if (blocked(seed.href)) return { result: 'blocked_by_robots', status: 200, jobs: [], note: `robots.txt disallows ${seed.pathname}; not collected` };
    const r0 = await http.text(seed.href);
    if (!r0.ok) return fail(r0, { note: `Avature ${origin}: the starting job page did not load (${r0.status || r0.error}). Replace seed_url with any live job link.` });
    const searchHref = [...r0.data.matchAll(/href="([^"]*SearchJobs[^"]*)"/gi)].map(m => abs(m[1])).find(Boolean);
    if (!searchHref) return { result: 'not_fetchable', status: 200, jobs: [], note: `Avature ${origin}: no link to the job search on the starting page; nothing guessed, not collected` };
    if (blocked(searchHref)) return { result: 'blocked_by_robots', status: 200, jobs: [], note: `robots.txt disallows the job search page; not collected` };
    // keyword field from the search form on the search page itself
    const rs = await http.text(searchHref);
    if (!rs.ok) return fail(rs, { note: `Avature ${origin}: search page refused (${rs.status || rs.error})` });
    const form = (rs.data.match(/<form[^>]*SearchJobs[\s\S]*?<\/form>/i) || [''])[0];
    const kw = (form.match(/<input[^>]*type="(?:text|search)"[^>]*name="([^"]+)"/i) || form.match(/<input[^>]*name="([^"]+)"[^>]*type="(?:text|search)"/i) || [])[1];
    const action = abs((form.match(/action="([^"]+)"/i) || [])[1] || searchHref);
    const found = new Map(); let pages = 0, lastFail = null, stopped = false, unit = '*';
    const U = inventoryUnits(), startedAt = (opt.now || new Date()).toISOString();
    const harvest = html => { const before = found.size;
      for (const m of html.matchAll(/<a[^>]+href="([^"]*JobDetail[^"]*?jobId=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) { U.saw(unit, m[2]); const t = htmlToText(m[3]).split('\n')[0].trim(); if (!found.has(m[2]) || (t && !found.get(m[2]).title)) found.set(m[2], { url: abs(m[1]), title: t || found.get(m[2])?.title || '' }); }
      for (const m of html.matchAll(/<a[^>]+href="([^"]*\/(?:JobDetail|FolderDetail)\/[^"]*?\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi)) { U.saw(unit, m[2]); const t = htmlToText(m[3]).split('\n')[0].trim(); if (!found.has(m[2])) found.set(m[2], { url: abs(m[1]), title: t }); }
      return found.size - before; };
    const nextOf = html => { const m = html.match(/<a[^>]+(?:rel="next"|aria-label="[^"]*next[^"]*"|class="[^"]*next[^"]*")[^>]*href="([^"]+)"/i) || html.match(/<a[^>]+href="([^"]+)"[^>]*(?:rel="next"|aria-label="[^"]*next[^"]*"|class="[^"]*next[^"]*")/i); return m ? abs(m[1]) : null; };
    const crawl = async (start, u0) => { let url = start, seen = new Set(), why = null; unit = u0;
      while (url && !seen.has(url)) {
        if (pages >= (src.max_pages || 40)) { why = 'page limit reached'; break; }
        seen.add(url); if (blocked(url)) { why = 'next page disallowed by robots.txt'; break; }
        const r = url === searchHref ? rs : await http.text(url); pages++;
        if (!r.ok) { lastFail = r; if (refused(r)) stopped = true; why = `page failed (${r.status || r.error})`; break; }
        harvest(r.data); url = nextOf(r.data); }
      if (why) U.incomplete(u0, why); else U.done(u0, startedAt); };
    const queries = kw && src.queries?.length ? src.queries : [null];
    for (const q of queries) { if (stopped) { U.incomplete(q ?? '*', 'not reached (refused earlier)'); continue; } if (q === null) await crawl(searchHref, '*'); else { const u = new URL(action); u.searchParams.set(kw, q); await crawl(u.href, q); } }
    if (!found.size) return lastFail ? fail(lastFail, { note: `Avature ${origin}: no job links found (${lastFail.status || lastFail.error})` }) : { result: 'empty', status: 200, jobs: [], note: `Avature ${origin}: search pages had no job links` };
    const prev = opt.prevBySource?.get(src.id) || new Map();
    const jobs = []; let details = 0, reused = 0, detailRefused = false;
    for (const [id, f] of found) {
      const j = { source_id: src.id, ats: 'avature', employer: emp.employer, ext_id: id, title: f.title, url: f.url, locations: [], posted_at: null, posted_kind: 'unknown', desc_text: '', _units: U.of(id) };
      const pj = prev.get(id);
      if (pj && !detailStale(pj, opt) && pj.title === f.title && (pj.excerpt || pj.posted_kind !== 'unknown')) { j.reuse = pj; reused++; jobs.push(j); continue; }
      if (relevantTitle(f.title) && !detailRefused && details < (src.detail_cap || opt.detailCap)) {
        details++;
        const r = await http.text(f.url);
        if (!r.ok) { if (refused(r)) detailRefused = true; jobs.push(j); continue; }
        const jp = jsonLdJob(r.data);
        if (jp) {
          j.title = htmlToText(jp.title || '') || j.title; j.desc_text = htmlToText(jp.description || '');
          const locs = [].concat(jp.jobLocation || []).map(l => [l?.address?.addressLocality, l?.address?.addressRegion, l?.address?.addressCountry?.name || l?.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean);
          if (locs.length) j.locations = locs;
          if (/telecommute/i.test(JSON.stringify(jp.jobLocationType || ''))) j.remote_hint = true;
          if (jp.datePosted) { j.posted_at = iso(jp.datePosted); j.posted_kind = 'json_ld_date_posted'; }
          const bs = jp.baseSalary?.value; const unit = String(jp.baseSalary?.value?.unitText || '').toLowerCase();
          if (bs && Number(bs.minValue) > 0 && (!unit || unit === 'year')) j.salary_struct = { min: Number(bs.minValue), max: Number(bs.maxValue) || Number(bs.minValue), period: 'year', kind: 'base_likely', src: 'structured', snippet: 'JSON-LD baseSalary' };
        } else { j.desc_text = htmlToText(r.data).slice(0, 6000); }
      }
      jobs.push(j);
    }
    const partial = stopped || detailRefused;
    return { result: partial ? 'partial' : 'ok', status: partial ? (lastFail?.status || 429) : 200, jobs, units: U.out(),
      note: `${found.size} postings from ${pages} search pages${kw ? ` (keyword field "${kw}", ${queries.length} searches)` : ' (no keyword field found: browsed all)'}; ${details} job pages read, ${reused} reused` + (partial ? '; refused part-way, the rest are read next run' : ''),
      fields: { posted_date: 'JSON-LD datePosted (job page)', salary: 'JSON-LD baseSalary or description text', location: 'JSON-LD jobLocation', remote: 'jobLocationType TELECOMMUTE', req_id: 'job id in the URL' } };
  },

  // Employer's own careers page (no ATS feed): robots check → links matching link_pattern on list_url → each job page.
  // Uses JobPosting JSON-LD when present, otherwise <h1> + page text. The URL is the stable id. Dates stay unknown
  // unless the page states them.
  async company_html(src, emp, http, opt) {
    const u = new URL(src.list_url), origin = u.origin;
    const rb = await http.text(`${origin}/robots.txt`);
    const rules = rb.ok ? robotsRules(rb.data) : { disallow: [] };
    if (rules.disallow.some(dp => u.pathname.startsWith(dp))) return { result: 'blocked_by_robots', status: 200, jobs: [], note: `robots.txt disallows ${u.pathname}` };
    const r = await http.text(src.list_url);
    if (!r.ok) return fail(r, { note: `careers page ${src.list_url}: ${r.status || r.error}` });
    // Follow the site's own next-page links (rel=next, aria-label/class "next"), up to max_pages. Never constructed.
    let pages = 1, listGap = null;
    { const nextOf = html => { const m = html.match(/<a[^>]+(?:rel="next"|aria-label="[^"]*next[^"]*"|class="[^"]*\bnext\b[^"]*")[^>]*href="([^"]+)"/i) || html.match(/<a[^>]+href="([^"]+)"[^>]*(?:rel="next"|aria-label="[^"]*next[^"]*"|class="[^"]*\bnext\b[^"]*")/i); if (!m) return null; try { const n = new URL(m[1].replace(/&amp;/g, '&'), src.list_url); return n.origin === origin ? n.href : null; } catch { return null; } };
      const seenP = new Set([src.list_url]); let nx = nextOf(r.data);
      while (nx && !seenP.has(nx)) {
        if (pages >= (src.max_pages || 10)) { listGap = `stopped at the ${src.max_pages || 10}-page limit with more pages listed`; break; }
        if (rules.disallow.some(dp => dp && new URL(nx).pathname.startsWith(dp))) { listGap = 'next page disallowed by robots.txt'; break; }
        seenP.add(nx); const rn = await http.text(nx);
        if (!rn.ok) { listGap = `page ${pages + 1} failed (${rn.status || rn.error})`; break; } // later pages unread: don't close their roles
        pages++; r.data += '\n' + rn.data; nx = nextOf(rn.data); } }
    const pat = new RegExp(src.link_pattern || '/careers/[^/?#"]+/?$');
    const links = new Map();
    // Query strings are kept (many sites identify a posting as ?jid=12345); the pattern may match the path or path+query.
    for (const m of r.data.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      let U; try { U = new URL(m[1].replace(/&amp;/g, '&'), src.list_url); } catch { continue; }
      const href = U.href.replace(/\/$/, '');
      if (href.startsWith(origin) && (pat.test(U.pathname) || pat.test(U.pathname + U.search)) && href !== src.list_url.replace(/\/$/, '') && !links.has(href)) links.set(href, htmlToText(m[2]).split('\n')[0].trim());
    }
    // No matching links is not evidence of zero jobs: the listing may be built by JavaScript or the link format may have changed.
    if (!links.size) return { result: 'no_links_found', status: 200, jobs: [], note: `page read, but no links matching ${pat} on ${src.list_url}; the listing may be rendered by JavaScript` };
    const prev = opt.prevBySource?.get(src.id) || new Map();
    const jobs = []; let details = 0, reused = 0;
    for (const [href, linkText] of links) {
      const HU = new URL(href), qid = [...HU.searchParams.values()].find(v => /^\d{3,}$/.test(v));
      const segs = HU.pathname.replace(/^\/|\/$/g, '').split('/');
      const id = qid || segs.find(x => /^\d{3,}$/.test(x)) || segs.pop();
      const j = { source_id: src.id, ats: 'company_html', employer: emp.employer, ext_id: id, title: linkText || titleCase(id.replace(/-/g, ' ')), url: href, locations: [], posted_at: null, posted_kind: 'unknown', desc_text: '' };
      const pj = prev.get(id);
      if (pj && !detailStale(pj, opt) && pj.title) { j.title = pj.title; j.reuse = pj; reused++; jobs.push(j); continue; }
      if (rules.disallow.some(dp => new URL(href).pathname.startsWith(dp)) || details >= (src.detail_cap || opt.detailCap)) { jobs.push(j); continue; }
      details++;
      const d = await http.text(href);
      if (d.ok) {
        const jp = jsonLdJob(d.data);
        if (jp) {
          j.title = htmlToText(jp.title || '') || j.title; j.desc_text = htmlToText(jp.description || '');
          const locs = [].concat(jp.jobLocation || []).map(l => [l?.address?.addressLocality, l?.address?.addressRegion, l?.address?.addressCountry?.name || l?.address?.addressCountry].filter(Boolean).join(', ')).filter(Boolean);
          if (locs.length) j.locations = locs;
          if (/telecommute/i.test(JSON.stringify(jp.jobLocationType || ''))) j.remote_hint = true;
          if (jp.datePosted) { j.posted_at = iso(jp.datePosted); j.posted_kind = 'json_ld_date_posted'; }
        } else {
          const h1 = d.data.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); if (h1) j.title = htmlToText(h1[1]).trim() || j.title;
          const main = d.data.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || d.data.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          j.desc_text = htmlToText((main ? main[1] : d.data).replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, '')).slice(0, 20000);
          const loc = j.desc_text.match(/\b(?:location|based in)\s*[:\-–]\s*([^\n]{3,80})/i); if (loc) j.locations = [loc[1].trim()];
          if (/\bremote\b/i.test(j.desc_text.slice(0, 600))) j.remote_hint = true;
        }
      }
      jobs.push(j);
    }
    return { result: listGap ? 'partial' : 'ok', status: 200, jobs, note: `${links.size} job links on ${pages} careers page${pages === 1 ? '' : 's'}; ${details} job pages read, ${reused} reused from earlier runs${listGap ? `; listing incomplete (${listGap}): roles not seen are kept, not closed` : ''}`,
             fields: { posted_date: 'JSON-LD datePosted if present, else unknown (first-observed used)', salary: 'page text', location: 'JSON-LD or "Location:" line', remote: 'page text', req_id: 'page URL' } };
  },

  // Workday CXS: the same JSON the public careers page calls. Search by function keywords, then
  // fetch details (exact startDate + description) only for relevant US roles.
  async workday(src, emp, http, opt) {
    const base = `https://${src.host}/wday/cxs/${src.tenant}/${src.site}`;
    const allQ = src.queries?.length ? src.queries : [''];
    // Rotation: sources with many searches run a different slice each run (full coverage every N runs).
    const nRot = allQ.length >= (opt.rotateMinQueries || 7) ? Math.max(1, opt.queryRotation || 1) : 1;
    const prevSt = opt.prevStatusById?.get(src.id);
    const nowIso = (opt.now || new Date()).toISOString();
    // A search refused part-way is resumed next run (same rotation slot, same search, same offset less one page of
    // overlap) instead of the rotation simply moving on and leaving that search's later pages unread.
    const pend = prevSt?.checkpoint?.pending && allQ.includes(prevSt.checkpoint.pending.q) ? prevSt.checkpoint.pending : null;
    const slot = pend ? pend.slot % nRot : (opt.runSeq || 0) % nRot;
    let queries = nRot > 1 ? allQ.filter((_, i) => i % nRot === slot) : allQ;
    if (pend && queries.includes(pend.q)) queries = [...queries.slice(queries.indexOf(pend.q)), ...queries.slice(0, queries.indexOf(pend.q))];
    const refused = r => r.status === 429 || r.status === 403;
    const seen = new Map(); let anyOk = false, lastFail = null, stoppedAt = null, resumeOffset = null, scanned = 0, capHit = [], pendingOut = null;
    let U = inventoryUnits();
    const maxPer = src.max_results || opt.workdayMaxPerQuery || opt.maxPerQuery;
    // US-only listing: the tenant's own "United States" country filter, read from its response (never guessed) and
    // saved in status, so later runs page through US postings only. Far fewer pages means far fewer 429s.
    let facets = src.us_only === false ? {} : (prevSt?.us_facet ?? null), usFacetNew = null; // {} = checked, none found
    const page = async (q, offset) => {
      const r = await http.json(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ appliedFacets: facets || {}, limit: 20, offset, searchText: q }) });
      if (!r.ok) return { r };
      anyOk = true; scanned++;
      if (facets === null) { // first page this tenant has ever returned: look for its US filter
        const f = workdayUSFacet(r.data?.facets); facets = f || {};
        if (f) { usFacetNew = f; seen.clear(); U = inventoryUnits(); return { r, restart: true }; } // re-ask with the filter applied
      }
      if (offset === 0 && Number(r.data?.total) >= 2000) capHit.push(q || '(all)'); // Workday stops paging at 2,000 results
      const list = r.data?.jobPostings || [];
      for (const p of list) if (p.externalPath) { seen.set(p.externalPath, p); U.saw(q || '*', p.externalPath.split('_').pop()); }
      const total = Number(r.data?.total);
      return { r, more: list.length === 20 && !(Number.isFinite(total) && total > 0 && offset + 20 >= total) };
    };
    const fullScan = queries.length === 1 && queries[0] === '';
    if (fullScan) {
      // Every listing, paged by 20. If refused part-way, the next run resumes from that page and wraps around.
      const start = facets === null ? 0 : Math.min(prevSt?.resume_offset || 0, maxPer); // filter not known yet: offsets may change, start at 0
      const ranges = start ? [[start, maxPer], [0, start]] : [[0, maxPer]];
      let why = null, ended = false;
      scan: for (const [from, to] of ranges) { for (let offset = from; offset < to; offset += 20) {
        const { r, more, restart } = await page('', offset);
        if (restart) { offset = -20; continue; } // filter found on page 1: start over US-only (offsets changed)
        if (!r.ok) { lastFail = r; why = `failed at ${offset} (${r.status || r.error})`; if (refused(r) && anyOk) { stoppedAt = 0; resumeOffset = offset; } break scan; }
        if (!more) { ended = true; break; }
      } }
      if (!why && ended && !start) U.done('*', nowIso); else U.incomplete('*', why || (start ? 'resumed mid-list' : `stopped at the ${maxPer}-result limit`));
    } else {
      search: for (const [qi, q] of queries.entries()) {
        const resumeHere = pend && pend.q === q && pend.slot % nRot === slot;
        const startedAt = resumeHere ? pend.started : nowIso;
        let state = 'capped', from = resumeHere ? Math.max(0, pend.offset - 20) : 0;
        for (let offset = from; offset < maxPer; offset += 20) {
          const { r, more, restart } = await page(q, offset);
          if (restart) { offset = -20; continue; }
          if (!r.ok) { lastFail = r; state = `failed at ${offset} (${r.status || r.error})`;
            if (refused(r)) { stoppedAt = qi; pendingOut = { slot, q, offset, started: startedAt }; U.incomplete(q || '*', state); for (const q2 of queries.slice(qi + 1)) U.incomplete(q2 || '*', 'not reached'); break search; }
            break; }
          if (!more) { state = 'done'; break; }
        }
        if (state === 'done') U.done(q || '*', startedAt);
        else U.incomplete(q || '*', state === 'capped' ? `stopped at the ${maxPer}-result limit` : state);
        if (!anyOk && lastFail) break; // first search failed outright: config is wrong or site is refusing
      }
    }
    if (!anyOk) {
      const why = refused(lastFail || {}) ? `refused (${lastFail.status}) before any results; previous roles kept. Retries after the Retry-After wait were exhausted.`
        : `${lastFail?.status || lastFail?.error}. A 404/422 usually means the tenant/site name is wrong; copy it from an Apply URL.`;
      return fail(lastFail || {}, { note: `Workday ${src.host}/${src.site}: ${why}` });
    }
    const prev = opt.prevBySource?.get(src.id) || new Map();
    const jobs = []; let details = 0, reused = 0, detailRefused = false;
    for (const p of seen.values()) {
      const approx = relativePosted(p.postedOn);
      const ext = p.externalPath.split('_').pop();
      const j = { source_id: src.id, ats: 'workday', employer: emp.employer, ext_id: ext, req_id: (p.bulletFields || [])[0] || null, _units: U.of(ext),
        title: p.title, url: `https://${src.host}/${src.site}${p.externalPath}`, locations: [p.locationsText].filter(Boolean),
        posted_at: approx ? approx + 'T12:00:00.000Z' : null, posted_kind: approx ? 'relative_approx' : 'unknown', posted_text: p.postedOn || null, desc_text: '' };
      const pj = prev.get(ext);
      const relevant = relevantTitle(p.title) && (usText(p.locationsText) || /locations/i.test(p.locationsText || ''));
      if (relevant && pj && !detailStale(pj, opt) && (pj.posted_kind === 'start_date' || pj.excerpt) && pj.title === p.title) { j.reuse = pj; reused++; } // already read: don't fetch again
      else if (relevant && !detailRefused && details < (opt.workdayDetailCap || opt.detailCap)) {
        details++;
        const d = await http.json(`${base}${p.externalPath}`);
        if (!d.ok && refused(d)) detailRefused = true; // stop detail reads; list data still counts
        const info = d.ok ? d.data?.jobPostingInfo : null;
        if (info) {
          j.desc_text = htmlToText(info.jobDescription || '');
          j.locations = [info.location, ...(info.additionalLocations || [])].filter(Boolean);
          j.req_id = info.jobReqId || j.req_id;
          if (info.startDate) { j.posted_at = iso(info.startDate); j.posted_kind = 'start_date'; }
          if (info.remoteType) j.workplace_hint = /remote/i.test(info.remoteType) ? 'remote' : /hybrid/i.test(info.remoteType) ? 'hybrid' : null;
          j.country = info.country?.alpha2Code || null;
          if (info.externalUrl) j.url = info.externalUrl;
        }
      }
      jobs.push(j);
    }
    const partial = stoppedAt !== null;
    const incU = Object.entries(U.out().incomplete).filter(([, v]) => /limit/.test(v)).map(([k]) => k === '*' ? 'all' : k);
    const note = [Object.keys(facets || {}).length ? 'US postings only (site filter)' : '', fullScan ? `${seen.size} postings from a full scan (${scanned} pages${resumeOffset !== null ? `, stopped at listing ${resumeOffset}; next run resumes there` : ''})`
        : `${seen.size} postings from ${partial ? `${stoppedAt} of ` : ''}${queries.length} searches` + (nRot > 1 ? ` (rotation ${slot + 1}/${nRot} of ${allQ.length} total)` : ''),
      `${details} detail pages read, ${reused} reused from earlier runs`,
      partial ? `refused (${lastFail.status}) part-way: results so far kept, unreached roles kept and marked not refreshed` : '',
      detailRefused ? 'detail reads stopped after a refusal' : '',
      pendingOut ? `next run resumes "${pendingOut.q || 'all'}" at ${pendingOut.offset}` : '',
      incU.length ? `COVERAGE: ${incU.join(', ')} hit the ${maxPer}-result limit before the end; roles past it are unread and nothing from those searches is closed` : '',
      capHit.length ? `WARNING: ${capHit.join(', ')} matched 2,000+ listings, Workday's paging limit; postings past 2,000 are unreachable. Narrow the search terms or split by location/job-family facets copied from the site` : ''].filter(Boolean).join('; ');
    return { result: partial ? 'partial' : jobs.length ? 'ok' : 'empty', status: partial ? lastFail.status : 200, jobs, rotated: true, units: U.out(),
             checkpoint: { ...(prevSt?.checkpoint || {}), pending: pendingOut, updated_at: nowIso }, resume_offset: resumeOffset, us_facet: facets, note,
             fields: { posted_date: 'list: relative ("Posted 3 Days Ago"); detail: startDate', salary: 'detail description text', location: 'yes', remote: 'detail remoteType (if tenant sets it)', req_id: 'yes' } };
  },

  async amazon(src, emp, http, opt) {
    const seen = new Map(); let anyOk = false, lastFail = null;
    for (const q of src.queries || ['']) {
      for (let offset = 0; offset < opt.maxPerQuery; offset += 100) {
        const u = `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q)}&normalized_country_code%5B%5D=${src.country || 'USA'}&result_limit=100&offset=${offset}&sort=recent`;
        const r = await http.json(u);
        if (!r.ok) { lastFail = r; break; }
        anyOk = true;
        const list = r.data?.jobs || [];
        for (const p of list) seen.set(p.id_icims || p.id, p);
        if (list.length < 100) break;
      }
      if (!anyOk && lastFail) break;
    }
    // full US list, a chunk per run, resuming where the last run stopped (every posting is covered every few runs)
    let resume = null, scanned = 0, scanFrom = null, wrapped = false, cut = null, rows = 0, cyc = null;
    const prevStA = opt.prevStatusById?.get(src.id);
    if (src.full_scan && (anyOk || !lastFail)) {
      scanFrom = Number(prevStA?.resume_offset) || 0;
      let offset = scanFrom ? Math.max(0, scanFrom - 100) : 0; // one page of overlap when resuming: removals shift rows up
      while (scanned < (src.scan_pages_per_run || 40)) {
        const r = await http.json(`https://www.amazon.jobs/en/search.json?base_query=&normalized_country_code%5B%5D=${src.country || 'USA'}&result_limit=100&offset=${offset}&sort=recent`);
        if (!r.ok) { lastFail = r; resume = Math.max(offset, scanFrom); if ([403, 429].includes(r.status)) cut = offset; break; }
        anyOk = true; scanned++;
        const list = r.data?.jobs || [];
        for (const p of list) seen.set(p.id_icims || p.id, p);
        if (offset >= scanFrom) rows += list.length;
        if (list.length < 100) { resume = 0; wrapped = true; break; }
        offset += 100; resume = offset;
      }
      if (scanned) cyc = sweepCycle(prevStA?.checkpoint, { nowIso: (opt.now || new Date()).toISOString(), fromStart: scanFrom === 0, wrapped, rows });
    }
    if (!anyOk) return fail(lastFail || {}, { resume_offset: opt.prevStatusById?.get(src.id)?.resume_offset ?? null });
    const ckA = cyc?.ck || prevStA?.checkpoint || {};
    const scanNote = src.full_scan ? (scanned ? `; full US list: ${scanned} pages from ${scanFrom}${wrapped ? `, reached the end${cyc?.early ? ` (${cyc.early})` : ' — pass complete'}; next run starts over` : `, next run resumes at ${resume}`}` : '; full US list not read this run') + (cut != null ? ` (refused at ${cut}: ${lastFail?.status})` : '')
      + (ckA.last_full_cycle_end ? `; last complete pass ${ckA.last_full_cycle_end.slice(0, 10)} (${ckA.last_full_cycle_rows} rows)` : '; no complete pass yet, so nothing is closed') : '';
    const jobs = [...seen.values()].map(p => ({ source_id: src.id, ats: 'amazon', employer: /amazon-web-services/i.test(p.business_category || '') ? 'Amazon / AWS (AWS)' : 'Amazon / AWS',
      ext_id: String(p.id_icims || p.id), req_id: String(p.id_icims || ''), title: p.title, url: `https://www.amazon.jobs${p.job_path || ''}`,
      locations: [p.normalized_location || p.location].filter(Boolean), country: p.country_code === 'USA' ? 'US' : p.country_code,
      department: [p.business_category, p.job_category].filter(Boolean).join(' / ') || null,
      posted_at: iso(p.posted_date), posted_kind: 'posted_date', _path: p.job_path || null,
      desc_text: htmlToText([p.description, p.basic_qualifications, p.preferred_qualifications].filter(Boolean).join('\n')) }));
    // The pay statement ("The base salary range … is listed below. USA, NY, New York - 169,000.00 - 228,600.00 USD annually")
    // sits after the qualifications on the job page. When the search data doesn't carry it, read the posting's own page for
    // relevant roles, a capped number per run, and remember the check so a role without pay isn't re-read every run.
    const prevA = opt.prevBySource?.get(src.id) || new Map();
    const nowA = opt.now || new Date();
    let payPages = 0, payFound = 0, payReused = 0;
    for (const j of jobs) {
      const pj = prevA.get(j.ext_id);
      if (chooseSalary(parseSalaries(j.desc_text))) continue;
      if (!relevantTitle(j.title)) continue;
      if (pj?.salary && pj.title === j.title && !detailStale(pj, opt)) { j.salary_struct = { ...pj.salary, src: 'earlier page read' }; payReused++; continue; }
      if (pj?.pay_checked_at && (nowA - new Date(pj.pay_checked_at)) / 864e5 < 14) { j.pay_checked_at = pj.pay_checked_at; continue; }
      if (!j._path || payPages >= (src.pay_page_cap ?? 40)) continue;
      payPages++;
      const r = await http.text(`https://www.amazon.jobs${j._path}`);
      if (!r.ok) { if ([403, 429].includes(r.status)) break; continue; }
      const text = htmlToText(r.data);
      const at = text.search(/base (salary|pay) (range|for this position)/i);
      if (at >= 0) { j.desc_text += '\n' + text.slice(at, at + 1500); if (chooseSalary(parseSalaries(j.desc_text))) payFound++; }
      j.pay_checked_at = nowA.toISOString();
    }
    for (const j of jobs) delete j._path;
    return { result: cut != null ? 'partial' : jobs.length ? 'ok' : 'empty', status: cut != null ? lastFail.status : 200, jobs, note: `${jobs.length} US postings via keyword searches${scanNote}; pay: ${payPages} job pages read for the pay statement (${payFound} found), ${payReused} reused`,
             resume_offset: src.full_scan ? resume ?? scanFrom : null, rotated: !!src.full_scan, close_after_hours: src.full_scan ? (src.close_after_hours || 96) : undefined,
             checkpoint: src.full_scan ? ckA : undefined, close_before: src.full_scan ? (ckA.last_full_cycle_start || null) : undefined,
             fields: { posted_date: 'posted_date', salary: 'pay statement in qualification text (geo range)', location: 'yes', remote: 'text only', req_id: 'id_icims' } };
  },

  // Cisco careers runs on Phenom: search pages embed the results as JSON (phApp.ddo → eagerLoadRefineSearch.data.jobs).
  // Falls back to the older jobs.cisco.com results table if that's what comes back.
  async cisco_rss(src, emp, http, opt) {
    const phenom = await ADAPTERS.phenom({ ...src, base: src.phenom_base || 'https://careers.cisco.com/global/en' }, emp, http, opt);
    if (phenom.result === 'ok' || phenom.result === 'empty') return phenom;
    const seen = new Map(); let anyOk = false, lastFail = null, shapeMiss = 0;
    const U = inventoryUnits(), startedAt = (opt.now || new Date()).toISOString();
    void phenom;
    const cell = h => htmlToText(h).replace(/\s+/g, ' ').trim();
    for (const q of src.queries || []) {
      const r = await http.text(src.feed_url_template.replace('{q}', encodeURIComponent(q)));
      if (!r.ok) { lastFail = r; U.incomplete(q, `failed (${r.status || r.error})`); if (!anyOk && r.status === 404) break; continue; }
      const rows = [...r.data.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
      let got = 0;
      for (const row of rows) {
        const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
        const a = row.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (tds.length < 4 || !a) continue;
        const href = a[1].replace(/&amp;/g, '&');
        const url = href.startsWith('http') ? href : 'https://jobs.cisco.com' + (href.startsWith('/') ? '' : '/') + href;
        const id = (url.match(/(\d{5,})(?!.*\d{5,})/) || [url])[1] || url;
        const loc = cell(tds[3]), alt = tds[4] ? cell(tds[4]) : '';
        seen.set(id, { id, title: cell(a[2]) || cell(tds[0]), url, area: cell(tds[1]), locs: [loc, ...alt.split(/[;|]/).map(x => x.trim())].filter(Boolean) });
        U.saw(q, id); got++;
      }
      // the table shows the first 25 results only: a full table may hide more, so only a shorter one is complete
      if (got && got < 25) U.done(q, startedAt); else U.incomplete(q, got ? 'first 25 results only' : 'no rows');
      if (got) anyOk = true; else { shapeMiss++; lastFail = { error: 'parse_error', detail: 'No job rows found in the results table: ' + htmlToText(r.data).slice(0, 120) }; }
    }
    if (!anyOk) return fail(lastFail || {});
    const jobs = []; let details = 0;
    for (const p of seen.values()) {
      const j = { source_id: src.id, ats: 'cisco', employer: emp.employer, ext_id: p.id, req_id: p.id, title: p.title, url: p.url, _units: U.of(p.id),
        locations: p.locs, department: p.area || null, posted_at: null, posted_kind: 'unknown', desc_text: '' };
      if (relevantTitle(p.title) && (usText(p.locs.join(' ')) || !p.locs.length) && details < opt.detailCap) {
        details++;
        const d = await http.text(p.url);
        if (d.ok) j.desc_text = htmlToText(d.data).slice(0, 12000);
      }
      jobs.push(j);
    }
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, units: U.out(), note: `${seen.size} postings from ${(src.queries || []).length} searches (first 25 results each; full tables can't close roles); ${details} detail pages${shapeMiss ? `; ${shapeMiss} searches returned no rows` : ''}`,
             fields: { posted_date: 'not shown (first-observed date used)', salary: 'detail page text', location: 'table column', remote: 'location text', req_id: 'URL id' } };
  },

  async phenom(src, emp, http, opt) {
    const seen = new Map(); let anyOk = false, lastFail = null;
    const U = inventoryUnits(), startedAt = (opt.now || new Date()).toISOString();
    const grab = html => { const m = html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*phApp\./) || html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*<\/script>/); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } };
    const capN = src.max_per_query || opt.phenomMaxPerQuery || 30;
    for (const q of src.queries || ['']) {
      let state = `stopped at the ${capN}-result limit`;
      for (let from = 0; from < capN; from += 10) {
        const r = await http.text(`${src.base}/search-results?keywords=${encodeURIComponent(q)}&from=${from}&s=1`);
        if (!r.ok) { lastFail = r; state = `page at ${from} failed (${r.status || r.error})`; break; }
        const ddo = grab(r.data); const block = ddo?.eagerLoadRefineSearch; const list = block?.data?.jobs;
        if (!Array.isArray(list)) { lastFail = { error: 'parse_error', detail: 'Phenom page without eagerLoadRefineSearch.data.jobs' }; state = 'page not readable'; break; }
        anyOk = true; for (const j of list) { const id = String(j.jobSeqNo || j.jobId || j.reqId); seen.set(id, j); U.saw(q || '*', id); }
        if (list.length < 10 || from + 10 >= (block.totalHits || 0)) { state = 'done'; break; }
      }
      if (state === 'done') U.done(q || '*', startedAt); else U.incomplete(q || '*', state);
      if (!anyOk && lastFail) break;
    }
    if (!anyOk) return fail(lastFail || {});
    const jobs = []; let details = 0;
    for (const p of seen.values()) {
      const locs = (p.multi_location?.length ? p.multi_location : [p.location || p.cityStateCountry]).filter(Boolean);
      const url = p.applyUrl && !/apply/i.test(p.applyUrl.split('?')[0].split('/').pop() || '') ? p.applyUrl : `${src.base}/job/${p.jobId || p.jobSeqNo}`;
      const j = { source_id: src.id, ats: 'phenom', employer: emp.employer, ext_id: String(p.jobSeqNo || p.jobId || p.reqId), req_id: p.reqId || p.jobId || null, title: p.title, _units: U.of(String(p.jobSeqNo || p.jobId || p.reqId)),
        url, locations: locs, department: p.category || null, workplace_hint: /remote/i.test(p.workSiteFlexibility || p.type || '') ? 'remote' : null,
        posted_at: p.postedDate ? new Date(p.postedDate).toISOString() : null, posted_kind: p.postedDate ? 'posted_date' : 'unknown', desc_text: htmlToText(p.descriptionTeaser || '') };
      if (relevantTitle(p.title) && (usText(locs.join(' ')) || !locs.length) && details < opt.detailCap) {
        details++;
        const d = await http.text(`${src.base}/job/${p.jobId || p.jobSeqNo}`);
        const dd = d.ok ? grab(d.data)?.jobDetail?.data?.job : null;
        if (dd?.description) j.desc_text = htmlToText(dd.description);
      }
      jobs.push(j);
    }
    const capped = Object.keys(U.out().incomplete).length;
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, units: U.out(), note: `${seen.size} postings via Phenom search; ${details} detail pages${capped ? `; ${capped} of ${(src.queries || ['']).length} searches not read to the end (result limit or failed page): their roles are kept, not closed` : ''}`,
      fields: { posted_date: 'postedDate', salary: 'detail description', location: 'location / multi_location', remote: 'work-site flags', req_id: 'reqId' } };
  },

  // Eightfold (Microsoft). Microsoft's host starts refusing (429) after roughly 15 requests even at 7-12s spacing, so the
  // reader works incrementally under a per-run request budget instead of trying to cover everything in one run:
  //   - searches are filtered to the US on the server (location=), with a fallback if the filter returns nothing
  //   - breadth-first: one page from each search per round, the searches checked longest ago first
  //   - each search and the full US list ("*") keep their own checkpoint (offset, count, last scan, complete)
  //   - discovery and detail reads are budgeted separately; details only for new roles in a job category
  //   - a refusal stops the source for this run; all checkpoints are kept and work resumes next run
  //   - roles close only after a complete pass of the US list has finished since they were last seen
  async eightfold(src, emp, http, opt) {
    const host = `https://${src.host}`, D = encodeURIComponent(src.domain);
    const refused = r => [403, 429].includes(r?.status);
    const nowIso = (opt.now || new Date()).toISOString();
    const prevSt = opt.prevStatusById?.get(src.id) || {};
    const ck = JSON.parse(JSON.stringify(prevSt.checkpoint?.units ? prevSt.checkpoint : { units: {} }));
    let location = src.location ?? 'United States';
    if (ck.location_ok === false) location = '';
    const seen = new Map(); let anyOk = false, lastFail = null, cut = null, pagesRun = 0, total = null, locNote = null, filterSeen = 0, filterLeak = 0;
    const OVERLAP = src.page_overlap ?? 2; // re-read a couple of rows when resuming a saved offset, so roles shifted by new postings aren't skipped
    const touched = new Set();
    const searchBudget = src.search_budget ?? 5, listBudget = src.list_budget ?? 6, detailBudget = src.detail_budget ?? 3;
    const page = async (q, start) => {
      const url = loc => `${host}/api/pcsx/search?domain=${D}&query=${encodeURIComponent(q)}&location=${encodeURIComponent(loc)}&start=${start}&num=10`;
      let r = await http.json(url(location));
      let data = r.ok ? (r.data?.data || {}) : {};
      // a location filter that errors (not a refusal) or matches nothing on the broad list is treated as a wrong filter,
      // not as "no US jobs": fall back to unfiltered paging (US still decided locally) and remember it
      const badFilter = location && q === '' && ((!r.ok && !refused(r)) || (r.ok && Number(data.count) === 0));
      if (badFilter) {
        pagesRun++;
        const r2 = await http.json(url(''));
        if (r2.ok && Number(r2.data?.data?.count) > 0) {
          locNote = `location filter "${location}" ${r.ok ? 'matched nothing' : `failed (${r.status || r.error})`}; reading the unfiltered list instead (US decided locally)`;
          location = ''; ck.location_ok = false; r = r2; data = r2.data.data;
          Object.assign(unitOf('*'), { offset: 0, count: null, complete: false, cycle_started: nowIso }); start = 0;
        } else if (!r2.ok) r = r2;
      }
      if (!r.ok) return { r };
      const list = data.positions;
      if (!Array.isArray(list)) return { r: { ok: false, error: 'parse_error', detail: 'No data.positions in response' } };
      anyOk = true; pagesRun++; if (data.count != null && q === '') total = Number(data.count);
      for (const p of list) seen.set(String(p.id), p);
      if (location) for (const p of list) { const ls = [...(p.standardizedLocations || []), ...(p.locations || [])].map(l => typeof l === 'string' ? l : (l?.name || '')).join(' | '); filterSeen++; if (ls && !usText(ls) && !/remote|multiple/i.test(ls)) filterLeak++; }
      return { r, list, count: Number(data.count ?? Infinity), start };
    };
    const unitOf = k => (ck.units[k] ||= { offset: 0, count: null, last_scan: null, complete: false });
    const step = async (k) => { // one page of one unit; returns false when the source must stop
      const u = unitOf(k), q = k === '*' ? '' : k;
      if (u.offset === 0 && k === '*') { u.cycle_started = nowIso; u.cycle_bad = false; }
      const from = !touched.has(k) && u.offset > 0 ? Math.max(0, u.offset - OVERLAP) : u.offset; touched.add(k);
      const { r, list, count, start: used } = await page(q, from);
      if (used === 0 && from > 0) { u.offset = 0; if (k === '*') u.cycle_started = nowIso; } // filter fell back: restart this list
      if (!r.ok) { lastFail = r; if (refused(r)) { cut = `${k === '*' ? 'full US list' : `search "${k}"`} at ${u.offset}`; return false; } u.error = r.error || r.status; return true; }
      u.last_scan = nowIso; u.count = Number.isFinite(count) ? count : u.count; delete u.error;
      const next = (used ?? u.offset) + list.length;
      // an empty page before the reported count is reached ends this pass, but such a pass can't close roles
      if (!list.length && (used ?? u.offset) < count && Number.isFinite(count)) u.cycle_bad = true;
      if (!list.length || next >= count) { u.complete = true; u.offset = 0; if (k === '*' && !u.cycle_bad && u.cycle_started) { ck.last_full_cycle_start = u.cycle_started; ck.last_full_cycle_end = nowIso; } }
      else { u.complete = false; u.offset = next; }
      return 'page';
    };
    // 1) full US list first (it decides closures), then keyword searches breadth-first, oldest first
    let listPages = 0, searchPages = 0;
    while (listPages < listBudget && !cut) { const r = await step('*'); if (!r) break; listPages++; if (unitOf('*').offset === 0) break; }
    const queries = [...(src.queries || [])].sort((x, y) => String(unitOf(x).last_scan || '').localeCompare(String(unitOf(y).last_scan || '')));
    const done = new Set();
    while (searchPages < searchBudget && !cut && done.size < queries.length) {
      for (const q of queries) {
        if (searchPages >= searchBudget || cut) break;
        if (done.has(q)) continue;
        const r = await step(q); if (!r) break;
        searchPages++;
        if (unitOf(q).offset === 0) done.add(q); // reached the end of this search for now
      }
      if (!queries.length) break;
    }
    ck.updated_at = nowIso;
    if (!anyOk) return fail(lastFail || {}, { checkpoint: ck });
    const ts = v => v ? new Date((v > 1e12 ? v : v * 1000)).toISOString() : null;
    const prev = opt.prevBySource?.get(src.id) || new Map();
    const jobs = []; let details = 0, reused = 0, detailRefused = false, skippedNonUS = 0;
    // new roles take the detail budget first, then roles whose stored details are due a refresh
    for (const p of [...seen.values()].sort((a, b) => (prev.has(String(a.id)) ? 1 : 0) - (prev.has(String(b.id)) ? 1 : 0))) {
      const locs = ((p.standardizedLocations?.length ? p.standardizedLocations : p.locations) || []).map(l => typeof l === 'string' ? l : (l.name || l.location || '')).filter(Boolean);
      const allLocs = [...new Set([...locs, ...((p.locations || []).map(l => typeof l === 'string' ? l : (l.name || '')))])].filter(Boolean);
      // keep: any US location, no location, or a remote / multi-location posting that doesn't name a country yet
      const ambiguous = !allLocs.length || allLocs.some(l => /remote|multiple locations/i.test(l) && !/,\s*[A-Z][a-z]{3,}$/.test(l));
      if (!usText(allLocs.join(' | ')) && !ambiguous) { skippedNonUS++; continue; }
      const wlo = String(p.workLocationOption || '');
      const j = { source_id: src.id, ats: 'eightfold', employer: emp.employer, ext_id: String(p.id), req_id: p.displayJobId || null, title: p.name,
        url: p.positionUrl ? (p.positionUrl.startsWith('http') ? p.positionUrl : host + p.positionUrl) : `${host}/careers/job/${p.id}`,
        locations: allLocs, department: p.department || null,
        // the listing's work-site field has labelled remote roles as onsite: trust only remote/hybrid here, the detail record decides
        workplace_hint: /remote/i.test(wlo) ? 'remote' : /hybrid|flex/i.test(wlo) ? 'hybrid' : null,
        posted_at: ts(p.postedTs), posted_kind: p.postedTs ? 'posted_ts' : 'unknown', created_at: ts(p.creationTs), desc_text: '' };
      if (!j.posted_at && j.created_at) { j.posted_at = j.created_at; j.posted_kind = 'creation_ts (may predate public posting)'; }
      const pj = prev.get(j.ext_id);
      if (pj && !detailStale(pj, opt) && pj.title === j.title && (!relevantTitle(p.name) || pj.excerpt)) { j.reuse = pj; reused++; jobs.push(j); continue; } // already known: no detail fetch
      if (!detailRefused && !cut && relevantTitle(p.name) && details < detailBudget) {
        details++;
        const d = await http.json(`${host}/api/pcsx/position_details?domain=${D}&position_id=${encodeURIComponent(p.id)}&hl=en`);
        const dd = d.ok ? d.data?.data : null;
        if (dd) {
          const site = dd.efcustomTextWorkSite || '';
          j.desc_text = htmlToText(dd.jobDescription || '') + (site ? `\nWork site: ${site}` : '');
          if (site) j.workplace_hint = /100%|fully remote|remote/i.test(site) ? 'remote' : /up to \d+%|hybrid|flex/i.test(site) ? 'hybrid' : /on-?site|0%/i.test(site) ? 'onsite' : j.workplace_hint;
        } else if (refused(d)) detailRefused = true; // stop reading details this run; the rest are read next run
      }
      jobs.push(j);
    }
    const partial = !!cut;
    const U = ck.units['*'] || {};
    const listState = U.count != null ? `full US list: ${listPages} page${listPages === 1 ? '' : 's'} read, ${U.complete && U.offset === 0 ? `pass complete (${U.count} roles)` : `at ${U.offset} of ${U.count}`}` : `full US list: ${listPages} pages read`;
    const qDone = (src.queries || []).filter(q => ck.units[q]?.last_scan === nowIso).length;
    if (location && filterSeen >= 10 && filterLeak / filterSeen > 0.5) locNote = `location filter "${location}" seems ignored (${filterLeak} of ${filterSeen} listed roles outside the US); US decided locally`;
    else if (location && filterSeen) locNote ||= `server-side location filter "${location}" in use (${filterLeak} of ${filterSeen} listed roles outside the US)`;
    const note = [`${seen.size} positions listed from ${pagesRun} requests (${listPages} list, ${searchPages} search, budget ${listBudget}+${searchBudget})`, locNote,
      listState, `${qDone} of ${(src.queries || []).length} searches refreshed this run (oldest first)`,
      ck.last_full_cycle_end ? `last complete US pass finished ${ck.last_full_cycle_end.slice(0, 10)}` : 'no complete US pass yet, so nothing is closed',
      `${jobs.length} kept as US or location-unclear, ${skippedNonUS} outside the US skipped`,
      `${details} detail records read (budget ${detailBudget}), ${reused} reused`,
      cut ? `REFUSED (${cut}: ${lastFail?.status}) on request ${pagesRun + details + 1} of this run${lastFail?.retryAfter ? `, Retry-After ${lastFail.retryAfter}` : ', no Retry-After given'}; stopped for this run, progress saved, roles not reached are kept` : null,
      detailRefused ? 'detail reads refused; the rest are read next run' : null].filter(Boolean).join('; ');
    return { result: partial ? 'partial' : jobs.length ? 'ok' : 'empty', status: partial ? lastFail.status : 200, jobs, note, checkpoint: ck,
      rotated: true, close_before: ck.last_full_cycle_start || null, close_after_hours: src.close_after_hours || 336,
      fields: { posted_date: 'postedTs (creationTs kept separately)', salary: 'position_details jobDescription', location: 'standardizedLocations + locations (US decided locally)', remote: 'efcustomTextWorkSite (detail); listing flag used only for remote/hybrid', req_id: 'displayJobId' } };
  },

  async oracle_hcm(src, emp, http, opt) {
    const seen = new Map(); let anyOk = false, lastFail = null;
    const refused = r => [403, 429].includes(r?.status);
    const page = async (q, offset) => {
      const finder = `findReqs;siteNumber=${src.site},limit=50,${q ? `keyword=%22${encodeURIComponent(q)}%22,` : ''}sortBy=POSTING_DATES_DESC,offset=${offset}`;
      const r = await http.json(`https://${src.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`);
      if (!r.ok) return { r, list: [] };
      anyOk = true;
      const it = r.data?.items?.[0] || {}, list = it.requisitionList || [];
      for (const p of list) seen.set(String(p.Id), p);
      return { r, list, total: Number(it.TotalJobsCount ?? NaN) };
    };
    let cut = null;
    search: for (const q of src.queries || []) {
      for (let offset = 0; offset < (src.max_per_query || opt.maxPerQuery); offset += 50) {
        const { r, list, total } = await page(q, offset);
        if (!r.ok) { lastFail = r; if (refused(r)) { cut = `search "${q}"`; break search; } if (!anyOk) break search; break; }
        if (list.length < 50 || offset + 50 >= total) break;
      }
    }
    let resume = null, scanned = 0, scanFrom = null, wrapped = false, rows = 0, cyc = null;
    const prevStO = opt.prevStatusById?.get(src.id);
    if (src.full_scan && !cut && (anyOk || !lastFail)) {
      scanFrom = Number(prevStO?.resume_offset) || 0;
      let offset = scanFrom ? Math.max(0, scanFrom - 50) : 0; // one page of overlap when resuming
      while (scanned < (src.scan_pages_per_run || 30)) {
        const { r, list, total } = await page('', offset);
        if (!r.ok) { lastFail = r; resume = Math.max(offset, scanFrom); if (refused(r)) cut = `full list at ${offset}`; break; }
        scanned++;
        if (offset >= scanFrom) rows += list.length;
        if (list.length < 50 || offset + 50 >= total) { resume = 0; wrapped = true; break; }
        offset += 50; resume = offset;
      }
      if (scanned) cyc = sweepCycle(prevStO?.checkpoint, { nowIso: (opt.now || new Date()).toISOString(), fromStart: scanFrom === 0, wrapped, rows });
    }
    const ckO = cyc?.ck || prevStO?.checkpoint || {};
    if (!anyOk) return fail(lastFail || {}, { resume_offset: opt.prevStatusById?.get(src.id)?.resume_offset ?? null });
    const jobs = []; let details = 0, reused = 0, skippedNonUS = 0;
    const prev = opt.prevBySource?.get(src.id) || new Map();
    for (const p of seen.values()) {
      // the full list is worldwide: keep US and country-unknown postings only
      if (src.full_scan && p.PrimaryLocationCountry && p.PrimaryLocationCountry !== 'US' && !(p.secondaryLocations || []).some(l => /united states|\bUS\b|USA/i.test(l.Name || ''))) { skippedNonUS++; continue; }
      const j = { source_id: src.id, ats: 'oracle_hcm', employer: emp.employer, ext_id: String(p.Id), req_id: String(p.Id), title: p.Title,
        url: `https://${src.host}/hcmUI/CandidateExperience/en/sites/${src.site}/job/${p.Id}`,
        locations: [p.PrimaryLocation, ...(p.secondaryLocations || []).map(s => s.Name)].filter(Boolean), country: p.PrimaryLocationCountry || null,
        workplace_hint: /remote/i.test(p.WorkplaceType || '') ? 'remote' : /hybrid/i.test(p.WorkplaceType || '') ? 'hybrid' : null,
        posted_at: iso(p.PostedDate), posted_kind: 'posted_date', desc_text: htmlToText(p.ShortDescriptionStr || '') };
      const pj = prev.get(j.ext_id);
      if (pj && !detailStale(pj, opt) && pj.title === j.title && (!relevantTitle(p.Title) || pj.excerpt)) { j.reuse = pj; reused++; jobs.push(j); continue; } // already known: no detail fetch
      if (relevantTitle(p.Title) && details < opt.detailCap) {
        details++;
        const d = await http.json(`https://${src.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${p.Id}%22,siteNumber=${src.site}`);
        const it = d.ok ? d.data?.items?.[0] : null;
        if (it) j.desc_text = htmlToText([it.ExternalDescriptionStr, it.ExternalResponsibilitiesStr, it.ExternalQualificationsStr].filter(Boolean).join('\n'));
      }
      jobs.push(j);
    }
    const note = [`${seen.size} requisitions listed`, src.full_scan ? (scanned ? `full list: ${scanned} pages from ${scanFrom}${wrapped ? `, reached the end${cyc?.early ? ` (${cyc.early})` : ' — pass complete'}; next run starts over` : `, next run resumes at ${resume}`}` : 'full list not read this run') : null,
      src.full_scan ? (ckO.last_full_cycle_end ? `last complete pass ${ckO.last_full_cycle_end.slice(0, 10)}` : 'no complete pass yet, so nothing is closed') : null,
      `${details} detail records read, ${reused} reused`, skippedNonUS ? `${skippedNonUS} outside the US skipped` : null, cut ? `REFUSED part-way (${cut}: ${lastFail?.status}); roles not reached are kept` : null].filter(Boolean).join('; ');
    return { result: cut ? 'partial' : jobs.length ? 'ok' : 'empty', status: cut ? lastFail.status : 200, jobs, note,
      resume_offset: src.full_scan ? resume ?? scanFrom : null, rotated: !!src.full_scan, close_after_hours: src.full_scan ? (src.close_after_hours || 96) : undefined,
      checkpoint: src.full_scan ? ckO : undefined, close_before: src.full_scan ? (ckO.last_full_cycle_start || null) : undefined,
      fields: { posted_date: 'PostedDate', salary: 'detail text', location: 'yes', remote: 'WorkplaceType', req_id: 'Id' } };
  },
};

// ---------- aggregators: discovery only, never treated as original evidence
export const AGGREGATORS = {
  async adzuna(cfg, http, env) {
    if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return { result: 'skipped_no_key', jobs: [] };
    const jobs = [];
    for (const q of cfg.queries) for (const where of [cfg.where, null]) {
      const u = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${env.ADZUNA_APP_ID}&app_key=${env.ADZUNA_APP_KEY}&results_per_page=50&what=${encodeURIComponent(where ? q : q + ' remote')}` +
        (where ? `&where=${encodeURIComponent(where)}&distance=40` : '') + `&max_days_old=${cfg.maxDays}&sort_by=date&content-type=application/json`;
      const r = await http.json(u);
      if (!r.ok) return { result: r.status ? `http_${r.status}` : r.error, jobs };
      for (const a of r.data?.results || []) jobs.push({ source_id: 'agg:adzuna', ats: 'adzuna', source_class: 'aggregator', via: 'Adzuna', employer: a.company?.display_name || 'Unknown',
        ext_id: String(a.id), title: a.title?.replace(/<[^>]+>/g, ''), url: a.redirect_url, locations: [a.location?.display_name].filter(Boolean),
        posted_at: iso(a.created), posted_kind: 'aggregator_created', desc_text: a.description || '',
        salary_struct: a.salary_min ? { min: a.salary_min, max: a.salary_max || a.salary_min, period: 'year', kind: a.salary_is_predicted === '1' ? 'predicted' : 'unlabeled', src: 'adzuna', snippet: a.salary_is_predicted === '1' ? 'Adzuna predicted salary (not employer-stated)' : 'Adzuna salary field' } : null });
    }
    return { result: 'ok', jobs };
  },
  async serpapi(cfg, http, env) {
    if (!env.SERPAPI_KEY) return { result: 'skipped_no_key', jobs: [] };
    const jobs = [];
    for (const q of cfg.queries.slice(0, cfg.serpMaxQueries)) {
      const r = await http.json(`https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(q)}&location=${encodeURIComponent('New York, New York, United States')}&hl=en&gl=us&api_key=${env.SERPAPI_KEY}`);
      if (!r.ok) return { result: r.status ? `http_${r.status}` : r.error, jobs };
      for (const g of r.data?.jobs_results || []) jobs.push({ source_id: 'agg:serpapi', ats: 'google_jobs', source_class: 'aggregator', via: `Google Jobs via ${g.via || 'unknown'}`, employer: g.company_name || 'Unknown',
        ext_id: g.job_id?.slice(0, 64) || g.title, title: g.title, url: g.apply_options?.[0]?.link || g.share_link, locations: [g.location].filter(Boolean),
        remote_hint: g.detected_extensions?.work_from_home === true, posted_at: null, posted_kind: 'aggregator_relative', posted_text: g.detected_extensions?.posted_at || null, desc_text: g.description || '' });
    }
    return { result: 'ok', jobs };
  },
};
