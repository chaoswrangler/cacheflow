// Seed discovery: find public job boards for companies from outside lists (YC directory, VC portfolios).
// A small batch runs each collection. A board is accepted only with evidence that it belongs to the company:
// it is linked from the company's own website, or its postings name the company / its web domain.
// Accepted boards are written to data/discovered.json, which the collector and the site read alongside sources.json.
import { atsLinks, robotsRules } from './adapters-server.mjs';

const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const SUPPORTED = new Set(['greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters']);
const RECHECK_DAYS = 30;

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

// Board names to try when the website gives no link: the company name squashed and hyphenated, and the domain's first label.
export function guessSlugs(seed) {
  const n = String(seed.name || '').toLowerCase().replace(/&/g, 'and').replace(/\.(ai|io|com|dev|co)$/, '$1');
  const base = n.replace(/\b(inc|labs|technologies|technology|ai|hq)\b/g, ' ').trim();
  const dom = domainOf(seed.website);
  const label = dom ? dom.split('.')[0] : null;
  return [...new Set([n.replace(/[^a-z0-9]/g, ''), n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), base.replace(/[^a-z0-9]/g, ''), label].filter(x => x && x.length >= 3))].slice(0, 4);
}

const BOARD = {
  greenhouse: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`,
  ashby: s => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
  lever: s => `https://api.lever.co/v0/postings/${s}?mode=json&limit=20`,
  workable: s => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
  smartrecruiters: s => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=20`,
};
const BOARD_URL = {
  greenhouse: s => `https://job-boards.greenhouse.io/${s}`, ashby: s => `https://jobs.ashbyhq.com/${encodeURIComponent(s)}`,
  lever: s => `https://jobs.lever.co/${s}`, workable: s => `https://apply.workable.com/${s}/`, smartrecruiters: s => `https://careers.smartrecruiters.com/${s}`,
};
const ID = { greenhouse: 'gh', ashby: 'ashby', lever: 'lever', workable: 'workable', smartrecruiters: 'sr' };

// Read a board response into { jobs, name, texts } for the identity check.
export function readBoard(ats, d) {
  if (!d) return null;
  if (ats === 'greenhouse') return Array.isArray(d.jobs) ? { jobs: d.jobs.length, name: d.name || null, texts: d.jobs.slice(0, 6).map(j => `${j.title} ${j.absolute_url || ''} ${j.content || ''}`) } : null;
  if (ats === 'ashby') return Array.isArray(d.jobs) ? { jobs: d.jobs.length, name: null, texts: d.jobs.slice(0, 6).map(j => `${j.title} ${j.jobUrl || ''} ${j.descriptionPlain || ''}`) } : null;
  if (ats === 'lever') return Array.isArray(d) ? { jobs: d.length, name: null, texts: d.slice(0, 6).map(j => `${j.text} ${j.hostedUrl || ''} ${j.descriptionPlain || ''} ${j.additionalPlain || ''}`) } : null;
  if (ats === 'workable') return d.name || Array.isArray(d.jobs) ? { jobs: (d.jobs || []).length, name: d.name || null, texts: (d.jobs || []).slice(0, 6).map(j => `${j.title} ${j.description || ''}`) } : null;
  if (ats === 'smartrecruiters') return Array.isArray(d.content) ? { jobs: d.totalFound ?? d.content.length, name: d.content[0]?.company?.name || null, texts: d.content.slice(0, 6).map(j => `${j.name} ${j.company?.name || ''}`) } : null;
  return null;
}

// Does the board belong to this company? Linked from its own site = yes. Otherwise the board's name or its postings
// must contain the company name (4+ letters) or its web domain. Short or generic names need the domain.
export function identityCheck(seed, board, fromSite) {
  if (fromSite) return { ok: true, why: `linked from ${domainOf(seed.website) || 'the company website'}` };
  const name = nk(seed.name), dom = domainOf(seed.website);
  const hay = nk([board.name || '', ...board.texts].join(' '));
  const hayRaw = [board.name || '', ...board.texts].join(' ').toLowerCase();
  if (dom && hayRaw.includes(dom)) return { ok: true, why: `postings mention ${dom}` };
  const core = x => nk(String(x || '').toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|ai|hq|the|careers|jobs)\b\.?/g, ' '));
  if (board.name && core(board.name) && core(board.name) === core(seed.name)) return { ok: true, why: `board name "${board.name}"` };
  if (name.length >= 6 && hay.includes(name)) return { ok: true, why: `postings name ${seed.name}` };
  return { ok: false, why: board.jobs ? 'postings don\'t name the company or its domain' : 'board has no postings to check' };
}

async function careersLinks(seed, http) {
  const dom = domainOf(seed.website);
  if (!dom) return [];
  const origin = `https://${dom}`;
  const rb = await http.text(`${origin}/robots.txt`);
  const rules = rb.ok ? robotsRules(rb.data) : { disallow: [] };
  const out = [];
  for (const path of ['/', '/careers', '/jobs']) {
    if (rules.disallow.some(d => d && path.startsWith(d))) continue;
    const r = await http.text(origin + path);
    if (r.ok) out.push(...atsLinks(r.data).filter(x => SUPPORTED.has(x.ats)));
    if (out.length) break;
  }
  return out;
}

export async function seedProbe({ seeds, discovered, state, http, now = new Date(), batch = 40, registryNames = new Set(), log = () => {} }) {
  const list = (seeds?.seeds || []).filter(s => !s.known && !registryNames.has(nk(s.name)));
  const have = new Set((discovered.employers || []).map(e => nk(e.employer)));
  const checked = state.checked || {};
  const due = s => { const c = checked[nk(s.name)]; return !have.has(nk(s.name)) && (!c || (now - new Date(c.at)) / 864e5 > RECHECK_DAYS); };
  let i = state.next || 0, done = 0, added = 0, scanned = 0;
  while (done < batch && scanned < list.length) {
    const s = list[i % list.length]; i++; scanned++;
    if (!due(s)) continue;
    done++;
    const linked = await careersLinks(s, http);
    const cands = linked.length ? linked.map(x => ({ ats: x.ats, slug: x.slug, fromSite: true }))
      : guessSlugs(s).flatMap(slug => ['ashby', 'greenhouse', 'lever'].map(ats => ({ ats, slug, fromSite: false })));
    let hit = null; const tried = [];
    for (const c of cands) {
      if (!BOARD[c.ats]) continue;
      const slug = c.ats === 'workable' || c.ats === 'smartrecruiters' ? c.slug : c.slug.split('/')[0];
      const r = await http.json(BOARD[c.ats](slug));
      const b = r.ok ? readBoard(c.ats, r.data) : null;
      tried.push(`${c.ats}:${slug}=${b ? b.jobs + ' jobs' : r.status || r.error}`);
      if (!b) continue;
      const idc = identityCheck(s, b, c.fromSite);
      if (idc.ok && (b.jobs > 0 || c.fromSite)) { hit = { ats: c.ats, slug, jobs: b.jobs, why: idc.why }; break; }
      if (b.jobs && !idc.ok) tried[tried.length - 1] += ` (rejected: ${idc.why})`;
    }
    checked[nk(s.name)] = { at: now.toISOString(), result: hit ? `${hit.ats}:${hit.slug}` : 'not_found', tried: tried.slice(0, 8) };
    log(`seed ${s.name}: ${hit ? `${hit.ats}:${hit.slug} (${hit.why})` : 'no verified board'} [${tried.length} checks]`);
    if (!hit) continue;
    added++;
    (discovered.employers ||= []).push({
      employer: s.name, sector: s.sector || 'Enterprise SaaS', vertical: '', tier: 'core', type: 'growth', discovered: true,
      size: s.size ?? null, size_source: s.size != null ? 'YC directory team size' : null, seed_source: s.source, seed_url: s.source_url || null,
      careers_url: s.website || null, careers_url_verified: false, notes: [`Found automatically from the ${s.source === 'yc' ? 'Y Combinator directory' : s.source} seed list.`],
      sources: [{ id: `${ID[hit.ats]}:${nk(hit.slug)}`, ats: hit.ats, slug: hit.slug, board_url: BOARD_URL[hit.ats](hit.slug),
        verification: { status: 'auto_discovered', method: `Seed probe ${now.toISOString().slice(0, 10)}: board reachable with ${hit.jobs} postings; ownership: ${hit.why}.`, date: now.toISOString().slice(0, 10) } }],
    });
  }
  state.next = i % Math.max(1, list.length); state.checked = checked; state.updated_at = now.toISOString();
  state.progress = { seeds: list.length, checked: Object.keys(checked).length, found: (discovered.employers || []).length };
  return { done, added };
}
