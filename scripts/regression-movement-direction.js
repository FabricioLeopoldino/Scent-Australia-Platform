// Proves the History page says which way stock went, and says it truthfully.
//
// WHY THIS EXISTS (2026-08-19). The page printed "+" whenever quantity was
// greater than zero, in green — and quantity is stored as a MAGNITUDE, with
// direction living in the type. Every sale therefore read as an addition: a
// 400 mL outbound showed as "+400 mL". The owner found it while trying to use
// the page as an audit source, which is exactly what it is for.
//
// The map is DERIVED from production, so the important check here is that it
// still agrees with production. A hand-maintained list of types rots the moment
// somebody adds one, and a rotted map is worse than none: it states a direction
// confidently and wrongly.
//
// Read-only. No server, no writes.
//
// Run: node scripts/regression-movement-direction.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;
import { directionOf, DIRECTION_SQL, IN, OUT, NEUTRAL } from '../server/platform/movement-direction.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const mk = (schema) => new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: `-c search_path=${schema},public`,
});

console.log('\n1. The rule is stated once, and the screen does not second-guess it');
const page = readFileSync(join(ROOT, 'src/sm/pages/HistoryActivity.jsx'), 'utf8');
check(/r\.direction === 'out'/.test(page), 'the page colours and signs from r.direction');
// The exact expression that caused the defect.
check(!/Number\(r\.quantity\)\s*>\s*0\s*\?\s*'\+'/.test(page),
  'it no longer infers a direction from the sign of a magnitude');
check(!/color:\s*Number\(r\.quantity\)\s*<\s*0/.test(page),
  'and no longer colours by that sign either');
check(/'Balance after'/.test(page),
  'the column says "Balance after", not "Balance" — it is the balance at that moment');

console.log('\n2. Nothing has a direction it did not earn');
check(![...IN].some((t) => OUT.has(t)), 'no type is both in and out');
check(![...NEUTRAL].some((t) => IN.has(t) || OUT.has(t)), 'and nothing neutral is also decided');
check(directionOf('adjust') === null,
  'an adjustment stays neutral — it is bidirectional by definition, whatever the sample says');
check(directionOf('a type nobody has invented yet') === null,
  'an unknown type claims nothing rather than guessing');

console.log('\n3. The map still agrees with what the balances actually do');
// The check that stops it rotting: re-derive from live data and compare.
const disagreed = [];
const unmapped = [];
for (const schema of ['sa', 'sm']) {
  const pool = mk(schema);
  try {
    const rows = (await pool.query(`
      WITH d AS (SELECT type, balance_after::float
                   - lag(balance_after::float) OVER (PARTITION BY product_code ORDER BY created_at, id) AS delta
                   FROM transactions)
      SELECT type, count(*) FILTER (WHERE delta > 0) up, count(*) FILTER (WHERE delta < 0) down
        FROM d GROUP BY 1`)).rows;
    for (const r of rows) {
      const up = Number(r.up), down = Number(r.down), tot = up + down;
      const claimed = directionOf(r.type);
      if (!tot) continue;                       // only ever a first movement; nothing to learn
      if (!claimed) { if (!NEUTRAL.has(r.type)) unmapped.push(`${schema}.${r.type}`); continue; }
      const observed = up > down ? 'in' : 'out';
      const confidence = Math.max(up, down) / tot;
      if (claimed !== observed && confidence >= 0.9) {
        disagreed.push(`${schema}.${r.type}: map says ${claimed}, data says ${observed} (${Math.round(confidence * 100)}%)`);
      }
    }
  } finally { await pool.end(); }
}
check(disagreed.length === 0, 'no type moves the opposite way to what the map claims', disagreed.join('; '));
// Not a failure: a new type appearing is information, not a fault. It just must
// not silently acquire a direction.
if (unmapped.length) console.log(`  ··    ${unmapped.length} type(s) not in the map, rendering neutral: ${unmapped.join(', ')}`);

console.log('\n4. The SQL and the JavaScript answer the same question');
{
  const pool = mk('sa');
  try {
    const rows = (await pool.query(
      `SELECT DISTINCT t.type, ${DIRECTION_SQL()} AS direction FROM transactions t`)).rows;
    const clash = rows.filter((r) => (r.direction || null) !== directionOf(r.type));
    check(clash.length === 0, 'every type resolves identically in SQL and in code',
      clash.map((c) => `${c.type}: sql=${c.direction} js=${directionOf(c.type)}`).join('; '));
    check(rows.length > 0, `checked against every type in use (${rows.length})`);
  } finally { await pool.end(); }
}

console.log(failed === 0 ? '\n✅ movement-direction: all checks passed' : `\n❌ ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
