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
const NON_USD = 'MXN|CAD|GBP|EUR|INR|AUD|BRL|JPY|SGD|CHF|PLN|SEK|NOK|DKK|ILS|NZD|ZAR|HKD|CNY|RMB|KRW|COP|ARS|CLP|PEN|AED|SAR|TWD|PHP|THB|IDR|MYR|CZK|HUF|RON|TRY|NIS';
const NON_USD_AFTER = new RegExp(String.raw`^\s*(?:${NON_USD})\b|^\s*(?:pesos|euros|pounds|rupees|reais|yen)\b`, 'i');
const NON_USD_BEFORE = new RegExp(String.raw`(?:\b(?:CA|C|A|AU|NZ|MX|MX\$|SG|S|HK|R|NT|NZ)|£|€|₹|¥|\b(?:${NON_USD}))\s*$`);
export const MAX_PLAUSIBLE_BASE = 1500000;
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
    // Base pay is compared in US dollars: skip ranges stated in another currency ("$912,000 - $1,254,000 MXN",
    // "CA$150,000", "C$…", "A$…"), whether the code comes before, inside or right after the numbers.
    if (/CAD|CA\$/i.test(m) || NON_USD_AFTER.test(after) || NON_USD_BEFORE.test(before)) return;
    let period = 'year';
    if (/^\s*(\/\s?|per\s|an\s)(hr|hour)|^\s*hourly/i.test(after) || /\/\s?(hr|hour)/i.test(m)) period = 'hour';
    if (/^\s*(m|mm|million|b|billion)\b/i.test(after)) return;
    if (period === 'year' && max < 1000) return; // "$5 - $10M" style noise
    const annMin = period === 'hour' ? min * 2080 : min;
    const annMax = period === 'hour' ? max * 2080 : max;
    if (annMax < 25000 || annMin > MAX_PLAUSIBLE_BASE) return; // grants, funding rounds and the like are not salaries
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
  const okStruct = structured && (!structured.currency || /^usd$/i.test(structured.currency)) && !(structured.min > MAX_PLAUSIBLE_BASE) ? structured : null;
  const all = [...(okStruct ? [okStruct] : []), ...ranges];
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
const GENERIC_LOC = /remote|anywhere|nationwide|virtual|distributed|home[- ]based|work from home|\bwfh\b|^\s*(united states( of america)?|usa?|u\.s\.a?\.?)\s*$/i;
const NATIONWIDE = /anywhere in the (u\.?s|united states)|(remote|work) (from )?anywhere in the|remote[- ](within|in|across) the (u\.?s|united states)|u\.?s\.?[- ]based,? remote|any (u\.?s\.? )?state|all (50 )?(u\.?s\.? )?states/i;
const FOREIGN_RE = /\b(india|israel|united kingdom|\buk\b|england|scotland|london|ireland|dublin|germany|berlin|munich|france|paris|spain|madrid|barcelona|netherlands|amsterdam|poland|warsaw|krakow|romania|czech|prague|ukraine|serbia|canada|canadian|toronto|vancouver|montreal|ontario|quebec|british columbia|alberta|nova scotia|mexico|costa rica|brazil|são paulo|sao paulo|argentina|colombia|chile|peru|japan|tokyo|singapore|australia|\baus\b|sydney|melbourne|new zealand|china|taiwan|korea|seoul|philippines|manila|vietnam|hong kong|uae|dubai|saudi|sweden|stockholm|switzerland|zurich|italy|milan|portugal|lisbon|denmark|norway|finland|belgium|austria|europe|emea|apac|latam|south africa|nigeria|kenya|egypt|turkey|istanbul)\b/i;
const US_MARK = /united states|\bu\.?s\.?a?\b|\busa\b/i;
// Per listed location: 'foreign', 'generic' (remote/US with no place attached), or 'place' (a US city, state or region).
export function placeKind(l = '') {
  const t = String(l);
  if (FOREIGN_RE.test(t) && !US_MARK.test(t)) return 'foreign';
  const rest = (US_MARK.test(t) ? t.replace(new RegExp(FOREIGN_RE.source, 'gi'), ' ').replace(/\b(or|and)\b|&/gi, ' ') : t).replace(/\b(remote|anywhere|nationwide|virtual|distributed|home[- ]based|work from home|wfh|hybrid|in[- ]office|on[- ]?site|flexible|united states( of america)?|usa?|u\.s\.a?\.?|north america|americas|location|locations|multiple|various|any)(?![a-z])/gi, ' ')
    .replace(/[^a-z]+/gi, ' ').trim();
  return rest ? 'place' : 'generic';
}
// Remote roles that only open to non-US places.
const splitLocs = L => (L || []).flatMap(l => String(l).split(/\s*[;|]\s*/)).filter(Boolean);
export function foreignRemote(job) {
  const L = splitLocs(job.locations);
  return !!job.remote_us && L.length > 0 && L.every(l => placeKind(l) === 'foreign');
}
const REGION_STATES = {
  'tri-state': 'NY NJ CT', 'tristate': 'NY NJ CT', 'new england': 'CT MA RI VT NH ME', 'northeast': 'NY NJ PA CT MA RI VT NH ME', 'north east': 'NY NJ PA CT MA RI VT NH ME',
  'mid-atlantic': 'NY NJ PA DE MD DC VA WV', 'mid atlantic': 'NY NJ PA DE MD DC VA WV', 'east': 'NY NJ PA CT MA RI VT NH ME DE MD DC VA WV NC SC GA FL OH MI', 'east coast': 'NY NJ PA CT MA RI VT NH ME DE MD DC VA NC SC GA FL',
  'southeast': 'GA FL NC SC TN AL MS VA KY', 'south east': 'GA FL NC SC TN AL MS VA KY', 'south': 'TX OK AR LA MS AL GA FL TN KY NC SC VA', 'southwest': 'AZ NM TX NV UT CO OK', 'south west': 'AZ NM TX NV UT CO OK',
  'central': 'TX OK KS NE SD ND MN IA MO AR LA WI IL IN MI OH CO', 'midwest': 'OH MI IN IL WI MN IA MO KS NE SD ND', 'mid-west': 'OH MI IN IL WI MN IA MO KS NE SD ND', 'great lakes': 'OH MI IN IL WI MN',
  'west': 'CA OR WA NV AZ UT CO ID MT WY NM AK HI', 'west coast': 'CA OR WA', 'pacific northwest': 'WA OR ID', 'pacnw': 'WA OR ID', 'pnw': 'WA OR ID', 'northwest': 'WA OR ID MT', 'socal': 'CA', 'norcal': 'CA', 'bay area': 'CA',
  'rockies': 'CO UT WY MT ID', 'mountain': 'CO UT WY MT ID NV AZ NM', 'texas': 'TX', 'dmv': 'DC MD VA', 'carolinas': 'NC SC',
};
const CITY_ALIAS = { la: 'CA', 'l.a.': 'CA', 'los angeles': 'CA', sf: 'CA', 'san francisco': 'CA', 'bay area': 'CA', 'silicon valley': 'CA', nyc: 'NY', 'new york city': 'NY', dfw: 'TX', 'dallas': 'TX', houston: 'TX', austin: 'TX', atl: 'GA', atlanta: 'GA', chicago: 'IL', chi: 'IL', boston: 'MA', seattle: 'WA', denver: 'CO', phoenix: 'AZ', miami: 'FL', philadelphia: 'PA', philly: 'PA', minneapolis: 'MN', detroit: 'MI', 'twin cities': 'MN', 'research triangle': 'NC', raleigh: 'NC', charlotte: 'NC', nashville: 'TN', 'salt lake city': 'UT', portland: 'OR', 'san diego': 'CA', pittsburgh: 'PA', cincinnati: 'OH', columbus: 'OH', cleveland: 'OH', 'st. louis': 'MO', 'kansas city': 'MO', dc: 'DC' };
const ABBR_SKIP = new Set(['IN', 'OR', 'ME', 'OK', 'HI', 'AI', 'IT', 'AL', 'DE', 'ID', 'PA', 'MA', 'CO']); // too ambiguous as a bare abbreviation in titles
// States a title's territory names, e.g. "AE - Seattle", "(SoCal)", "Majors - Minnesota", "Customer Engineer, Raleigh, NC".
export function territoryStates(job) {
  const title = String(job.title || ''), out = new Set();
  const segs = title.split(/\s[-–—|]\s|[(),/]|:\s/).slice(1).map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!segs.length) return out;
  const names = Object.entries(STATES);
  const cityState = new Map();
  for (const l of splitLocs(job.locations)) { const m = String(l).match(/^\s*([a-z .'-]+?),\s*([A-Z]{2})\b/i); if (m && STATES[m[2].toUpperCase()]) cityState.set(m[1].trim().toLowerCase(), m[2].toUpperCase()); }
  for (const seg of segs) {
    for (const [ab, nm] of names) if (new RegExp(`\\b${nm.toLowerCase()}\\b`).test(seg) && !(ab === 'WA' && /washington,? d\.?c/.test(seg))) out.add(ab);
    if (/washington,? d\.?c|\bd\.c\.?$/.test(seg)) out.add('DC');
    const al = CITY_ALIAS[seg.replace(/\b(region|territory|metro|area)\b/g, '').trim()]; if (al) out.add(al);
    for (const [rg, st] of Object.entries(REGION_STATES)) if (new RegExp(`^(${rg})(\\s+(region|territory|us|usa))?$`).test(seg)) st.split(' ').forEach(x => out.add(x));
    for (const [city, st] of cityState) if (city.length > 2 && new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(seg)) out.add(st);
  }
  const abbr = title.match(/,\s*([A-Z]{2})\)?\s*$/); if (abbr && STATES[abbr[1]] && !ABBR_SKIP.has(abbr[1])) out.add(abbr[1]);
  return out;
}
export function remoteTied(job, home = '') {
  const L = splitLocs(job.locations);
  const terr = territoryStates(job);
  if (terr.size) return !terr.has(String(home).toUpperCase());
  if (!L.length) return false;
  const kinds = L.map(placeKind);
  if (kinds.includes('generic')) return false;
  return !NATIONWIDE.test((job.elig_text || '') + ' ' + (job.excerpt || ''));
}
export function homeFit(job, { metro = '', state = '' } = {}) {
  const locText = (job.locations || []).join(' | ');
  const abbr = (state || '').toUpperCase();
  const name = STATES[abbr] || '';
  const metroParts = metro.split('|').map(x => x.trim()).filter(Boolean);
  const metroRe = metroParts.length ? new RegExp(`\\b(${metroParts.map(esc).join('|')})\\b`, 'i') : null;
  const inMetro = !!(metroRe && metroRe.test(locText));
  const metroLoc = inMetro ? (job.locations || []).find(l => metroRe.test(l)) || null : null;
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
  // "Remote" but every listed place is a specific city/region outside the home state, and nothing says
  // anywhere-in-the-US: a territory or office-tied role (ServiceNow work personas, regional AEs).
  const foreign = !inMetro && foreignRemote(job);
  const tied = !foreign && !!job.remote_us && !inMetro && remoteTied(job, abbr) && !(elig === 'yes' && !territoryStates(job).size);
  return { in_metro: inMetro, eligibility: foreign ? 'no' : tied ? 'tied' : elig, metro_loc: metroLoc, tied, foreign };
}
// The location to show for a role: the one that made it match (commute area, then remote, then a US place),
// not simply the first one the employer listed.
export function shownLocation(job, fit = {}, loc = '') {
  const L = job.locations || [];
  if (!L.length) return { text: '—', more: 0, all: [] };
  let pick = null;
  if (loc === 'metro' && fit.metro_loc) pick = fit.metro_loc;
  else if (loc.startsWith('remote')) pick = L.find(l => /remote|anywhere|distributed/i.test(l)) || null;
  if (!pick) pick = L.find(l => classifyWorkplace({ locations: [l] }).us === true) || L[0];
  return { text: pick, more: new Set(L).size - 1, all: [...new Set(L)] };
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
  product:  F('Product & programs', 'Product management', 'Product Manager, Group PM, Head of Product', /\bproduct\s+(manager|management|lead|owner|director|leader|strategy)|\bproduct\s+mgr\b|\b(group|principal|staff|senior|sr\.?|lead)\s+product\b(?!\s+(marketing|designer|design|security|engineer|engineering|counsel|recruiter|analyst|analytics|data|ux|ui|specialist|associate|support|writer|photographer|sales|partnerships))|\bhead of product\b|\bvp,?\s+(of\s+)?product\b|\bcpo\b/i),
  tpm:      F('Product & programs', 'Program & technical program mgmt', 'Program Manager, TPM, Portfolio Manager', /\b(technical\s+)?program manag|\btpm\b|\bprogram (lead|director)|portfolio manag/i),
  pmm:      F('Marketing', 'Product marketing', 'Product Marketing Manager, Solutions Marketing', /product marketing|\bpmm\b|solutions? marketing|portfolio marketing|competitive marketing|industry marketing/i),
  marketing:F('Marketing', 'Marketing, brand & communications', 'Brand, Content, Comms, Events, DevRel', /\bmarketing\b|\bbrand\b|communications|\bpr\b|public relations|content (strateg|market|lead|manager|writer|director)|campaign|\bevents?\b|social media|evangel|developer relations|devrel|analyst relations|community (manager|lead)|copywrit|storytell/i),
  demand:   F('Marketing', 'Demand gen, growth & lifecycle', 'Demand Gen, Growth, ABM, Field Marketing', /demand gen|\bgrowth\b|lifecycle|performance marketing|\babm\b|account[- ]based|marketing operations|field marketing|digital marketing|\bseo\b|paid (media|social|search)/i),
  sales:    F('Sales & customers', 'Sales & account management', 'Account Executive, Sales Director, BDR', /\baccount (executive|director)|\bsales\b|strategic pursuits?|capture (manager|lead|director)|commercial (lead|director|manager)|business development|\b[bs]dr\b|(security|solutions?|technology|cloud|ai|data|technical) specialist|client (partner|director)|enterprise (seller|executive)|\bterritory\b/i),
  se:       F('Sales & customers', 'Solutions & sales engineering', 'Solutions Engineer, Sales Engineer, Field CTO', /(solutions?|sales|pre-?sales|customer|field|partner|forward[- ]deployed|value) (engineer|architect|consultant)|field cto|technical (seller|specialist)|(?:forward[- ]deployed |deployment )strategist|\bpresales\b/i),
  partner:  F('Sales & customers', 'Partnerships, alliances & channel', 'Alliances, Channel, ISV, MSSP partners', /(?<!business |talent |hr |people |finance |hrbp |learning |client |acquisition |compensation |rewards |benefits |care |clinical |research |design |delivery |engagement |success )partner|alliance|channel|ecosystem|(?:cloud|aws|azure|gcp) marketplace|marketplace (?:alliances|partner)|\bisv\b|reseller|\bmssp\b|distribution (?:partner|channel|sales)|distributor|co-?sell/i),
  cs:       F('Sales & customers', 'Customer success & adoption', 'Customer Success, TAM, Adoption, Renewals', /customer success|customer (experience|outcomes|value)|adoption|value (realization|management|engineer|consult|advis)|technical account manager|\btam\b|renewal|client success|implementation (manager|lead)|onboarding/i),
  enable:   F('Sales & customers', 'Enablement & training', 'Sales Enablement, Readiness, Training', /enablement|readiness|training|learning (and|&) development|curriculum|instructional|\bacademy\b/i),
  gtm:      F('Strategy & operations', 'Go-to-market strategy & ops', 'GTM Strategy, Revenue Ops, Sales Strategy', /go[- ]to[- ]market|\bgtm\b|(revenue|sales|field|commercial|partner) (operations|strategy|planning)|rev ?ops|sales ?ops|deal (desk|strategy|op(?:eration)?s)|territory planning/i),
  strategy: F('Strategy & operations', 'Strategy & business operations', 'Strategy, BizOps, Transformation, Corp Dev', /(?:corporate|business|gtm|go[- ]to[- ]market|growth|revenue|sales|commercial|product|pricing|operations|market|global|deal|solutions|services|channel|partner(?:ship)?s?|platform|ai|security|enterprise|portfolio|ecosystem|company)\s+strateg(?:y|ies)\b|^(?:senior |sr\.? |lead |principal |staff |associate )?strategy\b|[,(|–—-]\s*strategy\b|\b(?:head|director|vp|vice president|chief|manager|lead) of (?:corporate |business |global )?strategy|\bstrategy\s*(?:&|and|\+)\s*(?:operations|ops|planning|analytics|bizops|business operations)|strategic (?:initiatives|projects|programs|planning|operations)|(?:business|corporate|gtm) strategist|business operations|biz ?ops|\boperations (?:lead|manager|director)|transformation|special projects|business planning|corporate development|\bm&a\b|\bpricing\b/i),
  cos:      F('Strategy & operations', 'Chief of staff & executive office', 'Chief of Staff, Office of the CEO/CISO', /chief of staff|office of the (ceo|cto|ciso|cio|cpo|coo|president)|executive (operations|business partner)|technical advisor to/i),
  ci:       F('Strategy & operations', 'Competitive & market intelligence', 'Competitive Intel, Market Research, Win/Loss', /competitive|market (intelligence|research|insights)|win[- ]loss|industry analyst/i),
  threat:   F('Security practice', 'Threat research & intelligence', 'Threat Intel Analyst, Security Researcher, CTI', /threat (intel|research|hunt|analy|insight|landscape|actor)|\bcti\b|(cyber|security|adversary|counter[- ]?threat|threat actor) (intelligence|research)|security researcher|(?<!business |market |competitive |sales |revenue |customer |partner |marketing )intelligence (analyst|researcher|lead|manager|director)|malware (analy|research|reverse)|reverse engineer|vulnerability research|exploit research|adversary emulation|intel(ligence)? (operations|collection|fusion)|\bosint\b/i),
  secops:   F('Security practice', 'Security operations, IR & testing', 'SOC, Incident Response, DFIR, Red Team', /security operations|\bsoc\b|incident (response|responder|handler)|\bdfir\b|forensic|detection (engineer|and response|& response)|\bmdr\b|security analyst|cyber (defense|analyst)|(blue|purple|red) team|penetration test|pen ?test|offensive security/i),
  seceng:   F('Security practice', 'Security engineering & architecture', 'Security Engineer, Cloud/AppSec, Product Security', /security (engineer|architect)|(cloud|application|product|infrastructure|network|endpoint|data) security (engineer|architect|lead|manager|analyst)|\bappsec\b|devsecops|identity (engineer|architect)|\biam (engineer|architect)|cryptograph|vulnerability (management|engineer)/i),
  grc:      F('Security practice', 'GRC, risk, privacy & trust', 'GRC, Risk, Compliance, Privacy, CISO', /\bgrc\b|governance|\brisk\b|compliance|privacy|trust (and|&) safety|security assurance|(?<!to the |of the )\bciso\b|security program|fedramp/i),
  ai:       F('Technology', 'AI product, strategy & GTM', 'AI Product Manager, AI Strategy, AI Solutions, AI Governance', /machine learning|\bml\b|\bai\b|artificial intelligence|deep learning|\bllms?\b|applied scientist|research scientist|generative|\bgenai\b|\bnlp\b|computer vision|agentic/i),
  mleng:    F('Technology', 'ML engineering & research', 'ML Engineer, Applied/Research Scientist, AI Researcher', /machine learning|\bml\b|\bai\b|artificial intelligence|deep learning|\bllms?\b|applied scientist|research scientist|\bnlp\b|computer vision/i, true),
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
const HEAD_ROLES = [
  [/\b(counsel|attorney|lawyer|paralegal)\b/i, 'legal'],
  [/\b(recruiter|sourcer|recruiting coordinator)\b/i, 'people'],
  [/\bdesigner\b/i, 'design'],
];
export function classifyFunctions(title = '', desc = '') {
  const hits = [];
  for (const [k, f] of Object.entries(FUNCTIONS)) if (f.re.test(title)) hits.push(k);
  // The job noun decides: "Commercial Counsel - US Sales" is a legal role, "Senior Product Designer" a design role.
  for (const [re, k] of HEAD_ROLES) if (re.test(title)) { hits.length = 0; hits.push(k); break; }
  // AI builders (ML engineer, research scientist) are their own category; AI product/strategy/GTM stays in `ai`.
  const builder = /\b(engineer|engineering|scientist|researcher|research|developer|programmer)\b/i.test(title) && !ENG_GTM.test(title) && !/\bproduct (manager|lead|owner)|strateg|governance|policy/i.test(title);
  if (builder && (hits.includes('ai') || hits.includes('mleng'))) { const r = hits.filter(k => k !== 'ai' && k !== 'mleng'); hits.length = 0; hits.push(...r, 'mleng'); }
  else { const at = hits.indexOf('mleng'); if (at >= 0) hits.splice(at, 1); }
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
  ...SK('Security · threat & operations', [
    ['XDR / EDR', String.raw`\b(x|e)dr\b|extended detection`], ['SIEM / SOAR', String.raw`\bsiem\b|\bsoar\b`], ['MDR / managed security', String.raw`\bmdr\b|managed (detection|security)|mssp`],
    ['SOC operations', String.raw`\bsoc\b|security operations`], ['Threat intelligence', String.raw`threat intel`], ['Threat hunting', String.raw`threat hunt|advanced hunting`], ['Detection engineering', String.raw`detection engineering|detection (rules?|content|logic)|\bsigma\b rules?|\byara\b`],
    ['Incident response', String.raw`incident response|\bdfir\b`], ['Digital forensics', String.raw`forensic|memory analysis|disk imaging`], ['Malware analysis & reverse engineering', String.raw`malware analy|reverse engineer|\bida pro\b|ghidra`],
    ['Threat actor tracking', String.raw`threat actor|nation[- ]state|\bapt\d*\b|adversary (tracking|research)`], ['OSINT', String.raw`\bosint\b|open[- ]source intelligence`], ['Dark web & cybercrime', String.raw`dark ?web|underground (forums?|markets?)|cyber ?crime`],
    ['CTI standards (STIX, MISP, Diamond)', String.raw`\bstix\b|\btaxii\b|\bmisp\b|diamond model|kill chain`], ['MITRE ATT&CK', String.raw`mitre|att&ck`], ['Ransomware', String.raw`ransomware`],
    ['Vulnerability research', String.raw`vulnerability research|exploit (development|research)|\bcve\b`], ['Red team / penetration testing', String.raw`red team|penetration test|\bpen ?test|offensive security|ethical hack`], ['Purple team & adversary emulation', String.raw`purple team|adversary emulation|breach and attack simulation`],
    ['Threat modeling', String.raw`threat model`], ['Security research', String.raw`security research`], ['Deception', String.raw`deception technolog|honeypot|honeytoken`],
    ['Insider risk', String.raw`insider (risk|threat)`], ['Fraud & trust and safety', String.raw`fraud (detection|prevention|risk|analytics|operations|investigat|strategy)|trust (and|&) safety|anti-?abuse|abuse prevention`], ['Tabletop & crisis exercises', String.raw`tabletop|crisis (communication|management|simulation)|breach (response|notification)`],
    ['KQL', String.raw`\bkql\b|kusto`], ['SPL / Splunk', String.raw`splunk|\bspl\b`], ['Scripting (Python / PowerShell)', String.raw`\bpython\b|powershell`], ['SQL', String.raw`\bsql\b`],
  ]),
  ...SK('Security · domains', [
    ['Cybersecurity (general)', String.raw`cyber ?security|information security|infosec`], ['Zero trust', String.raw`zero[- ]trust`], ['Security architecture', String.raw`security architect`],
    ['Identity & access', String.raw`\biam\b|identity (and|&) access|identity security|\bpam\b|privileged access`], ['Identity threat detection (ITDR)', String.raw`\bitdr\b|identity threat`], ['Endpoint security', String.raw`endpoint (security|protection)|\bepp\b|anti-?virus|anti-?malware`],
    ['SASE / network security', String.raw`\bsase\b|\bsse\b|\bcasb\b|network security|firewall`], ['Web, API & DDoS protection', String.raw`\bwaf\b|web application firewall|ddos|bot (management|mitigation)|api security`], ['DNS security', String.raw`dns security|protective dns`],
    ['Cloud security', String.raw`cloud security|\bcnapp\b|\bcspm\b|\bcwpp\b`], ['CIEM & entitlements', String.raw`\bciem\b|entitlement management|cloud entitlements`], ['Container & workload security', String.raw`container security|workload protection|runtime security|kubernetes security`],
    ['SaaS security (SSPM)', String.raw`\bsspm\b|saas security`], ['AppSec / DevSecOps', String.raw`appsec|application security|devsecops|software supply chain`], ['Supply chain & SBOM', String.raw`\bsbom\b|supply chain security|software composition|\bsast\b|\bdast\b`],
    ['Data security / DLP', String.raw`data security|\bdlp\b|data loss`], ['Data security posture (DSPM)', String.raw`\bdspm\b|data security posture`], ['Encryption, PKI & secrets', String.raw`\bpki\b|encryption|key management|\bkms\b|secrets management|cryptograph`],
    ['Post-quantum cryptography', String.raw`post-?quantum|quantum[- ](safe|resistant)`], ['Email security', String.raw`email security|phishing|\bbec\b`], ['Browser security', String.raw`browser security|enterprise browser|secure browser`],
    ['Mobile security', String.raw`mobile security|mobile threat|\bmdm\b`], ['Vulnerability & exposure mgmt', String.raw`vulnerability management|exposure management|attack surface|\bctem\b`], ['Security awareness & human risk', String.raw`security awareness|human risk|phishing simulation`],
    ['AI security', String.raw`ai security|securing ai|security for ai|llm security|prompt injection|model security|ai red team`], ['OT / IoT security', String.raw`\bot security|\bics\b|operational technology|\biot\b`], ['Cyber resilience & backup', String.raw`cyber resilience|cyber recovery|immutable backup|backup (and|&) recovery`],
    ['Privacy', String.raw`privacy (program|engineer|compliance|regulation|counsel|by design|operations|impact|law)|data privacy|\bgdpr\b|\bccpa\b`],
  ]),
  ...SK('Security · risk & compliance', [
    ['GRC & compliance', String.raw`\bgrc\b|governance,? risk|compliance|soc ?2|iso ?27001|fedramp|nist`], ['Security program & strategy', String.raw`security (program|strategy|roadmap|leadership)|\bciso\b|\bvciso\b|office of the ciso`],
    ['Cyber risk & quantification', String.raw`cyber risk|risk quantification|fair (model|methodology)|risk assessment`], ['Third-party & vendor risk', String.raw`third[- ]party risk|vendor risk|\btprm\b|supply chain risk`],
    ['FedRAMP, CMMC & public sector', String.raw`fedramp|\bcmmc\b|\bfisma\b|stateramp|\bitar\b|impact level [2-6]|\bil[2456]\b`], ['PCI, HIPAA & SOX', String.raw`pci[- ]?dss|\bpci\b|\bsox\b|sarbanes`],
    ['ISO 27001 / SOC 2 / ISO 42001', String.raw`soc ?2|iso ?27001|iso ?42001`], ['NIST CSF / 800-53', String.raw`nist (csf|cybersecurity framework|800|sp ?800)|800-53|800-171`],
    ['Cyber regulation (SEC, NIS2, DORA)', String.raw`\bnis ?2\b|\bdora\b|sec (cyber|disclosure)|incident reporting rule|\bcircia\b`], ['Audit', String.raw`\baudit`], ['Cyber insurance', String.raw`cyber insurance`],
    ['Security metrics & board reporting', String.raw`security metrics|board reporting|risk reporting|board of directors`],
  ]),
  ...SK('Security · platforms & credentials', [
    ['Microsoft Defender / Sentinel', String.raw`defender|microsoft sentinel|azure sentinel`], ['Microsoft Entra / Purview / Intune', String.raw`\bentra\b|azure ad|purview|intune|active directory`], ['CrowdStrike', String.raw`crowdstrike`],
    ['Palo Alto Networks', String.raw`palo alto networks|prisma (cloud|access)|cortex (xsiam|xdr|xsoar)`], ['Google SecOps / Mandiant', String.raw`mandiant|chronicle|google secops|google security operations|virustotal`], ['Zscaler / Netskope / Cloudflare', String.raw`zscaler|netskope|cloudflare`],
    ['Okta / CyberArk', String.raw`\bokta\b|cyberark`], ['Wiz / CNAPP vendors', String.raw`\bwiz\b|orca security|lacework|sysdig`], ['Elastic / OpenSearch', String.raw`elastic (security|siem|stack)|elasticsearch|opensearch`],
    ['AWS security services', String.raw`guardduty|security hub|aws security|amazon inspector`], ['ServiceNow', String.raw`servicenow`],
    ['CISSP / CISM / CCSP', String.raw`\bcissp\b|\bcism\b|\bccsp\b|\bcisa\b certif`], ['GIAC / OSCP / CEH', String.raw`\bgiac\b|\bgc(ih|ia|ti|fa|ed)\b|\boscp\b|\bceh\b`], ['CompTIA Security+', String.raw`security\+|comptia`], ['Security clearance', String.raw`security clearance|top secret|ts/sci|secret clearance|\bclearance\b`],
  ]),
  ...SK('Cloud & platform', [
    ['AWS', String.raw`\baws\b|amazon web services`], ['Azure', String.raw`\bazure\b`], ['GCP', String.raw`\bgcp\b|google cloud`], ['SaaS / B2B', String.raw`\bsaas\b|\bb2b\b`], ['APIs & platforms', String.raw`\bapis?\b|platform strategy|developer platform`], ['Kubernetes / cloud native', String.raw`kubernetes|cloud[- ]native|containers`],
    ['Data platforms (Snowflake, Databricks)', String.raw`snowflake|databricks|data lake|lakehouse`], ['Observability', String.raw`observability|datadog|telemetry|opentelemetry`], ['Infrastructure as code', String.raw`terraform|infrastructure as code|\biac\b|cloudformation|bicep`],
  ]),
  ...SK('Sales', [
    ['Enterprise sales', String.raw`enterprise sales|strategic accounts|named accounts|enterprise customers`], ['Pipeline & revenue', String.raw`pipeline|bookings|\barr\b|quota|revenue growth`], ['New logo acquisition', String.raw`new logos?|new business|net[- ]new|hunter`],
    ['Account management & expansion', String.raw`account management|upsell|cross-?sell|land[- ]and[- ]expand|install base`], ['Renewals', String.raw`renewals?`], ['Sales methodology (MEDDICC, Challenger)', String.raw`\bmeddp?ic+\b|challenger|command of the message|value selling|solution selling|consultative selling|sandler|spin selling`],
    ['Complex deals & negotiation', String.raw`negotiat|complex (sales|deals)|deal (strategy|structuring)|multi-?year (deals|agreements)|enterprise agreements?`], ['Forecasting & deal desk', String.raw`forecast|deal desk`], ['RevOps & CRM', String.raw`revops|revenue operations|sales operations|salesforce|hubspot|\bcrm\b|\bclari\b|\bgong\b`],
    ['Territory & account planning', String.raw`territory|account plan`], ['Sales development (SDR/BDR)', String.raw`\bsdrs?\b|\bbdrs?\b|sales development|inside sales`], ['Overlay & specialist sales', String.raw`overlay|specialist sales|solution specialist|specialist team`],
    ['Sales leadership', String.raw`sales (leader|management|manager)|regional (vice president|director)|\brvp\b|first[- ]line (sales )?manager`], ['Cloud marketplace & private offers', String.raw`private offers?|\bcppo\b|(aws|azure|google cloud|cloud) marketplace|marketplace (listing|transact)`],
    ['Executive & C-suite selling', String.raw`c-?level (selling|relationships)|executive (selling|sponsor)|ciso relationships|selling to (the )?ciso`],
  ]),
  ...SK('Partnerships & alliances', [
    ['Channel & partners', String.raw`channel|reseller|distributor|\bvar\b|\bgsi\b|systems integrator|\bmsp\b`], ['Alliances & co-sell', String.raw`alliances?|co-?sell|marketplace|\bisv\b|technology partner`],
    ['Hyperscaler partnerships', String.raw`hyperscaler|(aws|azure|microsoft|google cloud|gcp) (partner|alliance)|cloud alliances?|\bmacc\b|\bedp\b|committed spend`], ['GSI & consulting partners', String.raw`global system integrators?|\bgsis?\b|accenture|deloitte|kpmg|\bpwc\b|capgemini|booz allen`],
    ['MSSP / MSP partners', String.raw`\bmssps?\b|\bmsps?\b|managed service providers?`], ['Technology ecosystem & integrations', String.raw`ecosystem|integration partners?|technology alliances?|tech partners?|partner integrations?`],
    ['Partner programs & incentives', String.raw`partner (program|incentive|tier)|\bmdf\b|market development funds|rebates?|partner funding`], ['Partner marketing', String.raw`partner marketing|through-?channel|co-?marketing|joint marketing`],
    ['Partner enablement', String.raw`partner (enablement|training|certification|readiness)`], ['Business development & strategic partnerships', String.raw`business development|strategic partnerships?|corporate development|\boem\b|white[- ]label`],
    ['Partner sales & recruitment', String.raw`partner (sales|recruit|acquisition|sourced)|partner[- ]led|partner pipeline`],
  ]),
  ...SK('Marketing', [
    ['Go-to-market strategy', String.raw`go[- ]to[- ]market|\bgtm\b`], ['Product marketing', String.raw`product marketing|\bpmms?\b`], ['Positioning & messaging', String.raw`positioning|messaging|narrative|value proposition`],
    ['Launches', String.raw`product launch|launches|launch strategy`], ['Pricing & packaging', String.raw`pricing|packaging|monetization`], ['Competitive intelligence', String.raw`competitive (intel|analysis|strategy|landscape)|battle ?cards|win[/ -]loss`],
    ['Market research & segmentation', String.raw`market research|segmentation|\bicp\b|ideal customer profile|buyer personas?|\btam\b|market sizing`], ['Analyst relations', String.raw`analyst relations|gartner|forrester|\bidc\b`],
    ['Demand generation', String.raw`demand gen|\babm\b|account[- ]based|campaigns?\b|pipeline generation`], ['Digital & performance marketing', String.raw`digital marketing|performance marketing|paid (media|search|social)|\bsem\b|\bppc\b`], ['SEO', String.raw`\bseo\b|search engine optimi`],
    ['Lifecycle & growth marketing', String.raw`lifecycle marketing|growth marketing|product[- ]led growth|\bplg\b|nurture`], ['Marketing operations & automation', String.raw`marketing (operations|automation|ops)|marketo|eloqua|pardot`], ['Marketing analytics & attribution', String.raw`attribution|marketing analytics|\bmqls?\b|marketing[- ]sourced`],
    ['Field & event marketing', String.raw`field marketing|event marketing|trade ?shows?|sponsorships?|executive (dinners|roundtables)|roadshows?`], ['Brand', String.raw`brand (strategy|marketing|management|awareness|identity|campaigns?)|branding`], ['Customer marketing & references', String.raw`customer marketing|case stud(y|ies)|customer references?|reference program`],
    ['PR & communications', String.raw`public relations|media relations|corporate comm|press releases?|\bpr (strategy|agency|team)\b`], ['Social media', String.raw`social media|linkedin (strategy|presence|content)`], ['Technical marketing', String.raw`technical marketing|\btmes?\b|demo (creation|development|environments?)`],
  ]),
  ...SK('Customer & solutions', [
    ['Pre-sales / solutions', String.raw`pre-?sales|solutions? (engineer|architect|consult)|technical sales`], ['Proof of concept / value', String.raw`proof[- ]of[- ](concept|value)|\bpo[cv]s?\b|technical (evaluation|validation)`], ['Demos & workshops', String.raw`\bdemos?\b|workshops?|envisioning|technical deep[- ]dives?`],
    ['RFPs & security questionnaires', String.raw`\brf[piq]s?\b|security questionnaires?|proposal (writing|responses?)`], ['Value engineering & ROI', String.raw`value engineering|business value|\broi\b|\btco\b`], ['Sales enablement', String.raw`enablement|sales readiness|playbooks?`],
    ['Customer success & adoption', String.raw`customer success|adoption|retention|expansion|\bnrr\b|churn`], ['Technical account management', String.raw`technical account manag`], ['Professional services & delivery', String.raw`professional services|implementation (services|consult|manag|engineer|projects?)|deployment services|customer onboarding`],
    ['Customer advisory boards', String.raw`customer advisory (board|council)|\bcab\b`], ['Escalation management', String.raw`escalation`], ['Training & certification programs', String.raw`training (programs?|curricul)|certification programs?|learning (programs?|paths?)|instructional design`],
  ]),
  ...SK('Product', [
    ['Product management', String.raw`product management|product manager|\bprd\b|product requirements`], ['Product strategy & roadmap', String.raw`product strategy|roadmap|product vision`], ['0→1 incubation', String.raw`0\s?(to|→|-)\s?1|zero to one|incubat|new (product|service) introduction`],
    ['Security product management', String.raw`security product (manag|lead|strateg)`], ['Technical / platform product', String.raw`technical product manag|platform product|api product`], ['Product operations', String.raw`product op(eration)?s`],
    ['Market requirements (MRD)', String.raw`\bmrd\b|market requirements`], ['Program management', String.raw`program management|program manager|\bpmp\b|portfolio`], ['Agile delivery', String.raw`\bagile\b|\bscrum\b|kanban|\bjira\b`],
    ['Experimentation & metrics', String.raw`a/b test|experimentation|\bokrs?\b|kpis?|north star`], ['Customer discovery', String.raw`customer discovery|user research|voice of (the )?customer`],
  ]),
  ...SK('AI', [
    ['AI / ML (general)', String.raw`\bai\b|artificial intelligence|machine learning|\bml\b`], ['Generative AI / LLMs', String.raw`generative ai|gen ?ai|\bllms?\b|large language`], ['Agents & agentic workflows', String.raw`\bagents?\b|agentic|copilot|\bmcp\b|autonomous`],
    ['AI for security operations', String.raw`security copilot|ai[- ](driven|powered|native) (soc|security)|\bai soc\b|autonomous soc`], ['AI platforms (OpenAI, Bedrock, Vertex)', String.raw`openai|anthropic|bedrock|vertex ai|gemini|hugging ?face`],
    ['AI governance', String.raw`ai governance|responsible ai|ai risk|model risk|ai safety`], ['Model evaluation', String.raw`model evaluation|llm evaluation|\bevals\b`], ['Prompt & RAG engineering', String.raw`prompt engineering|\brag\b|retrieval[- ]augmented`],
    ['AI product & GTM', String.raw`ai (products?|go-to-market|gtm|solutions|adoption)`], ['Automation', String.raw`automation|workflow automation|power automate|low[- ]code`],
  ]),
  ...SK('Markets & segments', [
    ['Public sector & federal', String.raw`public sector|federal (agenc|government|customers|civilian|sales|market|systems|programs)|government (agenc|customers|sector|clients)|\bdod\b|department of defense|state and local government|\bsled\b|civilian agenc|intelligence community`], ['Financial services', String.raw`financial services|banking|fintech|\bfsi\b|insurance`],
    ['Critical infrastructure', String.raw`critical infrastructure|energy (sector|and utilities)|utilit(y|ies) (sector|customers|industry)|industrial (control|cyber|security)|manufacturing (sector|customers|industry)`], ['Mid-market & SMB', String.raw`mid-?market|\bsmbs?\b|small (and|&) medium`], ['Fortune 500 / strategic', String.raw`fortune (100|500|1000) (customers|accounts|companies|clients)|global 2000|\bg2k\b`],
    ['Global & international (EMEA/APAC)', String.raw`\bemea\b|\bapac\b|\blatam\b|international markets|global (markets|regions)`],
  ]),
  ...SK('Healthcare & public health', [
    ['Healthcare', String.raw`health ?care|hospital|health system|clinical`], ['HIPAA & health data', String.raw`hipaa|\bphi\b|\behr\b|\bemr\b|epic\b`], ['Payer / provider', String.raw`payer|provider network|health plan`], ['Pharma & life sciences', String.raw`pharma|life sciences|biotech`], ['Public health / MPH', String.raw`public health|\bmph\b|epidemiolog`],
  ]),
  ...SK('Business & leadership', [
    ['MBA / business strategy', String.raw`\bmba\b|business strategy|corporate strategy`], ['P&L & business cases', String.raw`p&l|business case|financial model|unit economics`], ['Executive communication', String.raw`executive (communication|briefing|presence|stakeholder)|c-?suite|board[- ]level`],
    ['Executive advisory', String.raw`executive advis|trusted advisor|advisory`], ['Operating model & BizOps', String.raw`operating model|business operations|operating rhythm|\bqbr\b|planning cadence`], ['Chief of staff', String.raw`chief of staff`],
    ['Cross-functional leadership', String.raw`cross[- ]functional|stakeholder management|influence without authority`], ['People leadership', String.raw`people manag|direct reports|build(ing)? (and lead(ing)? )?(high[- ]performing )?teams`], ['Change & transformation', String.raw`change management|(digital|business|security|cloud) transformation|transformation (program|office|initiatives?)`],
    ['M&A & integration', String.raw`m&a|acquisition integration|merger`],
  ]),
  ...SK('Content & community', [
    ['Thought leadership', String.raw`thought leadership|point of view|\bpov\b`], ['Content strategy', String.raw`content (strategy|marketing)|editorial|storytelling`], ['Research & threat reports', String.raw`threat reports?|research reports?|white ?papers?|e-?books?`],
    ['Technical writing & blogs', String.raw`technical writing|blogs?\b|documentation`], ['Webinars & events', String.raw`webinars?|events?|conferences?|keynote|\bcpe\b`], ['Public speaking', String.raw`public speaking|speaker|keynote|panel(ist)?s?\b`],
    ['Podcasts & video', String.raw`podcasts?|video (content|series)|youtube`], ['Security community & conferences', String.raw`bsides|def ?con|black ?hat|\brsac\b|rsa conference|owasp|\bissa\b|isaca|infragard|\bisc2\b`], ['Community & advocacy', String.raw`community|advocacy|evangelism|developer relations`],
  ]),
];

// Tags a posting. The employer's own name is removed first, so a vendor skill (CrowdStrike, Okta, Cloudflare…)
// means the role works with that product, not that the employer is that vendor.
const CO_SUFFIX = /[,.]?\s+(inc|llc|ltd|corp(oration)?|co|plc|gmbh|holdings|technologies|group)\.?$/i;
export function jobSkills(employer = '', text = '') {
  const name = String(employer).replace(CO_SUFFIX, '').trim();
  if (name.length >= 3) {
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = [name, ...(name.split(/\s+/)[0].length >= 5 ? [name.split(/\s+/)[0]] : [])];
    text = text.replace(new RegExp(`\\b(${parts.map(esc).join('|')})\\b`, 'gi'), ' ');
  }
  return extractSkills(text);
}
export function extractSkills(text = '') {
  const out = [];
  for (const s of SKILLS) if (s.re.test(text)) out.push(s.id);
  return out;
}

/* ------------------------------------------------------------------ enrichment */
// A posting whose main (first) location is outside the US and whose only stated pay is in another currency
// is a non-US role, even when the ATS also lists "United States" among its locations (e.g. "Remote (Canada)",
// "Canada", "United States" with a CAD-only pay range).
const BARE_US = /^\s*(?:united states(?: of america)?|usa|us|u\.s\.a?\.?)\s*$/i;
// main location abroad, and the only US entry (if any) is a bare "United States" with no US city or state
export function abroadFirst(locations = []) {
  if (!locations.length || classifyWorkplace({ locations: [locations[0]] }).us !== false) return false;
  return !locations.slice(1).some(l => !BARE_US.test(l) && classifyWorkplace({ locations: [l] }).us === true);
}
export function foreignOnly(locations = [], text = '', usdSalary = null) {
  if (!locations.length || usdSalary) return false;
  if (!abroadFirst(locations)) return false;
  return new RegExp(String.raw`\d[\d,.]*\s*(?:${NON_USD})\b|\b(?:CA|C|A|AU|MX)\$\s?\d|£\s?\d|€\s?\d`).test(text);
}
export function enrichJob(raw) {
  const text = raw.desc_text || '';
  const loc0 = classifyWorkplace(raw);
  const sal = chooseSalary(parseSalaries(text), raw.salary_struct || null);
  const loc = foreignOnly(raw.locations, text, sal && sal.min != null ? sal : null) ? { ...loc0, us: false, remote_us: false } : loc0;
  const fn = classifyFunctions(raw.title, text);
  const kw = jobSkills(raw.employer, raw.title + '\n' + text);
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
    const r = await http.json(`https://boards-api${src.region === 'eu' ? '.eu' : ''}.greenhouse.io/v1/boards/${src.slug}/jobs?content=true`);
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
        salary_struct: sr && sr.min ? { min: per === 'hour' ? sr.min * 2080 : sr.min, max: per === 'hour' ? sr.max * 2080 : sr.max, period: per, kind: 'base_likely', src: 'structured', currency: sr.currency || null, snippet: `Lever salaryRange ${sr.currency || ''} ${sr.min}–${sr.max} ${sr.interval || ''}` } : null,
      };
    });
    return { result: jobs.length ? 'ok' : 'empty', status: r.status, jobs,
             fields: { posted_date: 'createdAt', salary: 'salaryRange (when employer fills it) + text', location: 'yes', remote: 'workplaceType', req_id: 'no' } };
  },
  async ashby(src, emp, http) {
    const r = await http.json(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(src.slug)}?includeCompensation=true`);
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
        salary_struct: comp && comp.minValue ? { min: per === 'hour' ? comp.minValue * 2080 : comp.minValue, max: per === 'hour' ? (comp.maxValue || comp.minValue) * 2080 : (comp.maxValue || comp.minValue), period: per, kind: 'base', src: 'structured', currency: comp.currencyCode || null, snippet: `Ashby compensation: ${j.compensation?.compensationTierSummary || ''}` } : null,
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
// Company type: big tech & large companies, established security companies, startups & growth-stage,
// or roles found through aggregators. Older registries/criteria used tiers (heavy/named/core).
const TIER_TYPE = { heavy: 'big', named: 'security', core: 'growth' };
export function companyType(j, e) { return j?.source_class === 'aggregator' ? 'aggregator' : (e?.type || TIER_TYPE[e?.tier] || 'growth'); }
export function companyTypeFilter(c) {
  if (c.types) return c.types;
  const t = c.tiers || {}, out = {};
  for (const [tier, ty] of Object.entries(TIER_TYPE)) if (t[tier] === false) out[ty] = false;
  if (t.aggregator === false) out.aggregator = false;
  return out;
}
/* Title variants per job category, used for outside searches (LinkedIn, Indeed, Google, ATS x-ray, aggregators).
   Ordered by how common the title is; outside searches use the first few when a site limits query length. */
export const FN_TERMS = {
  product: ['product manager', 'senior product manager', 'principal product manager', 'group product manager', 'director of product', 'head of product', 'product lead', 'technical product manager'],
  tpm: ['technical program manager', 'program manager', 'senior program manager', 'program director', 'engineering program manager', 'portfolio manager'],
  pmm: ['product marketing manager', 'senior product marketing manager', 'director of product marketing', 'head of product marketing', 'product marketing lead', 'solutions marketing manager', 'technical marketing manager'],
  marketing: ['marketing manager', 'content marketing', 'brand marketing', 'communications manager', 'field marketing', 'marketing director', 'head of marketing'],
  demand: ['demand generation', 'growth marketing', 'lifecycle marketing', 'ABM manager', 'marketing operations', 'head of growth', 'performance marketing'],
  sales: ['account executive', 'enterprise account executive', 'strategic account executive', 'sales director', 'regional sales manager', 'account manager', 'head of sales'],
  se: ['solutions engineer', 'sales engineer', 'solutions architect', 'customer engineer', 'field CTO', 'presales engineer', 'technical account manager'],
  partner: ['partner manager', 'partnerships manager', 'alliances manager', 'channel manager', 'partner development manager', 'ISV partnerships', 'head of partnerships', 'strategic alliances director'],
  cs: ['customer success manager', 'technical account manager', 'customer success director', 'head of customer success', 'adoption manager', 'renewals manager'],
  enable: ['sales enablement', 'revenue enablement', 'enablement manager', 'GTM enablement', 'sales readiness', 'partner enablement'],
  gtm: ['go-to-market', 'GTM strategy', 'GTM operations', 'revenue operations', 'sales strategy', 'commercial strategy', 'GTM lead'],
  strategy: ['strategy and operations', 'business operations', 'strategic initiatives', 'corporate strategy', 'strategy manager', 'corporate development', 'business strategy'],
  cos: ['chief of staff', 'chief of staff to the CEO', 'chief of staff to the CISO', 'office of the CEO', 'executive business partner'],
  ci: ['competitive intelligence', 'market intelligence', 'competitive strategy', 'market research manager', 'win loss analyst', 'industry analyst'],
  threat: ['threat intelligence', 'threat researcher', 'security researcher', 'threat intelligence analyst', 'CTI analyst', 'malware researcher', 'threat hunter'],
  secops: ['security operations', 'incident response', 'SOC manager', 'detection and response', 'DFIR', 'red team', 'penetration tester'],
  seceng: ['security engineer', 'security architect', 'cloud security engineer', 'application security', 'product security', 'security engineering manager'],
  grc: ['GRC', 'governance risk compliance', 'security compliance', 'risk manager', 'privacy program manager', 'trust and safety', 'security assurance'],
  ai: ['AI product manager', 'AI strategy', 'AI solutions', 'AI go-to-market', 'AI governance', 'AI partnerships', 'AI transformation'],
  mleng: ['machine learning engineer', 'ML engineer', 'AI engineer', 'applied scientist', 'research scientist', 'AI researcher'],
  eng: ['software engineer', 'senior software engineer', 'staff software engineer', 'engineering manager', 'platform engineer', 'site reliability engineer'],
  data: ['data scientist', 'data analyst', 'analytics engineer', 'business intelligence', 'data engineer', 'analytics manager'],
  design: ['product designer', 'UX designer', 'UX researcher', 'design lead', 'design manager'],
  support: ['professional services consultant', 'implementation manager', 'support engineer', 'solutions consultant', 'customer support manager'],
  finance: ['finance manager', 'FP&A', 'strategic finance', 'controller', 'finance director'],
  people: ['recruiter', 'technical recruiter', 'people partner', 'HR business partner', 'talent acquisition'],
  legal: ['counsel', 'product counsel', 'privacy counsel', 'policy manager', 'government affairs'],
};
// "a" OR "b" OR … for sites that take boolean queries; cap keeps long queries under search-engine limits
export const orQuery = (terms, cap = 99) => terms.slice(0, cap).map(t => `"${t}"`).join(' OR ');
export function evaluateJob(j, { crit: c, emp: e, skillsOn = [], custom = [], win = null, excl = null, tz = TZ, force = false }) {
  // force: a role the user is tracking stays visible even when it no longer passes the filters
  if (!force && (j.status === 'closed' || j.us === false)) return null;
  if (!force && foreignRemote(j)) return null;
  const ty = companyType(j, e), types = companyTypeFilter(c);
  if (types[ty] === false) if (!force) return null;
  const sector = e?.sector || 'Unclassified', vertical = e?.vertical || '';
  const sectors = c.sectors || [], verticals = c.verticals || [];
  // Industry filter: picked industries plus the industries of any picked subcategories (none = all).
  // Within an industry that has picked subcategories, only those subcategories pass.
  const vSec = v => (c.vertSectors || {})[v] || 'Cybersecurity';
  const inSecs = new Set([...sectors, ...verticals.map(vSec)]);
  if (inSecs.size && !inSecs.has(sector)) if (!force) return null;
  const myVerts = verticals.filter(v => vSec(v) === sector);
  if (myVerts.length && !myVerts.includes(vertical)) if (!force) return null;
  const sel = selectedFunctions(c), fnHit = (j._fn || (j._fn = classifyFunctions(j.title).functions)).filter(f => sel.includes(f));
  const engOnly = !fnHit.length && c.engReview && j.eng_review;
  if (!fnHit.length && !engOnly) if (!force) return null;
  if (excl && excl.test(j.title)) if (!force) return null;
  if (j.seniority < (c.sen || 1)) if (!force) return null;
  const dt = dateFor(j, c);
  if (win) {
    if (!dt.d) if (!force) return null;
    const ymd = nyDate(new Date(dt.d), tz);
    if (ymd < win.start || ymd > win.end) if (!force) return null;
  }
  // Stored before the currency fix: drop pay that was really another currency or not a salary at all.
  if (j.salary && (j.salary.min > MAX_PLAUSIBLE_BASE || new RegExp(String.raw`\d\s*(?:${NON_USD})\b|CA\$|\bC\$`).test(j.salary.snippet || ''))) {
    // stored before the currency fix: the pay was another currency, and if the main location is outside the US, so is the role
    if (!force && abroadFirst(j.locations || [])) return null;
    j = { ...j, salary: null };
  }
  const tier = salaryTier(j.salary, c.minBase || 0);
  const salOk = { starts: ['starts'], starts_reaches: ['starts', 'reaches'], plus_unknown: ['starts', 'reaches', 'unknown', 'ote_only', 'predicted'], any: null }[c.salMode || 'starts_reaches'];
  if (salOk && !salOk.includes(tier)) if (!force) return null;
  const hf = homeFit(j, { metro: c.metro || '', state: c.state || '' });
  let loc;
  if (hf.in_metro) loc = 'metro';
  else if (hf.tied) loc = 'other';
  else if (j.remote_us && ['yes', 'likely'].includes(hf.eligibility)) loc = 'remote_yes';
  else if (j.remote_us && hf.eligibility === 'no') loc = 'remote_no';
  else if (j.remote_us) loc = 'remote_unknown';
  else loc = 'other';
  if ({ metro: !c.lMetro, remote_yes: !c.lRemoteYes, remote_unknown: !c.lRemoteUnknown, other: !c.lOther, remote_no: true }[loc]) if (!force) return null;
  // stored kw comes from the collector; re-tag from title + excerpt so skills added since the last run still match
  const kw = j._kw || (j._kw = new Set([...(j.kw || []), ...jobSkills(j.employer, j.title + '\n' + (j.excerpt || ''))]));
  const skillHits = skillsOn.filter(s => kw.has(s));
  const hay = (j.title + ' ' + (j.excerpt || '')).toLowerCase();
  const customHits = [...custom, ...csvList(c.include)].filter(k => hay.includes(k.toLowerCase()));
  const sFn = fnHit.length ? 30 : 15;
  const sSkill = Math.min(25, skillHits.length * 4 + customHits.length * 4);
  const sSal = { starts: 20, reaches: 12, unknown: 6, ote_only: 3, predicted: 3 }[tier] || 0;
  const sLoc = { remote_no: 0, metro: 15, remote_yes: hf.eligibility === 'yes' ? 15 : 12, remote_unknown: 8, other: 4 }[loc];
  const sSen = j.seniority > (c.sen || 1) ? 10 : 7;
  return { j, e, sector, vertical, tier, loc, hf, dt, fnHit, skillHits, customHits, score: sFn + sSkill + sSal + (sLoc || 0) + sSen, parts: { fn: sFn, skills: sSkill, base: sSal, loc: sLoc || 0, level: sSen },
           why: `fn ${sFn} · skills ${sSkill} · base ${sSal} · loc ${sLoc} · level ${sSen}` };
}
