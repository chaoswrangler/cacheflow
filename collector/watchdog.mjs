// Watchdog: checks that the most recent collection slot was collected. If it wasn't, and no collection is running,
// it starts one (workflow_dispatch). When it finds a missed slot or a failed collection run, the watchdog run itself
// ends as failed, so GitHub's own failed-run notification reaches the repo owner. No email service is involved.
// Runs from .github/workflows/watchdog.yml at :47 past each hour.
import fs from 'node:fs';
import { lastSlot } from './lib/slots.mjs';

export const GRACE_MIN = 75; // GitHub's scheduled runs are often late; don't alarm before this
// Pure decision, for tests. runs: recent collect.yml runs [{ status, conclusion, created_at, updated_at, html_url, event }]
export function decide({ now, lastCollected, runs = [] }) {
  const slot = lastSlot(now);
  if (!slot) return { action: 'none', why: 'before the first slot today' };
  const label = `${slot.hour}:00 ET`;
  if (lastCollected && lastCollected >= slot.at) return { action: 'none', why: `${label} slot collected at ${lastCollected.toISOString()}` };
  const sinceSlotMin = (now - slot.at) / 60000;
  if (sinceSlotMin < GRACE_MIN) return { action: 'none', why: `${label} slot not collected yet, still within the ${GRACE_MIN}-minute grace period` };
  const after = runs.filter(r => new Date(r.created_at) >= slot.at);
  const active = after.find(r => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(r.status));
  if (active) return { action: 'none', why: `${label} collection is running (${active.html_url})` };
  const failed = after.filter(r => r.status === 'completed' && r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped');
  const recentFail = failed.find(r => (now - new Date(r.updated_at)) / 60000 <= 65); // the previous check would have caught older ones
  if (recentFail) return { action: 'alert', slot: label, why: `the ${label} collection run ended with "${recentFail.conclusion}"`, url: recentFail.html_url, dispatch: false };
  if (failed.length) return { action: 'none', why: `${label} failure already reported` };
  const dispatched = after.some(r => r.event === 'workflow_dispatch');
  if (dispatched) return { action: 'none', why: `a ${label} catch-up run already ran; data not newer (it may have found no changes)` };
  return { action: 'alert', slot: label, why: `no collection ran for the ${label} slot (${Math.round(sinceSlotMin)} minutes ago)`, dispatch: true };
}

async function main() {
  const env = process.env, repo = env.GITHUB_REPOSITORY, token = env.GH_TOKEN;
  const now = env.NOW ? new Date(env.NOW) : new Date();
  let lastCollected = null;
  try { lastCollected = new Date(JSON.parse(fs.readFileSync('data/jobs.json', 'utf8')).generated_at); } catch {}
  const api = (path, opt = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, { ...opt, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(opt.headers || {}) } });
  let runs = [];
  try { const r = await api('/actions/workflows/collect.yml/runs?per_page=15'); runs = (await r.json()).workflow_runs || []; } catch (e) { console.log('watchdog: could not list runs:', e.message); }
  const d = decide({ now, lastCollected, runs });
  console.log(`watchdog: ${d.action} - ${d.why}`);
  if (d.action !== 'alert') return;
  let started = '';
  if (d.dispatch) {
    const r = await api('/actions/workflows/collect.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: env.GITHUB_REF_NAME || 'main', inputs: { send_digest: 'true' } }) });
    started = r.status === 204 ? 'A catch-up collection has been started automatically.' : `Starting a catch-up collection failed (HTTP ${r.status}); start one from Actions → Collect jobs → Run workflow.`;
    console.log('watchdog:', started);
  }
  // end the run as failed so GitHub's failed-run notification goes out, with the reason in the log
  console.log(`::error title=Cache Flow collector::${d.why}. ${started}${d.url ? ` Failed run: ${d.url}` : ''}`);
  process.exitCode = 1;
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.log('watchdog error:', e.message); process.exitCode = 1; });
