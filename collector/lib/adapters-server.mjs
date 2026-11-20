// Adapters that only work server-side (no CORS) or need many paced requests.
import { ADAPTERS as BASE, htmlToText, relativePosted, classifyFunctions, FUNCTIONS, parseSalaries, classifyWorkplace } from '../../assets/shared/core.mjs';

const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const fail = (r, extra = {}) => ({ result: r.error === 'timeout' ? 'timeout' : r.status ? `http_${r.status}` : (r.error || 'network_error'), status: r.status || null, jobs: [], note: r.detail || r.statusText || r.error || '', ...extra });
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

export const ADAPTERS = {
  ...BASE,

  // Greenhouse plus the optional pay_transparency detail call for relevant jobs with no salary in text
  async greenhouse(src, emp, http, opt) {
    const out = await BASE.greenhouse(src, emp, http);
    if (out.result !== 'ok' || !opt.ghPayTransparency) return out;
    let n = 0;
    for (const j of out.jobs) {
      if (n >= opt.ghPayCap) break;
      if (!relevantTitle(j.title) || parseSalaries(j.desc_text).length) continue;
      n++;
      const r = await http.json(`https://boards-api${src.region === 'eu' ? '.eu' : ''}.greenhouse.io/v1/boards/${src.slug}/jobs/${j.ext_id}?pay_transparency=true`);
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
    for (const q of queries) {
      for (let offset = 0; offset < opt.maxPerQuery; offset += 100) {
        const u = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=100&offset=${offset}` + (q ? `&q=${encodeURIComponent(q)}` : '') + (src.country ? `&country=${src.country}` : '');
        const r = await http.json(u);
        if (!r.ok) { lastFail = r; break; }
        anyOk = true;
        const list = r.data?.content || [];
        for (const p of list) seen.set(p.id, p);
        if (list.length < 100) break;
      }
    }
    if (!anyOk) return fail(lastFail || {});
    const jobs = [];
    let details = 0;
    for (const p of seen.values()) {
      const L = p.location || {};
      const j = { source_id: src.id, ats: 'smartrecruiters', employer: emp.employer, ext_id: p.id, req_id: p.refNumber || null,
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
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, note: `${seen.size} postings via ${queries.length} queries; ${details} detail pages`,
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
    const seen = new Map(); let pages = 0, lastFail = null, diag = '';
    for (const q of src.queries || ['']) {
      for (let page = 1; page <= (src.max_pages || 5); page++) {
        const url = `https://www.google.com/about/careers/applications/jobs/results?hl=en_US&q=${encodeURIComponent(q)}&location=United%20States&page=${page}`;
        const r = await http.text(url);
        if (!r.ok) { lastFail = r; if (r.status === 429 || r.status === 403) break; continue; }
        const block = afData(r.data, 'ds:1');
        if (!block) { diag = `page ${page} of "${q}": ${r.data.length} bytes, AF_initDataCallback ${/AF_initDataCallback/.test(r.data) ? 'present but no ds:1 data' : 'absent'}`; break; }
        pages++;
        const found = googleJobs(block); let fresh = 0;
        for (const g of found) if (!seen.has(g.id)) { seen.set(g.id, g); fresh++; }
        if (found.length < 20 || !fresh) break;
      }
      if (lastFail && (lastFail.status === 429 || lastFail.status === 403)) break;
    }
    if (!seen.size) {
      if (lastFail && !pages) return fail(lastFail, { note: `Google Careers refused or failed (${lastFail.status || lastFail.error}); previous roles kept.` });
      return { result: pages ? 'empty' : 'experimental_failed', status: 200, jobs: [], note: pages ? `${pages} pages read; no jobs matched the searches` : `Google Careers page format not recognized: ${diag || 'no data block found'}` };
    }
    const jobs = [...seen.values()].map(g => ({ source_id: src.id, ats: 'google_careers', employer: emp.employer, ext_id: g.id, title: g.title,
      url: `https://www.google.com/about/careers/applications/jobs/results/${g.id}-${g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      locations: g.locations, remote_hint: g.locations.some(l => /remote/i.test(l)), department: g.company && g.company !== 'Google' ? g.company : null,
      posted_at: null, posted_kind: g.ts ? 'updated_only' : 'unknown', updated_at: g.ts, desc_text: g.text }));
    return { result: 'ok', status: 200, jobs, note: `${jobs.length} roles from ${pages} result pages across ${(src.queries || ['']).length} searches (experimental parser)`,
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
    const found = new Map(); let via = '', lastFail = null;
    const addUrl = (u, title) => { const m = u.match(/\/job\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)/); if (m && !found.has(m[4])) found.set(m[4], { url: u.startsWith('http') ? u : base + u, slugTitle: title || m[2].replace(/-/g, ' '), slugCity: m[1].replace(/-/g, ' ') }); };
    for (const sm of (rules.sitemaps.length ? rules.sitemaps : [`${base}/sitemap.xml`]).slice(0, 3)) {
      const r = await http.text(sm); if (!r.ok) { lastFail = r; if (refused(r)) break; continue; }
      const locs = [...r.data.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
      const children = /<sitemapindex/i.test(r.data) ? locs.filter(l => /job/i.test(l)).slice(0, 10) : [];
      for (const c of children) { const cr = await http.text(c); if (cr.ok) for (const m of cr.data.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) addUrl(m[1]); else if (refused(cr)) { lastFail = cr; break; } }
      for (const l of locs) addUrl(l);
      if (found.size) { via = 'sitemap'; break; }
    }
    if (!found.size && !blocked(`/${lang}/search-jobs`)) {
      via = 'search pages';
      for (let p = 1; p <= (src.max_pages || 100); p++) {
        const r = await http.text(`${base}/${lang}/search-jobs?p=${p}`); if (!r.ok) { lastFail = r; break; }
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
      if (pj && pj.title) { j.title = pj.title; if (pj.excerpt || pj.posted_kind !== 'unknown') { j.reuse = pj; reused++; jobs.push(j); continue; } }
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
    const partial = detailRefused;
    return { result: partial ? 'partial' : 'ok', status: 200, jobs,
      note: `${found.size} postings via ${via}; ${details} job pages read, ${reused} reused from earlier runs` + (partial ? '; job-page reads refused part-way, the rest are read next run' : '') + (rules.crawlDelay ? `; robots crawl-delay ${rules.crawlDelay}s` : ''),
      fields: { posted_date: 'JSON-LD datePosted (job page)', salary: 'JSON-LD baseSalary or description text', location: 'JSON-LD jobLocation', remote: 'jobLocationType TELECOMMUTE', req_id: 'JSON-LD identifier' } };
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
    const pat = new RegExp(src.link_pattern || '/careers/[^/?#"]+/?$');
    const links = new Map();
    for (const m of r.data.matchAll(/<a\b[^>]*href="([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = new URL(m[1], src.list_url).href.replace(/\/$/, '');
      const path = new URL(href).pathname;
      if (href.startsWith(origin) && pat.test(path) && href !== src.list_url.replace(/\/$/, '') && !links.has(href)) links.set(href, htmlToText(m[2]).split('\n')[0].trim());
    }
    // No matching links is not evidence of zero jobs: the listing may be built by JavaScript or the link format may have changed.
    if (!links.size) return { result: 'no_links_found', status: 200, jobs: [], note: `page read, but no links matching ${pat} on ${src.list_url}; the listing may be rendered by JavaScript` };
    const prev = opt.prevBySource?.get(src.id) || new Map();
    const jobs = []; let details = 0, reused = 0;
    for (const [href, linkText] of links) {
      const id = new URL(href).pathname.replace(/^\/|\/$/g, '').split('/').pop();
      const j = { source_id: src.id, ats: 'company_html', employer: emp.employer, ext_id: id, title: linkText || titleCase(id.replace(/-/g, ' ')), url: href, locations: [], posted_at: null, posted_kind: 'unknown', desc_text: '' };
      const pj = prev.get(id);
      if (pj && pj.title) { j.title = pj.title; j.reuse = pj; reused++; jobs.push(j); continue; }
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
    return { result: 'ok', status: 200, jobs, note: `${links.size} job links on the careers page; ${details} job pages read, ${reused} reused from earlier runs`,
             fields: { posted_date: 'JSON-LD datePosted if present, else unknown (first-observed used)', salary: 'page text', location: 'JSON-LD or "Location:" line', remote: 'page text', req_id: 'page URL' } };
  },

  // Workday CXS: the same JSON the public careers page calls. Search by function keywords, then
  // fetch details (exact startDate + description) only for relevant US roles.
  async workday(src, emp, http, opt) {
    const base = `https://${src.host}/wday/cxs/${src.tenant}/${src.site}`;
    const allQ = src.queries?.length ? src.queries : [''];
    // Rotation: sources with many searches run a different slice each run (full coverage every N runs).
    const nRot = allQ.length >= (opt.rotateMinQueries || 7) ? Math.max(1, opt.queryRotation || 1) : 1;
    const slot = (opt.runSeq || 0) % nRot;
    const queries = nRot > 1 ? allQ.filter((_, i) => i % nRot === slot) : allQ;
    const refused = r => r.status === 429 || r.status === 403;
    const seen = new Map(); let anyOk = false, lastFail = null, stoppedAt = null, resumeOffset = null, scanned = 0, capHit = [];
    const maxPer = src.max_results || opt.workdayMaxPerQuery || opt.maxPerQuery;
    const page = async (q, offset) => {
      const r = await http.json(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: q }) });
      if (!r.ok) return { r };
      anyOk = true; scanned++;
      if (offset === 0 && Number(r.data?.total) >= 2000) capHit.push(q || '(all)'); // Workday stops paging at 2,000 results
      const list = r.data?.jobPostings || [];
      for (const p of list) if (p.externalPath) seen.set(p.externalPath, p);
      return { r, more: list.length === 20 };
    };
    const fullScan = queries.length === 1 && queries[0] === '';
    if (fullScan) {
      // Every listing, paged by 20. If refused part-way, the next run resumes from that page and wraps around.
      const start = Math.min(opt.prevStatusById?.get(src.id)?.resume_offset || 0, maxPer);
      const ranges = start ? [[start, maxPer], [0, start]] : [[0, maxPer]];
      scan: for (const [from, to] of ranges) for (let offset = from; offset < to; offset += 20) {
        const { r, more } = await page('', offset);
        if (!r.ok) { lastFail = r; if (refused(r) && anyOk) { stoppedAt = 0; resumeOffset = offset; } break scan; }
        if (!more) break;
      }
    } else {
      search: for (const [qi, q] of queries.entries()) {
        for (let offset = 0; offset < maxPer; offset += 20) {
          const { r, more } = await page(q, offset);
          if (!r.ok) { lastFail = r; if (refused(r)) { stoppedAt = qi; break search; } break; } // refused: stop, keep what we have
          if (!more) break;
        }
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
      const j = { source_id: src.id, ats: 'workday', employer: emp.employer, ext_id: ext, req_id: (p.bulletFields || [])[0] || null,
        title: p.title, url: `https://${src.host}/${src.site}${p.externalPath}`, locations: [p.locationsText].filter(Boolean),
        posted_at: approx ? approx + 'T12:00:00.000Z' : null, posted_kind: approx ? 'relative_approx' : 'unknown', posted_text: p.postedOn || null, desc_text: '' };
      const pj = prev.get(ext);
      const relevant = relevantTitle(p.title) && (usText(p.locationsText) || /locations/i.test(p.locationsText || ''));
      if (relevant && pj && (pj.posted_kind === 'start_date' || pj.excerpt) && pj.title === p.title) { j.reuse = pj; reused++; } // already read: don't fetch again
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
    const note = [fullScan ? `${seen.size} postings from a full scan (${scanned} pages${resumeOffset !== null ? `, stopped at listing ${resumeOffset}; next run resumes there` : ''})`
        : `${seen.size} postings from ${partial ? `${stoppedAt} of ` : ''}${queries.length} searches` + (nRot > 1 ? ` (rotation ${slot + 1}/${nRot} of ${allQ.length} total)` : ''),
      `${details} detail pages read, ${reused} reused from earlier runs`,
      partial ? `refused (${lastFail.status}) part-way: results so far kept, unreached roles kept and marked not refreshed` : '',
      detailRefused ? 'detail reads stopped after a refusal' : '',
      capHit.length ? `WARNING: ${capHit.join(', ')} matched 2,000+ listings, Workday's paging limit; postings past 2,000 are unreachable. Narrow the search terms or split by location/job-family facets copied from the site` : ''].filter(Boolean).join('; ');
    return { result: partial ? 'partial' : jobs.length ? 'ok' : 'empty', status: partial ? lastFail.status : 200, jobs, rotated: nRot > 1, resume_offset: resumeOffset, note,
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
    if (!anyOk) return fail(lastFail || {});
    const jobs = [...seen.values()].map(p => ({ source_id: src.id, ats: 'amazon', employer: /amazon-web-services/i.test(p.business_category || '') ? 'Amazon / AWS (AWS)' : 'Amazon / AWS',
      ext_id: String(p.id_icims || p.id), req_id: String(p.id_icims || ''), title: p.title, url: `https://www.amazon.jobs${p.job_path || ''}`,
      locations: [p.normalized_location || p.location].filter(Boolean), country: p.country_code === 'USA' ? 'US' : p.country_code,
      department: [p.business_category, p.job_category].filter(Boolean).join(' / ') || null,
      posted_at: iso(p.posted_date), posted_kind: 'posted_date',
      desc_text: htmlToText([p.description, p.basic_qualifications, p.preferred_qualifications].filter(Boolean).join('\n')) }));
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, note: `${jobs.length} US postings via keyword searches`,
             fields: { posted_date: 'posted_date', salary: 'pay statement in qualification text (geo range)', location: 'yes', remote: 'text only', req_id: 'id_icims' } };
  },

  // Cisco careers runs on Phenom: search pages embed the results as JSON (phApp.ddo → eagerLoadRefineSearch.data.jobs).
  // Falls back to the older jobs.cisco.com results table if that's what comes back.
  async cisco_rss(src, emp, http, opt) {
    const phenom = await ADAPTERS.phenom({ ...src, base: src.phenom_base || 'https://careers.cisco.com/global/en' }, emp, http, opt);
    if (phenom.result === 'ok' || phenom.result === 'empty') return phenom;
    const seen = new Map(); let anyOk = false, lastFail = null, shapeMiss = 0;
    void phenom;
    const cell = h => htmlToText(h).replace(/\s+/g, ' ').trim();
    for (const q of src.queries || []) {
      const r = await http.text(src.feed_url_template.replace('{q}', encodeURIComponent(q)));
      if (!r.ok) { lastFail = r; if (!anyOk && r.status === 404) break; continue; }
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
        got++;
      }
      if (got) anyOk = true; else { shapeMiss++; lastFail = { error: 'parse_error', detail: 'No job rows found in the results table: ' + htmlToText(r.data).slice(0, 120) }; }
    }
    if (!anyOk) return fail(lastFail || {});
    const jobs = []; let details = 0;
    for (const p of seen.values()) {
      const j = { source_id: src.id, ats: 'cisco', employer: emp.employer, ext_id: p.id, req_id: p.id, title: p.title, url: p.url,
        locations: p.locs, department: p.area || null, posted_at: null, posted_kind: 'unknown', desc_text: '' };
      if (relevantTitle(p.title) && (usText(p.locs.join(' ')) || !p.locs.length) && details < opt.detailCap) {
        details++;
        const d = await http.text(p.url);
        if (d.ok) j.desc_text = htmlToText(d.data).slice(0, 12000);
      }
      jobs.push(j);
    }
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, note: `${seen.size} postings from ${(src.queries || []).length} searches (first 25 results each); ${details} detail pages${shapeMiss ? `; ${shapeMiss} searches returned no rows` : ''}`,
             fields: { posted_date: 'not shown (first-observed date used)', salary: 'detail page text', location: 'table column', remote: 'location text', req_id: 'URL id' } };
  },

  async phenom(src, emp, http, opt) {
    const seen = new Map(); let anyOk = false, lastFail = null;
    const grab = html => { const m = html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*phApp\./) || html.match(/phApp\.ddo\s*=\s*(\{[\s\S]*?\});\s*<\/script>/); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } };
    for (const q of src.queries || ['']) {
      for (let from = 0; from < (opt.phenomMaxPerQuery || 30); from += 10) {
        const r = await http.text(`${src.base}/search-results?keywords=${encodeURIComponent(q)}&from=${from}&s=1`);
        if (!r.ok) { lastFail = r; break; }
        const ddo = grab(r.data); const block = ddo?.eagerLoadRefineSearch; const list = block?.data?.jobs;
        if (!Array.isArray(list)) { lastFail = { error: 'parse_error', detail: 'Phenom page without eagerLoadRefineSearch.data.jobs' }; break; }
        anyOk = true; for (const j of list) seen.set(String(j.jobSeqNo || j.jobId || j.reqId), j);
        if (list.length < 10 || from + 10 >= (block.totalHits || 0)) break;
      }
      if (!anyOk && lastFail) break;
    }
    if (!anyOk) return fail(lastFail || {});
    const jobs = []; let details = 0;
    for (const p of seen.values()) {
      const locs = (p.multi_location?.length ? p.multi_location : [p.location || p.cityStateCountry]).filter(Boolean);
      const url = p.applyUrl && !/apply/i.test(p.applyUrl.split('?')[0].split('/').pop() || '') ? p.applyUrl : `${src.base}/job/${p.jobId || p.jobSeqNo}`;
      const j = { source_id: src.id, ats: 'phenom', employer: emp.employer, ext_id: String(p.jobSeqNo || p.jobId || p.reqId), req_id: p.reqId || p.jobId || null, title: p.title,
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
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, note: `${seen.size} postings via Phenom search; ${details} detail pages`,
      fields: { posted_date: 'postedDate', salary: 'detail description', location: 'location / multi_location', remote: 'work-site flags', req_id: 'reqId' } };
  },

  // Eightfold PCSx (Microsoft): /api/pcsx/search (10 positions per page whatever num says) and /api/pcsx/position_details.
  // No server-side location filter (location=United States was refused once): US eligibility is decided locally from
  // every listed location. Each run: the keyword searches (fresh roles), then, with full_scan, the next chunk of the whole
  // list, resuming where the last run stopped. A refusal (403/429) stops the run and returns 'partial', so roles not
  // reached are kept, never closed. Details are read once per role and reused afterwards.
  async eightfold(src, emp, http, opt) {
    const host = `https://${src.host}`, D = encodeURIComponent(src.domain);
    const refused = r => [403, 429].includes(r?.status);
    const seen = new Map(); let anyOk = false, lastFail = null, cut = null, pagesRun = 0, total = null;
    const page = async (q, start) => {
      const r = await http.json(`${host}/api/pcsx/search?domain=${D}&query=${encodeURIComponent(q)}&location=&start=${start}&num=10`);
      if (!r.ok) return { r };
      const data = r.data?.data || {}, list = data.positions;
      if (!Array.isArray(list)) return { r: { ok: false, error: 'parse_error', detail: 'No data.positions in response' } };
      anyOk = true; pagesRun++; if (data.count != null) total = Number(data.count);
      for (const p of list) seen.set(String(p.id), p);
      return { r, list, count: Number(data.count ?? Infinity) };
    };
    // 1) keyword searches
    const maxPer = src.max_per_query || opt.eightfoldMaxPerQuery || 30;
    search: for (const q of src.queries || []) {
      let start = 0, prevFirst = null;
      while (start < maxPer) {
        const { r, list, count } = await page(q, start);
        if (!r.ok) { lastFail = r; if (refused(r)) { cut = `search "${q}" at ${start}`; break search; } break; }
        if (!list.length || String(list[0]?.id) === prevFirst) break;
        prevFirst = String(list[0]?.id); start += list.length;
        if (start >= count) break;
      }
      if (!anyOk && lastFail) break; // first request failed outright: don't keep knocking
    }
    // 2) full-list chunk
    let resume = null, scanned = 0, scanFrom = null, wrapped = false;
    if (src.full_scan && !cut && (anyOk || !lastFail)) {
      let start = scanFrom = Number(opt.prevStatusById?.get(src.id)?.resume_offset) || 0;
      const maxPages = src.scan_pages_per_run || opt.eightfoldScanPages || 40;
      while (scanned < maxPages) {
        const { r, list, count } = await page('', start);
        if (!r.ok) { lastFail = r; resume = start; if (refused(r)) cut = `full list at ${start}`; break; }
        scanned++;
        if (!list.length || start + list.length >= count) { resume = 0; wrapped = true; break; }
        start += list.length; resume = start;
      }
    }
    if (!anyOk) return fail(lastFail || {}, { resume_offset: resume ?? opt.prevStatusById?.get(src.id)?.resume_offset ?? null });
    const ts = v => v ? new Date((v > 1e12 ? v : v * 1000)).toISOString() : null;
    const prev = opt.prevBySource?.get(src.id) || new Map();
    const jobs = []; let details = 0, reused = 0, detailRefused = false, skippedNonUS = 0;
    for (const p of seen.values()) {
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
      if (pj && pj.title === j.title && (!relevantTitle(p.name) || pj.excerpt)) { j.reuse = pj; reused++; jobs.push(j); continue; } // already known: no detail fetch
      if (!detailRefused && relevantTitle(p.name) && details < (src.detail_cap || opt.detailCap)) {
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
    const note = [`${seen.size} positions listed (${pagesRun} pages${total != null ? ` of ${total} worldwide` : ''})`,
      src.full_scan ? (scanned ? `full list: ${scanned} pages from listing ${scanFrom}${wrapped ? ', reached the end; next run starts over' : `, next run resumes at ${resume}`}` : 'full list not scanned this run') : null,
      `${jobs.length} kept as US or location-unclear, ${skippedNonUS} outside the US skipped`,
      `${details} detail records read, ${reused} reused`,
      cut ? `REFUSED part-way (${cut}: ${lastFail?.status}); roles not reached are kept` : null,
      detailRefused ? 'detail reads refused part-way; the rest are read next run' : null].filter(Boolean).join('; ');
    return { result: partial ? 'partial' : jobs.length ? 'ok' : 'empty', status: partial ? lastFail.status : 200, jobs, note,
      resume_offset: src.full_scan ? resume ?? scanFrom : null,
      rotated: !!src.full_scan, close_after_hours: src.full_scan ? (src.close_after_hours || 168) : undefined,
      fields: { posted_date: 'postedTs (creationTs kept separately)', salary: 'position_details jobDescription', location: 'standardizedLocations + locations (US decided locally)', remote: 'efcustomTextWorkSite (detail); listing flag used only for remote/hybrid', req_id: 'displayJobId' } };
  },

  async oracle_hcm(src, emp, http, opt) {
    const seen = new Map(); let anyOk = false, lastFail = null;
    for (const q of src.queries || ['']) {
      const finder = `findReqs;siteNumber=${src.site},limit=50,keyword=%22${encodeURIComponent(q)}%22,sortBy=POSTING_DATES_DESC,offset=0`;
      const r = await http.json(`https://${src.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`);
      if (!r.ok) { lastFail = r; if (!anyOk) break; continue; }
      anyOk = true;
      for (const p of r.data?.items?.[0]?.requisitionList || []) seen.set(String(p.Id), p);
    }
    if (!anyOk) return fail(lastFail || {});
    const jobs = []; let details = 0;
    for (const p of seen.values()) {
      const j = { source_id: src.id, ats: 'oracle_hcm', employer: emp.employer, ext_id: String(p.Id), req_id: String(p.Id), title: p.Title,
        url: `https://${src.host}/hcmUI/CandidateExperience/en/sites/${src.site}/job/${p.Id}`,
        locations: [p.PrimaryLocation, ...(p.secondaryLocations || []).map(s => s.Name)].filter(Boolean), country: p.PrimaryLocationCountry || null,
        workplace_hint: /remote/i.test(p.WorkplaceType || '') ? 'remote' : /hybrid/i.test(p.WorkplaceType || '') ? 'hybrid' : null,
        posted_at: iso(p.PostedDate), posted_kind: 'posted_date', desc_text: htmlToText(p.ShortDescriptionStr || '') };
      if (relevantTitle(p.Title) && details < opt.detailCap) {
        details++;
        const d = await http.json(`https://${src.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${p.Id}%22,siteNumber=${src.site}`);
        const it = d.ok ? d.data?.items?.[0] : null;
        if (it) j.desc_text = htmlToText([it.ExternalDescriptionStr, it.ExternalResponsibilitiesStr, it.ExternalQualificationsStr].filter(Boolean).join('\n'));
      }
      jobs.push(j);
    }
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, fields: { posted_date: 'PostedDate', salary: 'detail text', location: 'yes', remote: 'WorkplaceType', req_id: 'Id' } };
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
