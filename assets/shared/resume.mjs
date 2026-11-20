// Resume / LinkedIn-PDF text → profile. Pure function so it can be tested in Node.
import { STATES, extractSkills, classifyFunctions, seniority, SKILLS } from './core.mjs?v=20261120y';

export const CRED_RES = [
  ['MBA', /\bM\.?B\.?A\b/], ['MPH', /\bM\.?P\.?H\b/], ['MS / MSc', /\b(M\.?S\.?c?|Master of Science)\b/], ['MA', /\b(M\.A\.|Master of Arts)\b/], ['PhD', /\bPh\.?D\b/], ['JD', /\bJ\.D\.?(?=\s|,|$)/], ['MD', /\bM\.D\.\b/],
  ['BA / BS', /\b(B\.A\.|B\.S\.c?|BA|BS|BSc|Bachelor)\b/], ['PMP', /\bPMP\b/], ['CISSP', /\bCISSP\b/], ['CISM', /\bCISM\b/], ['CISA', /\bCISA\b/], ['CCSP', /\bCCSP\b/], ['CEH', /\bCEH\b/], ['OSCP', /\bOSCP\b/],
  ['Security+', /Security\+/], ['GIAC', /\bGIAC\b|\bG(CIH|SEC|CIA|PEN)\b/], ['AWS Certified', /AWS Certified/i], ['Microsoft cert (SC/AZ/MS)', /\b(SC|AZ|MS|AI)-\d{3}\b/], ['CPA', /\bCPA\b/], ['CFA', /\bCFA\b/], ['Scrum (CSM/PSM)', /\b(CSM|PSM|Scrum Master)\b/], ['ITIL', /\bITIL\b/], ['Six Sigma', /six sigma/i],
];
export const BIG_EMPLOYERS = ['Microsoft', 'Amazon', 'AWS', 'Amazon Web Services', 'Google', 'Apple', 'Meta', 'Facebook', 'IBM', 'Oracle', 'SAP', 'Cisco', 'Salesforce', 'Adobe', 'Intel', 'NVIDIA', 'Dell', 'HP', 'VMware', 'Broadcom',
  'Deloitte', 'Accenture', 'PwC', 'EY', 'KPMG', 'McKinsey', 'BCG', 'Bain', 'Booz Allen', 'Gartner', 'Forrester', 'JPMorgan', 'Goldman Sachs', 'Morgan Stanley', 'Citi', 'Bank of America', 'Capital One',
  'Mandiant', 'FireEye', 'Symantec', 'McAfee', 'Splunk', 'Palo Alto Networks', 'CrowdStrike', 'Verizon', 'AT&T', 'Comcast', 'Pfizer', 'Johnson & Johnson', 'UnitedHealth', 'Kaiser', 'WebMD',
  'NYU Langone', 'Memorial Sloan Kettering', 'Mount Sinai', 'NewYork-Presbyterian', 'Northwell', 'Cleveland Clinic', 'Mayo Clinic', 'Epic', 'Cerner'];
// Roster names that are also ordinary words; never matched from free text
export const AMBIGUOUS = new Set(['Flex', 'Wing', 'Ro', 'Alma', 'Opal', 'Island', 'Lambda', 'Modal', 'Socket', 'Dust', 'Clerk', 'Harvey', 'Sierra', 'Cursor', 'Notion', 'SAFE', 'Calm', 'Siro', 'Serval', 'Compa', 'Lumos', 'Persona', 'Rula', 'Ketch', 'Alloy', 'Cobalt', 'Expel', 'Torq', 'Brex', 'Ramp', 'Forter', 'Medallion', 'Waymark', 'Sixfold', 'Lattice', 'Pendo', 'Gong', 'Dialpad', 'Intercom', 'Epic', 'Mixpanel']);

const HEADER_RE = /^(executive summary|professional summary|career summary|summary( of qualifications)?|profile|professional profile|about( me)?|objective|career objective|(professional |work |relevant )?experience|employment( history)?|career history|education( (and|&) (training|certifications))?|(core |key |technical )?(skills|competencies|expertise)|areas of expertise|certifications?|licenses?( (and|&) certifications)?|awards?( (and|&) recognition)?|publications|(selected )?projects|languages|contact( information)?|references|volunteer(ing| experience)?|interests|highlights|(selected |key )?achievements|accomplishments|top skills|honors( (and|&) awards)?|speaking( engagements)?|patents|leadership|page \d+ of \d+|resume|curriculum vitae|cv)\s*:?$/i;
const CRED_TOKEN = /^(mba|mph|ms|msc|ma|ba|bs|bsc|phd|ph\.d|jd|md|pmp|cissp|cism|cisa|ccsp|ceh|oscp|cpa|cfa|itil|csm|psm|rn|esq|jr|sr|ii|iii|iv)\.?$/i;
const TITLE_RE = /\b(manager|director|lead|head|vp|vice president|chief|engineer|analyst|consultant|architect|specialist|strategist|researcher|scientist|officer|owner|partner|executive|president|founder|advisor|principal|administrator|coordinator|program manager|product manager)\b/i;
const BULLET_RE = /^[•▪◦●○■□➢►\-–—*·]/;
const CONTACT_RE = /@|https?:|linkedin\.com|www\.|\d{3}[).\s-]+\d{3}[.\s-]\d{4}|page \d+ of \d+/i;
const SPLIT_RE = /\s*(?:\||•|·|•| {3,}|\t)\s*/;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function nameFrom(seg) {
  let s = seg.replace(/\s+/g, ' ').trim().replace(/\s*[,(].*$/, '').trim();
  if (!s || HEADER_RE.test(s) || CONTACT_RE.test(s) || TITLE_RE.test(s)) return null;
  if (/\b(summary|experience|education|skills|profile|resume|page|objective|contact)\b/i.test(s)) return null;
  const w = s.split(' ');
  if (w.length < 2 || w.length > 4) return null;
  if (!w.every(x => /^[A-Z][A-Za-z'’.-]*$/.test(x) || /^(de|da|van|von|del|la|le|di|bin|al)$/.test(x))) return null;
  if (w.some(x => CRED_TOKEN.test(x))) return null;
  if (w.every(x => x === x.toUpperCase() && x.length > 1) && w.length < 2) return null;
  return w.map(x => x === x.toUpperCase() && x.length > 2 ? x[0] + x.slice(1).toLowerCase() : x).join(' ');
}
function onlyCredsOrName(line, name) {
  let s = line;
  if (name) s = s.replace(new RegExp(esc(name), 'i'), '');
  return s.split(/[,|/\s]+/).filter(Boolean).every(t => CRED_TOKEN.test(t));
}

export function extractResume(text = '', { knownEmployers = [] } = {}) {
  // rejoin words a PDF hyphenated across a line break ("Pre-\nIntent" → "Pre-Intent"); tidy " ," spacing
  const t = String(text).replace(/\r/g, '').replace(/([A-Za-z])-[ \t]*\n[ \t]*([A-Za-z])/g, '$1-$2').replace(/\s+,/g, ',');
  const lines = t.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let nameIdx = -1;
  const p = { name: '', headline: '', location: '', creds: [], employers: [], titles: [], skillsOn: [], skillsOff: [], custom: [], suggestedFns: [], source: 'resume' };

  // name: score name-shaped segments near the top. A real name sits next to a title, a location, credentials
  // or contact details, and never directly under a section heading (LinkedIn PDFs list Top Skills first).
  const LOCISH = new RegExp(String.raw`,\s*(${Object.keys(STATES).join('|')}|${Object.values(STATES).join('|')})\b`);
  let best = null;
  for (let i = 0; i < Math.min(30, lines.length); i++) {
    if (HEADER_RE.test(lines[i])) continue;
    const segs = lines[i].split(SPLIT_RE);
    for (const seg of segs) {
      const n = nameFrom(seg); if (!n) continue;
      let sc = 1;
      if (i === 0) sc += 1;
      if (i > 0 && HEADER_RE.test(lines[i - 1])) sc -= 3;
      if (/,\s*(MBA|MPH|MS|PhD|PMP|CISSP|JD|MD|CPA)\b/.test(seg)) sc += 2;
      if (segs.length > 1 && CONTACT_RE.test(lines[i])) sc += 1;
      if (lines.slice(i + 1, i + 3).some(l => TITLE_RE.test(l) || / at /.test(l))) sc += 2;
      if (lines.slice(i, i + 4).some(l => LOCISH.test(l))) sc += 2;
      if (!best || sc > best.sc) best = { n, i, sc };
      break;
    }
  }
  if (best && best.sc > 0) { p.name = best.n; nameIdx = best.i; }

  // headline: the first short descriptive line after the name (not contact, heading, credentials, or a sentence)
  for (let i = nameIdx + 1; i < Math.min(nameIdx + 7, lines.length); i++) {
    const l = lines[i];
    if (CONTACT_RE.test(l) || HEADER_RE.test(l) || onlyCredsOrName(l, p.name)) continue;
    if (p.name && l.toLowerCase().startsWith(p.name.toLowerCase())) continue;
    if (l.length >= 8 && l.length <= 140 && !/[.!?]$/.test(l)) { p.headline = l; break; }
    if (/[.!?]$/.test(l)) break; // reached the summary paragraph
  }

  // location: only in the header area or LinkedIn's "City, State, Country" line; city must be a real word, not "MBA"
  const head = lines.slice(0, 25).join('\n');
  const abbr = Object.keys(STATES).join('|'), names = Object.values(STATES).join('|');
  const CITY = String.raw`([A-Z][a-z]+(?:[ .'-]+[A-Z]?[a-z]+){0,3})`;
  const tryLoc = re => { for (const m of head.matchAll(re)) { if (!TITLE_RE.test(m[1]) && !HEADER_RE.test(m[1])) return m; } return null; };
  const m = tryLoc(new RegExp(String.raw`(?:^|[\s|•·(])${CITY},\s*(${abbr})(?![A-Za-z])`, 'gm')) || tryLoc(new RegExp(String.raw`(?:^|[\s|•·(])${CITY},\s*(${names})\b`, 'gm'));
  if (m) { const st = Object.entries(STATES).find(([a, n]) => a === m[2] || n === m[2]); p.location = `${m[1].trim()}, ${st ? st[0] : m[2]}`; }

  p.creds = CRED_RES.filter(([, re]) => re.test(t)).map(([n]) => n);

  // employers: only where a company appears in a role/date line, not in bullets about competitors or partners
  const dated = new Set(); lines.forEach((l, i) => { if (/\b(19[7-9]\d|20[0-4]\d)\b|\bpresent\b|\bcurrent\b/i.test(l)) dated.add(i); });
  const cands = [...new Set([...BIG_EMPLOYERS, ...knownEmployers.filter(n => n.length >= 4 && !AMBIGUOUS.has(n))])];
  const found = [];
  lines.forEach((l, i) => {
    if (BULLET_RE.test(l) || l.length > 110 || /[.!?]$/.test(l)) return;
    if (![i - 2, i - 1, i, i + 1, i + 2].some(j => dated.has(j))) return;
    for (const n of cands) if (!found.includes(n) && new RegExp(`(^|[^A-Za-z])${esc(n)}(?![A-Za-z])`).test(l)) found.push(n);
  });
  p.employers = found.filter(n => !(['AWS', 'Amazon'].includes(n) && found.includes('Amazon Web Services'))).slice(0, 14);

  // titles: short non-bullet, non-sentence lines with a role word; strip "| Company (dates)" tails
  const titles = [];
  for (const l of lines) {
    if (BULLET_RE.test(l) || HEADER_RE.test(l) || CONTACT_RE.test(l) || /[.!?;]$/.test(l) || l.length > 100) continue;
    if (p.name && l.toLowerCase().startsWith(p.name.toLowerCase())) continue;
    const parts = l.split(/\s+(?:\||•|·|–|—|-|@|at)\s+|\s*\(|,\s*(?:19|20)\d\d|\s+(?:19|20)\d\d|\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d\d/).map(x => (x || '').replace(/[,:;\s]+$/, '').trim());
    let s = parts.find(x => x && TITLE_RE.test(x)) || '';
    if (!s || s.split(/\s+/).length > 8 || !TITLE_RE.test(s) || HEADER_RE.test(s) || (s.match(/,/g) || []).length > 1) continue;
    if (!titles.some(x => x.toLowerCase() === s.toLowerCase())) titles.push(s);
  }
  p.titles = titles.slice(0, 10);

  p.skillsOn = extractSkills(t);
  let maxSen = 0;
  for (const ti of p.titles) maxSen = Math.max(maxSen, seniority(ti));
  p.suggestedFns = suggestFunctions(p);
  const years = [...t.matchAll(/\b(19[7-9]\d|20[0-4]\d)\b/g)].map(x => +x[1]).filter(y => y <= new Date().getFullYear());
  p.years = years.length ? new Date().getFullYear() - Math.min(...years) : null;
  p.maxSen = maxSen;
  return p;
}

// Job-function categories suggested by a parsed profile: from titles and headline, plus skill clusters.
export function suggestFunctions(p) {
  const fn = new Set();
  for (const ti of p.titles || []) classifyFunctions(ti).functions.forEach(f => fn.add(f));
  const groups = (p.skillsOn || []).map(id => SKILLS.find(s => s.id === id)?.group);
  if (p.headline) classifyFunctions(p.headline).functions.forEach(f => fn.add(f));
  const n = g => groups.filter(x => x === g).length, has = id => (p.skillsOn || []).includes(id);
  const nSec = groups.filter(x => x && x.startsWith('Security')).length, any = ids => ids.filter(has).length;
  if (n('Sales') + n('Partnerships & alliances') + n('Marketing') + n('Customer & solutions') >= 4) fn.add('gtm');
  if (any(['Product marketing', 'Positioning & messaging', 'Launches', 'Pricing & packaging', 'Market research & segmentation', 'Analyst relations']) >= 2) fn.add('pmm');
  if (n('Marketing') >= 4) fn.add('marketing');
  if (any(['Demand generation', 'Digital & performance marketing', 'Lifecycle & growth marketing', 'Marketing operations & automation', 'Field & event marketing', 'Marketing analytics & attribution']) >= 2) fn.add('demand');
  if (n('Sales') >= 3) fn.add('sales');
  if (n('Partnerships & alliances') >= 2) fn.add('partner');
  if (any(['Pre-sales / solutions', 'Proof of concept / value', 'Demos & workshops', 'RFPs & security questionnaires', 'Value engineering & ROI']) >= 2) fn.add('se');
  if (any(['Customer success & adoption', 'Technical account management', 'Professional services & delivery', 'Escalation management']) >= 2) fn.add('cs');
  if (any(['Sales enablement', 'Partner enablement', 'Training & certification programs']) >= 2) fn.add('enable');
  if (has('Competitive intelligence')) fn.add('ci');
  if (n('Product') >= 2) fn.add('product');
  if (n('AI') >= 2) fn.add('ai');
  if (any(['Threat intelligence', 'Threat hunting', 'Malware analysis & reverse engineering', 'OSINT', 'Threat actor tracking', 'Dark web & cybercrime', 'CTI standards (STIX, MISP, Diamond)', 'Security research']) >= 2) fn.add('threat');
  if (any(['SOC operations', 'Incident response', 'Detection engineering', 'SIEM / SOAR', 'XDR / EDR', 'Digital forensics']) >= 2) fn.add('secops');
  if (n('Security · risk & compliance') >= 2 && nSec >= 3) fn.add('grc');
  return [...fn];
}
