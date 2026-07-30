// Self-check for the Neon keep-alive window (shared/warehouse-hours.js).
// No DB, no network — run it anywhere: node scripts/regression-warehouse-hours.js
//
// This guards money: the window decides how many hours/day we pay Neon to stay
// awake. A silent off-by-one here (or a DST slip) is a bill, not a crash.

import assert from 'node:assert/strict';
import { withinWarehouseHours } from '../shared/warehouse-hours.js';

// Melbourne is UTC+10 (AEST, winter) and UTC+11 (AEDT, summer, ~Oct–Apr).
// Both are covered below so a DST bug can't hide.
const cases = [
  // ── AEST / winter (July) — Melbourne = UTC+10 ────────────────────────────
  // Wed 2026-07-29
  ['2026-07-28T20:29:00Z', false, 'Wed 06:29 — one minute before opening'],
  ['2026-07-28T20:30:00Z', true,  'Wed 06:30 — opens exactly on the boundary'],
  ['2026-07-29T00:00:00Z', true,  'Wed 10:00 — mid-morning'],
  ['2026-07-29T06:59:00Z', true,  'Wed 16:59 — last billable minute'],
  ['2026-07-29T07:00:00Z', false, 'Wed 17:00 — closes exactly on the boundary'],
  ['2026-07-29T12:00:00Z', false, 'Wed 22:00 — night'],
  ['2026-07-29T16:00:00Z', false, 'Thu 02:00 — middle of the night'],

  // ── Weekends are excluded even during working hours ──────────────────────
  ['2026-08-01T02:00:00Z', false, 'Sat 12:00 — weekend, must stay asleep'],
  ['2026-08-02T02:00:00Z', false, 'Sun 12:00 — weekend, must stay asleep'],
  ['2026-07-31T02:00:00Z', true,  'Fri 12:00 — last working day'],
  ['2026-08-03T02:00:00Z', true,  'Mon 12:00 — first working day'],

  // ── AEDT / summer (January) — Melbourne = UTC+11 ─────────────────────────
  // Thu 2027-01-14
  ['2027-01-13T19:29:00Z', false, 'Thu 06:29 AEDT — before opening (DST)'],
  ['2027-01-13T19:30:00Z', true,  'Thu 06:30 AEDT — opens (DST)'],
  ['2027-01-14T05:59:00Z', true,  'Thu 16:59 AEDT — last minute (DST)'],
  ['2027-01-14T06:00:00Z', false, 'Thu 17:00 AEDT — closes (DST)'],
  ['2027-01-16T01:00:00Z', false, 'Sat 12:00 AEDT — weekend (DST)'],
];

let failed = 0;
for (const [iso, expected, label] of cases) {
  const actual = withinWarehouseHours(new Date(iso));
  if (actual === expected) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label} — expected ${expected}, got ${actual}  (${iso})`);
    failed++;
  }
}

// Midnight is the classic trap: 'hour12:false' renders it as "24" in some
// locales, which would make minuteOfDay 1440 and could flip the comparison.
assert.equal(withinWarehouseHours(new Date('2026-07-28T14:00:00Z')), false,
  'Wed 00:00 Melbourne must be outside the window');

console.log(
  failed === 0
    ? `\n✅ warehouse-hours: ${cases.length + 1}/${cases.length + 1} passed`
    : `\n❌ warehouse-hours: ${failed} failed`
);
process.exit(failed === 0 ? 0 : 1);
