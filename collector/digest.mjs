#!/usr/bin/env node
// Emails each subscriber the NEW matches for their own criteria. Runs after collect.mjs in GitHub Actions.
//
// Secrets (Settings → Secrets and variables → Actions):
//   RESEND_API_KEY   API key from resend.com (free tier works)
//   ALERT_FROM       e.g. "Cache Flow <alerts@yourdomain.com>" (domain verified in Resend)
//   SUBSCRIBERS      JSON array: [{ "email": "a@b.com", "crit": {...}, "skillsOn": [...], "custom": [...] }]
//                    (each entry is what the app's "Copy alert criteria" button produces)
//   DIGEST_SALT      any random string; used to hash emails in the public state file
//   SITE_URL         your GitHub Pages URL (for links back to the app)
//   ALERT_REPLY_TO   optional reply-to / unsubscribe contact
// Env:     DIGEST_MIN_HOURS  minimum hours between emails per subscriber (default 20 = one email a day;
//                            unsent matches roll into the next email). DIGEST_FORCE=1 ignores it (manual runs).
// Flags: --dry  build emails into collector/out/ without sending
import { readJobs } from './lib/jobstore.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateJob, windowFor, csvList, reFromList, nyDate, TZ } from '../assets/shared/core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = async (p, fb) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fb; } };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => n == null ? '?' : '$' + Math.round(n / 1000) + 'K';

export async function runDigest({ env = process.env, fetchImpl = globalThis.fetch, dataDir = join(ROOT, 'data'), outDir = join(ROOT, 'collector/out'), dry = process.argv.includes('--dry'), now = new Date() } = {}) {
  let subs;
  try { subs = JSON.parse(env.SUBSCRIBERS || '[]'); } catch { console.error('SUBSCRIBERS is not valid JSON'); return { sent: 0, error: 'bad_subscribers' }; }
  if (!subs.length) { console.log('digest: no subscribers configured; skipping'); return { sent: 0 }; }
  if (!dry && (!env.RESEND_API_KEY || !env.ALERT_FROM)) { console.log('digest: RESEND_API_KEY / ALERT_FROM not set; skipping'); return { sent: 0 }; }
  const salt = env.DIGEST_SALT || 'set-DIGEST_SALT';
  const jobs = (await readJobs(dataDir)).jobs;
  const reg = await readJSON(join(dataDir, 'sources.json'), { employers: [] });
  const empBy = new Map(reg.employers.map(e => [e.employer, e]));
  const empOf = j => empBy.get(j.employer) || empBy.get(String(j.employer).replace(/ \(AWS\)$/, '')) || null;
  const statePath = join(dataDir, 'digest-state.json');
  const state = await readJSON(statePath, { subscribers: {} });
  const results = [];
  for (const sub of subs) {
    if (!sub.email || !sub.crit) continue;
    const id = createHash('sha256').update(salt + sub.email.toLowerCase().trim()).digest('hex').slice(0, 16);
    const tz = sub.tz || TZ;
    const crit = { ...sub.crit, window: sub.crit.window === 'all' ? 'd7' : (sub.crit.window || 'd7') };
    const win = windowFor(crit.window, now, tz);
    const excl = reFromList(csvList(crit.exclude));
    const sent = new Set(state.subscribers[id]?.sent || []);
    const minH = Number(env.DIGEST_MIN_HOURS ?? 20), last = state.subscribers[id]?.last_sent;
    if (!env.DIGEST_FORCE && last && (now - new Date(last)) / 36e5 < minH) { results.push({ id, sent: false, count: 0, throttled: true }); continue; }
    const fresh = jobs.map(j => evaluateJob(j, { crit, emp: empOf(j), skillsOn: sub.skillsOn || [], custom: sub.custom || [], win, excl, tz }))
      .filter(m => m && !m.j.dup_of && !sent.has(m.j.uid))
      .sort((a, b) => (a.tier === 'starts' ? 0 : 1) - (b.tier === 'starts' ? 0 : 1) || b.score - a.score);
    if (!fresh.length && !env.DIGEST_SEND_EMPTY) { results.push({ id, sent: false, count: 0 }); continue; }
    const top = fresh.slice(0, 40);
    const html = renderEmail(top, fresh.length, crit, win, env, tz);
    const subject = `Cache Flow: ${fresh.length} new match${fresh.length === 1 ? '' : 'es'} (${top.filter(m => m.tier === 'starts').length} with base ≥ ${money(crit.minBase)})`;
    let ok = true;
    if (dry) { await mkdir(outDir, { recursive: true }); await writeFile(join(outDir, `digest-${id}.html`), html); }
    else {
      const r = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({ from: env.ALERT_FROM, to: [sub.email], subject, html, ...(env.ALERT_REPLY_TO ? { reply_to: env.ALERT_REPLY_TO } : {}) }) });
      ok = r.ok; if (!ok) console.error(`digest: send failed for subscriber ${id}: HTTP ${r.status}`);
    }
    if (ok) state.subscribers[id] = { last_sent: now.toISOString(), sent: [...sent, ...top.map(m => m.j.uid)].slice(-3000) };
    results.push({ id, sent: ok, count: fresh.length, subject });
  }
  state.updated = now.toISOString();
  if (!dry) await writeFile(statePath, JSON.stringify(state)); // contains hashed ids + public job ids only
  console.log(`digest: ${results.filter(r => r.sent).length}/${results.length} subscribers emailed`);
  return { results };
}

function renderEmail(ms, total, crit, win, env, tz) {
  const site = env.SITE_URL || '';
  const row = m => {
    const s = m.j.salary;
    const sal = !s ? 'Base not stated' : s.kind === 'ote_only' ? 'Only OTE stated (not base)' : `${s.kind === 'base' ? 'Base' : 'Salary'} ${money(s.min)}–${money(s.max)}`;
    const color = m.tier === 'starts' ? '#3bff9d' : m.tier === 'reaches' ? '#e8ff3b' : '#7f9bb0';
    const date = m.dt.d ? nyDate(new Date(m.dt.d), tz) : '';
    return `<tr><td style="padding:12px 14px;border-bottom:1px solid #12324a;border-left:3px solid ${color}">
      <a href="${esc(m.j.url)}" style="color:#d6f6ff;font:600 15px Arial,sans-serif;text-decoration:none">${esc(m.j.title)}</a>
      <div style="color:#00f0ff;font:12px Menlo,monospace;margin-top:3px">${esc(m.j.employer)} · ${esc((m.j.locations || [])[0] || m.j.workplace)}</div>
      <div style="color:${color};font:12px Menlo,monospace;margin-top:3px">${esc(sal)} · ${m.tier.toUpperCase()} · score ${m.score}</div>
      <div style="color:#7f9bb0;font:11px Menlo,monospace;margin-top:3px">${esc(date)} (${esc(m.dt.kind.replace(/_/g, ' '))}) · ${m.loc === 'remote_unknown' ? 'remote · state eligibility not stated' : esc(m.loc.replace('_', ' '))}${m.j.source_class === 'aggregator' ? ' · via aggregator' : ''}</div></td></tr>`;
  };
  return `<!doctype html><html><body style="margin:0;background:#05070d;padding:24px">
  <table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#0b1322;border:1px solid #12324a">
  <tr><td style="padding:18px 16px;border-bottom:1px solid #00f0ff55"><div style="color:#d6f6ff;font:700 18px Arial,sans-serif;letter-spacing:3px">CACHE<span style="color:#5fd0ff">//</span>FLOW</div>
  <div style="color:#7f9bb0;font:12px Menlo,monospace;margin-top:6px">${total} new match${total === 1 ? '' : 'es'} · window ${win.start} → ${win.end} · min base ${money(crit.minBase)} (OTE never counted)</div></td></tr>
  ${ms.map(row).join('')}
  ${total > ms.length ? `<tr><td style="padding:12px 14px;color:#7f9bb0;font:12px Menlo,monospace">+${total - ms.length} more in the app.</td></tr>` : ''}
  <tr><td style="padding:16px;color:#7f9bb0;font:11px Menlo,monospace;line-height:1.6">${site ? `<a href="${esc(site)}#matches" style="color:#00f0ff">Open Cache Flow</a> · ` : ''}You get this because you asked for Cache Flow alerts.
  To unsubscribe, reply ${env.ALERT_REPLY_TO ? `to ${esc(env.ALERT_REPLY_TO)} ` : ''}with "unsubscribe".</td></tr></table></body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) runDigest().catch(e => { console.error(e); process.exit(1); });
