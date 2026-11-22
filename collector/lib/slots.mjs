// Collection slots in New York time, shared by the gate (should this wake-up collect?) and the watchdog
// (did the last slot get collected?).
export const SLOTS = { weekday: [6, 10, 14, 18], weekend: [6, 10, 14, 18] };
// The most recent slot at or before `now`, as a Date, or null before today's first slot.
export function lastSlot(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(now).map(x => [x.type, x.value]));
  const hour = +p.hour, weekend = p.weekday === 'Sat' || p.weekday === 'Sun';
  const due = (weekend ? SLOTS.weekend : SLOTS.weekday).filter(h => h <= hour);
  if (!due.length) return null;
  const slotH = Math.max(...due);
  return { at: new Date(now.getTime() - (((hour - slotH) * 60 + +p.minute) * 60 + +p.second) * 1000), hour: slotH };
}
