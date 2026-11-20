// Shared by the browser app and the Node collector. No Node or DOM APIs in here.
// Everything that decides "is this base pay", "is NY eligible", "which function" lives in one place
// so the collector and the live browser check can never disagree.

export const TZ = 'America/New_York'; // collector default; the app passes the viewer's own time zone

/* ------------------------------------------------------------------ dates */
export function nyDate(d = new Date(), tz = TZ) {
  // YYYY-MM-DD for a Date as seen in the given time zone
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
export function weekWindow(now = new Date(), tz = TZ) {
  const end = nyDate(now, tz);
  const [y, m, d] = end.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun .. 6 Sat
  const back = dow === 0 ? 6 : dow - 1;
  return { start: addDays(end, -back), end, tz, label: 'Monday of current week through today' };
}
export function windowFor(mode, now = new Date(), tz = TZ) {
  if (mode === 'week') return weekWindow(now, tz);
  const days = { d7: 7, d14: 14, d30: 30 }[mode] || 7;
  const end = nyDate(now, tz);
  return { start: addDays(end, -(days - 1)), end, tz, label: `Last ${days} days` };
}
// Workday style "Posted 3 Days Ago" → approximate date (flagged approximate)
export function relativePosted(text, ref = new Date()) {
  if (!text) return null;
  const t = text.toLowerCase();
  const today = nyDate(ref);
  if (/today|just posted|hours? ago/.test(t)) return today;
  if (/yesterday/.test(t)) return addDays(today, -1);
  const m = t.match(/(\d+)\+?\s*days?\s*ago/);
  if (m) return t.includes('+') ? null : addDays(today, -Number(m[1]));
  return null;
}

/* ------------------------------------------------------------------ text */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•' };
export function decodeEntities(s = '') {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
export function htmlToText(html = '') {
  let s = String(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s); // Greenhouse double-escapes content
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
       .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
       .replace(/<li[^>]*>/gi, '\n• ')
       .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export const norm = (s = '') => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ------------------------------------------------------------------ salary
   Rules from the brief:
   - Only BASE salary counts. OTE, bonus, equity, total comp are never substituted.
   - "starts" = range minimum ≥ threshold; "reaches" = only the maximum ≥ threshold.
*/
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?\s?[kK]\b|\d{4,7}(?:\.\d{1,2})?|\d{2,3}(?:\.\d{1,2})?)`;
const CUR = String.raw`(?:USD|US\$|CAD|CA\$|\$)`;
const RANGE_RE = new RegExp(String.raw`(${CUR})\s?${NUM}\s*(?:USD|CAD)?\s*(?:\/\s?(?:yr|year|annum|hr|hour))?\s*(?:-|–|—|to|and)\s*(?:${CUR})?\s?${NUM}`, 'g');
const UPTO_RE = new RegExp(String.raw`(\$)\s?${NUM}(?:\s?\/\s?(?:year|yr))?[^$]{0,90}?\bup to\s*\$\s?${NUM}`, 'gi');

function toNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  const k = /k$/i.test(s);
  s = s.replace(/[kK]/, '').replace(/,/g, '');
  let n = parseFloat(s);
  if (!isFinite(n)) return null;
  if (k) n *= 1000;
  return n;
}
function classifyKind(before, after) {
  const ctx = (before + ' ' + after).toLowerCase();
  const near = before.slice(-140).toLowerCase();
  if (/\b(ote|on[- ]target|target (total )?earnings|total target comp|\bttc\b)/.test(near) ||
      /^\s*(usd\s*)?(\(usd\)\s*)?(ote|on[- ]target)/.test(after.toLowerCase())) return 'ote';
  if (/\bbase\b/.test(near)) return 'base';
  if (/^\s*(\(usd\)|usd)?\s*\+\s*(\d+%\s*)?(bonus|equity|commission|incentive)/i.test(after)) return 'base'; // Google style
  if (/total (cash )?comp|total rewards|total target/.test(near)) return 'total';
  if (/salary|pay range|hiring range|annual pay|wage|compensation range|pay scale|pay transparency|annual(ized)? range/.test(ctx)) return 'base_likely';
  return 'unlabeled';
}
export function parseSalaries(text = '') {
  const t = String(text);
  const out = [];
  const push = (m, a, b, idx, len) => {
    let min = toNumber(a), max = toNumber(b);
    if (min == null || max == null) return;
    if (max < min) [min, max] = [max, min];
    const after = t.slice(idx + len, idx + len + 80);
    const before = t.slice(Math.max(0, idx - 220), idx);
    let period = 'year';
    if (/^\s*(\/\s?|per\s|an\s)(hr|hour)|^\s*hourly/i.test(after) || /\/\s?(hr|hour)/i.test(m)) period = 'hour';
    if (/^\s*(m|mm|million|b|billion)\b/i.test(after)) return;
    if (period === 'year' && max < 1000) return; // "$5 - $10M" style noise
    const annMin = period === 'hour' ? min * 2080 : min;
    const annMax = period === 'hour' ? max * 2080 : max;
    if (annMax < 25000 || annMin > 3000000) return;
    const kind = classifyKind(before, after);
    const geo = /new york|\bnyc\b|\bny\b|tier ?1|zone ?(1|a)\b|highest/i.test(before.slice(-160) + after.slice(0, 40)) ? 'ny_or_top' : null;
    out.push({ min: Math.round(annMin), max: Math.round(annMax), period, kind, geo,
               snippet: (before.slice(-90) + m + after.slice(0, 30)).replace(/\s+/g, ' ').trim() });
  };
  for (const m of t.matchAll(RANGE_RE)) push(m[0], m[2], m[3], m.index, m[0].length);
  for (const m of t.matchAll(UPTO_RE)) push(m[0], m[2], m[3], m.index, m[0].length);
  // de-dup identical ranges
  const seen = new Set();
  return out.filter(r => { const k = `${r.min}-${r.max}-${r.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
const KIND_RANK = { base: 3, base_likely: 2, unlabeled: 1 };
export function chooseSalary(ranges = [], structured = null) {
  const all = [...(structured ? [structured] : []), ...ranges];
  const usable = all.filter(r => KIND_RANK[r.kind]);
  const ote = all.filter(r => r.kind === 'ote' || r.kind === 'total');
  if (!usable.length) return ote.length ? { min: null, max: null, kind: 'ote_only', ote: ote[0], multi: false, src: ote[0].src || 'text' } : null;
  const best = Math.max(...usable.map(r => KIND_RANK[r.kind]));
  let pool = usable.filter(r => KIND_RANK[r.kind] === best);
  const geo = pool.filter(r => r.geo === 'ny_or_top');
  if (geo.length) pool = geo;
  pool.sort((a, b) => b.min - a.min);
  const c = pool[0];
  return { min: c.min, max: c.max, period: c.period || 'year', kind: c.kind, src: c.src || 'text',
           snippet: c.snippet || null, multi: usable.length > 1, ote: ote[0] || null };
}
export function salaryTier(sal, threshold) {
  if (!sal) return 'unknown';
  if (sal.kind === 'ote_only') return 'ote_only';
  if (sal.kind === 'predicted') return 'predicted';
  if (sal.min >= threshold) return 'starts';
  if (sal.max >= threshold) return 'reaches';
  return 'below';
}

/* ------------------------------------------------------------------ location */
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const US_RE = new RegExp(String.raw`united states|\bU\.?S\.?A?\b|\bUSA\b|north america|,\s*(?:${US_STATES})\b|\b(?:new york|california|texas|washington|virginia|massachusetts|illinois|colorado|georgia|florida|new jersey|connecticut|north carolina|utah|oregon|arizona|pennsylvania|ohio|michigan|minnesota|maryland|tennessee|missouri|wisconsin)\b|seattle|san francisco|austin|boston|chicago|denver|atlanta|reston|arlington|herndon|sunnyvale|santa clara|mountain view|san jose|palo alto|los angeles|san diego|dallas|houston|raleigh|nashville|salt lake|miami|phoenix|portland|pittsburgh|philadelphia|kirkland|redmond|bellevue|washington,? d\.?c`, 'i');
const NON_US_RE = /\b(india|israel|united kingdom|\buk\b|england|london|ireland|dublin|germany|berlin|munich|france|paris|spain|madrid|netherlands|amsterdam|poland|warsaw|krakow|romania|czech|canada|toronto|vancouver|montreal|mexico|brazil|argentina|colombia|chile|japan|tokyo|singapore|australia|sydney|melbourne|china|taiwan|korea|seoul|philippines|manila|vietnam|hong kong|uae|dubai|saudi|sweden|stockholm|norway|denmark|finland|italy|milan|switzerland|zurich|austria|belgium|portugal|lisbon|south africa|new zealand|tel aviv|bengaluru|bangalore|hyderabad|pune|chennai|cork|belfast|emea|apac|latam)\b/i;
export const STATES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
const REMOTE_RE = /\bremote\b|anywhere|distributed|home[- ]based|work from home|\bvirtual\b|telecommut/i;
const STATE_NAME_RE = new RegExp(`\\b(${Object.values(STATES).join('|')})\\b`, 'i');
const esc = s => s.replace(/[.*+?^${}()[\]\\]/g, '\\$&');

// Commutable-area presets: if your city is in one, the whole metro is used
export const METRO_PRESETS = {
  'New York metro': 'new york|nyc|manhattan|brooklyn|queens|bronx|staten island|jersey city|hoboken|newark|stamford|white plains|greenwich|westchester|tarrytown|purchase|armonk|long island|norwalk|rye|pelham|new rochelle|yonkers|morristown|parsippany|short hills|harrison|valhalla|melville|garden city|montclair|edison',
  'SF Bay Area': 'san francisco|oakland|san jose|santa clara|sunnyvale|mountain view|palo alto|menlo park|redwood city|san mateo|foster city|cupertino|fremont|berkeley|south san francisco|burlingame|milpitas',
  'Seattle': 'seattle|bellevue|redmond|kirkland|bothell|tacoma|everett|issaquah',
  'Boston': 'boston|cambridge|somerville|waltham|burlington|lexington|newton|quincy|woburn|bedford|framingham',
  'Washington DC': 'washington|arlington|reston|herndon|mclean|tysons|alexandria|bethesda|rockville|chantilly|fairfax|vienna|silver spring',
  'Chicago': 'chicago|evanston|oak brook|schaumburg|naperville|deerfield',
  'Los Angeles': 'los angeles|santa monica|culver city|pasadena|irvine|burbank|el segundo|long beach|playa vista',
  'Austin': 'austin|round rock',
  'Denver': 'denver|boulder|broomfield|englewood|louisville',
  'Atlanta': 'atlanta|alpharetta|sandy springs|marietta',
  'Dallas': 'dallas|plano|irving|frisco|richardson|fort worth|addison',
  'Research Triangle': 'raleigh|durham|research triangle|rtp|cary|morrisville|chapel hill',
};
export function metroFor(city = '') {
  const c = city.trim().toLowerCase();
  if (!c) return '';
  for (const list of Object.values(METRO_PRESETS)) if (list.split('|').includes(c)) return list;
  return c;
}
// Location-independent facts, computed once by the collector
export function classifyWorkplace(job) {
  const locs = (job.locations || []).filter(Boolean);
  const locText = locs.join(' | ');
  let workplace = job.workplace_hint || null;
  if (!workplace) {
    if (job.remote_hint === true || REMOTE_RE.test(locText)) workplace = 'remote';
    else if (/hybrid/i.test(locText) || /\bhybrid\b/i.test(job.title || '')) workplace = 'hybrid';
    else if (locs.length) workplace = 'onsite';
    else workplace = 'unknown';
  }
  let us = US_RE.test(locText) ? true : (NON_US_RE.test(locText) ? false : null);
  if (job.country) us = /^(us|usa|united states)$/i.test(job.country) ? true : (us === true ? true : false);
  return { workplace, us, remote_us: workplace === 'remote' && us !== false };
}
// Sentences about where people can be hired from. Kept so each viewer can test their own state.
export function eligibilityText(desc = '') {
  const sents = desc.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const keep = sents.filter(x => /(eligib|hire|hiring|employ|located|reside|resident|based in|states?\b|work from|remote)/i.test(x) && (STATE_NAME_RE.test(x) || /\b(all|any) (50 )?(u\.?s\.?|us|united states)? ?states\b|anywhere in the (u\.?s|united states)/i.test(x)));
  // pay sentences that name a state also signal hiring there
  const pay = sents.filter(x => /(pay|salary|range|\$)/i.test(x) && STATE_NAME_RE.test(x));
  return [...new Set([...keep, ...pay])].join(' ').slice(0, 900);
}
// Viewer-specific: is this job in my commutable metro, or remote and open to my state?
export function homeFit(job, { metro = '', state = '' } = {}) {
  const locText = (job.locations || []).join(' | ');
  const abbr = (state || '').toUpperCase();
  const name = STATES[abbr] || '';
  const metroParts = metro.split('|').map(x => x.trim()).filter(Boolean);
  const metroRe = metroParts.length ? new RegExp(`\\b(${metroParts.map(esc).join('|')})\\b`, 'i') : null;
  const inMetro = !!(metroRe && metroRe.test(locText));
  let elig = 'n/a';
  if (inMetro) elig = 'yes';
  else if (job.remote_us && name) {
    const d = (job.elig_text || '') + ' ' + (job.excerpt || '');
    const st = `(${esc(name)}|\\b${abbr}\\b)`;
    if (new RegExp(`\\b(not|unable to|cannot|can't|won't)\\b[^.]{0,80}\\b(hire|hiring|employ|eligible|consider|support)[^.]{0,120}${st}`, 'i').test(d) ||
        new RegExp(`\\b(excluding|except|excludes|other than)\\b[^.]{0,100}${st}`, 'i').test(d)) elig = 'no';
    else if (new RegExp(`\\b${esc(name)}\\b|,\\s*${abbr}\\b`, 'i').test(locText)) elig = 'yes';
    else if (/\b(all|any) (50 )?(u\.?s\.?|us|united states)? ?states\b|anywhere in the (u\.?s|united states)/i.test(d)) elig = 'yes';
    else if (/(eligible|hire|located|reside)[^.]{0,60}\bin (the following|these|select) states/i.test(d)) elig = new RegExp(esc(name), 'i').test(d) ? 'yes' : 'no';
    else if (new RegExp(`${esc(name)}[^.]{0,60}(pay|salary|range|\\$)|(pay|salary|range)[^.]{0,80}${esc(name)}`, 'i').test(d)) elig = 'likely';
    else elig = 'unknown';
  } else if (job.remote_us) elig = 'unknown';
  return { in_metro: inMetro, eligibility: elig };
}
// Back-compat helper used by tests: one call with a metro and state
export function classifyLocation(job, opts = {}) {
  const w = classifyWorkplace(job);
  const h = homeFit({ ...job, ...w, elig_text: eligibilityText(job.desc_text || '') }, opts);
  return { ...w, in_metro: h.in_metro, eligibility: h.eligibility };
}

/* ------------------------------------------------------------------ functions & seniority */
// Job-function categories. Title-matched; a role can land in several. `group` drives the grouped picker,
// `hint` shows example titles, `broad` categories are off by default and get no description excerpt.
const F = (group, label, hint, re, broad = false) => ({ group, label, hint, re, broad });
export const FUNCTIONS = {
  product:  F('Product & programs', 'Product management', 'Product Manager, Group PM, Head of Product', /\bproduct\s+(manager|management|lead|owner|director|leader|strategy)|\b(group|principal|staff|senior|sr\.?|lead)\s+product\b|\bhead of product\b|\bvp,?\s+(of\s+)?product\b|\bcpo\b/i),
  tpm:      F('Product & programs', 'Program & technical program mgmt', 'Program Manager, TPM, Portfolio Manager', /\b(technical\s+)?program manag|\btpm\b|\bprogram (lead|director)|portfolio manag/i),
  pmm:      F('Marketing', 'Product marketing', 'Product Marketing Manager, Solutions Marketing', /product marketing|\bpmm\b|solutions? marketing|portfolio marketing|competitive marketing|industry marketing/i),
  marketing:F('Marketing', 'Marketing, brand & communications', 'Brand, Content, Comms, Events, DevRel', /\bmarketing\b|\bbrand\b|communications|\bpr\b|public relations|content (strateg|market|lead|manager|writer|director)|campaign|\bevents?\b|social media|evangel|developer relations|devrel|analyst relations|community (manager|lead)|copywrit|storytell/i),
  demand:   F('Marketing', 'Demand gen, growth & lifecycle', 'Demand Gen, Growth, ABM, Field Marketing', /demand gen|\bgrowth\b|lifecycle|performance marketing|\babm\b|account[- ]based|marketing operations|field marketing|digital marketing|\bseo\b|paid (media|social|search)/i),
  sales:    F('Sales & customers', 'Sales & account management', 'Account Executive, Sales Director, BDR', /\baccount (executive|director)|\bsales\b|commercial (lead|director|manager)|business development|\b[bs]dr\b|(security|solutions?|technology|cloud|ai|data|technical) specialist|client (partner|director)|enterprise (seller|executive)|\bterritory\b/i),
  se:       F('Sales & customers', 'Solutions & sales engineering', 'Solutions Engineer, Sales Engineer, Field CTO', /(solutions?|sales|pre-?sales|customer|field|partner|forward[- ]deployed|value) (engineer|architect|consultant)|field cto|technical (seller|specialist)|deployment strategist|\bpresales\b/i),
  partner:  F('Sales & customers', 'Partnerships, alliances & channel', 'Alliances, Channel, ISV, MSSP partners', /(?<!business |talent |hr |people |finance |hrbp |learning )partner|alliance|channel|ecosystem|marketplace|\bisv\b|reseller|\bmssp\b|distribution|co-?sell/i),
  cs:       F('Sales & customers', 'Customer success & adoption', 'Customer Success, TAM, Adoption, Renewals', /customer success|customer (experience|outcomes|value)|adoption|value (realization|management|engineer|consult|advis)|technical account manager|\btam\b|renewal|client success|implementation (manager|lead)|onboarding/i),
  enable:   F('Sales & customers', 'Enablement & training', 'Sales Enablement, Readiness, Training', /enablement|readiness|training|learning (and|&) development|curriculum|instructional|\bacademy\b/i),
  gtm:      F('Strategy & operations', 'Go-to-market strategy & ops', 'GTM Strategy, Revenue Ops, Sales Strategy', /go[- ]to[- ]market|\bgtm\b|(revenue|sales|field|commercial|partner) (operations|strategy|planning)|rev ?ops|sales ?ops|deal (desk|strategy)|territory planning/i),
  strategy: F('Strategy & operations', 'Strategy & business operations', 'Strategy, BizOps, Transformation, Corp Dev', /strateg(?!ic account)|business operations|biz ?ops|\boperations (lead|manager|director)|transformation|special projects|initiatives|business planning|corporate development|\bm&a\b|\bpricing\b/i),
  cos:      F('Strategy & operations', 'Chief of staff & executive office', 'Chief of Staff, Office of the CEO/CISO', /chief of staff|office of the (ceo|cto|ciso|cio|cpo|coo|president)|executive (operations|business partner)|technical advisor to/i),
  ci:       F('Strategy & operations', 'Competitive & market intelligence', 'Competitive Intel, Market Research, Win/Loss', /competitive|market (intelligence|research|insights)|win[- ]loss|industry analyst/i),
  threat:   F('Security practice', 'Threat research & intelligence', 'Threat Intel Analyst, Security Researcher, CTI', /threat (intel|research|hunt|analy|insight|landscape|actor)|\bcti\b|(cyber|security|adversary|counter[- ]?threat|threat actor) (intelligence|research)|security researcher|(?<!business |market |competitive |sales |revenue |customer |partner |marketing )intelligence (analyst|researcher|lead|manager|director)|malware (analy|research|reverse)|reverse engineer|vulnerability research|exploit research|adversary emulation|intel(ligence)? (operations|collection|fusion)|\bosint\b/i),
  secops:   F('Security practice', 'Security operations, IR & testing', 'SOC, Incident Response, DFIR, Red Team', /security operations|\bsoc\b|incident (response|responder|handler)|\bdfir\b|forensic|detection (engineer|and response|& response)|\bmdr\b|security analyst|cyber (defense|analyst)|(blue|purple|red) team|penetration test|pen ?test|offensive security/i),
  seceng:   F('Security practice', 'Security engineering & architecture', 'Security Engineer, Cloud/AppSec, Product Security', /security (engineer|architect)|(cloud|application|product|infrastructure|network|endpoint|data) security (engineer|architect|lead|manager|analyst)|\bappsec\b|devsecops|identity (engineer|architect)|\biam (engineer|architect)|cryptograph|vulnerability (management|engineer)/i),
  grc:      F('Security practice', 'GRC, risk, privacy & trust', 'GRC, Risk, Compliance, Privacy, CISO', /\bgrc\b|governance|\brisk\b|compliance|privacy|trust (and|&) safety|security assurance|(?<!to the |of the )\bciso\b|security program|fedramp/i),
  ai:       F('Technology', 'AI & machine learning', 'ML Engineer, Applied Scientist, AI Product', /machine learning|\bml\b|\bai\b|artificial intelligence|deep learning|\bllms?\b|applied scientist|research scientist|generative|\bgenai\b|\bnlp\b|computer vision|agentic/i),
  eng:      F('Technology', 'Software & infrastructure engineering', 'Software, Platform, SRE, DevOps Engineer', /(software|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|platform|infrastructure|site reliability|devops|systems|network|mobile|ios|android|firmware|embedded|qa|test|reliability|cloud|data|build|release) engineer|\bsre\b|\bsde\b|\bswe\b|\bdeveloper\b|engineering manager|\bprogrammer\b/i, true),
  data:     F('Technology', 'Data, analytics & BI', 'Data Scientist, Analyst, BI, Analytics Eng', /data (scien|analy|engineer|architect)|analytics|business intelligence|\bbi (analyst|developer|engineer)|insights analyst|statistic/i, true),
  design:   F('Technology', 'Design & UX research', 'Product Designer, UX Researcher', /\bdesigner\b|\bux\b|user experience|user research|product design|content design|\bui\b/i, true),
  support:  F('Corporate & services', 'Support & professional services', 'Support Engineer, Consultant, Services', /support (engineer|specialist|agent|manager|lead)|technical support|help ?desk|service desk|customer (support|service)|professional services|\bconsultant\b/i, true),
  finance:  F('Corporate & services', 'Finance & accounting', 'FP&A, Accounting, Controller, Procurement', /financ|accounting|accountant|controller|\bfp&a\b|treasury|\btax\b|payroll|procurement/i, true),
  people:   F('Corporate & services', 'People, HR & recruiting', 'Recruiter, HRBP, People Ops, Total Rewards', /recruit|talent (acquisition|partner)|\bhr\b|human resources|people (partner|operations|business|team)|\bhrbp\b|total rewards|\bsourcer\b/i, true),
  legal:    F('Corporate & services', 'Legal, policy & government affairs', 'Counsel, Paralegal, Public Policy', /\blegal\b|counsel|attorney|lawyer|paralegal|public policy|government (affairs|relations)|regulatory/i, true),
};
// Criteria saved before the categories were split (no fnKnown): old keys also cover their new children.
const LEGACY_FN = { strategy: ['cos', 'gtm'], sales: ['gtm', 'se'], ci: ['cs', 'enable'], pmm: ['marketing', 'demand'] };
export function selectedFunctions(c) {
  const f = c.functions || [];
  return c.fnKnown ? f : [...new Set([...f, ...f.flatMap(k => LEGACY_FN[k] || [])])];
}
export const FUNCTION_GROUPS = [...new Set(Object.values(FUNCTIONS).map(f => f.group))];
export const DEFAULT_FUNCTIONS = Object.keys(FUNCTIONS).filter(k => !FUNCTIONS[k].broad);
const ENG_REVIEW = /\b(engineer|architect)\b/i;
const ENG_GTM = /gtm|go[- ]to[- ]market|sales|solutions?|field|forward[- ]deployed|customer|partner|pre-?sales|growth|value|deployment strategist/i;
export function classifyFunctions(title = '', desc = '') {
  const hits = [];
  for (const [k, f] of Object.entries(FUNCTIONS)) if (f.re.test(title)) hits.push(k);
  const engReview = ENG_REVIEW.test(title) && ENG_GTM.test(title);
  return { functions: hits, eng_review: engReview };
}
export function seniority(title = '') {
  const t = title.toLowerCase();
  if (/\b(chief|cxo|ciso|cmo|cro|cpo|svp|evp|vice president|\bvp\b)\b/.test(t)) return 6;
  if (/\b(head of|director|sr\.? director|senior director)\b/.test(t)) return 5;
  if (/\b(principal|staff|group|lead|senior manager|sr\.? manager)\b/.test(t)) return 4;
  if (/\b(senior|sr\.?|iii)\b/.test(t)) return 3;
  if (/\b(intern|junior|jr\.?|associate|coordinator|entry|new grad|apprentice)\b/.test(t)) return 1;
  return 2;
}
export const SENIORITY_LABEL = { 1: 'Entry/associate', 2: 'Mid', 3: 'Senior', 4: 'Lead/principal', 5: 'Director/head', 6: 'VP/exec' };

/* ------------------------------------------------------------------ skills dictionary
   Used for resume extraction AND job tagging, so overlap is apples to apples. */
const SK = (group, items) => items.map(([id, re]) => ({ id, group, re: new RegExp(re, 'i') }));
export const SKILLS = [
  ...SK('Security', [
    ['XDR / EDR', String.raw`\b(x|e)dr\b|extended detection`], ['SIEM / SOAR', String.raw`\bsiem\b|\bsoar\b`], ['MDR / managed security', String.raw`\bmdr\b|managed (detection|security)|mssp`],
    ['SOC operations', String.raw`\bsoc\b|security operations`], ['Threat intelligence', String.raw`threat intel`], ['Threat hunting', String.raw`threat hunt|advanced hunting`], ['Malware analysis & reverse engineering', String.raw`malware analy|reverse engineer|\bida pro\b|ghidra`], ['OSINT', String.raw`\bosint\b|open[- ]source intelligence`], ['Threat actor tracking', String.raw`threat actor|nation[- ]state|\bapt\d*\b|adversary (tracking|research)`], ['Vulnerability research', String.raw`vulnerability research|exploit (development|research)|\bcve\b`],
    ['Incident response', String.raw`incident response|\bdfir\b`], ['Zero trust', String.raw`zero[- ]trust`], ['Identity & access', String.raw`\biam\b|identity (and|&) access|identity security|\bpam\b|privileged access`],
    ['SASE / network security', String.raw`\bsase\b|\bsse\b|\bcasb\b|network security|firewall`], ['Cloud security', String.raw`cloud security|\bcnapp\b|\bcspm\b|\bcwpp\b`], ['AppSec / DevSecOps', String.raw`appsec|application security|devsecops|software supply chain`],
    ['Data security / DLP', String.raw`data security|\bdlp\b|data loss`], ['Email security', String.raw`email security|phishing|\bbec\b`], ['Vulnerability & exposure mgmt', String.raw`vulnerability management|exposure management|attack surface`],
    ['GRC & compliance', String.raw`\bgrc\b|governance,? risk|compliance|soc ?2|iso ?27001|fedramp|nist`], ['MITRE ATT&CK', String.raw`mitre|att&ck`], ['KQL', String.raw`\bkql\b|kusto`],
    ['Microsoft Defender / Sentinel', String.raw`defender|microsoft sentinel|azure sentinel`], ['Ransomware', String.raw`ransomware`], ['OT / IoT security', String.raw`\bot security|\bics\b|operational technology|\biot\b`], ['Cybersecurity (general)', String.raw`cyber ?security|information security|infosec`],
  ]),
  ...SK('Cloud & platform', [
    ['AWS', String.raw`\baws\b|amazon web services`], ['Azure', String.raw`\bazure\b`], ['GCP', String.raw`\bgcp\b|google cloud`], ['SaaS / B2B', String.raw`\bsaas\b|\bb2b\b`], ['APIs & platforms', String.raw`\bapis?\b|platform strategy|developer platform`], ['Kubernetes / cloud native', String.raw`kubernetes|cloud[- ]native|containers`],
  ]),
  ...SK('Go-to-market', [
    ['Go-to-market strategy', String.raw`go[- ]to[- ]market|\bgtm\b`], ['Enterprise sales', String.raw`enterprise sales|strategic accounts|named accounts|enterprise customers`], ['Pipeline & revenue', String.raw`pipeline|bookings|\barr\b|quota|revenue growth`],
    ['Channel & partners', String.raw`channel|reseller|distributor|\bvar\b|\bgsi\b|systems integrator|\bmsp\b`], ['Alliances & co-sell', String.raw`alliances?|co-?sell|marketplace|\bisv\b|technology partner`],
    ['Positioning & messaging', String.raw`positioning|messaging|narrative|value proposition`], ['Launches', String.raw`product launch|launches|launch strategy`], ['Pricing & packaging', String.raw`pricing|packaging|monetization`],
    ['Demand generation', String.raw`demand gen|\babm\b|account[- ]based|campaigns?\b|pipeline generation`], ['Sales enablement', String.raw`enablement|sales readiness|playbooks?`], ['Competitive intelligence', String.raw`competitive (intel|analysis|strategy|landscape)|battle ?cards|win[/ -]loss`],
    ['Pre-sales / solutions', String.raw`pre-?sales|solutions? (engineer|architect|consult)|technical sales`], ['Customer success & adoption', String.raw`customer success|adoption|retention|expansion|\bnrr\b|churn`], ['Analyst relations', String.raw`analyst relations|gartner|forrester|\bidc\b`],
  ]),
  ...SK('Product', [
    ['Product management', String.raw`product management|product manager|\bprd\b|product requirements`], ['Product strategy & roadmap', String.raw`product strategy|roadmap|product vision`], ['0→1 incubation', String.raw`0\s?(to|→|-)\s?1|zero to one|incubat|new (product|service) introduction`],
    ['Program management', String.raw`program management|program manager|\bpmp\b|portfolio`], ['Experimentation & metrics', String.raw`a/b test|experimentation|\bokrs?\b|kpis?|north star`], ['Customer discovery', String.raw`customer discovery|user research|voice of (the )?customer`],
  ]),
  ...SK('AI', [
    ['AI / ML (general)', String.raw`\bai\b|artificial intelligence|machine learning|\bml\b`], ['Generative AI / LLMs', String.raw`generative ai|gen ?ai|\bllms?\b|large language`], ['Agents & agentic workflows', String.raw`\bagents?\b|agentic|copilot|\bmcp\b|autonomous`],
    ['AI governance', String.raw`ai governance|responsible ai|ai risk|model risk|ai safety`], ['Prompt & RAG engineering', String.raw`prompt engineering|\brag\b|retrieval[- ]augmented`], ['Automation', String.raw`automation|workflow automation|power automate|low[- ]code`],
  ]),
  ...SK('Healthcare & public health', [
    ['Healthcare', String.raw`health ?care|hospital|health system|clinical`], ['HIPAA & health data', String.raw`hipaa|\bphi\b|\behr\b|\bemr\b|epic\b`], ['Payer / provider', String.raw`payer|provider network|health plan`], ['Pharma & life sciences', String.raw`pharma|life sciences|biotech`], ['Public health / MPH', String.raw`public health|\bmph\b|epidemiolog`],
  ]),
  ...SK('Business & leadership', [
    ['MBA / business strategy', String.raw`\bmba\b|business strategy|corporate strategy`], ['P&L & business cases', String.raw`p&l|business case|financial model|unit economics`], ['Executive communication', String.raw`executive (communication|briefing|presence|stakeholder)|c-?suite|board[- ]level`],
    ['Executive advisory', String.raw`executive advis|trusted advisor|advisory`], ['Operating model & BizOps', String.raw`operating model|business operations|operating rhythm|\bqbr\b|planning cadence`], ['Chief of staff', String.raw`chief of staff`],
    ['Cross-functional leadership', String.raw`cross[- ]functional|stakeholder management|influence without authority`], ['M&A & integration', String.raw`m&a|acquisition integration|merger`],
  ]),
  ...SK('Content & community', [
    ['Thought leadership', String.raw`thought leadership|point of view|\bpov\b`], ['Webinars & events', String.raw`webinars?|events?|conferences?|keynote|\bcpe\b`], ['Content strategy', String.raw`content (strategy|marketing)|editorial|storytelling`], ['Community & advocacy', String.raw`community|advocacy|evangelism|developer relations`],
  ]),
];
export function extractSkills(text = '') {
  const out = [];
  for (const s of SKILLS) if (s.re.test(text)) out.push(s.id);
  return out;
}

/* ------------------------------------------------------------------ enrichment */
export function enrichJob(raw) {
  const text = raw.desc_text || '';
  const loc = classifyWorkplace(raw);
  const sal = chooseSalary(parseSalaries(text), raw.salary_struct || null);
  const fn = classifyFunctions(raw.title, text);
  const kw = extractSkills(raw.title + '\n' + text);
  const relevant = fn.functions.some(f => !FUNCTIONS[f].broad) || fn.eng_review;
  return {
    uid: `${raw.source_id}:${raw.ext_id}`,
    source_id: raw.source_id, ats: raw.ats, employer: raw.employer, source_class: raw.source_class || 'official',
    via: raw.via || null,
    title: raw.title, url: raw.url, req_id: raw.req_id || null, department: raw.department || null,
    locations: (raw.locations || []).slice(0, 8),
    workplace: loc.workplace, us: loc.us, remote_us: loc.remote_us, elig_text: loc.remote_us ? eligibilityText(text) || null : null,
    posted_at: raw.posted_at || null, posted_kind: raw.posted_kind || 'unknown', updated_at: raw.updated_at || null,
    salary: sal, functions: fn.functions, eng_review: fn.eng_review, seniority: seniority(raw.title),
    kw, excerpt: relevant ? text.slice(0, 900) : null,
  };
}

/* ------------------------------------------------------------------ ATS adapters (CORS-friendly ones run in the browser too)
   Each adapter receives `http` = { json(url, opts) } that returns {ok, status, data, error}.
   They return { result: 'ok'|'empty'|'http_error'|..., status, jobs: [raw], note, fields } */
const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const fail = (r, extra = {}) => ({ result: r.error === 'timeout' ? 'timeout' : r.status ? `http_${r.status}` : (r.error || 'network_error'), status: r.status || null, jobs: [], note: r.error || r.statusText || '', ...extra });

export const ADAPTERS = {
  async greenhouse(src, emp, http, opt = {}) {
    const r = await http.json(`https://boards-api.greenhouse.io/v1/boards/${src.slug}/jobs?content=true`);
    if (!r.ok) return fail(r);
    const list = r.data?.jobs;
    if (!Array.isArray(list)) return { result: 'parse_error', status: r.status, jobs: [], note: 'No jobs array in response' };
    const jobs = list.map(j => ({
      source_id: src.id, ats: 'greenhouse', employer: emp.employer, ext_id: String(j.id),
      req_id: j.requisition_id || null, title: j.title, url: j.absolute_url,
      locations: [j.location?.name, ...(j.offices || []).map(o => o.location || o.name)].filter(Boolean),
      department: (j.departments || []).map(d => d.name).join(', ') || null,
      posted_at: iso(j.first_published), posted_kind: j.first_published ? 'first_published' : 'updated_only',
      updated_at: iso(j.updated_at), desc_text: htmlToText(j.content || ''),
    }));
    return { result: jobs.length ? 'ok' : 'empty', status: r.status, jobs,
             fields: { posted_date: list.some(j => j.first_published) ? 'first_published' : 'updated_at only', salary: 'description text (+ optional pay_transparency detail)', location: 'yes', remote: 'from location text', req_id: list.some(j => j.requisition_id) ? 'yes' : 'no' } };
  },
  async lever(src, emp, http) {
    const r = await http.json(`https://api.lever.co/v0/postings/${src.slug}?mode=json`);
    if (!r.ok) return fail(r);
    if (!Array.isArray(r.data)) return { result: 'parse_error', status: r.status, jobs: [], note: 'Expected array' };
    const jobs = r.data.map(j => {
      const sr = j.salaryRange;
      const per = sr?.interval && /hour/i.test(sr.interval) ? 'hour' : 'year';
      return {
        source_id: src.id, ats: 'lever', employer: emp.employer, ext_id: j.id, title: j.text, url: j.hostedUrl,
        locations: j.categories?.allLocations?.length ? j.categories.allLocations : [j.categories?.location].filter(Boolean),
        department: j.categories?.team || j.categories?.department || null,
        workplace_hint: j.workplaceType && j.workplaceType !== 'unspecified' ? j.workplaceType.replace('on-site', 'onsite') : null,
        country: j.country || null,
        posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null, posted_kind: 'created',
        desc_text: [j.descriptionPlain, ...(j.lists || []).map(l => l.text + '\n' + htmlToText(l.content)), j.additionalPlain].filter(Boolean).join('\n'),
        salary_struct: sr && sr.min ? { min: per === 'hour' ? sr.min * 2080 : sr.min, max: per === 'hour' ? sr.max * 2080 : sr.max, period: per, kind: 'base_likely', src: 'structured', snippet: `Lever salaryRange ${sr.currency || ''} ${sr.min}–${sr.max} ${sr.interval || ''}` } : null,
      };
    });
    return { result: jobs.length ? 'ok' : 'empty', status: r.status, jobs,
             fields: { posted_date: 'createdAt', salary: 'salaryRange (when employer fills it) + text', location: 'yes', remote: 'workplaceType', req_id: 'no' } };
  },
  async ashby(src, emp, http) {
    const r = await http.json(`https://api.ashbyhq.com/posting-api/job-board/${src.slug}?includeCompensation=true`);
    if (!r.ok) return fail(r);
    const list = r.data?.jobs;
    if (!Array.isArray(list)) return { result: 'parse_error', status: r.status, jobs: [], note: 'No jobs array' };
    const jobs = list.filter(j => j.isListed !== false).map(j => {
      const comp = (j.compensation?.summaryComponents || []).find(c => /salary/i.test(c.compensationType || ''));
      const per = comp && /hour/i.test(comp.interval || '') ? 'hour' : 'year';
      return {
        source_id: src.id, ats: 'ashby', employer: emp.employer, ext_id: j.id, title: j.title, url: j.jobUrl,
        locations: [j.location, ...(j.secondaryLocations || []).map(s => s.location)].filter(Boolean),
        department: j.department || j.team || null,
        workplace_hint: j.workplaceType ? j.workplaceType.toLowerCase().replace('onsite', 'onsite') : (j.isRemote ? 'remote' : null),
        remote_hint: j.isRemote === true, country: j.address?.postalAddress?.addressCountry || null,
        posted_at: iso(j.publishedAt), posted_kind: 'published', desc_text: j.descriptionPlain || htmlToText(j.descriptionHtml || ''),
        salary_struct: comp && comp.minValue ? { min: per === 'hour' ? comp.minValue * 2080 : comp.minValue, max: per === 'hour' ? (comp.maxValue || comp.minValue) * 2080 : (comp.maxValue || comp.minValue), period: per, kind: 'base', src: 'structured', snippet: `Ashby compensation: ${j.compensation?.compensationTierSummary || ''}` } : null,
      };
    });
    return { result: jobs.length ? 'ok' : 'empty', status: r.status, jobs,
             fields: { posted_date: 'publishedAt', salary: 'structured compensation components (Salary type = base)', location: 'yes', remote: 'isRemote/workplaceType', req_id: 'no' } };
  },
};
export const BROWSER_ATS = new Set(['greenhouse', 'lever', 'ashby']);

/* ------------------------------------------------------------------ matching (shared by the app and the email digest) */
export const csvList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
export const reFromList = l => l.length ? new RegExp(l.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
export function dateFor(j, crit) {
  if (j.posted_at && j.posted_kind !== 'updated_only') return { d: j.posted_at, kind: j.posted_kind };
  if (j.posted_kind === 'updated_only' && crit.updated && j.updated_at) return { d: j.updated_at, kind: 'updated' };
  if (crit.firstSeen && j.first_observed) return { d: j.first_observed, kind: 'first_observed' };
  return { d: null, kind: 'none' };
}
export function evaluateJob(j, { crit: c, emp: e, skillsOn = [], custom = [], win = null, excl = null, tz = TZ }) {
  if (j.status === 'closed' || j.us === false) return null;
  const tiers = c.tiers || {};
  if (j.source_class === 'aggregator') { if (tiers.aggregator === false) return null; }
  else if (e && tiers[e.tier] === false) return null;
  const sector = e?.sector || 'Unclassified', vertical = e?.vertical || '';
  const sectors = c.sectors || [], verticals = c.verticals || [];
  if (sectors.length && !sectors.includes(sector)) return null;
  if (verticals.length && sector === 'Cybersecurity' && !verticals.includes(vertical)) return null;
  const sel = selectedFunctions(c), fnHit = (j.functions || []).filter(f => sel.includes(f));
  const engOnly = !fnHit.length && c.engReview && j.eng_review;
  if (!fnHit.length && !engOnly) return null;
  if (excl && excl.test(j.title)) return null;
  if (j.seniority < (c.sen || 1)) return null;
  const dt = dateFor(j, c);
  if (win) {
    if (!dt.d) return null;
    const ymd = nyDate(new Date(dt.d), tz);
    if (ymd < win.start || ymd > win.end) return null;
  }
  const tier = salaryTier(j.salary, c.minBase || 0);
  const salOk = { starts: ['starts'], starts_reaches: ['starts', 'reaches'], plus_unknown: ['starts', 'reaches', 'unknown', 'ote_only', 'predicted'], any: null }[c.salMode || 'starts_reaches'];
  if (salOk && !salOk.includes(tier)) return null;
  const hf = homeFit(j, { metro: c.metro || '', state: c.state || '' });
  let loc;
  if (hf.in_metro) loc = 'metro';
  else if (j.remote_us && ['yes', 'likely'].includes(hf.eligibility)) loc = 'remote_yes';
  else if (j.remote_us && hf.eligibility === 'no') loc = 'remote_no';
  else if (j.remote_us) loc = 'remote_unknown';
  else loc = 'other';
  if ({ metro: !c.lMetro, remote_yes: !c.lRemoteYes, remote_unknown: !c.lRemoteUnknown, other: !c.lOther, remote_no: true }[loc]) return null;
  const kw = new Set(j.kw || []);
  const skillHits = skillsOn.filter(s => kw.has(s));
  const hay = (j.title + ' ' + (j.excerpt || '')).toLowerCase();
  const customHits = [...custom, ...csvList(c.include)].filter(k => hay.includes(k.toLowerCase()));
  const sFn = fnHit.length ? 30 : 15;
  const sSkill = Math.min(25, skillHits.length * 4 + customHits.length * 4);
  const sSal = { starts: 20, reaches: 12, unknown: 6, ote_only: 3, predicted: 3 }[tier] || 0;
  const sLoc = { metro: 15, remote_yes: hf.eligibility === 'yes' ? 15 : 12, remote_unknown: 8, other: 4 }[loc];
  const sSen = j.seniority > (c.sen || 1) ? 10 : 7;
  return { j, e, sector, vertical, tier, loc, hf, dt, fnHit, skillHits, customHits, score: sFn + sSkill + sSal + sLoc + sSen,
           why: `fn ${sFn} · skills ${sSkill} · base ${sSal} · loc ${sLoc} · level ${sSen}` };
}
