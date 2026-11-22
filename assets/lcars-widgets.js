// Cache Flow LCARS widgets for the Matches page: intro chips, THIS WEEK summary, Target Array (category bands,
// fit rings, targets, leader cards, telemetry, key, signal log), Hunt command palette (Ctrl/⌘ K or /) and keyboard
// tracking (J/K, Enter, T/A/D, Esc). Fed by app.js with live matches; the array's filters also filter the results table.
import * as C from './shared/core.mjs?v=20261122f';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, at) => { const e = document.createElementNS(NS, tag); for (const k in at) e.setAttribute(k, at[k]); return e; };
const add = (par, tag, at, txt) => { const e = el(tag, at); if (txt != null) e.textContent = txt; par.appendChild(e); return e; };
const AC = '#5FD0FF', B1 = '#4F86F0', MUT = '#6F8CC4';
const scoreCol = s => s >= 90 ? AC : s >= 75 ? B1 : MUT;
const ST_LABEL = { '': 'No status', todo: 'To do', applied: 'Applied', no: 'Not interested' };
const ageText = h => h < 24 ? `${Math.max(0, Math.round(h))}h` : `${Math.floor(h / 24)}d`;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// short band names for the dial
const SHORT = { product: 'PRODUCT', tpm: 'PROGRAM', pmm: 'PMM', marketing: 'BRAND', demand: 'DEMAND', sales: 'SALES', se: 'SOLUTIONS', partner: 'ALLIANCES', cs: 'CUST SUCCESS',
  enable: 'ENABLEMENT', learning: 'LEARNING', gtm: 'GTM', strategy: 'STRATEGY', consulting: 'CONSULTING', ci: 'COMP INTEL', threat: 'THREAT INTEL', secops: 'SOC · IR',
  seceng: 'SEC ENG', grc: 'GRC', ai: 'AI', mleng: 'ML', eng: 'ENGINEERING', data: 'DATA', design: 'DESIGN', support: 'SUPPORT', finance: 'FINANCE', people: 'PEOPLE', legal: 'LEGAL', other: 'OTHER' };
const GSHORT = { 'Product & program management': 'PRODUCT', 'Marketing & GTM': 'MARKETING', 'Sales & customer success': 'SALES · CS', 'Learning & enablement': 'ENABLEMENT',
  'Strategy & business operations': 'STRATEGY', 'Consulting & advisory': 'CONSULTING', 'Security practitioners': 'SECURITY', 'AI, engineering & data': 'AI · ENG', 'Corporate functions': 'CORPORATE' };
const SECCOL = ['#2B4F9E', '#1E3D7D', '#25458A', '#3A5A97', '#163068', '#2F5296', '#1A3A75', '#234A8E', '#1B3A7A'];

let A = null;               // app hooks
const arr = { secs: new Set(), gate: 0, age: 0, sel: null };
let SEC = [], SECFULL = [], secOf = () => 0, bandKey = '';
let rows = [], view = [], byId = new Map(), firstDraw = true, counted = false, lastCtx = null;

/* ---------------------------------------------------------------- filter used by app.js on the results list */
export function arrayFilter(m) {
  if (!SEC.length) return true;
  if (arr.secs.size && !arr.secs.has(secOfMatch(m))) return false;
  if (arr.gate && m.score < arr.gate) return false;
  if (arr.age && postedH(m) > arr.age) return false;
  return true;
}
export const arrayActive = () => !!(arr.secs.size || arr.gate || arr.age);
export function arrayLabel() {
  return [...[...arr.secs].map(i => SEC[i]), arr.gate ? `FIT ${arr.gate}+` : '', arr.age ? `AGE ≤ ${arr.age === 24 ? '24H' : '3D'}` : ''].filter(Boolean).join(', ');
}
export function clearArray() { arr.secs.clear(); arr.gate = 0; arr.age = 0; A?.rerender(); }
const postedH = m => { const t = m.dt?.d ? Date.parse(m.dt.d) : Date.parse(m.j.first_observed); return isFinite(t) ? (Date.now() - t) / 36e5 : 1e6; };
const freshOf = m => (Date.now() - Date.parse(m.j.first_observed)) / 36e5 <= 24;
function secOfMatch(m) { return secOf(m); }

/* ---------------------------------------------------------------- bands from the viewer's categories */
function setupBands(crit) {
  const sel = (crit.functions || []).filter(f => C.FUNCTIONS[f]);
  const key = sel.join(',');
  if (key === bandKey) return;
  bandKey = key; arr.secs.clear();
  const fnOf = m => (m.j._fn || (m.j._fn = C.classifyFunctions(m.j.title).functions));
  if (sel.length <= 8) {
    SEC = sel.map(f => SHORT[f] || C.FUNCTIONS[f].label.toUpperCase()); SECFULL = sel.map(f => C.FUNCTIONS[f].label);
    secOf = m => { const f = fnOf(m); const i = sel.findIndex(k => f.includes(k)); return i < 0 ? 0 : i; };
  } else {
    const groups = C.FUNCTION_GROUPS.filter(g => sel.some(f => C.FUNCTIONS[f].group === g));
    SEC = groups.map(g => GSHORT[g] || g.toUpperCase()); SECFULL = groups;
    secOf = m => { const f = fnOf(m).filter(k => sel.includes(k)); const g = f.length ? C.FUNCTIONS[f[0]].group : groups[0]; const i = groups.indexOf(g); return i < 0 ? 0 : i; };
  }
  buildStatic();
}

/* ---------------------------------------------------------------- init: markup around the existing page */
export function initWidgets(hooks) {
  A = hooks;
  const head = $('#view-matches .sec-head'); if (!head || $('#lcw')) return;
  // intro: chips + profile line + actions
  head.insertAdjacentHTML('beforeend', `<p class="prof" id="lcwProf"><span class="pdot"></span><span></span></p>
    <div class="crit" id="lcwChips"></div>`);
  // summary + array, above the results controls
  document.body.classList.add('lcw-on');
  const lay = $('#mLayout');
  lay.insertAdjacentHTML('beforebegin', `<div id="lcw" class="lcw">
    <section class="panel hero" aria-labelledby="sumh">
      <div class="lsh"><span class="pill cy" id="sumh">THIS WEEK</span><span class="line"><i></i></span><span class="code" id="lcwCode"></span><span class="via"></span></div>
      <div class="hero-grid">
        <div class="big"><div class="n"><strong id="lcwBig">0</strong><span>MATCHES IN WINDOW</span></div>
          <div class="split" id="lcwSplit"></div><div class="legend" id="lcwLegend"></div></div>
        <div class="stats" id="lcwStats"></div>
        <div class="pipe"><h3>YOUR PIPELINE</h3><div><span>To do</span><b id="pTodo">0</b></div><div><span>Applied</span><b id="pApplied">0</b></div><div><span>Not interested</span><b id="pNo">0</b></div></div>
      </div>
    </section>
    <section class="panel" aria-labelledby="scopeh" id="lcwArray">
      <div class="lsh"><span class="pill b5" id="scopeh">TARGET ARRAY</span><span class="line"><i></i></span><span class="code" id="lcwArrCode"></span><span class="via"></span></div>
      <div class="array">
        <div class="telemetry" id="arrTiles" aria-live="polite"></div>
        <svg id="tac" viewBox="0 0 960 490" role="group" aria-label="Target array: matches plotted by job category and score. Closer to the hub is a better fit. Select a target or card to open it.">
          <defs><radialGradient id="hubg"><stop offset="0" stop-color="#0E2654"/><stop offset="1" stop-color="#02060F"/></radialGradient>
          <linearGradient id="wipeg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5FD0FF" stop-opacity=".05"/><stop offset="1" stop-color="#5FD0FF" stop-opacity=".9"/></linearGradient></defs>
          <g id="tacStatic"></g><g id="tacLeads"></g><g id="tacWipe" class="wiper"></g><g id="tacTargets"></g><g id="tacHub"></g><g id="tacCards"></g>
        </svg>
        <div class="arr-ctl">
          <div class="gates" role="group" aria-label="Minimum fit score"><span class="lbl">MIN FIT</span>${[0, 70, 80, 90].map(g => `<button type="button" data-gate="${g}" aria-pressed="${g === 0}">${g ? g + '+' : 'Any'}</button>`).join('')}</div>
          <div class="gates" role="group" aria-label="Posting age"><span class="lbl">AGE</span>${[[0, 'Any'], [24, '24h'], [72, '3d']].map(([a, l]) => `<button type="button" data-age="${a}" aria-pressed="${a === 0}">${l}</button>`).join('')}</div>
          <span class="grow" aria-hidden="true"></span>
          <button class="btn" type="button" id="arrClear" disabled>Clear filters</button>
          <button class="btn" type="button" id="keyBtn" aria-expanded="false" aria-controls="keyPanel"><span class="kbd">?</span>Key &amp; controls</button>
        </div>
        <div class="keypanel" id="keyPanel" hidden>
          <div class="kgrp"><h4>STATUS</h4>
            <span><svg width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" transform="rotate(45 8 8)" fill="#4F86F0"/></svg>No status</span>
            <span><svg width="16" height="16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" transform="rotate(45 8 8)" fill="#4F86F0"/><rect x="2.5" y="2.5" width="11" height="11" transform="rotate(45 8 8)" fill="none" stroke="#DCE8FF" stroke-width="1.2"/></svg>To do</span>
            <span><svg width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" transform="rotate(45 8 8)" fill="#5EF0B0"/></svg>Applied</span>
            <span><svg width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" transform="rotate(45 8 8)" fill="none" stroke="#6F8CC4" stroke-width="1.5"/></svg>Not interested</span></div>
          <div class="kgrp"><h4>SIGNAL</h4>
            <span><svg width="18" height="16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="#5FD0FF"/><circle cx="8" cy="8" r="6.5" fill="none" stroke="#5FD0FF" stroke-width="1" opacity=".6"/></svg>New in the last 24h (arrives from the rim)</span>
            <span><svg width="20" height="16" aria-hidden="true"><rect x="4" y="6" width="7" height="7" transform="rotate(45 7.5 9.5)" fill="#4F86F0" opacity=".7"/><rect x="8" y="2" width="7" height="7" transform="rotate(45 11.5 5.5)" fill="none" stroke="#8BA3D0" stroke-dasharray="2 2"/></svg>Syndicated listing (SYND)</span>
            <span><svg width="18" height="16" aria-hidden="true"><circle cx="9" cy="8" r="6" fill="none" stroke="#FFD66B" stroke-width="1.3" stroke-dasharray="2.5 2"/></svg>Remote, states not stated (ELIG ?)</span>
            <span><svg width="18" height="16" aria-hidden="true"><circle cx="9" cy="8" r="6.5" fill="none" stroke="#5FD0FF" stroke-width="1.4" stroke-dasharray="3 2.5"/></svg>Tracking (keyboard selection)</span></div>
          <div class="kgrp"><h4>CONTROLS</h4>
            <span><span class="kbd">J</span><span class="kbd">K</span>Cycle targets</span>
            <span><span class="kbd">↵</span>Open tracked role</span>
            <span><span class="kbd">T</span><span class="kbd">A</span><span class="kbd">D</span>To do · Applied · Not interested</span>
            <span><span class="kbd">Esc</span>Release tracking</span>
            <span><span class="kbd">Ctrl K</span>Hunt command</span>
            <span class="hint">Click a band to filter by job category. Click a fit ring for a minimum fit. Closer to the hub = better fit.</span></div>
        </div>
        <div class="log"><h3>SIGNAL LOG</h3><ol id="lcwLog" aria-live="polite"></ol></div>
      </div>
    </section>
  </div>`);
  // results header pill on the controls panel
  const ctl = $('#q')?.closest('.panel');
  if (ctl) { ctl.classList.add('lcw-results'); ctl.insertAdjacentHTML('afterbegin', `<div class="lsh" style="margin-bottom:14px"><span class="pill b1" id="resh">RESULTS</span><span class="line"><i></i></span><span class="code" id="lcwResCode"></span><span class="via"></span></div>`); }
  // discover banner
  const fs = $('#findsBox > summary');
  if (fs) { fs.classList.add('lcw-disc'); const sum = $('#findsSum'); fs.innerHTML = '<span class="dtag">DISCOVER</span><span class="txt"><b>Employers you may not know</b> · </span><span class="go" aria-hidden="true">EXPAND ▾</span>'; fs.querySelector('.txt').appendChild(sum); $('#findsBox').classList.add('discover'); }
  // criteria become a slide-in drawer (same controls, same behaviour)
  const cb = $('#critBox'), side = cb?.closest('.critside');
  if (cb && side) {
    side.classList.add('cf-drawer');
    cb.open = false; A.closeCriteria();
    cb.insertAdjacentHTML('afterbegin', '');
    side.insertAdjacentHTML('afterbegin', `<div class="drail" aria-hidden="true"><i style="height:90px;background:var(--L1)"></i><i style="flex:1;background:var(--L4)"></i><i style="height:60px;background:var(--L5)"></i></div>
      <header class="dhead"><h2>SEARCH CRITERIA</h2><button class="x" type="button" data-close aria-label="Close search criteria">✕</button></header>`);
    const sync = () => document.body.classList.toggle('crit-open', cb.open);
    cb.addEventListener('toggle', sync); sync();
  }
  // role detail drawer
  document.body.insertAdjacentHTML('beforeend', `<div class="scrim" id="scrim"></div>
    <aside class="cfd" id="cfDetail" role="dialog" aria-modal="true" aria-labelledby="cfdTitle" tabindex="-1">
      <div class="drail" aria-hidden="true"><i style="height:90px;background:var(--cy)"></i><i style="flex:1;background:var(--L4)"></i><i style="height:60px;background:var(--L1)"></i></div>
      <div class="inner"><header class="dhead"><h2 id="cfdTitle">TARGET</h2><span class="code" id="cfdId"></span><button class="x" type="button" data-close aria-label="Close role details">✕</button></header>
      <div class="dbody" id="cfdBody"></div>
      <footer><button class="btn" type="button" id="cfdList">Show in list</button><a class="btn primary pri" id="cfdOpen" target="_blank" rel="noopener">OPEN POSTING ↗</a></footer></div>
    </aside>`);
  // bottom LCARS bar
  $('main')?.insertAdjacentHTML('beforeend', `<div class="lc-bottom" aria-hidden="true"><i class="s1"></i><i class="s2">STATUSES STAY IN THIS BROWSER · NOTHING IS UPLOADED</i><i class="s3"></i><i class="s4"></i><i class="cap"></i></div>`);
  // background: drifting stars, moon and rays
  document.body.insertAdjacentHTML('afterbegin', `<div class="stars" aria-hidden="true"><svg id="starsvg" preserveAspectRatio="xMidYMid slice"></svg></div><div class="bgwolf" aria-hidden="true"><div class="bgrays"></div><div class="bgmoon"></div></div>`);
  (() => { const sv = $('#starsvg'), W = 1000; sv.setAttribute('viewBox', `0 0 ${W} 2000`); let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; let out = '';
    for (let k = 0; k < 2; k++) { for (let i = 0; i < 70; i++) { const x = rnd() * W, y = rnd() * 1000, r = rnd() < .15 ? 1.4 : .7, o = (.25 + rnd() * .6).toFixed(2); out += `<circle cx="${x.toFixed(1)}" cy="${(y + k * 1000).toFixed(1)}" r="${r}" fill="#BFD6FF" opacity="${o}"/>`; } seed = 7; }
    sv.innerHTML = out; })();
  // order as in the design: summary, discover banner, target array, results
  const fb = $('#findsBox'), arrP = $('#lcwArray'); if (fb && arrP) arrP.before(fb);
  // the funnel and score explainer sit inside the results panel, under the controls
  if (ctl) { ['#funnelBox', 'details.howscore', '#mSortBar', '#tierChips', '#jobGroups'].forEach(s => { const d = $(s); if (d) ctl.append(d); }); }
  // the criteria drawer must sit outside main's stacking context to cover the page
  if (side) document.body.append(side);
  // results header: the data tools sit on the RESULTS strip, as in the design
  const rsh = $('.lcw-results .lsh');
  if (rsh) { const tools = document.createElement('div'); tools.className = 'tools';
    const pr = $('#btnPrompt'); if (pr) { pr.classList.add('ghost-ac'); tools.append(pr); }
    tools.insertAdjacentHTML('beforeend', '<span class="sep"></span><span class="lbl">YOUR DATA</span>');
    ['#btnCsv', '#btnTrackOut', '#btnTrackIn'].forEach(s => { const b = $(s); if (b) tools.append(b); });
    rsh.append(tools); }
  // command palette + toasts
  document.body.insertAdjacentHTML('beforeend', `<div class="cmdk" id="cmdk" role="dialog" aria-modal="true" aria-labelledby="cmdkh" hidden>
    <div class="cmdk-box"><div class="cmdk-rail" aria-hidden="true"><i style="height:56px;background-color:var(--cy)"></i><i style="flex:1;background-color:var(--L4)"></i><i style="height:40px;background-color:var(--L1)"></i></div>
    <div class="cmdk-main"><div class="cmdk-top"><span class="pill" id="cmdkh">HUNT COMMAND</span><span class="kbd">ESC</span></div>
    <div class="cmdk-in"><svg viewBox="0 0 24 24" fill="none" stroke="#8FA8D6" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input id="cmdkq" type="text" role="combobox" aria-expanded="true" aria-controls="cmdkl" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Jump to a section, run an action, or find a role"></div>
    <ul id="cmdkl" role="listbox" aria-label="Commands"></ul><div class="cmdk-foot"><span>↑ ↓ navigate</span><span>↵ run</span><span>esc close</span></div></div></div></div>
    <div class="toasts" id="toasts" role="status" aria-live="polite"></div>`);
  wire();
}

/* ---------------------------------------------------------------- per-render update */
export function updateWidgets(ctx) {
  if (!$('#lcw')) return;
  lastCtx = ctx;
  setupBands(ctx.crit);
  const map = m => ({ m, id: m.j.uid, score: m.score, company: m.j.employer, role: m.j.title, st: A.stOf(m.j.uid) || '', fresh: freshOf(m), synd: m.j.source_class && m.j.source_class !== 'official',
    unk: m.loc === 'remote_unknown', h: postedH(m), s: secOf(m) });
  rows = ctx.base.map(map); byId = new Map(rows.map(r => [r.id, r]));
  view = rows.filter(r => arrayFilter(r.m));
  // intro
  const p = ctx.profile || {};
  $('#lcwProf span:last-child').textContent = ['PROFILE', p.name || (p.source === 'empty' ? 'No résumé loaded' : 'Résumé loaded'), p.location, (p.titles || [])[0]].filter(Boolean).join(' · ');
  $('#lcwChips').innerHTML = String(ctx.critSummary || '').split(' · ').filter(Boolean).map(c => `<span class="chip">${esc(c)}</span>`).join('') +
    `<button class="btn" id="openCmd" type="button" aria-haspopup="dialog" aria-controls="cmdk"><span class="kbd">${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'}</span>Hunt command</button>` +
    `<button class="btn lc" id="openCriteria" type="button">SEARCH CRITERIA</button>`;
  // THIS WEEK
  const all = ctx.all, tier = t => all.filter(m => m.tier === t).length, none = all.length - tier('starts') - tier('reaches');
  const min = ctx.minLabel;
  $('#sumh').textContent = (ctx.windowLabel || 'THIS WEEK').toUpperCase();
  $('#lcwCode').textContent = `SEC-02 · ${String(ctx.funnelSum || '').replace(/\?.*$/, '?').toUpperCase()}`;
  countTo($('#lcwBig'), all.length);
  $('#lcwSplit').innerHTML = [[tier('starts'), 'var(--cy)'], [tier('reaches'), 'var(--L1)'], [none, '#3A5A97']].filter(([n]) => n).map(([n, c]) => `<div style="flex:${n};background:${c}"></div>`).join('') || '<div style="flex:1;background:var(--line)"></div>';
  $('#lcwLegend').innerHTML = `<span><i style="background:var(--cy)"></i><b>${tier('starts')}</b> base starts ≥ ${esc(min)}</span><span><i style="background:var(--L1)"></i><b>${tier('reaches')}</b> base reaches ${esc(min)}</span><span><i style="background:#3A5A97"></i><b>${none}</b> no base stated</span>`;
  const stats = [[new Set(all.map(m => m.j.employer)).size, 'employers'], [all.filter(freshOf).length, 'new in the last 24h'], [ctx.openCount, 'open roles in dataset'], [all.filter(m => m.loc === 'remote_yes').length, 'remote · home state OK']];
  $('#lcwStats').innerHTML = stats.map(([n, l]) => `<div class="stat"><strong data-n="${n}">${Number(n).toLocaleString('en-US')}</strong><span>${esc(l)}</span></div>`).join('');
  const tr = Object.values(ctx.track || {});
  $('#pTodo').textContent = tr.filter(x => x.s === 'todo').length; $('#pApplied').textContent = tr.filter(x => x.s === 'applied').length; $('#pNo').textContent = tr.filter(x => x.s === 'no').length;
  $('#lcwArrCode').textContent = `ARRAY · ${String(SEC.length).padStart(2, '0')} ${SEC.length === (ctx.crit.functions || []).length ? 'CATEGORIES' : 'CATEGORY GROUPS'} · LIVE`;
  $('#lcwResCode').textContent = `TRACKING ${ctx.shown.toLocaleString()}${arrayActive() ? ' · ARRAY: ' + arrayLabel() : ''}`;
  drawTargets();
  renderLog(ctx);
  if (!counted) { counted = true; countUp(); }
  armWhenVisible();
  drawEdges();
}

export function refreshWidgets() { if (lastCtx) updateWidgets(lastCtx); }

/* ---------------------------------------------------------------- target array */
const CX = 300, CY = 236, A0 = 40, SPAN = 280, GAP = 3;
let NB = 1, SW = SPAN;
const pol = (r, a) => { const t = a * Math.PI / 180; return [CX + r * Math.cos(t), CY + r * Math.sin(t)]; };
const arcd = (r, a1, a2) => { const [x1, y1] = pol(r, a1), [x2, y2] = pol(r, a2); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${(a2 - a1) > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
const secStart = i => A0 + i * (SW + GAP);
const gateRad = g => 60 + (100 - g) * 3.6;
let bands = [], gateRings = {}, gateShade = null;
function buildStatic() {
  const ST = $('#tacStatic'), WP = $('#tacWipe'), HB = $('#tacHub'); if (!ST) return;
  ST.textContent = ''; WP.textContent = ''; HB.textContent = '';
  NB = Math.max(1, SEC.length); SW = (SPAN - GAP * (NB - 1)) / NB;
  add(ST, 'circle', { cx: CX, cy: CY, r: 186, fill: '#030A18' });
  gateShade = add(ST, 'path', { class: 'gateshade', d: '' }); gateRings = {};
  [[96, '90'], [132, '80'], [168, '70']].forEach(([r, l]) => {
    gateRings[l] = add(ST, 'path', { d: arcd(r, A0, A0 + SPAN), fill: 'none', stroke: '#132B5C', 'stroke-width': 1, 'stroke-dasharray': '3 5', class: 'gatering' });
    const gh = add(ST, 'path', { d: arcd(r, A0, A0 + SPAN), class: 'gatehit' }); add(gh, 'title', {}, `Minimum fit ${l}+`);
    gh.addEventListener('click', () => setGate(arr.gate === +l ? 0 : +l));
    const [x, y] = pol(r, 0); add(ST, 'text', { x, y: y - 6, 'text-anchor': 'middle', 'font-family': 'JetBrains Mono,monospace', 'font-size': 10, fill: '#6F8CC4' }, l);
  });
  add(ST, 'path', { d: arcd(176, A0, A0 + SPAN), fill: 'none', stroke: '#1A3770', 'stroke-width': 1.5 });
  for (let a = A0; a <= A0 + SPAN + .1; a += 5) { const big = (a - A0) % 20 === 0; const [x1, y1] = pol(178, a), [x2, y2] = pol(big ? 186 : 182, a); add(ST, 'line', { x1, y1, x2, y2, stroke: big ? '#3A5A97' : '#1E3D7D', 'stroke-width': big ? 2 : 1 }); }
  bands = SEC.map((nm, i) => {
    const a1 = secStart(i), a2 = a1 + SW, col = SECCOL[i % SECCOL.length];
    const b = add(ST, 'path', { d: arcd(203, a1, a2), fill: 'none', stroke: col, 'stroke-width': 28, class: 'band', pathLength: 1 }); b.style.animationDelay = (.15 + i * .12) + 's';
    const mid = a1 + SW / 2, lower = (mid % 360) > 0 && (mid % 360) < 180;
    add(ST, 'path', { id: 'bandtxt' + i, d: lower ? (() => { const [x1, y1] = pol(203, a2), [x2, y2] = pol(203, a1); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A203 203 0 0 0 ${x2.toFixed(1)} ${y2.toFixed(1)}`; })() : arcd(203, a1, a2), fill: 'none', stroke: 'none' });
    const lab = add(ST, 'text', { class: 'seclab', 'dominant-baseline': 'central' });
    const tpe = el('textPath', { href: '#bandtxt' + i, startOffset: '50%', 'text-anchor': 'middle' }); tpe.textContent = nm; lab.appendChild(tpe);
    const hit = add(ST, 'path', { d: arcd(203, a1, a2), class: 'bandhit', tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': `Filter results to ${SECFULL[i]} roles` });
    const toggle = () => { arr.secs.has(i) ? arr.secs.delete(i) : arr.secs.add(i); A.rerender(); };
    hit.addEventListener('click', toggle); hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    ['mouseenter', 'focus'].forEach(ev => hit.addEventListener(ev, () => { b.classList.add('hot'); lab.classList.add('hot'); }));
    ['mouseleave', 'blur'].forEach(ev => hit.addEventListener(ev, () => { b.classList.remove('hot'); lab.classList.remove('hot'); }));
    return { b, lab, tpe, hit, nm };
  });
  [[A0, SECCOL[0]], [A0 + SPAN, SECCOL[(NB - 1) % SECCOL.length]]].forEach(([a, c]) => { const [x, y] = pol(203, a); add(ST, 'circle', { cx: x, cy: y, r: 14, fill: c }); });
  add(ST, 'path', { d: arcd(222, A0 + 2, A0 + SPAN - 2), fill: 'none', stroke: '#132B5C', 'stroke-width': 1 });
  const [w1x, w1y] = pol(52, A0 + 9), [w2x, w2y] = pol(172, A0 + 9);
  add(WP, 'line', { x1: w1x, y1: w1y, x2: w2x, y2: w2y, stroke: 'url(#wipeg)', 'stroke-width': 2 });
  add(WP, 'path', { d: arcd(222, A0 + 3, A0 + 15), fill: 'none', stroke: AC, 'stroke-width': 4, 'stroke-linecap': 'round' });
  add(WP, 'path', { d: arcd(176, A0 + 3, A0 + 15), fill: 'none', stroke: AC, 'stroke-width': 2, opacity: .6 });
  add(HB, 'circle', { cx: CX, cy: CY, r: 40, fill: 'url(#hubg)', stroke: '#2B4F9E', 'stroke-width': 2 });
  add(HB, 'circle', { cx: CX, cy: CY, r: 48, fill: 'none', stroke: AC, 'stroke-width': 1.5, 'stroke-dasharray': '10 6 2 6', class: 'spin', opacity: .7 });
  const wg = add(HB, 'g', { transform: `translate(${CX - 32} ${CY - 34}) scale(.128)` });
  add(wg, 'path', { d: 'M250 150 L200 140 L118 18 L98 172 L38 160 L74 214 L12 242 L70 272 L24 326 L92 322 L64 392 L142 372 L150 436 L206 448 L250 505 L294 448 L350 436 L358 372 L436 392 L408 322 L476 326 L430 272 L488 242 L426 214 L462 160 L402 172 L382 18 L300 140 L250 150 Z', fill: '#13294F', stroke: '#7FA6E8', 'stroke-width': 14, 'stroke-linejoin': 'round' });
  const eyes = add(wg, 'g', { class: 'eyeflash' });
  add(eyes, 'path', { d: 'M140 240 L214 262 L170 272 Z', fill: '#BFF0FF' }); add(eyes, 'path', { d: 'M360 240 L286 262 L330 272 Z', fill: '#BFF0FF' });
}
function setGate(g) { arr.gate = g; A.rerender(); }
const trunc = (t, n) => t.length > n ? t.slice(0, n - 1) + '…' : t;
const ranked = () => view.slice().sort((a, b) => b.score - a.score || a.h - b.h);
function drawTargets() {
  const LD = $('#tacLeads'), TG = $('#tacTargets'), CD = $('#tacCards'); if (!LD) return;
  LD.textContent = ''; TG.textContent = ''; CD.textContent = '';
  // the dial shows the strongest 220 roles in the base set (more would be noise); the table shows everything
  const base = rows.slice().sort((a, b) => b.score - a.score || a.h - b.h).slice(0, 220);
  const inView = new Set(view.map(r => r.id));
  const items = base.map(r => ({ r, s: r.s, inv: inView.has(r.id) }));
  const perSec = {}; items.forEach(it => { (perSec[it.s] ||= []).push(it); });
  const placed = [], MIN = 12.5;
  Object.values(perSec).forEach(grp => grp.forEach(it => {
    const s0 = secStart(it.s) + 4, s1 = secStart(it.s) + SW - 4;
    let rad = Math.max(62, gateRad(it.r.score)), done = false;
    for (let tries = 0; tries < 40 && !done; tries++) {
      const steps = Math.max(2, Math.floor((s1 - s0) * Math.PI / 180 * rad / MIN));
      for (let j = 0; j <= steps && !done; j++) {
        const frac = j % 2 ? (0.5 + Math.ceil(j / 2) / (steps + 1)) : (0.5 - Math.ceil(j / 2) / (steps + 1));
        if (frac < 0 || frac > 1) continue;
        const a = s0 + (s1 - s0) * frac, [x, y] = pol(rad, a);
        if (placed.every(q => (q[0] - x) ** 2 + (q[1] - y) ** 2 >= MIN * MIN)) { it.a = a; it.rad = rad; it.x = x; it.y = y; done = true; }
      }
      if (!done) rad = Math.min(172, rad + MIN * 0.9);
    }
    if (!done) { it.a = (s0 + s1) / 2; it.rad = rad; [it.x, it.y] = pol(rad, it.a); }
    placed.push([it.x, it.y]); [it.ox, it.oy] = pol(240, it.a); it.top = it.oy < CY;
  }));
  const top = items.filter(i => i.inv).sort((a, b) => b.r.score - a.r.score || a.r.h - b.r.h).slice(0, 5);
  const N = top.length, slot = i => N < 5 ? (56 + i * 100) : (56 + i * ((490 - 112) / (N - 1)));
  top.forEach((it, rank) => { it.cy = slot(rank); });
  top.filter(i => i.top).sort((a, b) => a.cy - b.cy).forEach((it, t) => { it.lane = 8 + t * 7; it.xv = 536 - t * 8; });
  top.filter(i => !i.top).sort((a, b) => b.cy - a.cy).forEach((it, b) => { it.lane = 462 - b * 7; it.xv = 536 - b * 8; });
  items.slice().sort((a, b) => a.inv - b.inv).forEach(it => {
    const r = it.r, st = r.st, col = st === 'applied' ? '#5EF0B0' : scoreCol(r.score), small = !top.includes(it);
    const sz = small ? 3.6 : 6, locked = it.inv && top.length && top[0] === it, seln = arr.sel === r.id;
    const note = [r.fresh ? 'new in the last 24 hours' : ageText(r.h) + ' old', r.synd ? 'syndicated listing' : 'official listing', r.unk ? 'remote states not stated' : ''].filter(Boolean).join(', ');
    const g = add(TG, 'g', { class: 'tg' + (locked ? ' locked' : '') + (it.inv ? '' : ' out') + (seln ? ' sel' : '') + (r.fresh && firstDraw && it.inv ? ' arrive' : ''), tabindex: it.inv ? 0 : -1, role: 'button', 'aria-label': `${r.company}, ${r.role}, score ${r.score}, ${ST_LABEL[st]}, ${note}` });
    add(g, 'title', {}, `${r.company} · ${r.role} · ${r.score} · ${ST_LABEL[st]} · ${note}`);
    if (r.fresh && firstDraw && it.inv) { const [rx, ry] = pol(176, it.a); g.style.setProperty('--fx', (rx - it.x).toFixed(1) + 'px'); g.style.setProperty('--fy', (ry - it.y).toFixed(1) + 'px'); g.style.setProperty('--ad', (1.4 + Math.random() * .9).toFixed(2) + 's'); }
    if (r.fresh && it.inv) { const [tx, ty] = pol(Math.min(176, it.rad + 34), it.a); const gid = 'tr' + Math.random().toString(36).slice(2, 8);
      const lgd = add(g, 'linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: it.x, y1: it.y, x2: tx, y2: ty });
      add(lgd, 'stop', { offset: 0, 'stop-color': AC, 'stop-opacity': .7 }); add(lgd, 'stop', { offset: 1, 'stop-color': AC, 'stop-opacity': 0 });
      add(g, 'line', { x1: it.x, y1: it.y, x2: tx, y2: ty, stroke: `url(#${gid})`, 'stroke-width': 3, 'stroke-linecap': 'round', class: 'trail' }); }
    add(g, 'circle', { cx: it.x, cy: it.y, r: small ? 9 : 14, fill: 'transparent', stroke: small ? 'none' : '#1E3D7D', 'stroke-width': 1, class: 'ring3' });
    if (st === 'no') add(g, 'rect', { x: it.x - sz, y: it.y - sz, width: sz * 2, height: sz * 2, fill: 'none', stroke: MUT, 'stroke-width': 1.5, transform: `rotate(45 ${it.x} ${it.y})` });
    else {
      if (r.synd) add(g, 'rect', { x: it.x - sz + 5, y: it.y - sz - 5, width: sz * 2, height: sz * 2, fill: 'none', stroke: '#8BA3D0', 'stroke-width': 1.2, 'stroke-dasharray': '2.5 2', transform: `rotate(45 ${it.x + 5} ${it.y - 5})`, class: 'gh' });
      const fade = Math.max(.5, 1 - r.h / 220);
      add(g, 'rect', { x: it.x - sz, y: it.y - sz, width: sz * 2, height: sz * 2, fill: col, opacity: (r.synd ? .7 : 1) * fade, transform: `rotate(45 ${it.x} ${it.y})`, class: 'dm', style: 'filter:drop-shadow(0 0 6px ' + col + ')' });
    }
    if (r.unk && !small) add(g, 'circle', { cx: it.x, cy: it.y, r: sz + 7, class: 'unk' });
    if (r.fresh && it.inv) add(g, 'circle', { cx: it.x, cy: it.y, r: 7, class: 'np' });
    if (seln) { add(g, 'circle', { cx: it.x, cy: it.y, r: sz + 14, class: 'trk' }); const q = sz + 19, w = 6;
      add(g, 'path', { class: 'trkx', d: `M${it.x} ${it.y - q}v${w}M${it.x} ${it.y + q}v-${w}M${it.x - q} ${it.y}h${w}M${it.x + q} ${it.y}h-${w}` }); }
    if (st === 'todo' || st === 'applied') add(g, 'rect', { x: it.x - sz - 4, y: it.y - sz - 4, width: sz * 2 + 8, height: sz * 2 + 8, fill: 'none', stroke: st === 'applied' ? '#5EF0B0' : '#DCE8FF', 'stroke-width': 1.3, transform: `rotate(45 ${it.x} ${it.y})` });
    add(g, 'path', { class: 'lk', d: `M${it.x - 20} ${it.y - 12}V${it.y - 20}H${it.x - 12}M${it.x + 12} ${it.y - 20}H${it.x + 20}V${it.y - 12}M${it.x + 20} ${it.y + 12}V${it.y + 20}H${it.x + 12}M${it.x - 12} ${it.y + 20}H${it.x - 20}V${it.y + 12}`, fill: 'none', stroke: AC, 'stroke-width': 2 });
    it.g = g;
  });
  top.forEach((it, rank) => {
    const r = it.r, col = scoreCol(r.score);
    const d = `M${it.x.toFixed(1)} ${it.y.toFixed(1)} L${it.ox.toFixed(1)} ${it.oy.toFixed(1)} V${it.lane} H${it.xv} V${it.cy.toFixed(1)} H582`;
    const lg = add(LD, 'g', { class: 'lead' }); const ld = add(lg, 'path', { d, class: 'ld', pathLength: 1 }); const lp = add(lg, 'path', { d, class: 'ldp', pathLength: 1 }); lp.style.animationDelay = (-rank * 1.1) + 's';
    add(lg, 'circle', { cx: it.ox, cy: it.oy, r: 3, fill: '#02060F', stroke: '#2B5BB8', 'stroke-width': 1.5 }); add(lg, 'circle', { cx: it.xv, cy: it.lane, r: 2.5, fill: '#2B5BB8' });
    const c = add(CD, 'g', { class: 'card' + (arr.sel === r.id ? ' sel' : ''), tabindex: 0, role: 'button', 'aria-label': `Open ${r.company}, ${r.role}, score ${r.score}, ${ST_LABEL[r.st]}` });
    const y0 = it.cy - 32;
    add(c, 'rect', { x: 582, y: y0, width: 82, height: 64, rx: 32, fill: col }); add(c, 'rect', { x: 628, y: y0, width: 36, height: 64, fill: col });
    add(c, 'text', { x: 623, y: it.cy + 11, 'text-anchor': 'middle', 'font-family': 'Antonio,sans-serif', 'font-size': 30, 'font-weight': 700, fill: '#031018' }, String(r.score));
    add(c, 'rect', { x: 668, y: y0, width: 272, height: 64, class: 'body' }); add(c, 'rect', { x: 944, y: y0, width: 12, height: 64, rx: 6, fill: SECCOL[it.s % SECCOL.length] });
    const id2 = r.unk ? ['ELIG ?', '#FFD66B'] : r.synd ? ['SYND', '#8BA3D0'] : null;
    add(c, 'text', { x: 682, y: it.cy + 18, 'font-family': 'Inter,sans-serif', 'font-size': 15, 'font-weight': 600, fill: '#DCE8FF' }, trunc(r.role, id2 ? 24 : 31));
    if (id2) add(c, 'text', { x: 928, y: it.cy + 18, 'text-anchor': 'end', 'font-family': 'Antonio,sans-serif', 'font-size': 11, 'letter-spacing': 2, fill: id2[1] }, id2[0]);
    const tag = rank === 0 ? ['TOP MATCH', AC] : r.st === 'applied' ? ['APPLIED', '#5EF0B0'] : r.st === 'todo' ? ['TO DO', '#DCE8FF'] : r.fresh ? ['NEW', AC] : null;
    add(c, 'text', { x: 682, y: it.cy - 8, 'font-family': 'JetBrains Mono,monospace', 'font-size': 12, fill: '#8BA3D0' }, trunc(`#${rank + 1} · ${r.company} · ${SEC[it.s] || ''}${tag && (tag[0] === 'NEW' || tag[0] === 'TOP MATCH') ? '' : ' · ' + ageText(r.h)}`, tag ? (tag[0] === 'TOP MATCH' ? 22 : 25) : 33));
    if (tag) add(c, 'text', { x: 928, y: it.cy - 8, 'text-anchor': 'end', 'font-family': 'Antonio,sans-serif', 'font-size': 12, 'letter-spacing': 2, fill: tag[1] }, tag[0]);
    if (firstDraw) { ld.style.transitionDelay = (.15 + rank * .16) + 's, 0s'; it.g.style.transitionDelay = (.9 + rank * .08) + 's'; c.style.transitionDelay = (1 + rank * .1) + 's'; }
    it.c = c; it.lg = lg;
  });
  items.forEach(it => {
    const r = it.r, els = [it.g, it.c].filter(Boolean);
    const hot = on => [it.g, it.c, it.lg, bands[it.s]?.b, bands[it.s]?.lab].filter(Boolean).forEach(e => e.classList.toggle('hot', on));
    const go = () => {
      arr.sel = r.id;
      if (reduced()) { openDetail(r.id); return; }
      const bm = add(TG, 'path', { d: `M${CX} ${CY} L${it.x.toFixed(1)} ${it.y.toFixed(1)}`, class: 'beam', pathLength: 1 }), hit = add(TG, 'circle', { cx: it.x, cy: it.y, r: 4, class: 'beamhit' });
      hot(true); setTimeout(() => { bm.remove(); hit.remove(); }, 900); setTimeout(() => openDetail(r.id), 380);
    };
    els.forEach(e => {
      e.addEventListener('mouseenter', () => hot(true)); e.addEventListener('mouseleave', () => hot(false));
      e.addEventListener('focus', () => hot(true)); e.addEventListener('blur', () => hot(false));
      e.addEventListener('click', go); e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    });
  });
  if (arr.sel && !view.some(r => r.id === arr.sel)) arr.sel = null;
  if (arr.sel) { const it = items.find(i => i.r.id === arr.sel); if (it) { const [hx, hy] = pol(50, it.a); TG.insertBefore(el('path', { d: `M${hx.toFixed(1)} ${hy.toFixed(1)} L${it.x.toFixed(1)} ${it.y.toFixed(1)}`, class: 'tether' }), TG.firstChild); } }
  if (firstDraw && top.length) {
    const t1 = top[0]; add(TG, 'circle', { cx: t1.x, cy: t1.y, r: 8, class: 'shock' });
    const [lfx, lfy] = pol(t1.rad + 30, t1.a); add(TG, 'text', { x: lfx, y: lfy + 4, 'text-anchor': lfx < CX ? 'end' : 'start', class: 'lockflash' }, 'TOP MATCH');
  }
  if (items.length) firstDraw = false;
  const cnt = SEC.map((_, i) => rows.filter(r => r.s === i).length);
  // labels fit their arc: shrink the type, then drop the count if a long name still doesn't fit
  const arcLen = SW * Math.PI / 180 * 203 - 10, fitTxt = s => Math.min(14, arcLen / (s.length * 0.8));
  bands.forEach((bd, i) => { const sel = arr.secs.has(i); let txt = `${bd.nm} · ${cnt[i]}`; if (fitTxt(txt) < 9.5) txt = bd.nm;
    bd.tpe.textContent = txt; bd.lab.style.fontSize = Math.max(9, fitTxt(txt)).toFixed(1) + 'px'; bd.lab.style.letterSpacing = fitTxt(txt) < 12 ? '.12em' : ''; bd.b.classList.toggle('sel', sel); bd.lab.classList.toggle('sel', sel); bd.b.classList.toggle('dim', arr.secs.size > 0 && !sel); bd.hit.setAttribute('aria-pressed', String(sel)); });
  Object.entries(gateRings).forEach(([l, p]) => p.classList.toggle('on', arr.gate === +l));
  if (arr.gate && gateShade) { const ri = gateRad(arr.gate) + 2, ro = 176, [ax, ay] = pol(ro, A0), [bx, by] = pol(ro, A0 + SPAN), [cx2, cy2] = pol(ri, A0 + SPAN), [dx, dy] = pol(ri, A0);
    gateShade.setAttribute('d', `M${ax} ${ay} A${ro} ${ro} 0 1 1 ${bx} ${by} L${cx2} ${cy2} A${ri} ${ri} 0 1 0 ${dx} ${dy} Z`); } else gateShade?.setAttribute('d', '');
  $$('.gates button[data-gate]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.gate === arr.gate)));
  $$('.gates button[data-age]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.age === arr.age)));
  const avg = view.length ? Math.round(view.reduce((a, r) => a + r.score, 0) / view.length) : 0, best = ranked()[0];
  const L = arr.sel ? ranked() : null, i = L ? L.findIndex(r => r.id === arr.sel) : -1;
  const T = (lbl, val, c, sub) => `<div class="tile" style="--tc:${c}"><b>${lbl}</b><strong>${val}${sub ? `<small>${sub}</small>` : ''}</strong></div>`;
  const trk = i >= 0
    ? `<div class="tile tile-trk" style="--tc:${AC}"><b>◎ TRACKING · #${i + 1} OF ${L.length}</b><strong>${L[i].score} · ${esc(SEC[L[i].s] || '')}</strong><span class="who">${esc(L[i].company)} — ${esc(L[i].role)}</span></div>`
    : `<div class="tile tile-trk idle" style="--tc:#1E3D7D"><b>TRACKING</b><strong>Press J to lock onto the top target</strong><span class="who">${best ? `Top in view: ${best.score} · ${esc(best.role)}` : 'No targets in view'}</span></div>`;
  $('#arrTiles').innerHTML = T('IN VIEW', view.length.toLocaleString(), '#2B4F9E', '/' + rows.length.toLocaleString()) + T('NEW · 24H', view.filter(r => r.fresh).length, AC) + T('AVG FIT', avg || '—', B1) + T('TO DO', view.filter(r => r.st === 'todo').length, '#7FA6E8') + T('APPLIED', view.filter(r => r.st === 'applied').length, '#5EF0B0') + trk;
  $('#arrClear').disabled = !arrayActive();
}

/* ---------------------------------------------------------------- signal log */
function renderLog(ctx) {
  const t = ctx.generatedAt ? new Date(ctx.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
  const top = ranked().slice(0, 4);
  const LOG = [{ t, k: 'UPDATE', m: `Update complete · ${ctx.openCount.toLocaleString()} open roles from employer job boards`, c: 'sys' },
    ...top.map((r, i) => ({ t: r.m.dt?.d ? new Date(/T/.test(r.m.dt.d) ? r.m.dt.d : r.m.dt.d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase() : '—', k: i === 0 ? 'TOP MATCH' : 'STRONG MATCH', m: `${r.company} — ${r.role} · ${r.score}`, id: r.id, c: 'acq' })),
    ...(ctx.findsSum ? [{ t, k: 'DISCOVER', m: ctx.findsSum, c: 'sys' }] : [])];
  $('#lcwLog').innerHTML = LOG.map((l, i) => `<li class="${l.c}" style="animation-delay:${.2 + i * .12}s"><span class="t">${esc(l.t)}</span><span class="k">${l.k}</span><span class="m">${l.id ? `<button type="button" data-open="${esc(l.id)}">${esc(l.m)}</button>` : esc(l.m)}</span></li>`).join('');
}

/* ---------------------------------------------------------------- motion helpers */
function countTo(n, target) {
  if (!n) return;
  if (reduced() || counted) { n.textContent = target.toLocaleString('en-US'); return; }
  const t0 = performance.now() + 250, dur = target > 1000 ? 1600 : 1100;
  const step = now => { const t = Math.min(1, Math.max(0, (now - t0) / dur)), e = 1 - Math.pow(1 - t, 3); n.textContent = Math.round(target * e).toLocaleString('en-US'); if (t < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function countUp() { if (reduced()) return; $$('#lcwStats strong[data-n]').forEach((n, k) => { const target = +n.dataset.n, t0 = performance.now() + 340 + k * 90, dur = target > 1000 ? 1600 : 1100;
  const step = now => { const t = Math.min(1, Math.max(0, (now - t0) / dur)), e = 1 - Math.pow(1 - t, 3); n.textContent = Math.round(target * e).toLocaleString('en-US'); if (t < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); }); }
let armed = false;
function armWhenVisible() {
  const tac = $('#tac'); if (!tac || armed) return;
  const arm = () => { armed = true; tac.classList.add('armed'); };
  if (reduced() || !('IntersectionObserver' in window)) return arm();
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setTimeout(arm, 150); io.disconnect(); } }, { threshold: .3 }); io.observe(tac);
}
function drawEdges() {
  $$('#view-matches .panel').forEach((p, i) => {
    let s = p.querySelector(':scope > .edge');
    if (!s) { s = el('svg', { class: 'edge', 'aria-hidden': 'true' }); p.prepend(s); }
    const w = p.offsetWidth, h = p.offsetHeight, c = 18; if (!w || !h) return;
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    s.innerHTML = `<path pathLength="1" style="animation-delay:${-i * 3.1}s" d="M1 1 H${w - c} L${w - 1} ${c} V${h - 1} H${c} L1 ${h - c} Z"/>`;
  });
}

/* ---------------------------------------------------------------- toasts */
export function lcToast(title, msg, col = AC) {
  const box = $('#toasts'); if (!box) return;
  const t = document.createElement('div'); t.className = 'lctoast';
  t.innerHTML = `<span class="cap" style="background:${col}">◆</span><span class="tx"><b style="color:${col}">${esc(title)}</b><span>${esc(msg)}</span></span><i class="bar" style="background:${col}"></i>`;
  box.appendChild(t); setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2800);
  while (box.children.length > 3) box.firstElementChild.remove();
}
const STAT_TOAST = { applied: ['TARGET ENGAGED', AC], todo: ['TARGET MARKED', '#7FA6E8'], no: ['TARGET DISMISSED', '#FFD66B'], '': ['TARGET RESET', '#8BA3D0'] };
export function statusToast(uid, st) { const r = byId.get(uid); const [t, c] = STAT_TOAST[st || ''] || STAT_TOAST['']; lcToast(t, r ? `${r.company} — ${r.role}` : '', c); }

/* ---------------------------------------------------------------- wiring: controls, palette, keyboard */
function wire() {
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('#arrClear') || t.closest('[data-clear-arr]')) { clearArray(); return; }
    const g = t.closest('.gates button[data-gate]'); if (g) { setGate(+g.dataset.gate); return; }
    const a = t.closest('.gates button[data-age]'); if (a) { arr.age = +a.dataset.age; A.rerender(); return; }
    if (t.closest('#keyBtn')) { const kp = $('#keyPanel'), open = kp.hidden; kp.hidden = !open; $('#keyBtn').setAttribute('aria-expanded', String(open)); return; }
    if (t.closest('#openCmd')) { openCmd(t.closest('#openCmd')); return; }
    if (t.closest('#openCriteria')) { A.openCriteria(); return; }
    const lo = t.closest('#lcwLog [data-open]'); if (lo) { arr.sel = lo.dataset.open; openDetail(lo.dataset.open); }
  });
  const mq = matchMedia('(max-width:760px)');
  const fit = () => { $('#tac')?.setAttribute('viewBox', mq.matches ? '0 0 520 490' : '0 0 960 490'); const cd = $('#tacCards'), ld = $('#tacLeads'); if (cd) cd.style.display = mq.matches ? 'none' : ''; if (ld) ld.style.display = mq.matches ? 'none' : ''; };
  mq.addEventListener ? mq.addEventListener('change', fit) : mq.addListener(fit); fit();
  addEventListener('resize', () => { cancelAnimationFrame(wire.r); wire.r = requestAnimationFrame(drawEdges); });
  // depth tilt on the instrument
  if (!reduced() && matchMedia('(pointer:fine)').matches) {
    let ev = null, pending = false;
    addEventListener('mousemove', e => { ev = e; if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; const tac = $('#tac'); if (!tac) return;
      const t = tac.getBoundingClientRect(), inside = ev.clientY > t.top - 120 && ev.clientY < t.bottom + 120;
      tac.style.setProperty('--ax', inside ? Math.max(-1, Math.min(1, (ev.clientX - (t.left + t.width / 2)) / (t.width / 2))).toFixed(3) : 0);
      tac.style.setProperty('--ay', inside ? Math.max(-1, Math.min(1, (ev.clientY - (t.top + t.height / 2)) / (t.height / 2))).toFixed(3) : 0); }); }, { passive: true });
  }
  // palette
  const ck = $('#cmdk'), cq = $('#cmdkq'), cl = $('#cmdkl'); let sel = 0, shown = [], from = null;
  const jump = s => { A.showMatches(); setTimeout(() => $(s)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); };
  const CMDS = () => [
    { g: 'JUMP TO', c: '01', l: 'This week summary', h: `${lastCtx?.all.length ?? 0} matches`, run: () => jump('#sumh') },
    { g: 'JUMP TO', c: '02', l: 'Discover employers', h: 'high-pay finds', run: () => { jump('#findsBox'); const d = $('#findsBox'); if (d) d.open = true; } },
    { g: 'JUMP TO', c: '03', l: 'Target array', h: `${SEC.length} bands`, run: () => jump('#scopeh') },
    { g: 'JUMP TO', c: '04', l: 'Results table', h: `${view.length} in view`, run: () => jump('#resh') },
    { g: 'ACTIONS', c: 'A', l: 'Edit search criteria', h: 'pay · window · locations · categories', run: () => A.openCriteria() },
    { g: 'ACTIONS', c: '?', l: 'Why only these roles? See what each filter removes', h: 'funnel', run: () => { const f = $('#funnelBox'); if (f) { f.open = true; jump('#funnelBox'); } } },
    { g: 'ACTIONS', c: 'F', l: 'Show only roles new in the last 24 hours', h: 'age filter', run: () => { arr.age = 24; A.rerender(); jump('#scopeh'); } },
    { g: 'ACTIONS', c: 'S', l: 'Search roles or companies', h: 'focus search', run: () => { jump('#resh'); setTimeout(() => $('#q')?.focus({ preventScroll: true }), 350); } },
    { g: 'ACTIONS', c: 'AI', l: 'Prompt for your AI', h: 'copy prompt', run: () => $('#btnPrompt')?.click() },
    { g: 'ACTIONS', c: '◆', l: 'AI job alerts', h: 'daily new-roles lists', run: () => { location.hash = '#discover'; } },
    { g: 'YOUR DATA', c: 'D', l: 'Export CSV', h: 'download', run: () => $('#btnCsv')?.click() },
    { g: 'YOUR DATA', c: 'D', l: 'Back up statuses', h: 'save file', run: () => $('#btnTrackOut')?.click() },
    { g: 'YOUR DATA', c: 'D', l: 'Restore statuses', h: 'load file', run: () => $('#btnTrackIn')?.click() },
    ...ranked().slice(0, 8).map(r => ({ g: 'TARGETS', c: String(r.score), l: `${r.company} — ${r.role}`, h: (r.m.j.locations || [])[0] || '', run: () => { arr.sel = r.id; openDetail(r.id); } })),
  ];
  let list = [];
  function renderCmd() {
    const q = cq.value.trim().toLowerCase();
    shown = list.filter(c => !q || (c.l + ' ' + c.h + ' ' + c.g).toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    if (!shown.length) { cl.innerHTML = '<li class="none" role="presentation">No match. Try "results", "criteria" or a company name.</li>'; return; }
    let html = '', last = '';
    shown.forEach((c, i) => { if (c.g !== last) { html += `<li class="grp" role="presentation">${c.g}</li>`; last = c.g; }
      html += `<li role="option" id="ck${i}" data-i="${i}" aria-selected="${i === sel}"><span class="cap">${esc(c.c)}</span><span class="lb">${esc(c.l)}</span><span class="ht">${esc(c.h)}</span></li>`; });
    cl.innerHTML = html; cq.setAttribute('aria-activedescendant', 'ck' + sel); $('#ck' + sel)?.scrollIntoView({ block: 'nearest' });
  }
  function openCmd(f) { from = f || document.activeElement; list = CMDS(); ck.hidden = false; cq.value = ''; sel = 0; renderCmd(); setTimeout(() => cq.focus(), 10); }
  function closeCmd(restore = true) { ck.hidden = true; if (restore && from?.focus) from.focus(); }
  function runCmd(i) { const c = shown[i]; if (!c) return; closeCmd(false); c.run(); }
  wire.openCmd = openCmd;
  cq.addEventListener('input', () => { sel = 0; renderCmd(); });
  cq.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); renderCmd(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); renderCmd(); }
    else if (e.key === 'Enter') { e.preventDefault(); runCmd(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCmd(); }
  });
  cl.addEventListener('click', e => { const li = e.target.closest('[role=option]'); if (li) runCmd(+li.dataset.i); });
  ck.addEventListener('mousedown', e => { if (e.target === ck) closeCmd(); });
  document.addEventListener('keydown', e => {
    const k = e.key.toLowerCase(), a = document.activeElement, typing = /input|textarea|select/i.test(a?.tagName || '') || a?.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); ck.hidden ? openCmd() : closeCmd(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || typing || !ck.hidden || !$('#view-matches')?.classList.contains('active') || document.body.classList.contains('drawer-open') || document.body.classList.contains('crit-open')) return;
    if (k === '/') { e.preventDefault(); openCmd(); }
    else if (k === 'j' || k === 'k') { e.preventDefault(); cycle(k === 'j' ? 1 : -1); }
    else if (e.key === '?') { e.preventDefault(); $('#keyBtn')?.click(); }
    else if (!arr.sel) return;
    else if (k === 'enter' && (a === document.body || !a || a.closest('#tac'))) { e.preventDefault(); openDetail(arr.sel); }
    else if (k === 't' || k === 'a' || k === 'd') {
      e.preventDefault();
      const st = { t: 'todo', a: 'applied', d: 'no' }[k], L = ranked(), i = L.findIndex(x => x.id === arr.sel), id = arr.sel;
      if (k === 'd') { const nx = L.filter(x => x.id !== id); arr.sel = nx.length ? nx[Math.min(i, nx.length - 1)].id : null; }
      A.setStatus(id, st);
    } else if (k === 'escape') { arr.sel = null; drawTargets(); }
  });
}
/* ---------------------------------------------------------------- role detail drawer */
let lastFocus = null, detailUid = null;
function ringSvg(s, size = 48) {
  const C0 = 113.1, d = (s / 100 * C0).toFixed(1);
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" role="img" aria-label="Score ${s}"><g stroke="#2B4F9E" stroke-width="1.5"><path d="M24 0V4M24 44V48M0 24H4M44 24H48"/></g>
    <circle cx="24" cy="24" r="18" fill="none" stroke="#0F2347" stroke-width="4"/><circle class="ring" style="--c:${C0}" cx="24" cy="24" r="18" fill="none" stroke="${scoreCol(s)}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${d} ${C0}" transform="rotate(-90 24 24)"/>
    <text x="24" y="29" text-anchor="middle" font-family="Antonio,sans-serif" font-size="15" font-weight="700" fill="#DCE8FF">${s}</text></svg>`;
}
function openDetail(uid) {
  const m = byId.get(uid)?.m || A.getMatch(uid); if (!m) { A.showInList(uid); return; }
  detailUid = uid; arr.sel = uid;
  const j = m.j, s = j.salary, st = A.stOf(uid) || '', parts = A.scoreParts(m);
  const pay = s?.min ? `${A.money(s.min)}${s.max && s.max !== s.min ? '–' + A.money(s.max) : ''}` : 'Not stated';
  const kind = { starts: 'Base · starts at or above your minimum', reaches: 'Base · range reaches your minimum', unknown: 'No base pay stated', ote_only: 'OTE / total comp only', predicted: 'Predicted, not stated' }[m.tier] || '';
  const ls = A.locShort[m.loc], posted = m.dt?.d ? new Date(/T/.test(m.dt.d) ? m.dt.d : m.dt.d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
  const fns = (m.fnHit || []).map(f => C.FUNCTIONS[f]?.label || f);
  $('#cfdId').textContent = `SCORE ${m.score}/100`;
  $('#cfdOpen').href = j.url;
  $('#cfdBody').innerHTML = `
    <div class="dtop">${ringSvg(m.score, 72)}<div><div class="co">${esc(j.employer)}${j.sector ? ` <span>· ${esc(j.sector)}</span>` : ''}</div><div class="dtitle">${esc(j.title)}</div></div></div>
    <div class="lsh"><span class="pill b1">SIGNAL</span><span class="line"><i></i></span><span class="via"></span></div>
    <dl class="kv">
      <dt>BASE PAY</dt><dd><span class="pay">${esc(pay)}</span><span class="sub">${esc(kind)}</span></dd>
      <dt>LOCATION</dt><dd>${esc((j.locations || []).slice(0, 3).join(' · ') || 'Not listed')}${ls ? `<div class="badges"><span class="badge b-${ls[1]}">${esc(ls[0].toUpperCase())}</span></div>` : ''}</dd>
      <dt>POSTED</dt><dd><span class="mono">${esc(posted)}</span>${m.dt?.d ? ` · ${ageText(postedH(m))} ago` : ''}<span class="sub">Date basis: ${esc(m.dt?.kind || 'none')}</span></dd>
      <dt>SOURCE</dt><dd>${esc(j.ats || '')} · ${j.source_class === 'official' ? 'Official' : 'Syndicated'}${j.dup_count > 1 ? ` · ${j.dup_count} copies found` : ''}</dd>
      <dt>LEVEL</dt><dd>${esc(C.SENIORITY_LABEL[j.seniority] || 'Not detected')}</dd>
      <dt>CATEGORIES</dt><dd>${fns.map(esc).join(' · ') || '—'}</dd>
    </dl>
    <div class="dsec"><span class="dlab">STATUS</span><div class="stbtns" role="group" aria-label="Set status">${['', 'todo', 'applied', 'no'].map(k => `<button class="btn" type="button" data-setst="${k}" aria-pressed="${k === st}">${ST_LABEL[k]}</button>`).join('')}</div></div>
    <div class="parts"><span class="dlab">WHY IT SCORED ${m.score}</span>${parts.map(([l, v, mx, tx]) => `<div class="part"><div class="ph"><b>${esc(l)}</b><span>${v ?? 0}<i>/${mx}</i></span></div><div class="pbar"><i style="width:${Math.round((v || 0) / mx * 100)}%"></i></div><p>${esc(tx)}</p></div>`).join('')}</div>
    ${(j.kw || []).length ? `<div class="dsec"><span class="dlab">SKILLS FOUND IN THE POSTING</span><div class="skl">${j.kw.slice(0, 18).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div></div>` : ''}`;
  lastFocus = document.activeElement;
  document.body.classList.add('drawer-open'); $('#scrim').classList.add('on'); $('#cfDetail').classList.add('on'); setTimeout(() => $('#cfDetail').focus(), 30);
  drawTargets();
}
function closeDrawers() {
  document.body.classList.remove('drawer-open'); $('#scrim')?.classList.remove('on'); $('#cfDetail')?.classList.remove('on');
  if (document.body.classList.contains('crit-open')) A.closeCriteria(), document.body.classList.remove('crit-open');
  if (lastFocus?.focus) lastFocus.focus();
}
document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('[data-close]') || t.id === 'scrim') { closeDrawers(); return; }
  const sb = t.closest('#cfdBody [data-setst]');
  if (sb && detailUid) { const k = sb.dataset.setst; if (k === '' ? A.stOf(detailUid) : A.stOf(detailUid) !== k) { A.setStatusRaw(detailUid, k); } $$('#cfdBody [data-setst]').forEach(b => b.setAttribute('aria-pressed', String(b === sb))); return; }
  if (t.closest('#cfdList') && detailUid) { const u = detailUid; closeDrawers(); A.showInList(u); return; }
  // table rows open the detail drawer (links, status buttons and tags keep their own behaviour)
  const tr = t.closest('#jobGroups tr.mt-row');
  if (tr && !t.closest('a,button,.tag,select,input')) { e.preventDefault(); e.stopPropagation(); openDetail(tr.dataset.uid); }
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && (document.body.classList.contains('drawer-open') || document.body.classList.contains('crit-open'))) closeDrawers(); });

function cycle(dir) {
  const L = ranked(); if (!L.length) return;
  let i = L.findIndex(r => r.id === arr.sel);
  i = i < 0 ? (dir > 0 ? 0 : L.length - 1) : (i + dir + L.length) % L.length;
  arr.sel = L[i].id; drawTargets();
  const t = $('#tac').getBoundingClientRect(); if (t.bottom < 80 || t.top > innerHeight - 80) $('#tac').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
