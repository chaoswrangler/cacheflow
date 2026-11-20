// Decides whether a scheduled wake-up should collect. GitHub drops and delays cron runs, so the workflow
// wakes hourly and this checks: has the most recent slot (New York time) been collected yet?
// Writes run=true|false to $GITHUB_OUTPUT. NOW=<ISO time> overrides the clock for testing.
import fs from 'node:fs';

const SLOTS = { weekday: [6, 10, 14, 18], weekend: [10] }; // hours, America/New_York
const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
}).formatToParts(now).map(x => [x.type, x.value]));
const hour = +p.hour, weekend = p.weekday === 'Sat' || p.weekday === 'Sun';
const due = (weekend ? SLOTS.weekend : SLOTS.weekday).filter(h => h <= hour);

let run = false, why;
if (!due.length) why = 'before the first slot today';
else {
  const slotH = Math.max(...due);
  const slot = new Date(now.getTime() - (((hour - slotH) * 60 + +p.minute) * 60 + +p.second) * 1000);
  let last = 0;
  try { last = Date.parse(JSON.parse(fs.readFileSync('data/jobs.json', 'utf8')).generated_at) || 0; } catch {}
  run = last < slot.getTime();
  why = `${slotH}:00 ET slot ${run ? 'not yet collected' : 'already collected'} (last collection ${last ? new Date(last).toISOString() : 'never'})`;
}
console.log(`gate: ${run ? 'collect' : 'skip'} - ${why}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
