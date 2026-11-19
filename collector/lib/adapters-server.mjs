// Adapters that only work server-side (no CORS) or need many paced requests.
import { ADAPTERS as BASE, htmlToText, relativePosted, classifyFunctions, parseSalaries } from '../../assets/shared/core.mjs';

const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const fail = (r, extra = {}) => ({ result: r.error === 'timeout' ? 'timeout' : r.status ? `http_${r.status}` : (r.error || 'network_error'), status: r.status || null, jobs: [], note: r.detail || r.statusText || r.error || '', ...extra });
const relevantTitle = t => { const c = classifyFunctions(t); return c.functions.length || c.eng_review; };
const usText = s => /united states|\bUSA?\b|, [A-Z]{2}\b|remote|virtual|north america/i.test(s || '');

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
      const r = await http.json(`https://boards-api.greenhouse.io/v1/boards/${src.slug}/jobs/${j.ext_id}?pay_transparency=true`);
      const pr = r.ok && (r.data?.pay_input_ranges || [])[0];
      if (pr && pr.min_cents) j.salary_struct = { min: pr.min_cents / 100, max: pr.max_cents / 100, period: 'year', kind: /base|salary/i.test((pr.title || '') + (pr.blurb || '')) ? 'base' : 'base_likely', src: 'structured', snippet: `Greenhouse pay range: ${pr.title || ''}` };
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

  // Workday CXS: the same JSON the public careers page calls. Search by function keywords, then
  // fetch details (exact startDate + description) only for relevant US roles.
  async workday(src, emp, http, opt) {
    const base = `https://${src.host}/wday/cxs/${src.tenant}/${src.site}`;
    const seen = new Map(); let anyOk = false, lastFail = null;
    for (const q of src.queries || ['']) {
      for (let offset = 0; offset < (opt.workdayMaxPerQuery || opt.maxPerQuery); offset += 20) {
        const r = await http.json(`${base}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: q }) });
        if (!r.ok) { lastFail = r; break; }
        anyOk = true;
        const list = r.data?.jobPostings || [];
        for (const p of list) if (p.externalPath) seen.set(p.externalPath, p);
        if (list.length < 20) break;
      }
      if (!anyOk && lastFail) break; // first query failed: config is wrong, stop early
    }
    if (!anyOk) return fail(lastFail || {}, { note: `Workday ${src.host}/${src.site}: ${lastFail?.status || lastFail?.error}. A 404/422 usually means the tenant/site name is wrong; copy it from an Apply URL.` });
    const jobs = []; let details = 0;
    for (const p of seen.values()) {
      const approx = relativePosted(p.postedOn);
      const j = { source_id: src.id, ats: 'workday', employer: emp.employer, ext_id: p.externalPath.split('_').pop(), req_id: (p.bulletFields || [])[0] || null,
        title: p.title, url: `https://${src.host}/${src.site}${p.externalPath}`, locations: [p.locationsText].filter(Boolean),
        posted_at: approx ? approx + 'T12:00:00.000Z' : null, posted_kind: approx ? 'relative_approx' : 'unknown', posted_text: p.postedOn || null, desc_text: '' };
      const wantDetail = relevantTitle(p.title) && (usText(p.locationsText) || /locations/i.test(p.locationsText || '')) && details < opt.detailCap;
      if (wantDetail) {
        details++;
        const d = await http.json(`${base}${p.externalPath}`);
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
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs, note: `${seen.size} postings across ${src.queries?.length || 1} keyword searches; ${details} detail pages`,
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

  // Eightfold PCSX (Microsoft). Verified by request: /api/pcsx/search and /api/pcsx/position_details.
  // Pages hold ~10 positions; advance by the number actually returned; stop at data.count, an empty page or a repeat.
  async eightfold(src, emp, http, opt) {
    const host = `https://${src.host}`, D = encodeURIComponent(src.domain);
    const seen = new Map(); let anyOk = false, lastFail = null, incomplete = [];
    for (const q of src.queries || ['']) {
      let start = 0, prevFirst = null, count = Infinity, pages = 0;
      while (start < count && start < (opt.eightfoldMaxPerQuery || 30)) {
        const r = await http.json(`${host}/api/pcsx/search?domain=${D}&query=${encodeURIComponent(q)}&location=&start=${start}`);
        if (!r.ok) { lastFail = r; if (anyOk || pages) incomplete.push(`${q}@${start}: ${r.status || r.error}`); break; }
        const data = r.data?.data || {}; const list = data.positions;
        if (!Array.isArray(list)) { lastFail = { error: 'parse_error', detail: 'No data.positions in response' }; break; }
        anyOk = true; pages++; count = Number(data.count ?? count);
        if (!list.length || String(list[0]?.id) === prevFirst) break;
        prevFirst = String(list[0]?.id);
        for (const p of list) seen.set(String(p.id), p);
        start += list.length;
      }
      if (!anyOk && lastFail) break; // first request refused: don't keep knocking
    }
    if (!anyOk) return fail(lastFail || {});
    const ts = v => v ? new Date((v > 1e12 ? v : v * 1000)).toISOString() : null;
    const jobs = []; let details = 0;
    for (const p of seen.values()) {
      const locs = (p.standardizedLocations?.length ? p.standardizedLocations : p.locations) || [];
      const wlo = String(p.workLocationOption || '');
      const j = { source_id: src.id, ats: 'eightfold', employer: emp.employer, ext_id: String(p.id), req_id: p.displayJobId || null, title: p.name,
        url: p.positionUrl ? (p.positionUrl.startsWith('http') ? p.positionUrl : host + p.positionUrl) : `${host}/careers/job/${p.id}`,
        locations: locs.map(l => typeof l === 'string' ? l : (l.name || l.location || '')).filter(Boolean), department: p.department || null,
        workplace_hint: /remote/i.test(wlo) ? 'remote' : /hybrid|flex/i.test(wlo) ? 'hybrid' : /onsite|on-site|office/i.test(wlo) ? 'onsite' : null,
        posted_at: ts(p.postedTs), posted_kind: p.postedTs ? 'posted_ts' : 'unknown', created_at: ts(p.creationTs), desc_text: '' };
      if (!j.posted_at && j.created_at) { j.posted_at = j.created_at; j.posted_kind = 'creation_ts (may predate public posting)'; }
      if (relevantTitle(p.name) && (usText(j.locations.join(' ')) || !j.locations.length) && details < opt.detailCap) {
        details++;
        const d = await http.json(`${host}/api/pcsx/position_details?domain=${D}&position_id=${encodeURIComponent(p.id)}&hl=en`);
        const dd = d.ok ? d.data?.data : null;
        if (dd) {
          const site = dd.efcustomTextWorkSite || '';
          j.desc_text = htmlToText(dd.jobDescription || '') + (site ? `\nWork site: ${site}` : '');
          if (site) j.workplace_hint = /100%|fully remote|remote/i.test(site) ? 'remote' : /up to \d+%|hybrid|flex/i.test(site) ? 'hybrid' : /on-?site/i.test(site) ? 'onsite' : j.workplace_hint;
        } else if (!d.ok) incomplete.push(`details ${p.id}: ${d.status || d.error}`);
      }
      jobs.push(j);
    }
    return { result: jobs.length ? 'ok' : 'empty', status: 200, jobs,
      note: `${seen.size} positions from ${(src.queries || []).length} searches; ${details} detail pages` + (incomplete.length ? `; INCOMPLETE (${incomplete.length} requests cut short, e.g. ${incomplete[0]})` : ''),
      fields: { posted_date: 'postedTs (creationTs kept separately)', salary: 'position_details jobDescription', location: 'standardizedLocations', remote: 'workLocationOption + efcustomTextWorkSite', req_id: 'displayJobId' } };
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
