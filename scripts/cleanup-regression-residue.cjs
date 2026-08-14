// Removes what regression-sm.js and regression-d16-makeorder.cjs leave behind
// in the live database, and puts their fixture balances back.
//
// WHY THIS EXISTS (2026-08-14). Those two suites are the only regressions that
// need an already-running server, so they are run by hand and rarely. They
// create real rows and do not tear them down: two "TEST" masters, two
// production orders, a test client, and stock drift on the shared fixtures.
// Running them today left 456 live MUSE finished goods where there were 454.
//
// The business_unit rule added the same day caught it within hours — the two
// TEST masters had no unit, so integrity-sm went 34/0 to 33/1. That is the
// check working, not a reason to leave the rows there.
//
// WHY NOT cleanup-sm-test-data.cjs. That script's scope was locked on
// 2026-07-30, when every production order in the system was test data. It is
// now dangerous: it deletes ALL production orders, which today includes SM-001
// (#1020) and SM-002 (#1021, a real customer order), and it deletes DIF_00001,
// which has since become the Aere Diffuser. It must not be run again as-is.
//
// This one is deliberately narrow: named codes, named client, and orders that
// have NO Shopify order number — a real order always carries one, so an order
// from the store can never be caught by this even by accident.
//
// Idempotent. Dry run by default.
//
// Run:  node scripts/cleanup-regression-residue.cjs           (dry run)
//       node scripts/cleanup-regression-residue.cjs --apply
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const TEST_MASTERS = ['RD200_TEST', 'CANDLE_240G', 'MAJ_RD200_TEST'];
const TEST_CLIENTS = ['[regression] Coco Republic Test', 'Fabricio Test'];
// What the fixtures read before the suites ran, measured 2026-08-14.
const FIXTURE_BASELINE = { 'CMP-RB200': 4620, 'CMP-RLID': 4620, 'RM-ETHANOL': 43000 };

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});
const log = (s = '') => console.log(s);

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (t, p) => client.query(t, p);

    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — clear regression residue\n`);

    // ── The guard that makes this safe ────────────────────────────────────
    // A real order carries a Shopify number. Anything without one and created
    // by nobody is a script's work. This is asserted, not assumed: if a row
    // with a Shopify number ever matched, the run stops.
    // shopify_order_id as well as the number: webhooks.js writes `body.name ||
    // null`, so a real order can carry an id and no display number.
    const orders = (await q(
      `SELECT id, order_number, status, shopify_order_number, shopify_order_id FROM production_orders
        WHERE shopify_order_id IS NULL AND shopify_order_number IS NULL AND created_by IS NULL
          AND EXISTS (SELECT 1 FROM production_order_lines l
                       WHERE l.production_order_id = production_orders.id
                         AND l.product_type = ANY($1::text[]))`, [TEST_MASTERS])).rows;
    if (orders.some((o) => o.shopify_order_number || o.shopify_order_id)) {
      throw new Error('an order that came from the store matched — refusing to continue');
    }
    log(`  orders to delete   ${orders.length ? orders.map((o) => o.order_number).join(', ') : '(none)'}`);

    // Show what survives, so the blast radius is visible before committing.
    const keep = (await q(
      `SELECT order_number, status, shopify_order_number FROM production_orders
        WHERE id <> ALL($1::int[]) ORDER BY id`, [orders.map((o) => o.id)])).rows;
    log(`  orders kept        ${keep.map((o) => `${o.order_number}(${o.shopify_order_number || 'no store ref'})`).join(', ') || '(none)'}`);

    if (orders.length) {
      // transactions is ON DELETE SET NULL, so its rows survive the cascade and
      // keep the history. Only the orders themselves go.
      const del = await q(`DELETE FROM production_orders WHERE id = ANY($1::int[])`,
        [orders.map((o) => o.id)]);
      log(`  deleted            ${del.rowCount} order(s) + cascaded lines, components, reservations, jobs`);
    }

    // ── The TEST masters ──────────────────────────────────────────────────
    const masters = await q(
      `UPDATE products SET archived = true
        WHERE product_code = ANY($1::text[]) AND COALESCE(archived,false) = false
        RETURNING product_code`, [TEST_MASTERS]);
    log(`  masters archived   ${masters.rowCount ? masters.rows.map((r) => r.product_code).join(', ') : '(already done)'}`);

    // ── The test client ───────────────────────────────────────────────────
    const cl = await q(`DELETE FROM clients WHERE name = ANY($1::text[]) RETURNING name`,
      [TEST_CLIENTS]);
    log(`  clients deleted    ${cl.rowCount ? cl.rows.map((r) => r.name).join(', ') : '(none)'}`);

    // ── Fixture balances ──────────────────────────────────────────────────
    // Restoring the number without a transaction row would be a silent edit, so
    // the correction is written into the ledger like any other movement.
    for (const [code, want] of Object.entries(FIXTURE_BASELINE)) {
      const r = (await q(`SELECT id, current_stock::float s, unit FROM products WHERE product_code = $1`, [code])).rows[0];
      if (!r) { log(`  fixture ${code.padEnd(12)} not found`); continue; }
      if (r.s === want) { log(`  fixture ${code.padEnd(12)} already ${want}`); continue; }
      const diff = want - r.s;
      await q(`UPDATE products SET current_stock = $1 WHERE id = $2`, [want, r.id]);
      await q(
        `INSERT INTO transactions (product_id, product_name, product_code, type, quantity, unit, balance_after, notes, user_id)
         VALUES ($1, $2, $3, 'adjust', $4, $5, $6, $7, NULL)`,
        [r.id, code, code, Math.abs(diff), r.unit, want,
         `Restore after regression run (${r.s} → ${want}) — scripts/cleanup-regression-residue.cjs`]);
      log(`  fixture ${code.padEnd(12)} ${r.s} → ${want}  (${diff > 0 ? '+' : ''}${diff}, ledger row written)`);
    }

    // ── Result ────────────────────────────────────────────────────────────
    const live = (await q(
      `SELECT count(*) c FROM products WHERE segment='MUSE' AND category='FINISHED_GOOD'
        AND COALESCE(archived,false) = false`)).rows[0].c;
    const noUnit = (await q(
      `SELECT count(*) c FROM products WHERE segment='MUSE' AND category='FINISHED_GOOD'
        AND COALESCE(archived,false) = false AND business_unit IS NULL`)).rows[0].c;
    log(`\n  live MUSE finished goods   ${live}   (454 is the real catalogue)`);
    log(`  ...without a business_unit ${noUnit}   (must be 0)`);

    if (APPLY) { await client.query('COMMIT'); log('\n✅ committed\n'); }
    else { await client.query('ROLLBACK'); log('\n↩  rolled back — re-run with --apply to keep it\n'); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ rolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
