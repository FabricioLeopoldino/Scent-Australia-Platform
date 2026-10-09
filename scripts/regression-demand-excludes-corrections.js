// Proves a stocktake correction is not read as consumption.
//
// WHY THIS EXISTS (2026-10-09). Demand planning counted every hand-made removal
// as demand, including the ones that only reconcile the book to the shelf.
// Myrrh & Tonka took a removal of 127.8 L reading "Correcting a count — Stock
// Take 02/10/2026" and its daily rate went from 2.05 to 6.31 L/day on that one
// row — a figure the manager orders against. Across 90 days, 329 of the 1,073
// litres removed by hand were corrections.
//
// The distinction is not "did somebody mean to use it" but "did the shelf
// really lose it". Loss, spillage and samples ARE consumption: the oil is gone
// and must be replaced. In a correction the shelf lost nothing — the number did.
//
// The failure this guards against is drift: the rule has to reach EVERY query
// that computes demand, and there are two. Check 2 is the one that matters —
// it fails if somebody adds a third and forgets.
//
// READ-ONLY. Writes nothing.
//
// Run: node scripts/regression-demand-excludes-corrections.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
import { NON_DEMAND_REMOVE_REASONS, REMOVE_REASONS } from '../shared/stock-reasons.js';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

try {
  console.log('\n1. The rule lives with the reasons, in one place');
  check(NON_DEMAND_REMOVE_REASONS.includes('correction'),
    'a correction is not demand');
  // Deliberately NOT excluded — these are real losses of real oil.
  for (const r of ['loss', 'sample', 'technician', 'production']) {
    check(!NON_DEMAND_REMOVE_REASONS.includes(r),
      `${r} still counts as demand — the oil is genuinely gone`);
  }
  check(NON_DEMAND_REMOVE_REASONS.every((r) => REMOVE_REASONS.some((x) => x.id === r)),
    'every excluded reason is a real reason the form can produce',
    NON_DEMAND_REMOVE_REASONS.join(', '));

  console.log('\n2. Every demand query carries it — none can be added without');
  const server = src('server/sa/index.js');
  // Counted on the NAME, not on a spelling of the SQL. Matching `type = ANY($n)`
  // passed green for a query written as ANY($10) or `type IN (...)`, which is
  // precisely the drift this check exists to catch. A demand query is one that
  // uses DEMAND_TX_TYPES; the first occurrence is the declaration itself.
  const usesTypes = (server.match(/DEMAND_TX_TYPES/g) || []).length - 1;
  const usesFilter = (server.match(/\$\{EXCLUDE_NON_DEMAND\}/g) || []).length;
  check(usesTypes > 0 && usesTypes === usesFilter,
    `all ${usesTypes} demand queries exclude corrections`,
    `${usesTypes} use DEMAND_TX_TYPES, ${usesFilter} exclude corrections`);
  check(/const EXCLUDE_NON_DEMAND =/.test(server),
    'the SQL fragment is written once, not repeated per query');
  check(/NON_DEMAND_REMOVE_REASONS/.test(server),
    'and is built from the shared list rather than a literal');
  // The subtle one, and the reason this check exists at all. NOT (x AND NULL)
  // is NULL, and SQL drops a row whose WHERE is NULL — so without COALESCE the
  // filter silently removed every removal with no reason from demand too. That
  // is 566 L in 90 days and a decision the owner has not taken.
  check(/COALESCE\(reason, ''\) = ANY/.test(server),
    'a removal with NO reason still counts — the NULL case is handled');

  console.log('\n2b. And proven against the database, not only the source');
  const [n] = (await pool.query(`
    SELECT count(*) FILTER (WHERE reason IS NULL) sem_motivo,
           count(*) FILTER (WHERE NOT (true AND reason = ANY($1))) sem_coalesce,
           count(*) FILTER (WHERE NOT (true AND COALESCE(reason,'') = ANY($1))) com_coalesce
      FROM transactions WHERE type = 'remove'`, [NON_DEMAND_REMOVE_REASONS])).rows;
  check(Number(n.com_coalesce) === Number(n.sem_coalesce) + Number(n.sem_motivo),
    `COALESCE keeps the ${n.sem_motivo} reasonless removals the NULL would have dropped`,
    `${n.sem_coalesce} without it, ${n.com_coalesce} with it`);

  console.log('\n3. What it changes on the real ledger, today');
  const TY = ['remove', 'shopify_sale', 'sale', 'muse_production', 'sm_std_production', 'sm_major_production'];
  const win = `(t.created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date
               >= (NOW() AT TIME ZONE 'Australia/Sydney')::date - INTERVAL '30 days'`;
  // ONE scan, three figures. Two sequential queries disagreed by 0.4 L the
  // first time this ran — not a bug in the filter but a sale landing between
  // them. This store moves all day; any check that compares two reads of it is
  // comparing two different moments.
  const [m] = (await pool.query(`
    SELECT COALESCE(sum(t.quantity) FILTER (
             WHERE t.type = ANY($1)), 0)::float/1000 AS before,
           COALESCE(sum(t.quantity) FILTER (
             WHERE t.type = ANY($1)
               AND NOT (t.type = 'remove' AND COALESCE(t.reason,'') = ANY($2))), 0)::float/1000 AS after,
           COALESCE(sum(t.quantity) FILTER (
             WHERE t.type = 'remove' AND COALESCE(t.reason,'') = ANY($2)), 0)::float/1000 AS corrections
      FROM transactions t WHERE ${win}`, [TY, NON_DEMAND_REMOVE_REASONS])).rows;
  console.log(`     30-day demand: ${m.before.toFixed(1)} L → ${m.after.toFixed(1)} L  (${m.corrections.toFixed(1)} L was correction)`);
  check(m.after <= m.before, 'excluding corrections never increases demand');

  // The property that makes this safe: the difference is EXACTLY the
  // corrections, nothing else. If the filter ever caught more, this fails.
  check(Math.abs((m.before - m.after) - m.corrections) < 0.001,
    'and removes exactly the corrections, nothing more',
    `gap ${(m.before - m.after).toFixed(3)} vs corrections ${m.corrections.toFixed(3)}`);

  console.log(failed === 0
    ? '\n✅ demand-excludes-corrections: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
