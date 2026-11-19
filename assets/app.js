import * as C from './shared/core.mjs?v=20261119g';
import { CROSS, UNIVERSE } from './discovery.mjs?v=20261119g';
import { extractResume } from './shared/resume.mjs?v=20261119g';

/* ============================================================ state */
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || C.TZ;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('rr:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rr:' + k, JSON.stringify(v)); } catch { /* storage unavailable: keep in memory */ } },
};
const FN_KEYS = Object.keys(C.FUNCTIONS);
const QS = new URLSearchParams(location.search);
if (QS.has('owner')) store.set('owner', QS.get('owner') !== 'off');
const OWNER = !!store.get('owner', false);
const DEFAULT_CRIT = () => ({
  functions: [...FN_KEYS], engReview: true, minBase: 150000, salMode: 'starts_reaches', window: 'week', firstSeen: true, updated: true,
  lMetro: true, lRemoteYes: true, lRemoteUnknown: true, lOther: false, metro: '', state: '', sen: 2,
  include: '', exclude: 'intern, new grad, apprentice', tiers: { heavy: true, named: true, core: true, aggregator: true }, sectors: [], verticals: [],
});
const DEFAULT_PROFILE = () => ({ name: '', headline: '', location: '', creds: [], employers: [], titles: [], skillsOn: [], skillsOff: [], custom: [], suggestedFns: [], source: 'empty' });
const S = {
  registry: { employers: [], unresolved_identifiers: [] }, jobs: [], jobsMeta: null, status: { sources: [] },
  crit: { ...DEFAULT_CRIT(), ...store.get('crit', {}) }, profile: { ...DEFAULT_PROFILE(), ...store.get('profile', {}) },
  saved: new Set(store.get('saved', [])), hidden: new Set(store.get('hidden', [])), live: new Map(), empByName: new Map(), open: new Set(),
};
const save = () => { store.set('crit', S.crit); store.set('profile', S.profile); store.set('saved', [...S.saved]); store.set('hidden', [...S.hidden]); };

/* ============================================================ boot */
async function loadJSON(p, fb) {
  try { const r = await fetch(p, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  catch (e) { console.warn('load', p, e); return fb; }
}
async function boot() {
  const [reg, jobs, status, site] = await Promise.all([loadJSON('data/sources.json', null), loadJSON('data/jobs.json', { jobs: [] }), loadJSON('data/status.json', { sources: [] }), loadJSON('data/site.json', {})]);
  S.site = site || {};
  if (!reg) {
    document.querySelector('main').insertAdjacentHTML('afterbegin', OWNER
      ? `<div class="empty-state"><b>DATA FILES NOT REACHABLE</b>Open this app over http (GitHub Pages, or <code>python3 -m http.server</code> in the repo folder). Browsers block file:// data loads.</div>`
      : `<div class="empty-state"><b>COULDN'T LOAD LISTINGS</b>Please refresh the page in a moment.</div>`);
  }
  S.registry = reg || S.registry; S.jobs = jobs.jobs || []; S.jobsMeta = jobs; S.status = status;
  for (const e of S.registry.employers) S.empByName.set(e.employer, e);
  applyOwnerMode(); wireNav(); wireProfile(); renderProfile(); renderCriteria(); renderHud();
  renderMatches(); renderSources(); renderDiscover(); renderSetup();
  show(location.hash.slice(1) || (S.profile.source === 'empty' ? 'profile' : 'matches'));
}
const empOf = j => S.empByName.get(j.employer) || S.empByName.get(String(j.employer).replace(/ \(AWS\)$/, '')) || null;

/* ============================================================ nav / hud */
function applyOwnerMode() {
  document.body.classList.toggle('owner', OWNER);
  if (!OWNER) { $('[data-view="setup"]')?.remove(); }
}
function wireNav() {
  $$('#nav button').forEach(b => b.onclick = () => show(b.dataset.view));
  addEventListener('hashchange', () => show(location.hash.slice(1)));
}
function show(v) {
  if (!$('#view-' + v) || (v === 'setup' && !OWNER)) v = 'profile';
  $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  if (v === 'matches') renderMatches();
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }
const fmtDay = ymd => { if (!ymd) return '—'; const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ' ' + ymd; };
function renderHud() {
  const g = S.jobsMeta?.generated_at;
  const dot = $('#dataDot');
  if (!g) { $('#dataAge').textContent = OWNER ? 'NO COLLECTOR RUN YET' : 'UPDATING'; dot.className = OWNER ? 'dot bad' : 'dot warn'; }
  else {
    const hrs = (Date.now() - new Date(g)) / 36e5;
    $('#dataAge').textContent = 'DATA ' + new Date(g).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    dot.className = 'dot' + (hrs > 30 ? ' warn' : '');
  }
  const w = currentWindow();
  $('#winLabel').textContent = w ? `WINDOW ${w.start} → ${w.end}` : 'WINDOW: ANY DATE';
  $('#who').textContent = S.profile.name ? (S.profile.name + (S.profile.location ? ' · ' + S.profile.location : '')) : 'Job search · HUD';
  const open = S.jobs.filter(j => j.status !== 'closed').length;
  $('#heroEmp').textContent = `${S.registry.employers.length} employers`;
  $('#heroCount').textContent = S.registry.employers.length;
  $('#heroRoles').textContent = S.jobsMeta?.generated_at ? `${open.toLocaleString()} open roles` : 'awaiting first collection';
  $('#heroLive').textContent = S.jobsMeta?.generated_at ? 'Feeds live' : 'Feeds idle';
}
const currentWindow = () => S.crit.window === 'all' ? null : C.windowFor(S.crit.window, new Date(), LOCAL_TZ);

/* ============================================================ resume ingest */
function logIngest(html, reset = false) { const el = $('#ingestLog'); el.innerHTML = (reset ? '' : el.innerHTML + '<br>') + html; el.scrollTop = 1e6; }
function loadScript(src) {
  return new Promise((res, rej) => { if ([...document.scripts].some(s => s.src === src)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
}
async function fileToText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    let out = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      for (const it of tc.items) out += it.str + (it.hasEOL ? '\n' : ' ');
      out += '\n';
    }
    return out;
  }
  if (name.endsWith('.docx')) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
    return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  return await file.text();
}
function extractProfile(text) {
  return { ...DEFAULT_PROFILE(), ...extractResume(text, { knownEmployers: S.registry.employers.map(e => e.employer.replace(/ \/ AWS$/, '')) }) };
}
function applyProfile(p, how) {
  S.profile = { ...p };
  if (p.location) {
    const [city, st] = p.location.split(',').map(x => x.trim());
    if (st && C.STATES[st]) S.crit.state = st;
    if (!S.crit.metro && city) S.crit.metro = C.metroFor(city);
  }
  if (p.maxSen) S.crit.sen = Math.max(2, Math.min(5, p.maxSen - 1));
  save(); renderProfile(); renderCriteria(); renderHud(); renderDiscover();
  logIngest(`<span class="g">✓</span> ${how}: ${p.skillsOn.length} skills · ${p.titles.length} titles · ${p.creds.length} credentials · ${p.employers.length} employers` +
    (p.location ? ` · home <span class="c">${esc(p.location)}</span>` : ' · <span class="y">no home location found; set it below</span>') +
    (p.suggestedFns.length ? `<br><span class="p">cacheflow&gt;</span> suggested functions: <span class="c">${p.suggestedFns.map(f => C.FUNCTIONS[f].label).join(', ')}</span> (marked ◆; all stay selectable)` : ''));
}
const SAMPLE = `Definitely Ahuman
Senior Product Marketing Manager | Security GTM
Hoboken, NJ · definitely@example.com · linkedin.com/in/definitely-ahuman

EXPERIENCE
Senior Product Marketing Manager, Cloud Security — Example Corp (2021 – Present)
• Led go-to-market and positioning for an XDR and SIEM launch; built sales enablement playbooks and competitive battlecards.
• Partnered with channel and alliances teams on marketplace co-sell motions with AWS and Azure.
Product Manager, Identity — Sample Systems (2017 – 2021)
• Owned roadmap and PRDs for identity and access management features; ran customer discovery and pricing analysis.

EDUCATION
MBA — Example Business School · BS Computer Science
CERTIFICATIONS
CISSP · PMP`;

function wireProfile() {
  const drop = $('#drop'), file = $('#file');
  drop.onclick = () => file.click();
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => e.dataTransfer.files[0] && ingestFile(e.dataTransfer.files[0]));
  file.onchange = () => file.files[0] && ingestFile(file.files[0]);
  $('#btnExtract').onclick = () => { const v = $('#paste').value.trim(); if (!v) return toast('Paste text or drop a file first'); S.lastText = v; applyProfile(extractProfile(v), 'Pasted text'); };
  $('#btnPreset').onclick = () => { $('#paste').value = SAMPLE; S.lastText = SAMPLE; applyProfile(extractProfile(SAMPLE), 'Sample resume (fictional)'); };
  $('#btnClear').onclick = () => { S.profile = DEFAULT_PROFILE(); S.crit = DEFAULT_CRIT(); $('#paste').value = ''; save(); renderProfile(); renderCriteria(); renderHud(); logIngest('<span class="p">cacheflow&gt;</span> cleared', true); };
  $('#btnClaude').onclick = enhanceWithClaude;
  $('#heroUpload').onclick = e => { e.preventDefault(); $('#drop').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $('#file').click(), 450); };
  for (const [id, key] of [['#pName', 'name'], ['#pLoc', 'location'], ['#pHead', 'headline']]) $(id).onchange = e => {
    S.profile[key] = e.target.value.trim();
    if (key === 'location') applyProfile({ ...S.profile }, 'Location updated');
    save(); renderHud();
  };
  $('#addSkill').onkeydown = e => { if (e.key === 'Enter' && e.target.value.trim()) { S.profile.custom.push(e.target.value.trim()); e.target.value = ''; save(); renderProfile(); } };
}
async function ingestFile(f) {
  logIngest(`<span class="p">cacheflow&gt;</span> reading <span class="c">${esc(f.name)}</span> (${Math.round(f.size / 1024)} KB)…`, true);
  try {
    const text = await fileToText(f);
    if (text.trim().length < 80) { logIngest('<span class="r">✗</span> Very little text found. A scanned/image PDF needs OCR first; try the DOCX or paste the text.'); return; }
    S.lastText = text; $('#paste').value = text.slice(0, 20000);
    applyProfile(extractProfile(text), /linkedin/i.test(text) && /top skills/i.test(text) ? 'LinkedIn PDF export' : 'Resume file');
  } catch (e) { logIngest(`<span class="r">✗</span> ${esc(e.message)}. Paste the text instead.`); }
}
async function enhanceWithClaude() {
  const key = $('#apiKey').value.trim(); const text = (S.lastText || $('#paste').value || '').trim();
  if (!key || !text) return toast('Need an API key and resume text');
  $('#claudeMsg').textContent = 'calling…';
  const fnList = FN_KEYS.map(k => `${k} = ${C.FUNCTIONS[k].label}`).join('; ');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1500, system: 'You extract structured career data from resumes. Reply with one JSON object only, no prose. Use only facts stated in the text.',
        messages: [{ role: 'user', content: `Return JSON with keys: name, headline, location ("City, ST" for US), credentials[], employers[], titles[], skills[] (short phrases), functions[] (choose any that fit from: ${fnList}), seniority (1-6 where 3=senior IC, 4=lead/principal, 5=director, 6=VP+).\n\nRESUME:\n${text.slice(0, 30000)}` }] }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || r.status);
    const raw = (data.content || []).map(c => c.text || '').join('');
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const p = { ...S.profile };
    p.name = j.name || p.name; p.headline = j.headline || p.headline; p.location = j.location || p.location;
    p.creds = [...new Set([...(p.creds || []), ...(j.credentials || [])])]; p.employers = [...new Set([...(p.employers || []), ...(j.employers || [])])];
    p.titles = [...new Set([...(j.titles || []), ...(p.titles || [])])].slice(0, 12);
    const fromSkills = C.extractSkills((j.skills || []).join('\n'));
    p.skillsOn = [...new Set([...(p.skillsOn || []), ...fromSkills])];
    p.custom = [...new Set([...(p.custom || []), ...(j.skills || []).filter(s => !C.extractSkills(s).length).slice(0, 15)])];
    p.suggestedFns = (j.functions || []).filter(f => FN_KEYS.includes(f));
    p.maxSen = (+j.seniority || 0) + 1; p.source = 'resume + Claude';
    applyProfile(p, 'Claude-enhanced extraction');
    $('#claudeMsg').textContent = 'done';
  } catch (e) { $('#claudeMsg').textContent = ''; logIngest(`<span class="r">✗</span> Claude call failed: ${esc(e.message)}`); }
}
function renderProfile() {
  const p = S.profile;
  $('#pName').value = p.name || ''; $('#pLoc').value = p.location || ''; $('#pHead').value = p.headline || '';
  $('#profSource').textContent = p.source === 'empty' ? 'no resume loaded' : p.source + (p.years ? ` · ~${p.years} yrs` : '');
  $('#pCreds').innerHTML = [...(p.creds || []).map(c => `<span class="tag m">${esc(c)}</span>`), ...(p.employers || []).map(c => `<span class="tag">${esc(c)}</span>`), ...(p.titles || []).slice(0, 6).map(c => `<span class="tag f">${esc(c)}</span>`)].join('') || '<span class="hint">Nothing yet. Drop a resume or load the sample.</span>';
  const on = new Set(p.skillsOn || []), off = new Set(p.skillsOff || []);
  const groups = {};
  for (const s of C.SKILLS) (groups[s.group] ||= []).push(s);
  $('#pSkills').innerHTML = Object.entries(groups).map(([g, list]) => `<div style="margin:8px 0 4px" class="hint">${esc(g)}</div><div class="chips">` +
    list.map(s => `<button class="chip ${on.has(s.id) && !off.has(s.id) ? 'on' : ''}" data-skill="${esc(s.id)}">${esc(s.id)}</button>`).join('') + '</div>').join('') +
    ((p.custom || []).length ? `<div style="margin:8px 0 4px" class="hint">Custom keywords</div><div class="chips">${p.custom.map((c, i) => `<button class="chip on m" data-custom="${i}">${esc(c)}<span class="x">×</span></button>`).join('')}</div>` : '');
  $('#skillSum').textContent = `Skills used for match scoring · ${(p.skillsOn || []).length} on${(p.custom || []).length ? ` · ${p.custom.length} custom` : ''}`;
  $$('#pSkills [data-skill]').forEach(b => b.onclick = () => {
    const id = b.dataset.skill; const s = new Set(S.profile.skillsOn || []);
    s.has(id) ? s.delete(id) : s.add(id); S.profile.skillsOn = [...s]; save(); b.classList.toggle('on'); $('#skillSum').textContent = `Skills used for match scoring · ${s.size} on`;
  });
  $$('#pSkills [data-custom]').forEach(b => b.onclick = () => { S.profile.custom.splice(+b.dataset.custom, 1); save(); renderProfile(); });
}

/* ============================================================ criteria */
function sectorsAndVerticals() {
  const sec = new Map(), ver = new Map();
  for (const e of S.registry.employers) { sec.set(e.sector, (sec.get(e.sector) || 0) + 1); if (e.sector === 'Cybersecurity') ver.set(e.vertical, (ver.get(e.vertical) || 0) + 1); }
  return { sec: [...sec].sort((a, b) => b[1] - a[1]), ver: [...ver].sort((a, b) => b[1] - a[1]) };
}
function renderCriteria() {
  const c = S.crit, sug = new Set(S.profile.suggestedFns || []);
  $('#cFunctions').innerHTML = FN_KEYS.map(k => `<label class="check"><input type="checkbox" data-fn="${k}" ${c.functions.includes(k) ? 'checked' : ''}> ${esc(C.FUNCTIONS[k].label)}${sug.has(k) ? ' <span style="color:var(--magenta)">◆</span>' : ''}</label>`).join('');
  $('#cEngReview').checked = c.engReview; $('#cMinBase').value = c.minBase; $('#cSalMode').value = c.salMode; $('#cWindow').value = c.window;
  $('#cFirstSeen').checked = c.firstSeen; $('#cUpdated').checked = c.updated;
  for (const k of ['lMetro', 'lRemoteYes', 'lRemoteUnknown', 'lOther']) $('#' + k).checked = c[k];
  $('#cMetro').value = c.metro; $('#cMetro').placeholder = 'set a home location, or type cities separated by |';
  $('#cMetroPreset').innerHTML = '<option value="">Metro preset…</option>' + Object.keys(C.METRO_PRESETS).map(k => `<option>${esc(k)}</option>`).join('');
  $('#cMetroPreset').onchange = e => { if (e.target.value) { c.metro = C.METRO_PRESETS[e.target.value]; $('#cMetro').value = c.metro; upd(); } };
  $('#cSen').innerHTML = Object.entries(C.SENIORITY_LABEL).map(([v, l]) => `<option value="${v}" ${+v === c.sen ? 'selected' : ''}>${l} and above</option>`).join('');
  $('#cInclude').value = c.include; $('#cExclude').value = c.exclude;
  const tierLbl = { heavy: 'Big tech & majors', named: 'Named targets', core: 'Core roster', aggregator: 'Aggregator finds' };
  $('#cTiers').innerHTML = Object.entries(tierLbl).map(([k, l]) => `<button class="chip ${c.tiers[k] ? 'on' : ''}" data-tier="${k}">${l}</button>`).join('');
  const { sec, ver } = sectorsAndVerticals();
  $('#cSectors').innerHTML = sec.map(([s, n]) => `<button class="chip ${c.sectors.includes(s) ? 'on' : ''}" data-sector="${esc(s)}">${esc(s)} · ${n}</button>`).join('');
  $('#cVerticals').innerHTML = ver.map(([s, n]) => `<button class="chip ${c.verticals.includes(s) ? 'on m' : ''}" data-vert="${esc(s)}">${esc(s)} · ${n}</button>`).join('');
  const upd = () => { save(); renderHud(); };
  $$('#cFunctions [data-fn]').forEach(i => i.onchange = () => { c.functions = $$('#cFunctions [data-fn]:checked').map(x => x.dataset.fn); upd(); });
  $('#cEngReview').onchange = e => { c.engReview = e.target.checked; upd(); };
  $('#cMinBase').onchange = e => { c.minBase = Math.max(0, +e.target.value || 0); upd(); };
  $('#cSalMode').onchange = e => { c.salMode = e.target.value; upd(); };
  $('#cWindow').onchange = e => { c.window = e.target.value; upd(); };
  $('#cFirstSeen').onchange = e => { c.firstSeen = e.target.checked; upd(); };
  $('#cUpdated').onchange = e => { c.updated = e.target.checked; upd(); };
  for (const k of ['lMetro', 'lRemoteYes', 'lRemoteUnknown', 'lOther']) $('#' + k).onchange = e => { c[k] = e.target.checked; upd(); };
  $('#cMetro').onchange = e => { c.metro = e.target.value.trim().toLowerCase(); upd(); };
  $('#cSen').onchange = e => { c.sen = +e.target.value; upd(); };
  $('#cInclude').onchange = e => { c.include = e.target.value; upd(); };
  $('#cExclude').onchange = e => { c.exclude = e.target.value; upd(); };
  $$('#cTiers [data-tier]').forEach(b => b.onclick = () => { c.tiers[b.dataset.tier] = !c.tiers[b.dataset.tier]; b.classList.toggle('on'); upd(); });
  $$('#cSectors [data-sector]').forEach(b => b.onclick = () => { const s = b.dataset.sector; c.sectors = c.sectors.includes(s) ? c.sectors.filter(x => x !== s) : [...c.sectors, s]; b.classList.toggle('on'); upd(); });
  $$('#cVerticals [data-vert]').forEach(b => b.onclick = () => { const s = b.dataset.vert; c.verticals = c.verticals.includes(s) ? c.verticals.filter(x => x !== s) : [...c.verticals, s]; b.classList.toggle('on'); b.classList.toggle('m'); upd(); });
  $('#btnReset').onclick = () => { S.crit = DEFAULT_CRIT(); if (S.profile.location) applyProfile({ ...S.profile }, 'Criteria reset'); save(); renderCriteria(); renderHud(); };
  $('#btnGo').onclick = () => show('matches');
}

/* ============================================================ matching */
const { csvList, reFromList } = C;
function evaluate(j, ctx) {
  return C.evaluateJob(j, { crit: S.crit, emp: empOf(j), skillsOn: S.profile.skillsOn, custom: S.profile.custom, win: ctx.win, excl: ctx.excl, tz: LOCAL_TZ });
}
function computeMatches() {
  const c = S.crit;
  const ctx = { win: currentWindow(), excl: reFromList(csvList(c.exclude)) };
  return S.jobs.map(j => evaluate(j, ctx)).filter(Boolean);
}
const money = n => n == null ? '?' : '$' + (n >= 1000 ? Math.round(n / 1000) + 'K' : n);
const KIND_LABEL = { base: 'BASE', base_likely: 'SALARY (base implied)', unlabeled: 'RANGE (type not stated)' };
const DATE_LABEL = { first_published: 'first published', published: 'published', created: 'created', posted_date: 'posted', start_date: 'posting start date', released: 'released', feed_pubdate: 'feed date',
  relative_approx: 'approx. from "posted N days ago"', updated: 'UPDATED date — may be a refresh', first_observed: 'first observed by collector (no posting date)', aggregator_created: 'aggregator date', none: 'no date' };
const LOC_LABEL = { metro: ['IN COMMUTE AREA', 'g'], remote_yes: ['REMOTE · HOME STATE OK', 'g'], remote_unknown: ['REMOTE · STATE ELIGIBILITY NOT STATED', 'a'], other: ['OTHER US LOCATION', 'f'] };

function jobCard(m) {
  const { j, e } = m;
  const s = j.salary;
  let sal = `<span class="sal unknown">BASE NOT STATED</span>`;
  if (s && s.kind === 'ote_only') sal = `<span class="sal ote_only">NO BASE STATED · <span class="tag r strike">${s.ote?.kind === 'total' ? 'TOTAL COMP' : 'OTE'} ${money(s.ote?.min)}–${money(s.ote?.max)} excluded</span></span>`;
  else if (s && s.kind === 'predicted') sal = `<span class="sal predicted">PREDICTED ${money(s.min)}–${money(s.max)} · not employer-stated</span>`;
  else if (s) sal = `<span class="sal ${m.tier}">${KIND_LABEL[s.kind] || 'RANGE'} ${money(s.min)}–${money(s.max)}${s.period === 'hour' ? ' (annualized from hourly)' : ''} · ${m.tier === 'starts' ? 'STARTS ≥ ' : m.tier === 'reaches' ? 'REACHES ≥ ' : 'BELOW '}${money(S.crit.minBase)}</span>` +
    (s.multi ? ' <span class="tag f" title="Several ranges found; highest or NY/top zone chosen">multi-range</span>' : '') + (s.ote ? ` <span class="tag r strike">OTE ${money(s.ote.min)}–${money(s.ote.max)} ignored</span>` : '');
  const dYmd = m.dt.d ? C.nyDate(new Date(m.dt.d), LOCAL_TZ) : null;
  const [ll, lc] = LOC_LABEL[m.loc];
  const saved = S.saved.has(j.uid), open = S.open.has(j.uid);
  const li = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(j.title + ' ' + (e?.employer || j.employer))}`;
  return `<article class="job ${m.tier} ${saved ? 'saved' : ''} ${open ? 'open' : ''}" data-uid="${esc(j.uid)}">
    <div><h4><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></h4>
      <div class="emp">${esc(j.employer)} <span>· ${esc(m.sector)}${m.vertical && m.sector === 'Cybersecurity' ? ' / ' + esc(m.vertical) : ''}</span></div></div>
    <div class="score"><div class="v">${m.score}<small>/100</small></div><div class="meter"><i style="width:${m.score}%"></i></div><div class="why">${m.why}</div></div>
    <div class="meta">${sal}</div>
    <div class="meta">
      <span class="tag ${lc}">${ll}</span><span class="tag f">${esc(j.workplace)}</span>
      ${j.source_class === 'aggregator' ? `<span class="tag a">AGGREGATOR · ${esc(j.via || j.ats)}</span>` : `<span class="tag">OFFICIAL · ${esc(j.ats)}</span>`}
      ${j.live ? '<span class="tag m">LIVE CHECK</span>' : ''}
      ${m.fnHit.map(f => `<span class="tag m">${esc(C.FUNCTIONS[f].label.split(/[,&]/)[0].trim())}</span>`).join('')}
      ${j.eng_review ? '<span class="tag a">REVIEW: ENGINEER TITLE</span>' : ''}
      ${j.reposted ? '<span class="tag a">DATE CHANGED · POSSIBLE REPOST</span>' : ''}
      ${j.stale ? `<span class="tag r">NOT REFRESHED SINCE ${esc((j.stale_since || '').slice(0, 10))}</span>` : ''}
      ${j.dup_count > 1 ? `<span class="tag f">${j.dup_count} COPIES ACROSS SOURCES</span>` : ''}
    </div>
    <div class="facts">
      <div>DATE <b>${dYmd ? fmtDay(dYmd) : '—'}</b> · ${esc(DATE_LABEL[m.dt.kind] || m.dt.kind)}</div>
      <div>LOCATION <b>${esc((j.locations || []).slice(0, 2).join(' · ') || '—')}</b></div>
      <div>FIRST SEEN <b>${esc((j.first_observed || '').slice(0, 10) || '—')}</b> · LAST SEEN <b>${esc((j.last_seen || '').slice(0, 10) || '—')}</b></div>
      <div>REQ <b>${esc(j.req_id || '—')}</b>${j.department ? ` · ${esc(j.department)}` : ''}</div>
      ${m.skillHits.length || m.customHits.length ? `<div style="grid-column:1/-1">MATCHED <b>${esc([...m.skillHits, ...m.customHits].join(' · '))}</b></div>` : ''}
    </div>
    ${j.excerpt ? `<div class="ex">${esc(j.excerpt)}${j.excerpt.length >= 900 ? '…' : ''}</div>` : ''}
    <div class="acts">
      <a class="btn pri sm" href="${esc(j.url)}" target="_blank" rel="noopener">Open posting ↗</a>
      ${j.excerpt ? `<button class="btn sec sm" data-act="open">${open ? 'Hide' : 'Show'} excerpt</button>` : ''}
      <button class="btn ${saved ? 'mag' : 'sec'} sm" data-act="save">${saved ? '★ Saved' : '☆ Save'}</button>
      <button class="btn sec sm" data-act="hide">${S.hidden.has(j.uid) ? 'Unhide' : 'Hide'}</button>
      <a class="btn sec sm" href="${li}" target="_blank" rel="noopener">LinkedIn ↗</a>
    </div></article>`;
}
function renderMatches() {
  const w = currentWindow();
  const meta = S.jobsMeta || {};
  $('#windowBanner').innerHTML = `<b>POSTING WINDOW</b><span class="d">${w ? `${fmtDay(w.start)} → ${fmtDay(w.end)}` : 'Any date'}</span><span>${esc(LOCAL_TZ)} · ${esc(w ? w.label : '')}</span><span class="spacer"></span>` +
    `<span>last updated: <span class="d">${meta.generated_at ? esc(new Date(meta.generated_at).toLocaleString()) : 'pending'}</span>${OWNER && meta.window ? ` · collector window ${esc(meta.window.start)} → ${esc(meta.window.end)} ET` : ''}</span>`;
  let ms = computeMatches();
  const q = $('#q').value.trim().toLowerCase();
  if (q) ms = ms.filter(m => (m.j.title + ' ' + m.j.employer + ' ' + (m.j.excerpt || '') + ' ' + (m.j.kw || []).join(' ')).toLowerCase().includes(q));
  const all = ms;
  if (!$('#showHidden').checked) ms = ms.filter(m => !S.hidden.has(m.j.uid));
  if ($('#onlySaved').checked) ms = ms.filter(m => S.saved.has(m.j.uid));
  if (!$('#showDups').checked) ms = ms.filter(m => !m.j.dup_of);
  const sort = $('#sort').value;
  const cmp = { score: (a, b) => b.score - a.score, date: (a, b) => (b.dt.d || '').localeCompare(a.dt.d || ''), salary: (a, b) => (b.j.salary?.min || 0) - (a.j.salary?.min || 0), employer: (a, b) => a.j.employer.localeCompare(b.j.employer) }[sort];
  ms.sort(cmp);
  const count = t => all.filter(m => m.tier === t).length;
  $('#matchTiles').innerHTML = [
    ['c', all.length, 'matches in window'], ['g', count('starts'), `base starts ≥ ${money(S.crit.minBase)}`], ['a', count('reaches'), `base reaches ≥ ${money(S.crit.minBase)}`],
    ['', count('unknown') + count('ote_only') + count('predicted'), 'no base stated'], ['m', new Set(all.map(m => m.j.employer)).size, 'employers'],
    ['', all.filter(m => m.loc === 'remote_yes').length, 'remote · home state OK'], ['', S.jobs.filter(j => j.status !== 'closed').length, 'open roles in dataset'],
  ].map(([c, n, l]) => `<div class="tile ${c}"><i class="cn tl"></i><i class="cn tr"></i><i class="cn bl"></i><i class="cn br"></i><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`).join('');
  if (!S.jobs.length) {
    $('#jobGroups').innerHTML = OWNER
      ? `<div class="empty-state"><b>NO JOB DATA YET</b>The collector hasn't saved a run yet. In GitHub, open <b>Actions → Collect jobs → Run workflow</b>, or click <b>Refresh boards now</b> on <a href="#sources">Sources</a> to pull Greenhouse, Lever and Ashby boards into this tab.</div>`
      : `<div class="empty-state"><b>LISTINGS ARE ON THE WAY</b>Cache Flow is gathering this week's openings from employer job boards. Set up your profile and criteria now. Matches appear here automatically once the next update lands.</div>`;
    return;
  }
  const groups = [
    ['starts', `Base starts at or above ${money(S.crit.minBase)}`, 'var(--green)'], ['reaches', `Base reaches ${money(S.crit.minBase)} (minimum is lower)`, 'var(--acid)'],
    ['unknown', 'Base salary not stated', 'var(--muted)'], ['ote_only', 'Only OTE / total comp stated (not base)', 'var(--red)'], ['predicted', 'Aggregator-predicted salary only', 'var(--red)'], ['below', `Base below ${money(S.crit.minBase)}`, 'var(--faint)'],
  ];
  const html = groups.map(([t, label, color]) => {
    const g = ms.filter(m => m.tier === t);
    if (!g.length) return '';
    return `<div class="group-h"><span style="color:${color}">■ ${esc(label)}</span><span class="bar"></span><span class="ct">${g.length}</span></div><div class="jobs">${g.slice(0, 300).map(jobCard).join('')}</div>` + (g.length > 300 ? `<p class="hint">Showing 300 of ${g.length}. Narrow the filters or export CSV for all.</p>` : '');
  }).join('');
  $('#jobGroups').innerHTML = html || `<div class="empty-state"><b>NO MATCHES IN THIS WINDOW</b>${S.jobs.length} roles in the dataset, none pass every filter. Try widening the posting window, the salary rule or the location options.<br>A board with zero matches is not the same as a board that failed. Check Sources for access failures.</div>`;
  S.lastMatches = ms;
}
function wireMatches() {
  ['#q', '#sort', '#onlySaved', '#showHidden', '#showDups'].forEach(s => $(s).addEventListener(s === '#q' ? 'input' : 'change', renderMatches));
  $('#jobGroups').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const uid = b.closest('.job').dataset.uid;
    if (b.dataset.act === 'save') S.saved.has(uid) ? S.saved.delete(uid) : S.saved.add(uid);
    if (b.dataset.act === 'hide') S.hidden.has(uid) ? S.hidden.delete(uid) : S.hidden.add(uid);
    if (b.dataset.act === 'open') S.open.has(uid) ? S.open.delete(uid) : S.open.add(uid);
    save(); renderMatches();
  });
  $('#btnCsv').onclick = () => {
    const rows = (S.lastMatches || []).map(m => ({ score: m.score, salary_tier: m.tier, base_min: m.j.salary?.min ?? '', base_max: m.j.salary?.max ?? '', salary_kind: m.j.salary?.kind ?? '', ote_excluded: m.j.salary?.ote ? `${m.j.salary.ote.min}-${m.j.salary.ote.max}` : '',
      title: m.j.title, employer: m.j.employer, sector: m.sector, vertical: m.vertical, location: (m.j.locations || []).join(' | '), workplace: m.j.workplace, location_fit: m.loc, home_state_eligibility: m.hf.eligibility,
      date: m.dt.d ? C.nyDate(new Date(m.dt.d), LOCAL_TZ) : '', date_basis: m.dt.kind, first_observed: m.j.first_observed, last_seen: m.j.last_seen, reposted: !!m.j.reposted, stale: !!m.j.stale,
      source_class: m.j.source_class, ats: m.j.ats, source_id: m.j.source_id, req_id: m.j.req_id || '', duplicates: m.j.dup_count || 1, url: m.j.url }));
    downloadCSV(rows, `cache-flow-matches-${C.nyDate(new Date(), LOCAL_TZ)}.csv`);
  };
}
function downloadCSV(rows, name) {
  if (!rows.length) return toast('Nothing to export');
  const cols = Object.keys(rows[0]);
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([[cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ============================================================ sources */
const VERIFIED = new Set(['verified_feed', 'verified_pattern', 'documented_public_json']);
const resultClass = r => !r || r === 'never_run' ? 'idle' : r === 'ok' ? 'ok' : r === 'empty' ? 'empty' : ['link_only', 'not_fetchable', 'skipped_no_key'].includes(r) ? 'idle' : ['timeout', 'experimental_failed', 'blocked_or_network'].includes(r) ? 'warn' : 'bad';
const RESULT_HELP = { ok: 'Fetched; jobs returned', empty: 'Fetched; board has zero jobs right now', http_403: 'Refused (403). Access failed; not evidence of zero jobs', http_404: 'Not found (404). Identifier or site name likely wrong',
  http_429: 'Rate limited after retries', timeout: 'Timed out after retries', network_error: 'Network failure', parse_error: 'Response not in the expected shape', link_only: 'No public feed; open the careers link',
  not_fetchable: 'Needs ATS discovery (see verification note)', blocked_or_network: 'Browser blocked the request (CORS) or network failed; the collector can still read it', experimental_failed: 'Experimental adapter did not get data', never_run: 'Not collected yet', adapter_error: 'Adapter crashed; see message' };
function sourceRows() {
  const st = new Map(S.status.sources.map(s => [s.id, s]));
  const rows = [];
  for (const e of S.registry.employers) for (const s of e.sources) {
    const live = S.live.get(s.id), run = live || st.get(s.id);
    rows.push({ e, s, run, result: run?.result || (s.ats === 'link_only' ? 'link_only' : s.ats === 'unresolved' ? 'not_fetchable' : 'never_run'), live: !!live });
  }
  for (const s of S.status.sources.filter(x => x.id.startsWith('agg:'))) rows.push({ e: { employer: '(aggregator) ' + s.ats, sector: 'Aggregator', vertical: '', tier: 'aggregator', sources: [] }, s: { id: s.id, ats: s.ats, verification: { status: 'aggregator' } }, run: s, result: s.result });
  return rows;
}
function coverage(rows) {
  const emps = S.registry.employers;
  const okIds = new Set(rows.filter(r => ['ok', 'empty'].includes(r.result)).map(r => r.s.id));
  const verifiedEmp = emps.filter(e => e.sources.some(s => VERIFIED.has(s.verification?.status) || okIds.has(s.id)));
  const feeds = rows.filter(r => r.s.ats !== 'link_only' && r.s.ats !== 'unresolved' && (VERIFIED.has(r.s.verification?.status) || okIds.has(r.s.id)));
  const failed = rows.filter(r => !okIds.has(r.s.id) && (resultClass(r.result) === 'bad' || resultClass(r.result) === 'warn' || /unresolved/.test(r.s.verification?.status || '')));
  const checked = emps.filter(e => e.sources.some(s => okIds.has(s.id)));
  return { emps: emps.length, verifiedEmp: verifiedEmp.length, feeds: feeds.length, cross: CROSS.length, failed: failed.length, checked: checked.length };
}
function renderSources() {
  const rows = sourceRows(), cov = coverage(rows);
  $('#covTiles').innerHTML = [['c', cov.emps, 'unique employers'], ['g', cov.verifiedEmp, 'employers w/ verified source'], ['c', cov.feeds, 'verified feeds / APIs'], ['m', cov.cross, 'cross-employer sources'], ['r', cov.failed, 'failed / unresolved'], ['a', cov.checked, 'employers checked for vacancies']]
    .map(([c, n, l]) => `<div class="tile ${c}"><i class="cn tl"></i><i class="cn tr"></i><i class="cn bl"></i><i class="cn br"></i><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  const fill = (sel, label, vals) => { const cur = $(sel).value; $(sel).innerHTML = `<option value="">${label}</option>` + vals.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join(''); };
  fill('#sAts', 'All ATS', [...new Set(rows.map(r => r.s.ats))].sort());
  fill('#sStatus', 'All results', [...new Set(rows.map(r => r.result))].sort());
  fill('#sSector', 'All sectors', [...new Set(rows.map(r => r.e.sector))].sort());
  const q = $('#sq').value.toLowerCase(), fa = $('#sAts').value, fs = $('#sStatus').value, fsec = $('#sSector').value;
  const vis = rows.filter(r => (!q || r.e.employer.toLowerCase().includes(q)) && (!fa || r.s.ats === fa) && (!fs || r.result === fs) && (!fsec || r.e.sector === fsec));
  const fv = f => !f ? '—' : Object.entries(f).map(([k, v]) => `${k}: ${v}`).join('<br>');
  $('#srcTable').innerHTML = `<thead><tr><th>Employer</th><th>Sector / vertical</th><th>Tier</th><th>ATS</th><th>Verification</th><th>Last result</th><th>Jobs</th><th>Date / pay / location visibility</th><th>Last checked</th><th>Links</th><th></th></tr></thead><tbody>` +
    vis.map(r => {
      const s = r.s, e = r.e, run = r.run;
      const links = [e.careers_url && `<a href="${esc(e.careers_url)}" target="_blank" rel="noopener">careers${e.careers_url_verified ? '' : '*'}</a>`, s.board_url && `<a href="${esc(s.board_url)}" target="_blank" rel="noopener">board</a>`,
        s.feed_url && `<a href="${esc(s.feed_url)}" target="_blank" rel="noopener">feed</a>`, e.linkedin_jobs_url && `<a href="${esc(e.linkedin_jobs_url)}" target="_blank" rel="noopener">LinkedIn</a>`].filter(Boolean).join(' · ');
      return `<tr><td class="emp">${esc(e.employer)}${(e.notes || []).length ? ` <span title="${esc(e.notes.join(' '))}" style="color:var(--acid);cursor:help">ⓘ</span>` : ''}</td><td>${esc(e.sector)}<br><span style="color:var(--faint)">${esc(e.vertical || '')}</span></td><td>${esc(e.tier)}</td><td>${esc(s.ats)}${s.slug ? `<br><span style="color:var(--faint)">${esc(s.slug)}</span>` : ''}</td>
        <td title="${esc(s.verification?.method || '')}" style="cursor:help">${esc(s.verification?.status || '—')}</td>
        <td><span class="st ${resultClass(r.result)}" title="${esc(RESULT_HELP[r.result] || r.result)}">${esc(r.result)}</span>${run?.http_status ? ` <span style="color:var(--faint)">${run.http_status}</span>` : ''}${r.live ? ' <span class="tag m">live</span>' : ''}${run?.message ? `<br><span style="color:var(--faint)">${esc(String(run.message).slice(0, 140))}</span>` : ''}</td>
        <td>${run ? `${run.jobs_stored ?? '—'}${run.jobs_total != null && run.jobs_total !== run.jobs_stored ? ` / ${run.jobs_total}` : ''}` : '—'}</td><td>${fv(run?.fields)}</td>
        <td>${run?.checked_at ? esc(run.checked_at.slice(0, 16).replace('T', ' ')) : '—'}${run?.last_success_at && run.last_success_at !== run.checked_at ? `<br><span style="color:var(--faint)">last ok ${esc(run.last_success_at.slice(0, 10))}</span>` : ''}</td>
        <td>${links}</td><td>${C.BROWSER_ATS.has(s.ats) ? `<button class="btn sec sm" data-live="${esc(s.id)}">Live</button>` : ''}</td></tr>`;
    }).join('') + '</tbody>';
  $('#unresolved').innerHTML = (S.registry.unresolved_identifiers || []).map(u => `<div class="hint" style="margin-bottom:8px"><span class="tag r">${esc(u.ats)}:${esc(u.identifier)}</span> ${esc(u.note)}</div>`).join('') +
    `<p class="hint">Employers whose Greenhouse guess returned 404 are listed in the table as <b>unresolved</b>. Run the collector with <code>--probe</code> to get candidate boards for review.</p>`;
  $('#fieldVis').innerHTML = `<table><thead><tr><th>ATS</th><th>Posting date</th><th>Base salary</th><th>Remote</th><th>Req ID</th></tr></thead><tbody>${[
    ['Greenhouse', 'first_published (else updated_at only)', 'Description text; optional pay_transparency ranges', 'Location text', 'requisition_id when set'],
    ['Lever', 'createdAt', 'salaryRange when filled + text', 'workplaceType', '—'], ['Ashby', 'publishedAt', 'Structured comp (Salary component = base)', 'isRemote / workplaceType', '—'],
    ['Workday', 'List: "Posted N days ago"; detail: startDate', 'Detail description text', 'remoteType if tenant sets it', 'jobReqId'], ['SmartRecruiters', 'releasedDate', 'Detail text', 'location.remote', 'refNumber'],
    ['Amazon', 'posted_date', 'Geo pay statement in text', 'Text only', 'id_icims'], ['Oracle HCM', 'PostedDate', 'Detail text', 'WorkplaceType', 'Id'], ['Aggregators', 'Varies / relative', 'Often predicted. Never treated as base', 'Varies', '—'],
  ].map(r => `<tr>${r.map((c, i) => `<td ${i ? '' : 'class="emp"'}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  $$('#srcTable [data-live]').forEach(b => b.onclick = () => liveCheck([b.dataset.live]));
  $$('#srcTable th').forEach((th, i) => th.onclick = () => sortTable(i));
}
function sortTable(i) {
  const tb = $('#srcTable tbody'); const rows = [...tb.rows]; const dir = (sortTable.last === i ? -sortTable.dir : 1); sortTable.last = i; sortTable.dir = dir;
  rows.sort((a, b) => a.cells[i].textContent.localeCompare(b.cells[i].textContent, undefined, { numeric: true }) * dir).forEach(r => tb.appendChild(r));
}
function wireSources() {
  ['#sq', '#sAts', '#sStatus', '#sSector'].forEach(s => $(s).addEventListener(s === '#sq' ? 'input' : 'change', renderSources));
  $('#btnLiveAll').onclick = () => {
    const ids = sourceRows().filter(r => C.BROWSER_ATS.has(r.s.ats)).map(r => r.s.id);
    if (!confirm(`Pull the latest listings from ${ids.length} Greenhouse, Lever and Ashby boards into this tab? Requests are paced (one at a time per host), so this takes a few minutes.`)) return;
    liveCheck(ids);
  };
  $('#btnDirCsv').onclick = () => downloadCSV(sourceRows().map(r => ({ employer: r.e.employer, sector: r.e.sector, vertical: r.e.vertical, tier: r.e.tier, official_careers: r.e.careers_url || '', careers_url_verified: !!r.e.careers_url_verified,
    ats: r.s.ats, identifier: r.s.slug || r.s.tenant || r.s.company || '', board_url: r.s.board_url || '', feed_url: r.s.feed_url || '', linkedin_jobs: r.e.linkedin_jobs_url || '', verification: r.s.verification?.status || '', verification_method: r.s.verification?.method || '',
    last_result: r.result, http_status: r.run?.http_status || '', jobs_stored: r.run?.jobs_stored ?? '', fields: r.run?.fields ? JSON.stringify(r.run.fields) : '', last_checked: r.run?.checked_at || '', last_success: r.run?.last_success_at || '', notes: (r.e.notes || []).join(' ') })), `cache-flow-source-directory-${C.nyDate(new Date(), LOCAL_TZ)}.csv`);
}
// Browser http with per-host pacing; never retries 403s
const bhttp = (() => {
  const chains = new Map(); const sleep = ms => new Promise(r => setTimeout(r, ms));
  return { json(url) {
    const host = new URL(url).host;
    const run = async () => {
      for (let a = 0; a < 3; a++) {
        let r;
        try { r = await fetch(url, { headers: { accept: 'application/json' } }); }
        catch { return { ok: false, error: 'blocked_or_network', detail: 'Browser blocked the request (CORS) or the network failed. Not evidence of zero jobs.' }; }
        if (r.status === 429 || r.status >= 500) { const ra = +r.headers.get('retry-after'); await sleep(Math.min(30000, (ra ? ra * 1000 : 1500 * 2 ** a) + Math.random() * 500)); continue; }
        if (!r.ok) return { ok: false, status: r.status, statusText: r.statusText };
        try { return { ok: true, status: r.status, data: await r.json() }; } catch { return { ok: false, error: 'parse_error' }; }
      }
      return { ok: false, status: 429, statusText: 'Rate limited after retries' };
    };
    const p = (chains.get(host) || Promise.resolve()).then(run).finally(() => sleep(450 + Math.random() * 650));
    chains.set(host, p.catch(() => {}).then(() => sleep(450 + Math.random() * 650)));
    return p;
  } };
})();
async function liveCheck(ids) {
  const log = $('#liveLog'); log.style.display = 'block';
  const line = h => { log.innerHTML += h + '<br>'; log.scrollTop = 1e6; };
  line(`<span class="p">cacheflow&gt;</span> live check: ${ids.length} board(s)`);
  const byId = new Map(); for (const e of S.registry.employers) for (const s of e.sources) byId.set(s.id, { e, s });
  let done = 0; const hud = $('#hud');
  const work = ids.map(async id => {
    const { e, s } = byId.get(id);
    const out = await C.ADAPTERS[s.ats](s, e, bhttp);
    const now = new Date().toISOString();
    const prevUids = new Map(S.jobs.filter(j => j.source_id === id).map(j => [j.uid, j]));
    if (out.result === 'ok' || out.result === 'empty') {
      const fresh = out.jobs.map(r => { const j = C.enrichJob(r); const p = prevUids.get(j.uid); return { ...j, first_observed: p?.first_observed || now, last_seen: now, status: 'open', live: true }; }).filter(j => j.us !== false);
      S.jobs = S.jobs.filter(j => j.source_id !== id).concat(fresh);
    }
    S.live.set(id, { id, result: out.result, http_status: out.status, message: out.note || '', fields: out.fields, jobs_total: out.jobs.length, jobs_stored: out.jobs.length, checked_at: now, last_success_at: ['ok', 'empty'].includes(out.result) ? now : null });
    done++; hud.style.setProperty('--progress', Math.round(done / ids.length * 100) + '%');
    line(`<span class="${resultClass(out.result) === 'ok' || out.result === 'empty' ? 'g' : resultClass(out.result) === 'warn' ? 'y' : 'r'}">${esc(out.result.padEnd(12))}</span> ${esc(e.employer)} <span class="c">${esc(id)}</span> → ${out.jobs.length} jobs`);
  });
  await Promise.all(work);
  line(`<span class="g">✓</span> live check complete. Results are in this browser tab only; the scheduled collector keeps the shared record.`);
  setTimeout(() => hud.style.setProperty('--progress', '0%'), 1500);
  renderSources(); renderMatches();
}

/* ============================================================ discover */
const FN_QUERY = { product: 'product manager', tpm: 'technical program manager', pmm: 'product marketing manager', sales: 'go-to-market strategy', partner: 'partnerships alliances', ci: 'competitive intelligence enablement', strategy: 'chief of staff strategy' };
function renderDiscover() {
  const c = S.crit, home = S.profile.location || (c.state ? C.STATES[c.state] : '') || 'United States';
  const secWord = c.sectors.length === 1 && c.sectors[0] === 'Cybersecurity' || c.verticals.length ? ' security' : '';
  const enc = encodeURIComponent;
  const rows = c.functions.map(f => {
    const q = FN_QUERY[f] + secWord;
    const ats = `(site:job-boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com OR site:myworkdayjobs.com) "${FN_QUERY[f]}"${secWord ? ' security' : ''} ("${home.split(',')[0]}" OR remote)`;
    return `<tr><td class="emp">${esc(C.FUNCTIONS[f].label)}</td><td>${esc(q)}</td><td>
      <a target="_blank" rel="noopener" href="https://www.linkedin.com/jobs/search/?keywords=${enc(q)}&location=${enc(home)}&f_TPR=r604800">LinkedIn · ${esc(home.split(',')[0])}</a> ·
      <a target="_blank" rel="noopener" href="https://www.linkedin.com/jobs/search/?keywords=${enc(q)}&location=United%20States&f_WT=2&f_TPR=r604800">LinkedIn · remote US</a> ·
      <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${enc(q + ' jobs ' + home)}&ibp=htl;jobs">Google Jobs</a> ·
      <a target="_blank" rel="noopener" href="https://www.indeed.com/jobs?q=${enc(q)}&l=${enc(home)}&fromage=7">Indeed · 7d</a> ·
      <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${enc(ats)}&tbs=qdr:w">ATS x-ray · past week</a></td></tr>`;
  }).join('');
  $('#genLinks').innerHTML = `<div class="tbl-wrap" style="max-height:none"><table><thead><tr><th>Function</th><th>Query</th><th>Searches</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint" style="margin-top:8px">Built from your selected functions and home location (<b>${esc(home)}</b>). The ATS x-ray finds employers that aren't in the roster yet. Add any you find to <code>data/sources.json</code>. These URL formats are standard query strings and may change on the sites' side. Salary filters on these sites mix in estimates, so check base pay on the posting itself.</p>`;
  const vTag = v => v === 'seen' ? '<span class="tag g">seen 2026-11-19</span>' : '<span class="tag f">unverified link</span>';
  $('#xTable').innerHTML = `<thead><tr><th>Source</th><th>Type</th><th>Employers / functions</th><th>Date filters</th><th>Base salary</th><th>Location / remote</th><th>Access limits</th><th>Duplicate / coverage</th><th>Link</th></tr></thead><tbody>` +
    CROSS.map(x => `<tr><td class="emp"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td>${esc(x.type)}</td><td>${esc(x.covers)}</td><td>${esc(x.date)}</td><td>${esc(x.base)}</td><td>${esc(x.ny)}</td><td>${esc(x.limits)}</td><td>${esc(x.dup)}</td><td>${vTag(x.v)}</td></tr>`).join('') + '</tbody>';
  $('#uTable').innerHTML = `<thead><tr><th>Directory</th><th>Year / currentness</th><th>Employer count</th><th>How it expands coverage</th><th>Link</th></tr></thead><tbody>` +
    UNIVERSE.map(x => `<tr><td class="emp"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td>${esc(x.year)}</td><td>${esc(x.count)}</td><td>${esc(x.how)}</td><td>${vTag(x.v)}</td></tr>`).join('') + '</tbody>';
}

/* ============================================================ setup */
function renderSetup() {
  const repo = location.hostname.endsWith('github.io') ? `${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}` : '<owner>/<repo>';
  $('#setupLeft').innerHTML = `<div class="kicker">Deploy</div>
    <ol><li>Push this folder to a GitHub repo (public repos get unlimited Actions minutes).</li>
    <li><b>Settings → Pages</b>: deploy from branch <code>main</code>, folder <code>/ (root)</code>.</li>
    <li><b>Settings → Actions → General → Workflow permissions</b>: choose <b>Read and write</b> so the collector can commit data.</li>
    <li><b>Actions → Collect jobs → Run workflow</b> for the first run (about 20–45 minutes). After that it runs on schedule.</li>
    <li>Optional discovery feeds: add repo secrets <code>ADZUNA_APP_ID</code>/<code>ADZUNA_APP_KEY</code> (free) and/or <code>SERPAPI_KEY</code>.</li></ol>
    <h4>How collection works</h4>
    <p>GitHub Pages only serves static files. The scheduled GitHub Action runs <code>collector/collect.mjs</code>, which reads each employer's public job feed with polite pacing (one request at a time per host, randomized gaps, bounded backoff on 429/5xx, Retry-After honored, no retries on 403). It writes <code>data/jobs.json</code> and <code>data/status.json</code>. Each run is a git commit, so the repo history is the audit trail.</p>
    <p>In the browser, <b>Live check</b> reads Greenhouse, Lever and Ashby boards directly. Workday, Amazon, Oracle and Microsoft only come through the Action.</p>
    <h4>Add an employer</h4>
    <p>Open any role on their careers site and click <b>Apply</b>. The host tells you the ATS: <code>job-boards.greenhouse.io/&lt;slug&gt;</code>, <code>jobs.lever.co/&lt;slug&gt;</code>, <code>jobs.ashbyhq.com/&lt;slug&gt;</code>, <code>&lt;tenant&gt;.wd5.myworkdayjobs.com/&lt;site&gt;</code>. Add a source object to that employer in <code>data/sources.json</code>. The next run reports whether it worked.</p>
    <pre>{ "id": "wd:acme", "ats": "workday", "host": "acme.wd5.myworkdayjobs.com",
  "tenant": "acme", "site": "AcmeCareers", "queries": ["product manager"] }</pre>
    <p>Run <code>node collector/collect.mjs --probe</code> to get suggested boards for unresolved employers. Suggestions go to <code>data/probe-results.json</code> for you to review; nothing is auto-added.</p>
`;
  $('#setupRight').innerHTML = `<div class="kicker">Method &amp; limits</div>
    <h4>Salary</h4><ul><li>Only base salary counts. OTE, on-target earnings, total comp, bonus, equity and aggregator-predicted figures are shown but never used as base.</li>
    <li><b>Starts</b> = the range minimum meets your threshold. <b>Reaches</b> = only the maximum does. They're listed separately.</li>
    <li>With several geo ranges, a range labeled for your top-cost zone or New York is preferred. Otherwise the highest range is used and flagged "multi-range".</li></ul>
    <h4>Dates</h4><ul><li>Each card says which date it was filtered on: original posting date, Workday start date, an approximate date from "posted N days ago", an <b>updated</b> date (could be a refresh), or the collector's first-observed date.</li>
    <li>When a role's posting date changes between runs, it's flagged as a possible repost and the earlier dates are kept.</li>
    <li>The window uses your browser's time zone (${esc(LOCAL_TZ)}).</li></ul>
    <h4>Location</h4><ul><li>"Commute area" matches your metro list against the job's locations.</li>
    <li>For US-remote roles, the description is checked for your state: excluded, listed, "all 50 states", or a pay range naming it. If none applies, it's marked <b>not stated</b>, never assumed.</li></ul>
    <h4>Failures</h4><ul><li>A 403 means access failed, not that the employer has no jobs. A 404 usually means a wrong identifier. When a refresh fails, the previous roles are kept and flagged "not refreshed".</li>
    <li>LinkedIn profiles and LinkedIn job search can't be read automatically. Use the PDF export and the generated links.</li></ul>
    <h4>Coverage</h4><p>The roster has ${S.registry.employers.length} employers seeded from a feed scan plus big-tech systems. It is <b>not exhaustive</b>. The Sources tab lists every gap.</p>
    <p class="hint">Repo: ${esc(repo)} · resume parsing runs locally in this browser · nothing about you leaves this page unless you use the optional Claude call</p>`;
}

function fatal(e) {
  console.error(e);
  const m = document.querySelector('main');
  if (m) m.insertAdjacentHTML('afterbegin', `<div class="empty-state" style="margin-bottom:20px"><b>CACHE FLOW HIT AN ERROR</b>${esc(e?.message || e)}<br>Try a hard refresh (Ctrl + Shift + R). If it persists, the browser console has details.</div>`);
  $('#dataAge') && ($('#dataAge').textContent = 'ERROR');
}
try { wireMatches(); wireSources(); boot().catch(fatal); } catch (e) { fatal(e); }
