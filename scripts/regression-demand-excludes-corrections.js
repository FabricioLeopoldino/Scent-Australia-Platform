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
import { NON_DEMAND_REMOVE_REASONS, UNPATTERNED_REMOVE_REASONS, REMOVE_REASONS } from '../shared/stock-reasons.js';
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
  // filter silently removed every removal with no reason from demand too. The
  // owner has since decided those (2026-10-12) — and the decision lives in its
  // own rule, UNPATTERNED_REMOVAL, checked in section 5. The correction rule
  // must still never take it by accident, which is what this guards.
  check(/COALESCE\(reason, ''\) = ANY/.test(server),
    'the correction rule does not catch a removal with NO reason by accident — the NULL case is handled (no-reason is ruled out on purpose, by its own rule)');

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

  console.log('\n4. Technician refills of contracted oils are not sales (step 3, 2026-10-12)');
  const composed = server.slice(server.indexOf('const EXCLUDE_NON_DEMAND'), server.indexOf('const ALLOWED_MIME_TYPES'));
  check(['EXCLUDE_CORRECTIONS', 'TECHNICIAN_REFILL', 'REVERSED_SALE', 'UNPATTERNED_REMOVAL', 'ONE_OFF_ORDER']
    .every((n) => composed.includes('${' + n + '}')),
    'the demand filter carries every rule, so every demand query gets all of them');
  const refill = server.slice(server.indexOf('const TECHNICIAN_REFILL'), server.indexOf('// A sale that was later cancelled'));
  check(!/\bIN\s*\(/.test(refill) && (refill.match(/EXISTS/g) || []).length === 2,
    'written with EXISTS, never IN — IN can return NULL and drop the row');
  check(/forecast_120_days > 0/.test(refill) && /MAX\(import_date\)/.test(refill),
    'only on oils with a contract figure in the LATEST forecast');

  // Proven on the real ledger inside a transaction that is rolled back: the
  // cache is filled from Shopify, the filter is measured, nothing is kept.
  const before = (await pool.query(`SELECT COUNT(*)::int n FROM shopify_order_actor`)).rows[0].n;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { refreshOrderActors } = await import('../server/sa/shopify-order-actors.js');
    const cached = await refreshOrderActors(client);
    const block = server.slice(server.indexOf('const sqlTextArray'), server.indexOf('const ALLOWED_MIME_TYPES'));
    const frag = new Function('NON_DEMAND_REMOVE_REASONS', 'UNPATTERNED_REMOVE_REASONS',
      `${block}; return [EXCLUDE_CORRECTIONS, TECHNICIAN_REFILL, EXCLUDE_NON_DEMAND, REVERSED_SALE, UNPATTERNED_REMOVAL, ONE_OFF_ORDER];`);
    const [EC, TR, END, RS, UR, OO] = frag(NON_DEMAND_REMOVE_REASONS, UNPATTERNED_REMOVE_REASONS);
    const w = `(created_at::timestamptz AT TIME ZONE 'Australia/Sydney')::date
               >= (NOW() AT TIME ZONE 'Australia/Sydney')::date - INTERVAL '30 days'`;
    const [t] = (await client.query(`
      SELECT COALESCE(sum(quantity) FILTER (WHERE true ${EC}), 0)::float/1000 AS no_corr,
             COALESCE(sum(quantity) FILTER (WHERE true ${END}), 0)::float/1000 AS demand,
             COALESCE(sum(quantity) FILTER (WHERE ${TR}), 0)::float/1000 AS refills,
             COALESCE(sum(quantity) FILTER (WHERE true ${EC} AND (${TR} OR ${RS} OR ${UR} OR ${OO})), 0)::float/1000 AS ruled_out
        FROM transactions WHERE type = ANY($1) AND ${w}`, [TY])).rows;
    console.log(`     ${cached} orders read · 30-day demand ${t.no_corr.toFixed(1)} L → ${t.demand.toFixed(1)} L (${t.refills.toFixed(1)} L technician refills, ${(t.ruled_out - t.refills).toFixed(1)} L more by the step 2 rules)`);
    // The read is incremental, so it may legitimately bring 0 new orders; what
    // must hold is that the cache it leaves is not empty, or the technician
    // rule above measured nothing and still passed.
    const [cacheRows] = (await client.query(`SELECT COUNT(*)::int n FROM shopify_order_actor`)).rows;
    check(cacheRows.n > 0, `the order cache is populated (${cacheRows.n} orders, ${cached} read just now)`);
    check(Math.abs((t.no_corr - t.demand) - t.ruled_out) < 0.001,
      'and removes exactly what the rules name, nothing more');

    console.log('\n5. Step 2: what is real but not a pattern stays out of the rate (2026-10-12)');
    // A cancelled fulfilment is not a sale: for every order and oil, what
    // demand counts equals what was finally shipped. #38367 was fulfilled
    // three times and cancelled twice — 6 L, not 18. Measured over each order's
    // WHOLE life (any order touched in the window), so a sale just before the
    // window and its reversal just inside it are judged together. Both
    // directions: over-counting inflates, under-counting empties a shelf.
    const pairs = (await client.query(`
      SELECT shopify_order_id o,
             COALESCE(SUM(quantity) FILTER (WHERE type = 'shopify_sale' AND NOT ${RS}), 0) counted,
             GREATEST(SUM(CASE WHEN type = 'shopify_sale' THEN quantity ELSE -quantity END), 0) net
        FROM transactions
       WHERE type IN ('shopify_sale', 'shopify_reversal')
         AND shopify_order_id IN (SELECT shopify_order_id FROM transactions
                                   WHERE shopify_order_id IS NOT NULL AND ${w})
       GROUP BY shopify_order_id, product_id`)).rows.map((r) => ({ o: r.o, counted: +r.counted, net: +r.net }));
    const over = pairs.filter((r) => r.counted > r.net + 1);
    const under = pairs.filter((r) => r.counted < r.net - 1);
    check(over.length === 0, `a cancelled fulfilment never counts as a sale (${pairs.length} order lines)`,
      over.slice(0, 3).map((r) => `${r.o}: counts ${r.counted} of ${r.net}`).join(' | '));
    check(under.length === 0, 'and a real shipment is never dropped with it',
      under.slice(0, 3).map((r) => `${r.o}: counts ${r.counted} of ${r.net}`).join(' | '));
    const [u] = (await client.query(`SELECT COUNT(*)::int n FROM transactions
       WHERE type = 'remove' AND COALESCE(reason, '') = ANY($1) AND ${w} ${END}`, [UNPATTERNED_REMOVE_REASONS])).rows;
    check(u.n === 0, 'no removal marked other, or with no reason, reaches the rate', `${u.n} do`);
    const [k1] = (await client.query(`SELECT COUNT(*)::int n FROM transactions
       WHERE type = 'shopify_sale' AND ${w} AND ${OO} ${END}`)).rows;
    check(k1.n === 0, 'no order of 15 L or more of one oil reaches the rate', `${k1.n} do`);
    // Loss, samples, technician service and production are real consumption
    // and must still count — the rule is about pattern, not about removals.
    check(['loss', 'sample', 'technician', 'production'].every((r) => !UNPATTERNED_REMOVE_REASONS.includes(r)),
      'loss, samples, technician service and production still count');
    // A technician buying an oil with no contract stays in demand.
    const [k] = (await client.query(`
      SELECT COUNT(*)::int n FROM transactions
       WHERE type = 'shopify_sale' AND ${w} AND NOT ${TR}
         AND EXISTS (SELECT 1 FROM shopify_order_actor o JOIN demand_internal_actors a
                       ON lower(btrim(a.customer_name)) = lower(btrim(o.customer_name)) WHERE o.order_number = transactions.shopify_order_id)`)).rows;
    console.log(`     ${k.n} technician order lines on products with no contract stay counted`);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const [left] = (await pool.query(`SELECT COUNT(*)::int n FROM shopify_order_actor`)).rows;
  check(left.n === before, `rolled back — the cache holds ${left.n} rows, as it did before`);

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
