// Decides whether a scheduled wake-up should collect. GitHub drops and delays cron runs, so the workflow
// wakes hourly and this checks: has the most recent slot (New York time) been collected yet?
// Writes run=true|false to $GITHUB_OUTPUT. NOW=<ISO time> overrides the clock for testing.
import fs from 'node:fs';
import { lastSlot } from './lib/slots.mjs';

const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const slot = lastSlot(now);
let run = false, why;
if (!slot) why = 'before the first slot today';
else {
  let last = 0;
  try { last = Date.parse(JSON.parse(fs.readFileSync('data/jobs.json', 'utf8')).generated_at) || 0; } catch {}
  run = last < slot.at.getTime();
  why = `${slot.hour}:00 ET slot ${run ? 'not yet collected' : 'already collected'} (last collection ${last ? new Date(last).toISOString() : 'never'})`;
}
console.log(`gate: ${run ? 'collect' : 'skip'} - ${why}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
