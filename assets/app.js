import * as C from './shared/core.mjs?v=20261120c';
import { CROSS, UNIVERSE } from './discovery.mjs?v=20261120c';
import { extractResume, suggestFunctions } from './shared/resume.mjs?v=20261120c';

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
const PAY_LEVELS = [0, 80000, 100000, 120000, 140000, 150000, 160000, 175000, 180000, 200000, 220000, 225000, 250000, 275000, 300000, 350000, 400000];
/* Company types, so you can tell what kind of employer a role is at. */
const EMP_TYPE = {
  big: { label: 'Big tech & large companies', hint: 'Big tech, cloud giants and large public or late-stage companies (Microsoft, Google, AWS, Salesforce, Stripe, OpenAI, big trading firms…)' },
  security: { label: 'Established security companies', hint: 'Large or long-running security vendors and security services firms (CrowdStrike, Palo Alto Networks, CyberArk, Fortinet, Optiv…)' },
  growth: { label: 'Startups & growth-stage', hint: 'Younger, venture-backed companies in security, AI, SaaS, fintech and health, from early stage to pre-IPO' },
  aggregator: { label: 'Found via job aggregators', hint: "Roles from aggregator searches rather than the employer's own job site; check the posting" },
};
const typeOf = m => C.companyType(m.j, m.e);
const QS = new URLSearchParams(location.search);
if (QS.has('owner')) store.set('owner', QS.get('owner') !== 'off');
const OWNER = !!store.get('owner', false);
const DEFAULT_CRIT = () => ({
  functions: [...C.DEFAULT_FUNCTIONS], fnKnown: [...FN_KEYS], engReview: false, minBase: 150000, salMode: 'starts_reaches', window: 'week', firstSeen: true, updated: true,
  lMetro: true, lRemoteYes: true, lRemoteUnknown: true, lOther: false, metro: '', state: '', sen: 2,
  include: '', exclude: 'intern, new grad, apprentice', types: { big: true, security: true, growth: true, aggregator: true }, sectors: [], verticals: [], blockEmp: [],
});
const DEFAULT_PROFILE = () => ({ name: '', headline: '', location: '', creds: [], employers: [], titles: [], skillsOn: [], skillsOff: [], custom: [], suggestedFns: [], source: 'empty' });
const S = {
  registry: { employers: [], unresolved_identifiers: [] }, jobs: [], jobsMeta: null, status: { sources: [] },
  crit: { ...DEFAULT_CRIT(), ...store.get('crit', {}) }, profile: { ...DEFAULT_PROFILE(), ...store.get('profile', {}) },
  track: store.get('track', null), fnOpen: new Set(store.get('fnOpen', [])), live: new Map(), empByName: new Map(), open: new Set(),
};
/* Application tracker: one status per role, kept in this browser only (never sent anywhere).
   todo = interested / to do, applied, no = not interested. The old star and hide map onto todo and no. */
const STATUS = { todo: { label: 'To do', short: 'To do', icon: '★', cls: 'st-todo' }, applied: { label: 'Applied', short: 'Applied', icon: '✓', cls: 'st-applied' }, no: { label: 'Not interested', short: 'Not interested', icon: '✕', cls: 'st-no' } };
if (!S.track) {
  S.track = {};
  const t = new Date().toISOString();
  for (const u of store.get('saved', [])) S.track[u] = { s: 'todo', t };
  for (const u of store.get('hidden', [])) S.track[u] = { s: 'no', t };
  store.set('track', S.track);
}
const stOf = uid => S.track[uid]?.s || '';
function setStatus(uid, st) {
  if (!st || stOf(uid) === st) delete S.track[uid];
  else S.track[uid] = { ...(S.track[uid] || {}), s: st, t: new Date().toISOString(), ...(st === 'applied' && !S.track[uid]?.applied ? { applied: new Date().toISOString() } : {}) };
  save();
}
// Category set changed since these criteria were saved: re-suggest from the stored profile (or use the
// defaults) once, then leave the user's toggles alone.
if ((S.crit.fnKnown || []).join() !== FN_KEYS.join()) {
  const known = new Set(S.crit.fnKnown || []);
  const sug = S.profile.source !== 'empty' ? suggestFunctions(S.profile) : [];
  if (S.profile.source !== 'empty') S.profile.suggestedFns = sug;
  if (!S.crit.fnKnown) S.crit.functions = sug.length ? sug : [...C.DEFAULT_FUNCTIONS];
  else for (const k of FN_KEYS) if (!known.has(k) && sug.includes(k) && !S.crit.functions.includes(k)) S.crit.functions.push(k);
  S.crit.functions = S.crit.functions.filter(k => FN_KEYS.includes(k));
  S.crit.fnKnown = [...FN_KEYS]; S.crit.engReview = false;
}
{ // criteria saved before company types: carry over any tier the user had switched off
  const stored = store.get('crit', {});
  if (stored.tiers && !stored.types) { S.crit.types = { big: true, security: true, growth: true, aggregator: true, ...C.companyTypeFilter({ tiers: stored.tiers }) }; delete S.crit.tiers; store.set('crit', S.crit); }
  delete S.crit.tiers;
}
const save = () => { store.set('crit', S.crit); store.set('profile', S.profile); store.set('track', S.track); };

/* Phones show data tables as stacked cards; each cell carries its column name. */
function labelTables(root = document) {
  for (const t of root.querySelectorAll('table:not(.mt)')) {
    const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!heads.length) continue;
    for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => { if (td.tagName === 'TD' && !td.hasAttribute('data-label')) td.setAttribute('data-label', td.colSpan > 1 ? '' : heads[i] || ''); });
  }
}
new MutationObserver(() => { cancelAnimationFrame(labelTables.f); labelTables.f = requestAnimationFrame(() => labelTables()); }).observe(document.documentElement, { childList: true, subtree: true });

/* ============================================================ boot */
async function loadJSON(p, fb) {
  try { const r = await fetch(p, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  catch (e) { console.warn('load', p, e); return fb; }
}
async function boot() {
  const [reg, jobs, status, site, disc] = await Promise.all([loadJSON('data/sources.json', null), loadJSON('data/jobs.json', { jobs: [] }), loadJSON('data/status.json', { sources: [] }), loadJSON('data/site.json', {}), loadJSON('data/discovered.json', { employers: [] })]);
  // companies the seed probe found (YC directory, VC portfolios) join the registry
  if (reg && disc?.employers?.length) { const names = new Set(reg.employers.map(e => e.employer.toLowerCase())); for (const e of disc.employers) if (!names.has(e.employer.toLowerCase())) reg.employers.push(e); }
  S.site = site || {};
  if (!reg) {
    document.querySelector('main').insertAdjacentHTML('afterbegin', OWNER
      ? `<div class="empty-state"><b>DATA FILES NOT REACHABLE</b>Open this app over http (GitHub Pages, or <code>python3 -m http.server</code> in the repo folder). Browsers block file:// data loads.</div>`
      : `<div class="empty-state"><b>COULDN'T LOAD LISTINGS</b>Please refresh the page in a moment.</div>`);
  }
  S.registry = reg || S.registry; S.jobs = jobs.jobs || []; S.jobsMeta = jobs; S.status = status;
  for (const e of S.registry.employers) S.empByName.set(e.employer, e);
  applyOwnerMode(); wireNav(); wireProfile(); renderProfile(); renderCriteria(); wireCritLayout(); renderHud();
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
  const mb = $('#menuBtn'), nav = $('#nav');
  const setMenu = open => { nav.classList.toggle('open', open); mb.setAttribute('aria-expanded', String(open)); mb.classList.toggle('x', open); };
  mb.onclick = e => { e.stopPropagation(); setMenu(!nav.classList.contains('open')); };
  document.addEventListener('click', e => { if (!e.target.closest('#nav')) setMenu(false); });
  addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
  $$('#nav button').forEach(b => b.onclick = () => { show(b.dataset.view); setMenu(false); scrollTo({ top: 0 }); });
  addEventListener('hashchange', () => show(location.hash.slice(1)));
}
function show(v) {
  if (!$('#view-' + v) || (v === 'setup' && !OWNER)) v = 'profile';
  $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  document.body.classList.toggle('on-matches', v === 'matches');
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
function logIngest(html, reset = false) { const el = $('#ingestLog'); el.style.display = 'block'; el.innerHTML = (reset ? '' : el.innerHTML + '<br>') + html; el.scrollTop = 1e6; }
function loadScript(src) {
  return new Promise((res, rej) => { if ([...document.scripts].some(s => s.src === src)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
}
async function fileToText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    // pdf.js 4.10.38, vendored (patched for CVE-2024-4367); eval disabled as defense in depth
    const lib = await import(new URL('./vendor/pdf.min.mjs', import.meta.url).href);
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
    const pdf = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
    let out = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      for (const it of tc.items) out += it.str + (it.hasEOL ? '\n' : ' ');
      out += '\n';
    }
    return out;
  }
  if (name.endsWith('.docx')) {
    await loadScript(new URL('./vendor/mammoth.browser.min.js', import.meta.url).href); // mammoth 1.13.0, vendored (patched for CVE-2025-11849)
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
  if (p.suggestedFns?.length) S.crit.functions = [...p.suggestedFns];
  save(); renderProfile(); renderCriteria(); renderHud(); renderDiscover();
  logIngest(`<span class="g">✓</span> ${how}: ${p.skillsOn.length} skills · ${p.titles.length} titles · ${p.creds.length} credentials · ${p.employers.length} employers` +
    (p.location ? ` · home <span class="c">${esc(p.location)}</span>` : ' · <span class="y">no home location found; set it below</span>') +
    (p.suggestedFns.length ? `<br><span class="p">cacheflow&gt;</span> job categories pre-selected from your résumé: <span class="c">${p.suggestedFns.map(f => C.FUNCTIONS[f].label).join(', ')}</span> (marked ◆; change them any time in Search criteria on the Matches page)` : '<br><span class="y">No job categories recognized; the defaults stay selected.</span>'));
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
  $('#btnClear').onclick = () => { S.profile = DEFAULT_PROFILE(); S.crit = DEFAULT_CRIT(); $('#paste').value = ''; save(); renderProfile(); renderCriteria(); renderHud(); $('#ingestLog').style.display = 'none'; };
  $('#heroUpload').onclick = e => { e.preventDefault(); $('#drop').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $('#file').click(), 450); };
  for (const [id, key] of [['#pName', 'name'], ['#pLoc', 'location'], ['#pHead', 'headline']]) $(id).onchange = e => {
    S.profile[key] = e.target.value.trim();
    if (key === 'location') applyProfile({ ...S.profile }, 'Location updated');
    save(); renderHud();
  };
  $('#skillFind').oninput = filterSkills;
  $('#skillOnly').onclick = e => { const b = e.currentTarget, v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); b.classList.toggle('on', v); filterSkills(); };
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
function filterSkills() {
  const q = ($('#skillFind')?.value || '').trim().toLowerCase(), only = $('#skillOnly')?.getAttribute('aria-pressed') === 'true';
  $$('#pSkills .skgrp').forEach(d => {
    let shown = 0;
    d.querySelectorAll('.chip').forEach(c => { const v = (!q || c.textContent.toLowerCase().includes(q) || d.dataset.g.toLowerCase().includes(q)) && (!only || c.classList.contains('on')); c.hidden = !v; shown += v; });
    d.hidden = !shown;
    if (q || only) d.open = shown > 0; else d.open = new Set(store.get('skOpen', [])).has(d.dataset.g);
  });
}
function renderProfile() {
  const p = S.profile;
  $('#pName').value = p.name || ''; $('#pLoc').value = p.location || ''; $('#pHead').value = p.headline || '';
  $('#profSource').textContent = p.source === 'empty' ? 'no resume loaded' : p.source + (p.years ? ` · ~${p.years} yrs` : '');
  $('#pCreds').innerHTML = [...(p.creds || []).map(c => `<span class="tag m">${esc(c)}</span>`), ...(p.employers || []).map(c => `<span class="tag">${esc(c)}</span>`), ...(p.titles || []).slice(0, 6).map(c => `<span class="tag f">${esc(c)}</span>`)].join('') || '<span class="hint">Nothing yet. Drop a resume or load the sample.</span>';
  const on = new Set(p.skillsOn || []), off = new Set(p.skillsOff || []);
  const groups = {};
  for (const s of C.SKILLS) (groups[s.group] ||= []).push(s);
  const skOpen = new Set(store.get('skOpen', []));
  $('#pSkills').innerHTML = Object.entries(groups).map(([g, list]) => { const k = list.filter(s => on.has(s.id) && !off.has(s.id)).length;
    return `<details class="skgrp" data-g="${esc(g)}" ${skOpen.has(g) ? 'open' : ''}><summary>${esc(g)} <span class="skn">${k ? `${k} on · ` : ''}${list.length}</span></summary><div class="chips">` +
    list.map(s => `<button class="chip ${on.has(s.id) && !off.has(s.id) ? 'on' : ''}" data-skill="${esc(s.id)}">${esc(s.id)}</button>`).join('') + '</div></details>'; }).join('') +
    ((p.custom || []).length ? `<div style="margin:8px 0 4px" class="hint">Custom keywords</div><div class="chips">${p.custom.map((c, i) => `<button class="chip on m" data-custom="${i}">${esc(c)}<span class="x">×</span></button>`).join('')}</div>` : '');
  $('#skillSum').textContent = `Skills used for match scoring · ${(p.skillsOn || []).length} on${(p.custom || []).length ? ` · ${p.custom.length} custom` : ''}`;
  $$('#pSkills [data-skill]').forEach(b => b.onclick = () => {
    const id = b.dataset.skill; const s = new Set(S.profile.skillsOn || []);
    s.has(id) ? s.delete(id) : s.add(id); S.profile.skillsOn = [...s]; save(); b.classList.toggle('on'); $('#skillSum').textContent = `Skills used for match scoring · ${s.size} on`;
    const d = b.closest('.skgrp'), k = d.querySelectorAll('.chip.on').length; d.querySelector('.skn').textContent = (k ? `${k} on · ` : '') + d.querySelectorAll('.chip').length;
  });
  $$('#pSkills .skgrp').forEach(d => d.ontoggle = () => { if (($('#skillFind')?.value || '').trim() || $('#skillOnly')?.getAttribute('aria-pressed') === 'true') return; const o = new Set(store.get('skOpen', [])); d.open ? o.add(d.dataset.g) : o.delete(d.dataset.g); store.set('skOpen', [...o]); });
  filterSkills();
  $$('#pSkills [data-custom]').forEach(b => b.onclick = () => { S.profile.custom.splice(+b.dataset.custom, 1); save(); renderProfile(); });
}

/* ============================================================ criteria */
function sectorsAndVerticals() {
  const sec = new Map(), ver = new Map(), tree = new Map();
  for (const e of S.registry.employers) {
    sec.set(e.sector, (sec.get(e.sector) || 0) + 1);
    if (e.vertical) { ver.set(e.vertical, (ver.get(e.vertical) || 0) + 1); if (!tree.has(e.sector)) tree.set(e.sector, new Map()); const t = tree.get(e.sector); t.set(e.vertical, (t.get(e.vertical) || 0) + 1); }
  }
  return { sec: [...sec].sort((a, b) => b[1] - a[1]), ver: [...ver].sort((a, b) => b[1] - a[1]), tree };
}
/* Criteria live beside the results: a sticky sidebar on wide screens, a collapsible panel above the results
   otherwise. Every change re-runs the match list (debounced), so there's no separate "run search" step. */
const wideLayout = () => innerWidth >= 1100;
function queueMatches() { clearTimeout(queueMatches.t); queueMatches.t = setTimeout(() => { if ($('#view-matches').classList.contains('active')) renderMatches(); else S.matchesDirty = true; }, 150); }
function setCritOpen(open) { const d = $('#critBox'); if (!d) return; d.open = open; syncLayout(); }
function syncLayout() { const d = $('#critBox'); $('#mLayout')?.classList.toggle('side-open', !!d?.open && wideLayout()); }
function critSummary() {
  const c = S.crit, n = (c.functions || []).length;
  const rule = { starts: 'starts ≥', starts_reaches: 'starts or reaches', plus_unknown: '≥ (or unstated)', any: 'any' }[c.salMode] || '';
  const win = { week: 'this week', d7: '7 days', d14: '14 days', d30: '30 days', all: 'any date' }[c.window] || c.window;
  const locs = [c.lMetro && 'commute area', (c.lRemoteYes || c.lRemoteUnknown) && 'remote', c.lOther && 'other US'].filter(Boolean).join(' + ') || 'no locations';
  return `${n} categor${n === 1 ? 'y' : 'ies'} · base ${c.salMode === 'any' ? 'any' : rule + ' ' + money(c.minBase)} · ${win} · ${locs}`;
}
function wireCritLayout() {
  const d = $('#critBox'); if (!d) return;
  const stored = store.get('critOpen', null);
  d.open = wideLayout() ? (stored ?? true) : false; // phones and narrow windows open on the results; criteria are one tap away
  d.addEventListener('toggle', () => { store.set('critOpen', d.open); syncLayout(); });
  addEventListener('resize', () => { clearTimeout(wireCritLayout.t); wireCritLayout.t = setTimeout(syncLayout, 120); });
  syncLayout();
}
function renderCriteria() {
  const c = S.crit, sug = new Set(S.profile.suggestedFns || []);
  const fnRow = k => `<label class="check" title="${esc(C.FUNCTIONS[k].hint)}"><input type="checkbox" data-fn="${k}" ${c.functions.includes(k) ? 'checked' : ''}> <span>${esc(C.FUNCTIONS[k].label)}${sug.has(k) ? ' <span class="fn-sug" title="Suggested from your résumé">◆</span>' : ''}<small>${esc(C.FUNCTIONS[k].hint)}</small></span></label>`;
  $('#cFunctions').innerHTML = `<div class="fn-tools"><span>${c.functions.length} of ${FN_KEYS.length} selected</span>${sug.size ? '<button class="linkbtn" data-fnset="sug">◆ From résumé</button>' : ''}<button class="linkbtn" data-fnset="def">Defaults</button><button class="linkbtn" data-fnset="all">All</button><button class="linkbtn" data-fnset="none">None</button></div>` +
    C.FUNCTION_GROUPS.map(g => { const ks = FN_KEYS.filter(k => C.FUNCTIONS[k].group === g), on = ks.filter(k => c.functions.includes(k)).length;
      return `<details class="fn-group" data-grp="${esc(g)}" ${S.fnOpen.has(g) ? 'open' : ''}><summary>${esc(g)} <em>${on}/${ks.length}</em></summary>${ks.map(fnRow).join('')}</details>`; }).join('');
  const levels = [...new Set([...PAY_LEVELS, +c.minBase || 0])].sort((a, b) => a - b);
  $('#cMinBase').innerHTML = levels.map(v => `<option value="${v}">${v ? money(v) + '+' : 'No minimum'}${v && !PAY_LEVELS.includes(v) ? ' (from your profile)' : ''}</option>`).join('');
  $('#cMinBase').value = String(+c.minBase || 0); $('#cSalMode').value = c.salMode; $('#cWindow').value = c.window;
  $('#cFirstSeen').checked = c.firstSeen; $('#cUpdated').checked = c.updated;
  for (const k of ['lMetro', 'lRemoteYes', 'lRemoteUnknown', 'lOther']) $('#' + k).checked = c[k];
  $('#cMetro').value = c.metro; $('#cMetro').placeholder = 'set a home location, or type cities separated by |';
  $('#cMetroPreset').innerHTML = '<option value="">Metro preset…</option>' + Object.keys(C.METRO_PRESETS).map(k => `<option>${esc(k)}</option>`).join('');
  $('#cMetroPreset').onchange = e => { if (e.target.value) { c.metro = C.METRO_PRESETS[e.target.value]; $('#cMetro').value = c.metro; upd(); } };
  $('#cSen').innerHTML = Object.entries(C.SENIORITY_LABEL).map(([v, l]) => `<option value="${v}" ${+v === c.sen ? 'selected' : ''}>${l} and above</option>`).join('');
  $('#cInclude').value = c.include; $('#cExclude').value = c.exclude;
  const tierN = {}; for (const e of S.registry.employers) { const k = C.companyType({}, e); tierN[k] = (tierN[k] || 0) + 1; }
  c.types ||= {};
  $('#cTiers').innerHTML = Object.entries(EMP_TYPE).map(([k, v]) => `<button class="chip ${c.types[k] !== false ? 'on' : ''}" data-tier="${k}" title="${esc(v.hint)}" aria-pressed="${c.types[k] !== false}">${esc(v.label)}${tierN[k] ? ' · ' + tierN[k] : ''}</button>`).join('') +
    `<details class="typehelp"><summary>What do these mean?</summary>${Object.values(EMP_TYPE).map(v => `<div><b>${esc(v.label)}</b> ${esc(v.hint)}</div>`).join('')}</details>`;
  c.blockEmp ||= [];
  $('#cBlocked').innerHTML = c.blockEmp.length ? c.blockEmp.map(n => `<button class="chip on r" data-unblock="${esc(n)}" title="Show this employer again">${esc(n)} ✕</button>`).join('') : '<span class="sub2">None. Use “Hide this employer” in a role’s details to stop seeing a company.</span>';
  const { sec, ver } = sectorsAndVerticals();
  const { tree } = sectorsAndVerticals();
  c.vertSectors = {}; for (const [sc, vs] of tree) for (const v of vs.keys()) c.vertSectors[v] = sc;
  const anyInd = c.sectors.length || c.verticals.length;
  { const n = new Set([...c.sectors, ...c.verticals.map(v => c.vertSectors[v])]).size;
    $('#indSum').textContent = anyInd ? `${n} industr${n === 1 ? 'y' : 'ies'}${c.verticals.length ? ` · ${c.verticals.length} subcategor${c.verticals.length === 1 ? 'y' : 'ies'}` : ''}` : 'All industries';
    if (!renderCriteria.indInit) { $('#indBox').open = !!anyInd; renderCriteria.indInit = true; } }
  $('#cSectors').innerHTML = `<div class="fn-tools"><span>${anyInd ? (n => `Showing ${n} industr${n === 1 ? 'y' : 'ies'} · tap to change`)(new Set([...c.sectors, ...c.verticals.map(v => c.vertSectors[v])]).size) : 'All industries included. Pick an industry, or open one and pick subcategories, to narrow.'}</span>${anyInd ? '<button class="linkbtn" id="indAll">Include all</button>' : ''}</div>` +
    sec.map(([sc, n]) => {
      const vs = [...(tree.get(sc) || new Map())].sort((a, b) => b[1] - a[1]), picked = vs.filter(([v]) => c.verticals.includes(v)).length, on = c.sectors.includes(sc) || picked;
      return `<details class="fn-group ind ${on ? 'on' : ''}" ${picked ? 'open' : ''}><summary><button class="chip ${c.sectors.includes(sc) ? 'on' : ''}" data-sector="${esc(sc)}" aria-pressed="${c.sectors.includes(sc)}">${esc(sc)} · ${n}</button><span class="sub2">${picked ? `${picked} of ${vs.length} subcategories` : vs.length > 1 ? `${vs.length} subcategories` : ''}</span></summary>` +
        (vs.length > 1 ? `<div class="chips">${vs.map(([v, k]) => `<button class="chip ${c.verticals.includes(v) ? 'on m' : ''}" data-vert="${esc(v)}" aria-pressed="${c.verticals.includes(v)}">${esc(v)} · ${k}</button>`).join('')}</div>` : '') + `</details>`;
    }).join('');
  const upd = () => { save(); renderHud(); queueMatches(); };
  // category groups start collapsed (their header shows how many are on); remember the ones opened
  $$('#cFunctions details[data-grp]').forEach(d => d.ontoggle = () => { d.open ? S.fnOpen.add(d.dataset.grp) : S.fnOpen.delete(d.dataset.grp); store.set('fnOpen', [...S.fnOpen]); });
  $$('#cFunctions [data-fn]').forEach(i => i.onchange = () => { c.functions = $$('#cFunctions [data-fn]:checked').map(x => x.dataset.fn); upd(); renderCriteria(); });
  $$('#cFunctions [data-fnset]').forEach(b => b.onclick = e => { e.preventDefault();
    c.functions = { sug: [...sug], def: [...C.DEFAULT_FUNCTIONS], all: [...FN_KEYS], none: [] }[b.dataset.fnset]; upd(); renderCriteria(); });
  $('#cMinBase').onchange = e => { c.minBase = Math.max(0, +e.target.value || 0); upd(); };
  $('#cSalMode').onchange = e => { c.salMode = e.target.value; upd(); };
  $('#cWindow').onchange = e => { c.window = e.target.value; upd(); };
  $('#cFirstSeen').onchange = e => { c.firstSeen = e.target.checked; upd(); };
  $('#cUpdated').onchange = e => { c.updated = e.target.checked; upd(); };
  for (const k of ['lMetro', 'lRemoteYes', 'lRemoteUnknown', 'lOther']) $('#' + k).onchange = e => { c[k] = e.target.checked; upd(); };
  $('#cMetro').onchange = e => { c.metro = e.target.value.trim().toLowerCase(); upd(); };
  $('#cSen').onchange = e => { c.sen = +e.target.value; upd(); };
  $('#cInclude').onchange = $('#cInclude').oninput = e => { c.include = e.target.value; upd(); };
  $('#cExclude').onchange = $('#cExclude').oninput = e => { c.exclude = e.target.value; upd(); };
  $$('#cTiers [data-tier]').forEach(b => b.onclick = () => { const k = b.dataset.tier; c.types[k] = c.types[k] === false; b.classList.toggle('on', c.types[k]); b.setAttribute('aria-pressed', c.types[k]); upd(); });
  $$('#cBlocked [data-unblock]').forEach(b => b.onclick = () => { c.blockEmp = c.blockEmp.filter(n => n !== b.dataset.unblock); upd(); renderCriteria(); });
  $$('#cSectors [data-sector]').forEach(b => b.onclick = e => { e.preventDefault(); const s = b.dataset.sector; c.sectors = c.sectors.includes(s) ? c.sectors.filter(x => x !== s) : [...c.sectors, s]; upd(); renderCriteria(); });
  $$('#cSectors [data-vert]').forEach(b => b.onclick = () => { const s = b.dataset.vert; c.verticals = c.verticals.includes(s) ? c.verticals.filter(x => x !== s) : [...c.verticals, s]; upd(); renderCriteria(); });
  $('#indAll') && ($('#indAll').onclick = () => { c.sectors = []; c.verticals = []; upd(); renderCriteria(); });
  $('#btnReset').onclick = () => { S.crit = DEFAULT_CRIT(); if (S.profile.location) applyProfile({ ...S.profile }, 'Criteria reset'); save(); renderCriteria(); renderHud(); queueMatches(); };
  $('#btnGo').onclick = () => { setCritOpen(wideLayout()); show('matches'); scrollTo({ top: 0 }); };
  $('#btnCritDone').onclick = () => { if (!wideLayout()) setCritOpen(false); $('#mResults').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
}

/* ============================================================ matching */
const { csvList, reFromList } = C;
function evaluate(j, ctx) {
  return C.evaluateJob(j, { crit: S.crit, emp: empOf(j), skillsOn: S.profile.skillsOn, custom: S.profile.custom, win: ctx.win, excl: ctx.excl, tz: LOCAL_TZ });
}
function computeMatches() {
  const c = S.crit;
  const ctx = { win: currentWindow(), excl: reFromList(csvList(c.exclude)) };
  const out = [];
  for (const j of S.jobs) {
    const blocked = S.crit.blockEmp?.length && S.crit.blockEmp.includes(j.employer);
    const hit = blocked ? null : evaluate(j, ctx);
    const m = hit || (stOf(j.uid) ? C.evaluateJob(j, { crit: S.crit, emp: empOf(j), skillsOn: S.profile.skillsOn, custom: S.profile.custom, win: ctx.win, excl: ctx.excl, tz: LOCAL_TZ, force: true }) : null);
    if (m) { m.inFilters = !!hit; out.push(m); }
  }
  return out;
}
const money = n => n == null ? '?' : '$' + (n >= 1000 ? Math.round(n / 1000) + 'K' : n);
const KIND_LABEL = { base: 'BASE', base_likely: 'SALARY (base implied)', unlabeled: 'RANGE (type not stated)' };
const DATE_LABEL = { first_published: 'first published', published: 'published', created: 'created', posted_date: 'posted', start_date: 'posting start date', released: 'released', feed_pubdate: 'feed date',
  relative_approx: 'approx. from "posted N days ago"', updated: 'UPDATED date — may be a refresh', first_observed: 'first observed by collector (no posting date)', aggregator_created: 'aggregator date', none: 'no date' };
const LOC_LABEL = { remote_no: ['REMOTE · HOME STATE EXCLUDED', 'r'], metro: ['IN COMMUTE AREA', 'g'], remote_yes: ['REMOTE · HOME STATE OK', 'g'], remote_unknown: ['REMOTE · STATE ELIGIBILITY NOT STATED', 'a'], other: ['OTHER US LOCATION', 'f'] };

const LOC_SHORT = { remote_no: ['Remote · state excluded', 'r'], metro: ['Commute area', 'g'], remote_yes: ['Remote · state OK', 'g'], remote_unknown: ['Remote · state ?', 'a'], other: ['Other US', 'f'] };
const DATE_SHORT = { first_published: 'published', published: 'published', created: 'created', posted_date: 'posted', posted_ts: 'posted', start_date: 'start date', released: 'released', feed_pubdate: 'feed',
  relative_approx: '≈ approx.', updated: 'updated only', first_observed: 'first seen', aggregator_created: 'aggregator', none: '—' };
function jobRow(m) {
  const { j, e } = m, s = j.salary, open = S.open.has(j.uid), st = stOf(j.uid), tr = S.track[j.uid];
  let base = '<span class="sal unknown">not stated</span>';
  if (s && s.kind === 'ote_only') base = `<span class="sal ote_only">OTE only</span><div class="sub2">${money(s.ote?.min)}–${money(s.ote?.max)} excluded</div>`;
  else if (s && s.kind === 'predicted') base = `<span class="sal predicted">${money(s.min)}–${money(s.max)}</span><div class="sub2">predicted, not base</div>`;
  else if (s) base = `<span class="sal ${m.tier}">${money(s.min)}–${money(s.max)}</span><div class="sub2">${m.tier === 'starts' ? 'starts ≥ min' : m.tier === 'reaches' ? 'reaches min' : 'below min'}${s.kind === 'base' ? '' : s.kind === 'base_likely' ? ' · implied' : ' · type unstated'}</div>`;
  const [ll, lc] = m.hf?.tied ? ['Remote · tied to area', 'a'] : LOC_SHORT[m.loc];
  const sl = C.shownLocation(j, m.hf, m.loc), slTitle = sl.all.join(' · ');
  const slText = esc(sl.text) + (sl.more ? ` <span class="more-loc">+${sl.more}</span>` : '');
  const dYmd = m.dt.d ? C.nyDate(new Date(m.dt.d), LOCAL_TZ) : null;
  const stTag = st ? `<span class="tag ${STATUS[st].cls}">${esc(STATUS[st].short)}${(st === 'applied' ? tr.applied || tr.t : tr.t) ? ' · ' + esc(shortDay(st === 'applied' ? tr.applied || tr.t : tr.t)) : ''}</span>` : '';
  const flags = [stTag, j.status === 'closed' && '<span class="tag r">closed</span>', st && !m.inFilters && j.status !== 'closed' && '<span class="tag f">outside filters</span>', j.reposted && '<span class="tag a">repost?</span>', j.stale && `<span class="tag r" title="${esc(STALE_HELP)}">stale</span>`, j.eng_review && '<span class="tag a">review</span>', j.dup_count > 1 && `<span class="tag f">×${j.dup_count}</span>`].filter(Boolean).join('');
  const li = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(j.title + ' ' + (e?.employer || j.employer))}`;
  const detail = open ? `<tr class="mt-detail" data-uid="${esc(j.uid)}"><td colspan="8"><div class="dgrid">
      <div><b>Location</b>${m.loc === 'metro' && m.hf.metro_loc ? `Matched on <b class="inl">${esc(m.hf.metro_loc)}</b> (commute area). ` : ''}${sl.more ? 'All listed: ' : ''}${esc(sl.all.join(' · ') || '—')} · ${esc(j.workplace)}${m.hf.eligibility !== 'n/a' ? ` · home-state eligibility: ${esc(m.hf.eligibility)}` : ''}</div>
      <div><b>Dates</b>${dYmd ? esc(fmtDay(dYmd)) + ' (' + esc(DATE_LABEL[m.dt.kind] || m.dt.kind) + ')' : '—'} · first seen ${esc((j.first_observed || '').slice(0, 10))} · last seen ${esc((j.last_seen || '').slice(0, 10))}</div>
      <div class="wide"><b>Why this scored ${m.score} of 100</b><div class="sbreak">${scoreParts(m).map(([l, v, mx, txt]) => `<div class="sb"><span class="sbl">${esc(l)}</span><span class="sbv">${v}<i>/${mx}</i></span><i class="sbar"><i style="width:${Math.round(100 * v / mx)}%"></i></i><span class="sbt">${esc(txt)}</span></div>`).join('')}</div></div>
      <div><b>Source</b>${esc(j.source_class === 'aggregator' ? 'aggregator · ' + (j.via || j.ats) : 'official · ' + j.ats)} · req ${esc(j.req_id || '—')}${j.department ? ' · ' + esc(j.department) : ''}</div>
      ${j.stale ? `<div class="wide"><b>Stale</b>${esc(STALE_HELP)}${j.last_seen ? ' Last confirmed ' + esc(j.last_seen.slice(0, 10)) + '.' : ''}</div>` : ''}
      ${s?.snippet ? `<div class="wide"><b>Pay text</b>${esc(s.snippet)}</div>` : ''}
      ${m.skillHits.length || m.customHits.length ? `<div class="wide"><b>Matched</b>${esc([...m.skillHits, ...m.customHits].join(' · '))}</div>` : ''}
      ${j.excerpt ? `<div class="wide ex2">${esc(j.excerpt)}${j.excerpt.length >= 900 ? '…' : ''}</div>` : ''}
      <div class="wide row"><a class="btn pri sm" href="${esc(j.url)}" target="_blank" rel="noopener">Open posting ↗</a><a class="btn sec sm" href="${li}" target="_blank" rel="noopener">LinkedIn ↗</a>
        <button class="btn sec sm" data-act="blockemp" title="Stop showing roles from ${esc(j.employer)}. Undo under Search criteria → Hidden employers.">Hide this employer</button>
        <span class="stseg" role="group" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<button class="${v.cls} ${st === k ? 'on' : ''}" data-act="st" data-st="${k}" aria-pressed="${st === k}">${v.icon} ${esc(v.label)}</button>`).join('')}</span></div>
      ${st ? `<div class="wide sub2">Status saved in this browser only${tr.applied ? ` · applied ${esc(new Date(tr.applied).toLocaleDateString())}` : ''} · last changed ${esc(new Date(tr.t).toLocaleString())}</div>` : ''}
    </div></td></tr>` : '';
  return `<tr class="mt-row ${m.tier} ${open ? 'open' : ''} ${st ? STATUS[st].cls : ''}" data-uid="${esc(j.uid)}">
    <td class="c-save"><button class="stbtn ${st ? STATUS[st].cls + ' on' : ''}" data-act="stmenu" title="Status: ${st ? esc(STATUS[st].label) : 'none'}" aria-label="Set status" aria-haspopup="menu">${st ? STATUS[st].icon : '○'}</button></td>
    <td class="c-score" title="${esc(scoreTitle(m))}"><b>${m.score}</b><i class="mbar"><i style="width:${m.score}%"></i></i></td>
    <td class="c-role">${S.groupBy === 'employer' ? '' : `<div class="co">${esc(j.employer)} <span>· ${esc(m.sector)}${m.vertical && m.sector === 'Cybersecurity' ? ' / ' + esc(m.vertical) : ''}</span></div>`}<a href="${esc(j.url)}" target="_blank" rel="noopener" class="ttl">${esc(j.title)}</a>${flags ? `<div class="sub2">${flags}</div>` : ''}<div class="mbase">${base.replace('<div class="sub2">', '<span class="sub2"> · ').replace('</div>', '</span>')}</div><div class="mmeta"><span title="${esc(slTitle)}">${slText}</span> <span class="tag ${lc}">${ll}</span>${applyOf(m) === 'quick' ? ' <span class="tag m" title="' + esc(APPLY.quick.hint) + '">QUICK APPLY</span>' : ''}${dYmd ? ` <span>${esc(DATE_SHORT[m.dt.kind] || m.dt.kind)} ${esc(dYmd.slice(5))}</span>` : ''}</div></td>
    <td class="c-base">${base}</td>
    <td class="c-loc"><div class="one" title="${esc(slTitle)}">${slText}</div><span class="tag ${lc}">${ll}</span>${applyOf(m) === 'quick' ? ' <span class="tag m" title="' + esc(APPLY.quick.hint) + '">QUICK APPLY</span>' : ''}</td>
    <td class="c-date">${dYmd ? esc(dYmd.slice(5)) : '—'}<div class="sub2">${esc(DATE_SHORT[m.dt.kind] || m.dt.kind)}</div></td>
    <td class="c-src">${j.source_class === 'aggregator' ? '<span class="tag a">agg</span>' : '<span class="tag">official</span>'}<div class="sub2">${esc(j.ats)}</div></td>
    <td class="c-act"><button class="more" data-act="open" title="Details">${open ? '−' : '+'}</button></td></tr>${detail}`;
}
// group rows by employer, keeping the current sort: groups are ordered by their best-placed role
/* How much work applying takes, from the hiring system behind the posting. */
const APPLY = {
  quick: { label: 'Quick apply', hint: 'One form, no account (Greenhouse, Ashby, Lever, SmartRecruiters, Comeet, Workable…)', ats: ['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'comeet', 'workable', 'jazzhr', 'rippling', 'recruitee', 'breezy'] },
  account: { label: 'Account required', hint: 'Sign-up or multi-step portal (Workday, Oracle, Eightfold, Phenom, Amazon, Google…)', ats: ['workday', 'oracle_hcm', 'eightfold', 'phenom', 'amazon', 'google', 'successfactors', 'icims', 'taleo', 'dayforce', 'radancy', 'cisco'] },
  other: { label: 'Company site or other', hint: 'Applies on a careers page or through another site' },
};
const applyOf = m => Object.keys(APPLY).find(k => APPLY[k].ats?.includes(m.j.ats)) || 'other';
const GROUP_BY = {
  apply: { key: applyOf, label: k => APPLY[k].label, order: Object.keys(APPLY) },
  employer: { key: m => m.j.employer, label: k => k },
  type: { key: typeOf, label: k => EMP_TYPE[k]?.label || k },
  sector: { key: m => m.sector, label: k => k },
  vertical: { key: m => m.sector + (m.vertical ? ' · ' + m.vertical : ''), label: k => k },
  status: { key: m => stOf(m.j.uid) || 'none', label: k => STATUS[k]?.label || 'No status yet' },
};
function groupedRows(list) {
  const gb = GROUP_BY[S.groupBy] || GROUP_BY.employer;
  const groups = new Map();
  for (const m of list) { const k = gb.key(m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  if (S.groupBy !== 'employer') {
    S.collapsed ||= new Set();
    const entries = gb.order ? [...groups].sort((a, b) => gb.order.indexOf(a[0]) - gb.order.indexOf(b[0])) : [...groups];
    return entries.map(([k, ms]) => {
      const gk = S.groupBy + ':' + k, closed = S.collapsed.has(gk), emps = new Set(ms.map(m => m.j.employer)).size, starts = ms.filter(m => m.tier === 'starts').length;
      return `<tr class="mt-group ${closed ? 'closed' : ''}" data-emp="${esc(gk)}"><td colspan="8"><span class="caret">${closed ? '▸' : '▾'}</span><b>${esc(gb.label(k))}</b>
        <span class="gmeta">${ms.length} role${ms.length > 1 ? 's' : ''} · ${emps} employer${emps > 1 ? 's' : ''}${starts ? ` · ${starts} starting ≥ ${money(S.crit.minBase)}` : ''}${S.groupBy === 'type' && EMP_TYPE[k] ? ' · ' + esc(EMP_TYPE[k].hint) : ''}${S.groupBy === 'apply' ? ' · ' + esc(APPLY[k].hint) : ''}</span></td></tr>` +
        (closed ? '' : ms.map(jobRow).join(''));
    }).join('');
  }
  S.collapsed ||= new Set();
  return [...groups].map(([emp, ms]) => {
    const closed = S.collapsed.has(emp), m0 = ms[0];
    const bases = ms.map(m => m.j.salary).filter(x => x && x.min != null && !['ote_only', 'predicted'].includes(x.kind));
    const top = bases.length ? Math.max(...bases.map(x => x.max)) : null;
    const starts = ms.filter(m => m.tier === 'starts').length;
    return `<tr class="mt-group ${closed ? 'closed' : ''}" data-emp="${esc(emp)}"><td colspan="8"><span class="caret">${closed ? '▸' : '▾'}</span><b>${esc(emp)}</b>
      <span class="gmeta">${ms.length} role${ms.length > 1 ? 's' : ''}${starts ? ` · ${starts} starting ≥ ${money(S.crit.minBase)}` : ''}${top ? ` · up to ${money(top)}` : ''} · ${esc(m0.sector)}${m0.vertical && m0.sector === 'Cybersecurity' ? ' / ' + esc(m0.vertical) : ''}</span></td></tr>` +
      (closed ? '' : ms.map(jobRow).join(''));
  }).join('');
}
function renderMatches() {
  S.matchesDirty = false;
  if ($('#critSum')) $('#critSum').textContent = critSummary();
  const w = currentWindow();
  const meta = S.jobsMeta || {};
  $('#windowBanner').innerHTML = `<b>POSTING WINDOW</b><span class="d">${w ? `${fmtDay(w.start)} → ${fmtDay(w.end)}` : 'Any date'}</span><span>${esc(LOCAL_TZ)} · ${esc(w ? w.label : '')}</span><span class="spacer"></span>` +
    `<span>last updated: <span class="d">${meta.generated_at ? esc(new Date(meta.generated_at).toLocaleString()) : 'pending'}</span>${OWNER && meta.window ? ` · collector window ${esc(meta.window.start)} → ${esc(meta.window.end)} ET` : ''}</span>`;
  let ms = computeMatches();
  const q = $('#q').value.trim().toLowerCase();
  if (q) ms = ms.filter(m => (m.j.title + ' ' + m.j.employer + ' ' + (m.j.excerpt || '') + ' ' + (m.j.kw || []).join(' ')).toLowerCase().includes(q));
  if (S.empOnly) ms = ms.filter(m => m.j.employer === S.empOnly);
  const tf = $('#typeFilter').value;
  if (tf) ms = ms.filter(m => typeOf(m) === tf);
  const af = $('#applyFilter').value;
  if (af) ms = ms.filter(m => applyOf(m) === af);
  const all = ms.filter(m => m.inFilters);
  const stSel = $('#stFilter').value || 'active';
  S.stUniverse = ms.map(m => m.j.uid);
  const stCount = k => ms.filter(m => stOf(m.j.uid) === k).length;
  for (const o of $('#stFilter').options) o.textContent = o.dataset.l + (STATUS[o.value] ? ` · ${stCount(o.value)}` : '');
  ms = stSel === 'active' ? ms.filter(m => m.inFilters && stOf(m.j.uid) !== 'no')
    : stSel === 'none' ? ms.filter(m => m.inFilters && !stOf(m.j.uid))
    : stSel === 'all' ? ms
    : ms.filter(m => stOf(m.j.uid) === stSel);
  if (!$('#showDups').checked) ms = ms.filter(m => !m.j.dup_of);
  const count = t => all.filter(m => m.tier === t).length;
  $('#matchTiles').innerHTML = [
    ['c', all.length, 'matches in window'], ['g', count('starts'), `base starts ≥ ${money(S.crit.minBase)}`], ['a', count('reaches'), `base reaches ≥ ${money(S.crit.minBase)}`],
    ['', count('unknown') + count('ote_only') + count('predicted'), 'no base stated'], ['m', new Set(all.map(m => m.j.employer)).size, 'employers'],
    ['', all.filter(m => m.loc === 'remote_yes').length, 'remote · home state OK'], ['', S.jobs.filter(j => j.status !== 'closed').length, 'open roles in dataset'], ['g', Object.values(S.track).filter(x => x.s === 'applied').length, 'applied'],
  ].map(([c, n, l]) => `<div class="tile ${c}"><i class="cn tl"></i><i class="cn tr"></i><i class="cn bl"></i><i class="cn br"></i><div class="n">${Number(n).toLocaleString('en-US')}</div><div class="l">${esc(l)}</div></div>`).join('');
  if (!S.jobs.length) {
    $('#jobGroups').innerHTML = OWNER
      ? `<div class="empty-state"><b>NO JOB DATA YET</b>The collector hasn't saved a run yet. In GitHub, open <b>Actions → Collect jobs → Run workflow</b>, or click <b>Refresh boards now</b> on <a href="#sources">Sources</a> to pull Greenhouse, Lever and Ashby boards into this tab.</div>`
      : `<div class="empty-state"><b>LISTINGS ARE ON THE WAY</b>Cache Flow is gathering this week's openings from employer job boards. Set up your profile and criteria now. Matches appear here automatically once the next update lands.</div>`;
    return;
  }
  // tier chips (keep "starts" and "reaches" visibly separate), then the sortable table
  const tierSel = S.tierSel || 'all';
  const tc = t => ms.filter(m => t === 'none' ? ['unknown', 'ote_only', 'predicted'].includes(m.tier) : m.tier === t).length;
  $('#tierChips').innerHTML = [['all', 'All', ms.length], ['starts', `Base starts ≥ ${money(S.crit.minBase)}`, tc('starts')], ['reaches', `Base reaches ${money(S.crit.minBase)}`, tc('reaches')], ['none', 'No base stated', tc('none')], ['below', 'Below minimum', tc('below')]]
    .filter(([k, , n]) => k === 'all' || n).map(([k, l, n]) => `<button class="chip ${tierSel === k ? 'on' : ''}" data-tier="${k}">${esc(l)} · ${n}</button>`).join('') +
    (S.empOnly ? `<button class="chip on m" data-clearemp="1" title="Show all employers again">Employer: ${esc(S.empOnly)} ✕</button>` : '');
  if (tierSel !== 'all') ms = ms.filter(m => tierSel === 'none' ? ['unknown', 'ote_only', 'predicted'].includes(m.tier) : m.tier === tierSel);
  const { key, dir } = S.sort || { key: 'score', dir: -1 };
  if ($('#msort') && [...$('#msort').options].some(o => o.value === key)) $('#msort').value = key;
  const LOCR = { metro: 4, remote_yes: 3, remote_unknown: 2, other: 1 };
  const val = { score: m => m.score, role: m => (m.j.employer + ' \u0000 ' + m.j.title).toLowerCase(), employer: m => m.j.employer.toLowerCase(), base: m => (m.j.salary?.min ?? -1) + ({ starts: 3e6, reaches: 2e6 }[m.tier] || 0),
    loc: m => LOCR[m.loc] || 0, posted: m => m.dt.d || '', source: m => (m.j.source_class === 'official' ? '0' : '1') + m.j.ats }[key];
  ms.sort((x, y) => { const a = val(x), b = val(y); return (a < b ? -1 : a > b ? 1 : 0) * dir || y.score - x.score; });
  const limit = S.showN || 200;
  const th = (k, l, cls = '') => `<th class="${cls} ${key === k ? 'sorted' : ''}" data-sort="${k}">${l}${key === k ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
  $('#jobGroups').innerHTML = ms.length ? `<div class="mt-wrap"><table class="mt"><thead><tr><th class="c-save"></th>${th('score', 'Score', 'c-score')}${th('role', 'Company / Role')}${th('base', 'Base pay', 'c-base')}${th('loc', 'Location', 'c-loc')}${th('posted', 'Posted', 'c-date')}${th('source', 'Source', 'c-src')}<th class="c-act"></th></tr></thead><tbody>` +
      (S.groupBy ? groupedRows(ms.slice(0, limit)) : ms.slice(0, limit).map(jobRow).join('')) + `</tbody></table></div>` + (ms.length > limit ? `<div class="row" style="justify-content:center;margin-top:14px"><button class="btn sec sm" id="moreRows">Show ${Math.min(200, ms.length - limit)} more of ${ms.length - limit}</button></div>` : '')
    : STATUS[stSel] ? `<div class="empty-state"><b>NOTHING MARKED “${esc(STATUS[stSel].label.toUpperCase())}”</b>Use the ○ button at the left of any row, or the buttons in a row's details, to set Applied, To do or Not interested.</div>`
    : `<div class="empty-state"><b>NO MATCHES IN THIS WINDOW</b>${S.jobs.length} roles in the dataset, none pass every filter. Try widening the posting window, the salary rule or the location options.</div>`;
  S.lastMatches = ms;
  renderFinds();
}
function wireMatches() {
  $('#stFilter').value = store.get('stFilter', 'active');
  $('#stFilter').addEventListener('change', e => store.set('stFilter', e.target.value));
  wireStatusMenu();
  wireFinds();
  ['#q', '#stFilter', '#showDups'].forEach(s => $(s).addEventListener(s === '#q' ? 'input' : 'change', () => { S.showN = 200; renderMatches(); }));
  S.groupBy = store.get('groupBy', store.get('groupEmp', false) ? 'employer' : '');
  $('#groupBy').value = S.groupBy;
  $('#groupBy').addEventListener('change', e => { S.groupBy = e.target.value; store.set('groupBy', S.groupBy); renderMatches(); });
  $('#typeFilter').innerHTML = '<option value="">All company types</option>' + Object.entries(EMP_TYPE).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#typeFilter').value = store.get('typeFilter', '');
  $('#typeFilter').addEventListener('change', e => { store.set('typeFilter', e.target.value); S.showN = 200; renderMatches(); });
  $('#applyFilter').innerHTML = '<option value="">Any application type</option>' + Object.entries(APPLY).map(([k, v]) => `<option value="${k}" title="${esc(v.hint)}">${esc(v.label)}</option>`).join('');
  $('#applyFilter').value = store.get('applyFilter', '');
  $('#applyFilter').addEventListener('change', e => { store.set('applyFilter', e.target.value); S.showN = 200; renderMatches(); });
  $('#msort').addEventListener('change', e => { const k = e.target.value; S.sort = { key: k, dir: ['employer'].includes(k) ? 1 : -1 }; renderMatches(); });
  $('#tierChips').addEventListener('click', e => { if (e.target.closest('[data-clearemp]')) { S.empOnly = null; S.showN = 200; renderMatches(); return; } const c = e.target.closest('[data-tier]'); if (!c) return; S.tierSel = c.dataset.tier; S.showN = 200; renderMatches(); });
  $('#jobGroups').addEventListener('click', e => {
    const h = e.target.closest('th[data-sort]');
    if (h) { const k = h.dataset.sort; const cur = S.sort || { key: 'score', dir: -1 }; S.sort = { key: k, dir: cur.key === k ? -cur.dir : (['role', 'employer', 'source'].includes(k) ? 1 : -1) }; renderMatches(); return; }
    if (e.target.id === 'moreRows') { S.showN = (S.showN || 200) + 200; renderMatches(); return; }
    const g = e.target.closest('tr.mt-group');
    if (g) { S.collapsed ||= new Set(); const k = g.dataset.emp; S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k); renderMatches(); return; }
    let b = e.target.closest('[data-act]');
    if (!b) { const row = e.target.closest('tr.mt-row'); if (!row || e.target.closest('a')) return; b = { dataset: { act: 'open' } }; b.closest = () => row; }
    const uid = b.closest('[data-uid]').dataset.uid;
    if (b.dataset.act === 'stmenu') { openStatusMenu(b, uid); return; }
    if (b.dataset.act === 'st') { applyStatus(uid, b.dataset.st); return; }
    if (b.dataset.act === 'blockemp') {
      const emp = S.jobs.find(x => x.uid === uid)?.employer; if (!emp) return;
      S.crit.blockEmp = [...new Set([...(S.crit.blockEmp || []), emp])]; save(); keepPlace(uid, () => { renderMatches(); renderCriteria(); });
      undoToast(`Hiding roles from ${emp}`, () => { S.crit.blockEmp = S.crit.blockEmp.filter(n => n !== emp); save(); renderMatches(); renderCriteria(); }); return;
    }
    if (b.dataset.act === 'open') S.open.has(uid) ? S.open.delete(uid) : S.open.add(uid);
    save(); keepPlace(uid, () => replaceRow(uid) || renderMatches());
  });
  $('#btnCsv').onclick = () => {
    const rows = (S.lastMatches || []).map(m => ({ score: m.score, salary_tier: m.tier, base_min: m.j.salary?.min ?? '', base_max: m.j.salary?.max ?? '', salary_kind: m.j.salary?.kind ?? '', ote_excluded: m.j.salary?.ote ? `${m.j.salary.ote.min}-${m.j.salary.ote.max}` : '',
      title: m.j.title, employer: m.j.employer, employer_type: EMP_TYPE[typeOf(m)]?.label || '', sector: m.sector, vertical: m.vertical, location: (m.j.locations || []).join(' | '), workplace: m.j.workplace, location_fit: m.loc, home_state_eligibility: m.hf.eligibility,
      date: m.dt.d ? C.nyDate(new Date(m.dt.d), LOCAL_TZ) : '', date_basis: m.dt.kind, first_observed: m.j.first_observed, last_seen: m.j.last_seen, reposted: !!m.j.reposted, stale: !!m.j.stale,
      source_class: m.j.source_class, ats: m.j.ats, source_id: m.j.source_id, req_id: m.j.req_id || '', duplicates: m.j.dup_count || 1,
      my_status: STATUS[stOf(m.j.uid)]?.label || '', applied_on: S.track[m.j.uid]?.applied ? C.nyDate(new Date(S.track[m.j.uid].applied), LOCAL_TZ) : '', url: m.j.url }));
    downloadCSV(rows, `cache-flow-matches-${C.nyDate(new Date(), LOCAL_TZ)}.csv`);
  };
}
/* Plain-language score breakdown. Weights mirror evaluateJob in core.mjs (max 100). */
function scoreParts(m) {
  const p = m.parts || {}, c = S.crit, j = m.j;
  const fnNames = (m.fnHit || []).map(f => C.FUNCTIONS[f]?.label || f);
  const hits = [...(m.skillHits || []), ...(m.customHits || [])];
  const LOCTXT = m.hf?.tied ? { other: 'listed as remote, but tied to a city or territory outside your home state (only specific places are listed and nothing says anywhere in the US)' } : { metro: 'in your commute area', remote_yes: m.hf?.eligibility === 'yes' ? 'remote, and your home state is listed as eligible' : 'remote, and your home state is likely eligible', remote_unknown: "remote, but the posting doesn't say which states can apply", other: 'outside your commute area and not remote', remote_no: 'remote, but your home state is excluded' };
  const BASETXT = { starts: `base pay starts at or above your ${money(c.minBase)} minimum`, reaches: `base pay range reaches your ${money(c.minBase)} minimum but starts below it`, unknown: 'no base pay stated', ote_only: 'only on-target earnings (base + commission) stated, which is not counted as base', predicted: 'only a predicted range from an aggregator, not the employer', below: `base pay tops out below your ${money(c.minBase)} minimum` };
  return [
    ['Job category', p.fn, 30, fnNames.length ? 'matches ' + fnNames.join(', ') : 'flagged for review; not in your selected categories'],
    ['Skills & keywords', p.skills, 25, hits.length ? `${hits.length} found in the posting (4 points each): ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? '…' : ''}` : 'none of your résumé skills or extra keywords appear in the title or excerpt'],
    ['Base pay', p.base, 20, BASETXT[m.tier] || m.tier],
    ['Location', p.loc, 15, LOCTXT[m.loc] || m.loc],
    ['Level', p.level, 10, j.seniority > (c.sen || 1) ? 'above your minimum seniority' : 'at your minimum seniority'],
  ];
}
const scoreTitle = m => `Match score ${m.score}/100: ` + scoreParts(m).map(([l, v, mx]) => `${l} ${v}/${mx}`).join(' · ');
const STALE_HELP = "Not refreshed on the latest update: the employer's job site refused or rate-limited part of the last check (or this search wasn't in this run's rotation), so this role is carried over from an earlier check. It is probably still open, but confirm on the posting.";
const shortDay = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
/* Re-render the list without moving the reader: pin a row (the one acted on, or the next one if it
   disappears) to the same spot on screen. Safari has no CSS scroll anchoring, so do it explicitly. */
/* Update one row in place (expand/collapse, status) instead of rebuilding the list, so nothing above moves. */
function replaceRow(uid) {
  const m = (S.lastMatches || []).find(x => x.j.uid === uid), row = document.querySelector(`#jobGroups tr.mt-row[data-uid="${CSS.escape(uid)}"]`);
  if (!m || !row) return false;
  const det = row.nextElementSibling?.classList.contains('mt-detail') ? row.nextElementSibling : null;
  const stSel = $('#stFilter').value || 'active', st = stOf(uid);
  const hide = (stSel === 'active' && st === 'no') || (stSel === 'none' && st) || (STATUS[stSel] && st !== stSel);
  det?.remove();
  if (hide) { row.remove(); S.lastMatches = S.lastMatches.filter(x => x.j.uid !== uid); }
  else { const tb = document.createElement('tbody'); tb.innerHTML = jobRow(m); row.replaceWith(...tb.children); }
  updateStatusCounts();
  return true;
}
function updateStatusCounts() {
  const n = k => (S.stUniverse || []).filter(u => stOf(u) === k).length;
  for (const o of $('#stFilter').options) if (STATUS[o.value]) o.textContent = o.dataset.l + ` · ${n(o.value)}`;
}
function keepPlace(uid, fn) {
  const rows = $$('#jobGroups tr.mt-row'), i = rows.findIndex(r => r.dataset.uid === uid);
  const cands = i < 0 ? [] : [rows[i], ...rows.slice(i + 1, i + 6), ...rows.slice(Math.max(0, i - 5), i).reverse()].map(r => r.dataset.uid);
  const top0 = i < 0 ? null : rows[i].getBoundingClientRect().top;
  fn();
  if (top0 == null) return;
  const pin = () => {
    for (const u of cands) {
      const el = document.querySelector(`#jobGroups tr.mt-row[data-uid="${CSS.escape(u)}"]`);
      if (el) { const d = el.getBoundingClientRect().top - top0; if (Math.abs(d) > 1) scrollBy({ top: d, behavior: 'instant' }); el.querySelector('.stbtn')?.focus({ preventScroll: true }); return; }
    }
  };
  pin(); requestAnimationFrame(pin);
}
function applyStatus(uid, st) {
  const before = S.track[uid] ? { ...S.track[uid] } : null;
  setStatus(uid, st);
  const now = stOf(uid);
  keepPlace(uid, () => replaceRow(uid) || renderMatches());
  const msg = now ? `Marked ${STATUS[now].label.toLowerCase()}` : 'Status cleared';
  undoToast(msg + (now === 'no' && ($('#stFilter').value || 'active') === 'active' ? ' · hidden from this list' : ''), () => { if (before) S.track[uid] = before; else delete S.track[uid]; save(); renderMatches(); });
}
function undoToast(msg, undo) {
  const t = $('#toast'); t.innerHTML = `${esc(msg)} <button class="linkbtn" id="toastUndo">Undo</button>`; t.classList.add('on');
  $('#toastUndo').onclick = () => { undo(); t.classList.remove('on'); };
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 5000);
}
function openStatusMenu(btn, uid) {
  const menu = $('#stMenu'), st = stOf(uid);
  menu.innerHTML = Object.entries(STATUS).map(([k, v]) => `<button role="menuitemradio" aria-checked="${st === k}" class="${v.cls} ${st === k ? 'on' : ''}" data-st="${k}"><i>${v.icon}</i>${esc(v.label)}</button>`).join('') +
    (st ? `<button role="menuitem" data-st="" class="clr"><i>○</i>Clear status</button>` : '');
  menu.dataset.uid = uid;
  const r = btn.getBoundingClientRect();
  menu.style.top = (r.bottom + scrollY + 6) + 'px'; menu.style.left = Math.min(r.left + scrollX, innerWidth - 220) + 'px';
  menu.hidden = false; menu.querySelector('button')?.focus({ preventScroll: true });
}
function wireStatusMenu() {
  const menu = $('#stMenu');
  const close = () => { menu.hidden = true; };
  menu.addEventListener('click', e => { const b = e.target.closest('button[data-st]'); if (!b) return; const uid = menu.dataset.uid; close(); applyStatus(uid, b.dataset.st || stOf(uid)); });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('#stMenu') && !e.target.closest('[data-act="stmenu"]')) close(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  addEventListener('scroll', close, { passive: true });
  // backup / restore so the tracker can move between browsers or devices
  $('#btnTrackOut').onclick = () => {
    const byUid = new Map(S.jobs.map(j => [j.uid, j]));
    const roles = Object.entries(S.track).map(([uid, v]) => { const j = byUid.get(uid); return { uid, ...v, title: j?.title, employer: j?.employer, url: j?.url }; });
    if (!roles.length) return toast('No statuses to back up yet');
    const blob = new Blob([JSON.stringify({ app: 'cache-flow', kind: 'tracker', exported: new Date().toISOString(), roles }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `cache-flow-tracker-${C.nyDate(new Date(), LOCAL_TZ)}.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#btnTrackIn').onclick = () => $('#trackFile').click();
  $('#trackFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text()); if (d.kind !== 'tracker' || !Array.isArray(d.roles)) throw new Error('not a tracker file');
      let n = 0;
      for (const r of d.roles) {
        if (!r.uid || !STATUS[r.s]) continue;
        const cur = S.track[r.uid];
        if (!cur || String(r.t) > String(cur.t)) { S.track[r.uid] = { s: r.s, t: r.t || new Date().toISOString(), ...(r.applied ? { applied: r.applied } : {}) }; n++; }
      }
      save(); renderMatches(); toast(`Restored ${n} status${n === 1 ? '' : 'es'}`);
    } catch (err) { toast('Could not read that file: ' + err.message); }
  };
}
/* Pay-first discovery: high published base at companies the user may not know, grouped by employer. */
function renderFinds() {
  if (!$('#findsList')) return;
  const min = +($('#findsMin').value || 225000), tsel = $('#findsTypes').value || 'growth';
  const focus = $('#findsFocus').value || 'mine', maxSize = +($('#findsSize').value || 0), keepUnknown = $('#findsUnknown').checked;
  $('#findsUnknownWrap').style.display = maxSize ? '' : 'none';
  const NONBROAD = FN_KEYS.filter(k => !C.FUNCTIONS[k].broad);
  const FOCUS = {
    mine: { functions: S.crit.functions, sectors: S.crit.sectors, verticals: S.crit.verticals },
    secgtm: { functions: ['pmm', 'marketing', 'demand', 'sales', 'se', 'partner', 'cs', 'enable', 'gtm', 'strategy', 'cos', 'ci', 'threat', 'secops', 'seceng', 'grc', 'product'], sectors: ['Cybersecurity'], verticals: [] },
    product: { functions: ['product', 'tpm', 'pmm'], sectors: [], verticals: [] },
    aicloud: { functions: S.crit.functions, sectors: ['AI', 'Cloud, data & dev tools', 'Hyperscaler & big tech'], verticals: [] },
    all: { functions: NONBROAD, sectors: [], verticals: [] },
  }[focus];
  const types = tsel === 'all' ? null : new Set(tsel.split(','));
  const crit = { ...S.crit, ...FOCUS, fnKnown: FN_KEYS, salMode: 'starts', minBase: min, types: { big: true, security: true, growth: true, aggregator: false } };
  const ctx = { win: currentWindow(), excl: reFromList(csvList(S.crit.exclude)) };
  const blocked = new Set(S.crit.blockEmp || []);
  const byEmp = new Map();
  for (const j of S.jobs) {
    if (blocked.has(j.employer) || stOf(j.uid) === 'no' || j.dup_of) continue;
    const e = empOf(j), ty = C.companyType(j, e);
    if (types && !types.has(ty)) continue;
    if (maxSize && (e?.size == null ? !keepUnknown : e.size > maxSize)) continue;
    const m = C.evaluateJob(j, { crit, emp: e, skillsOn: S.profile.skillsOn, custom: S.profile.custom, win: ctx.win, excl: ctx.excl, tz: LOCAL_TZ });
    if (!m || !['base', 'base_likely'].includes(m.j.salary?.kind)) continue;
    const g = byEmp.get(j.employer) || byEmp.set(j.employer, { emp: j.employer, e, ty, roles: [] }).get(j.employer);
    g.roles.push(m);
  }
  const groups = [...byEmp.values()].map(g => { g.roles.sort((a, b) => (b.j.salary.min - a.j.salary.min) || b.score - a.score); g.top = g.roles[0]; return g; })
    .sort((a, b) => b.top.j.salary.min - a.top.j.salary.min || b.roles.length - a.roles.length);
  const nRoles = groups.reduce((n, g) => n + g.roles.length, 0);
  $('#findsSum').textContent = groups.length ? `${groups.length} compan${groups.length === 1 ? 'y' : 'ies'} · ${nRoles} role${nRoles === 1 ? '' : 's'} with base starting at ${money(min)}+` : `none at ${money(min)}+ in this window`;
  $('#findsList').innerHTML = groups.length ? groups.slice(0, 30).map(g => {
    const t = g.top, s = t.j.salary;
    return `<div class="find"><div class="fh"><b>${esc(g.emp)}</b><span class="tag ${g.ty === 'growth' ? 'm' : ''}">${esc(EMP_TYPE[g.ty]?.label || g.ty)}</span></div>
      <div class="sub2">${esc(t.sector)}${t.vertical ? ' · ' + esc(t.vertical) : ''}${g.e?.size ? ` · ~${g.e.size} people` : ''}${g.e?.discovered ? ' · new from YC directory' : ''}</div>
      <a class="ttl" href="${esc(t.j.url)}" target="_blank" rel="noopener">${esc(t.j.title)}</a>
      <div class="fpay"><span class="sal starts">${money(s.min)}–${money(s.max)}</span> base${g.roles.length > 1 ? ` · ${g.roles.length} roles at ${money(min)}+` : ''}</div>
      <div class="sub2">${esc(C.shownLocation(t.j, t.hf, t.loc).text)}${(t.j.locations || []).length > 1 ? ` +${new Set(t.j.locations).size - 1}` : ''}</div>
      <button class="linkbtn" data-findemp="${esc(g.emp)}">Show in list</button></div>`;
  }).join('') : `<div class="sub2">No published base ranges starting at ${money(min)}+ for your categories and locations in this posting window. Try a lower level, a wider window, or all company types.</div>`;
}
function wireFinds() {
  if (!$('#findsBox')) return;
  $('#findsMin').value = String(store.get('findsMin', 225000)); $('#findsTypes').value = store.get('findsTypes', 'growth');
  $('#findsFocus').value = store.get('findsFocus', 'mine'); $('#findsSize').value = String(store.get('findsSize', '')); $('#findsUnknown').checked = store.get('findsUnknown', true);
  for (const [id, k] of [['#findsFocus', 'findsFocus'], ['#findsSize', 'findsSize'], ['#findsUnknown', 'findsUnknown']])
    $(id).onchange = e => { store.set(k, e.target.type === 'checkbox' ? e.target.checked : e.target.value); renderFinds(); };
  $('#findsBox').open = !!store.get('findsOpen', false);
  $('#findsBox').addEventListener('toggle', () => store.set('findsOpen', $('#findsBox').open));
  $('#findsMin').onchange = e => { store.set('findsMin', +e.target.value); renderFinds(); };
  $('#findsTypes').onchange = e => { store.set('findsTypes', e.target.value); renderFinds(); };
  $('#findsList').addEventListener('click', e => { const b = e.target.closest('[data-findemp]'); if (!b) return;
    S.empOnly = b.dataset.findemp; $('#typeFilter').value = ''; S.showN = 200; renderMatches(); $('#jobGroups').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
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
const resultClass = r => !r || r === 'never_run' ? 'idle' : r === 'ok' ? 'ok' : r === 'empty' ? 'empty' : ['link_only', 'not_fetchable', 'skipped_no_key'].includes(r) ? 'idle' : ['timeout', 'experimental_failed', 'blocked_or_network', 'partial', 'blocked_by_robots', 'no_links_found'].includes(r) ? 'warn' : 'bad';
const RESULT_HELP = { ok: 'Fetched; jobs returned', blocked_by_robots: "The site's robots.txt disallows these pages; not collected", no_links_found: 'Careers page read, but no job links matched. The list may be built by JavaScript; not evidence of zero jobs', partial: 'Refused part-way; roles found so far kept, the rest kept as not refreshed', empty: 'Fetched; board has zero jobs right now', http_403: 'Refused (403). Access failed; not evidence of zero jobs', http_404: 'Not found (404). Identifier or site name likely wrong',
  http_429: 'Rate limited after retries', timeout: 'Timed out after retries', network_error: 'Network failure', parse_error: 'Response not in the expected shape', link_only: 'No public feed; open the careers link',
  not_fetchable: 'Needs ATS discovery (see verification note)', blocked_or_network: 'Browser blocked the request (CORS) or network failed; the collector can still read it', experimental_failed: 'Experimental adapter did not get data', never_run: 'Not collected yet', adapter_error: 'Adapter crashed; see message' };
function sourceRows() {
  const st = new Map(S.status.sources.map(s => [s.id, s]));
  const rows = [];
  for (const e of S.registry.employers) for (const s of e.sources) {
    const live = S.live.get(s.id), run = live || st.get(s.id);
    rows.push({ e, s, run, result: run?.result || (s.ats === 'link_only' ? 'link_only' : s.ats === 'unresolved' ? 'not_fetchable' : 'never_run'), live: !!live });
  }
  for (const s of S.status.sources.filter(x => x.id.startsWith('agg:'))) rows.push({ e: { employer: '(aggregator) ' + s.ats, sector: 'Aggregator', vertical: '', tier: 'aggregator', type: 'aggregator', sources: [] }, s: { id: s.id, ats: s.ats, verification: { status: 'aggregator' } }, run: s, result: s.result });
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
    .map(([c, n, l]) => `<div class="tile ${c}"><i class="cn tl"></i><i class="cn tr"></i><i class="cn bl"></i><i class="cn br"></i><div class="n">${Number(n).toLocaleString('en-US')}</div><div class="l">${l}</div></div>`).join('');
  const fill = (sel, label, vals) => { const cur = $(sel).value; $(sel).innerHTML = `<option value="">${label}</option>` + vals.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join(''); };
  fill('#sAts', 'All ATS', [...new Set(rows.map(r => r.s.ats))].sort());
  fill('#sStatus', 'All results', [...new Set(rows.map(r => r.result))].sort());
  fill('#sSector', 'All sectors', [...new Set(rows.map(r => r.e.sector))].sort());
  if (!$('#sType').options.length) $('#sType').innerHTML = '<option value="">All company types</option>' + Object.entries(EMP_TYPE).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  const q = $('#sq').value.toLowerCase(), fa = $('#sAts').value, fs = $('#sStatus').value, fsec = $('#sSector').value, fty = $('#sType').value;
  const vis = rows.filter(r => (!q || r.e.employer.toLowerCase().includes(q)) && (!fa || r.s.ats === fa) && (!fs || r.result === fs) && (!fsec || r.e.sector === fsec) && (!fty || C.companyType({}, r.e) === fty));
  // compact visibility chips: green = the source exposes it, grey = it doesn't; hover for the detail
  const FV = [['posted_date', 'Date'], ['salary', 'Pay'], ['location', 'Loc'], ['remote', 'Remote'], ['req_id', 'Req']];
  const fv = f => !f ? '—' : FV.map(([k, l]) => { const v = String(f[k] ?? 'n/a'); const has = !/^(no|n\/a|not |text only)/i.test(v); return `<span class="tag ${has ? 'g' : 'f'}" title="${esc(l + ': ' + v)}">${l}</span>`; }).join('');
  $('#srcTable').innerHTML = `<thead><tr><th>Employer</th><th>Sector / vertical</th><th>ATS</th><th>Verification</th><th>Last result</th><th>Jobs</th><th>Fields exposed</th><th>Last checked</th><th>Links</th><th></th></tr></thead><tbody>` +
    vis.map(r => {
      const s = r.s, e = r.e, run = r.run;
      const links = [e.careers_url && `<a href="${esc(e.careers_url)}" target="_blank" rel="noopener">careers${e.careers_url_verified ? '' : '*'}</a>`, s.board_url && `<a href="${esc(s.board_url)}" target="_blank" rel="noopener">board</a>`,
        s.feed_url && `<a href="${esc(s.feed_url)}" target="_blank" rel="noopener">feed</a>`, e.linkedin_jobs_url && `<a href="${esc(e.linkedin_jobs_url)}" target="_blank" rel="noopener">LinkedIn</a>`].filter(Boolean).join(' · ');
      return `<tr><td class="emp">${esc(e.employer)}${(e.notes || []).length ? ` <span title="${esc(e.notes.join(' '))}" style="color:var(--acid);cursor:help">ⓘ</span>` : ''}<div class="sub" title="${esc(EMP_TYPE[C.companyType({}, e)]?.hint || '')}">${esc(EMP_TYPE[C.companyType({}, e)]?.label || '')}${e.priority ? ' · priority' : ''}${e.discovered ? ' · found via ' + (e.seed_source === 'yc' ? 'YC directory' : esc(e.seed_source || 'seed list')) : ''}${e.size ? ' · ~' + e.size + ' people' : ''}</div></td><td>${esc(e.sector)}<br><span style="color:var(--faint)">${esc(e.vertical || '')}</span></td><td>${esc(s.ats)}${s.slug ? `<br><span style="color:var(--faint)">${esc(s.slug)}</span>` : ''}</td>
        <td title="${esc(s.verification?.method || '')}" style="cursor:help">${esc(s.verification?.status || '—')}</td>
        <td><span class="st ${resultClass(r.result)}" title="${esc(RESULT_HELP[r.result] || r.result)}">${esc(r.result)}</span>${run?.http_status ? ` <span style="color:var(--faint)">${run.http_status}</span>` : ''}${r.live ? ' <span class="tag m">live</span>' : ''}${run?.message ? `<div class="msg" title="${esc(run.message)}">${esc(String(run.message))}</div>` : ''}</td>
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
  ['#sq', '#sAts', '#sStatus', '#sSector', '#sType'].forEach(s => $(s).addEventListener(s === '#sq' ? 'input' : 'change', renderSources));
  $('#btnLiveAll').onclick = () => {
    const ids = sourceRows().filter(r => C.BROWSER_ATS.has(r.s.ats)).map(r => r.s.id);
    if (!confirm(`Pull the latest listings from ${ids.length} Greenhouse, Lever and Ashby boards into this tab? Requests are paced (one at a time per host), so this takes a few minutes.`)) return;
    liveCheck(ids);
  };
  $('#btnDirCsv').onclick = () => downloadCSV(sourceRows().map(r => ({ employer: r.e.employer, sector: r.e.sector, vertical: r.e.vertical, company_type: EMP_TYPE[C.companyType({}, r.e)]?.label || '', priority: !!r.e.priority, official_careers: r.e.careers_url || '', careers_url_verified: !!r.e.careers_url_verified,
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
const FN_QUERY = { product: 'product manager', tpm: 'technical program manager', pmm: 'product marketing manager', marketing: 'marketing manager', demand: 'demand generation', sales: 'account executive', se: 'solutions engineer', partner: 'partnerships alliances', cs: 'customer success manager', enable: 'sales enablement', gtm: 'go-to-market strategy', strategy: 'strategy business operations', cos: 'chief of staff', ci: 'competitive intelligence', threat: 'threat intelligence researcher', secops: 'security operations incident response', seceng: 'security engineer', grc: 'governance risk compliance', ai: 'machine learning AI', eng: 'software engineer', data: 'data scientist analytics', design: 'product designer', support: 'professional services consultant', finance: 'finance', people: 'recruiter', legal: 'counsel' };
function renderDiscover() {
  const c = S.crit, home = S.profile.location || (c.state ? C.STATES[c.state] : '') || 'United States';
  const secWord = c.sectors.length === 1 && c.sectors[0] === 'Cybersecurity' || (c.verticals.length && c.verticals.every(v => (c.vertSectors?.[v] || 'Cybersecurity') === 'Cybersecurity')) ? ' security' : '';
  const enc = encodeURIComponent;
  // LinkedIn experience filter from the seniority setting (4 mid-senior, 5 director, 6 executive)
  const fE = c.sen >= 5 ? '5,6' : c.sen >= 3 ? '4,5,6' : '';
  const city = home.split(',')[0];
  const SITES_ATS = ['job-boards.greenhouse.io', 'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'myworkdayjobs.com', 'jobs.smartrecruiters.com', 'apply.workable.com'];
  const SITES_STARTUP = ['wellfound.com/jobs', 'workatastartup.com/jobs', 'ats.rippling.com', 'jobs.jobvite.com'];
  const xray = (sites, terms) => `(${sites.map(x => 'site:' + x).join(' OR ')}) (${C.orQuery(terms, 4)})${secWord ? ' security' : ''} ("${city}" OR remote)`;
  const rows = c.functions.map(f => {
    const terms = C.FN_TERMS[f] || [FN_QUERY[f]];
    const li = `(${C.orQuery(terms, 8)})${secWord}`, ind = `(${C.orQuery(terms, 6)})${secWord}`, gj = `${C.orQuery(terms, 4)}${secWord} jobs ${home}`;
    return `<tr><td class="emp">${esc(C.FUNCTIONS[f].label)}</td><td><span class="terms">${esc(terms.join(' · '))}</span>${secWord ? '<div class="sub2">+ security</div>' : ''}</td><td class="links">
      <a target="_blank" rel="noopener" href="https://www.linkedin.com/jobs/search/?keywords=${enc(li)}&location=${enc(home)}&f_TPR=r604800${fE ? '&f_E=' + enc(fE) : ''}">LinkedIn · ${esc(city)}</a>
      <a target="_blank" rel="noopener" href="https://www.linkedin.com/jobs/search/?keywords=${enc(li)}&location=United%20States&f_WT=2&f_TPR=r604800${fE ? '&f_E=' + enc(fE) : ''}">LinkedIn · remote US</a>
      <a target="_blank" rel="noopener" href="https://www.indeed.com/jobs?q=${enc(ind)}&l=${enc(home)}&fromage=7">Indeed · 7 days</a>
      <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${enc(gj)}&ibp=htl;jobs">Google Jobs</a>
      <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${enc(xray(SITES_ATS, terms))}&tbs=qdr:w">Job boards · past week</a>
      <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${enc(xray(SITES_STARTUP, terms))}&tbs=qdr:m">Startup boards · past month</a></td></tr>`;
  }).join('');
  $('#genLinks').innerHTML = `<div class="tbl-wrap" style="max-height:none"><table><thead><tr><th>Job category</th><th>Titles searched</th><th>Searches</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint" style="margin-top:8px">Each row searches every title variant for that category, near <b>${esc(home)}</b> or remote, at your seniority. LinkedIn and Indeed show the past week; the job-board x-ray (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable) shows the past week and the startup x-ray (Wellfound, YC, Rippling, Jobvite) the past month. Both x-rays surface employers that aren't in the roster yet. Add any you find to <code>data/sources.json</code>. These URL formats are standard query strings and may change on the sites' side. Salary filters on these sites mix in estimates, so check base pay on the posting itself.</p>`;
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
    <h4>Email me my matches</h4>
    <p>The Action can email new matches for <b>your current criteria and skills</b> after each run, at most once a day. Your criteria live in an encrypted GitHub secret, never in the public repo.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap"><input id="alertEmail" type="email" placeholder="you@example.com" style="flex:1;min-width:200px">
    <button class="btn pri" id="btnAlertCopy">Copy alert settings</button></div>
    <p class="hint">Paste the copied text into the <code>SUBSCRIBERS</code> secret. To add someone, put their entry in the same list: <code>[ {...}, {...} ]</code>.</p>
`;
  $('#alertEmail').value = store.get('alertEmail', '');
  $('#btnAlertCopy').onclick = async () => {
    const email = $('#alertEmail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter the email address to send alerts to');
    store.set('alertEmail', email);
    const { window: _w, ...crit } = S.crit;
    const entry = [{ email, tz: LOCAL_TZ, crit: { ...crit, window: 'd7' }, skillsOn: S.profile.skillsOn || [], custom: S.profile.custom || [] }];
    const txt = JSON.stringify(entry);
    try { await navigator.clipboard.writeText(txt); toast('Alert settings copied. Paste into the SUBSCRIBERS secret.'); }
    catch { prompt('Copy this into the SUBSCRIBERS secret:', txt); }
  };
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
    <p class="hint">Repo: ${esc(repo)} · resume parsing runs locally in this browser · nothing about you leaves this page</p>`;
}

function fatal(e) {
  console.error(e);
  const m = document.querySelector('main');
  if (m) m.insertAdjacentHTML('afterbegin', `<div class="empty-state" style="margin-bottom:20px"><b>CACHE FLOW HIT AN ERROR</b>${esc(e?.message || e)}<br>Try a hard refresh (Ctrl + Shift + R). If it persists, the browser console has details.</div>`);
  $('#dataAge') && ($('#dataAge').textContent = 'ERROR');
}
try { wireMatches(); wireSources(); boot().catch(fatal); } catch (e) { fatal(e); }
