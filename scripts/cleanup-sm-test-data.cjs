#!/usr/bin/env node
/*
 * Clean the SM/MUSE test data (owner-approved 2026-07-30).
 *
 * WHY: every production order in `sm` is test/construction data — the survey found
 * 63 orders, all belonging to test clients ("Fabricio Test", "[regression] Coco
 * Republic Test") or created by regression scripts (created_by NULL). There is no
 * real order in the system. Owner: "são testes, prefiro que apague".
 *
 * SCOPE (owner decisions, locked):
 *   1. All 63 production orders + everything that cascades from them
 *      (lines, jobs, components, reservations, packing_records, shipping_labels,
 *      dashboard_alerts) + their linked transactions.
 *   2. Test registrations: masters RD200_TEST / CANDLE_240G / MAJ_RD200_TEST,
 *      their variants (Muse_RDTEST00001, Muse_CANDLEG00001), the "Test Diffuser",
 *      and the test clients "Fabricio Test" + "[regression] Coco Republic Test".
 *      KEPT: RD200, RS100, TS10 (the real 124-variant MUSE catalog), MC00001,
 *      CS00001, CS00002, and the client "Lucia Tse".
 *   3. Stock balances are NOT recalculated — owner will reconcile by physical
 *      count. Deleting transactions does not alter products.current_stock (a
 *      stored column), so balances are untouched by design. Releasing the 207
 *      reservations DOES free up available stock, which is intended.
 *
 * NOT deleted (reported instead, needs a separate owner decision): transactions
 * with no production_order_id — manual adjustments, transfers, shopify test
 * sales. They aren't part of "delete these orders".
 *
 * SAFETY: refuses to run without CLEANUP_DATABASE_URL; dry-run by default
 * (BEGIN…ROLLBACK); --commit to apply; every assert must pass or it rolls back.
 */
const { Pool } = require('pg');

const COMMIT = process.argv.includes('--commit');
const DB = process.env.CLEANUP_DATABASE_URL;
if (!DB) {
  console.error('REFUSING TO RUN: set CLEANUP_DATABASE_URL to the target.');
  process.exit(2);
}

// MC00001 ("Coco Republic Calabria Candle 240g") is deleted too (owner, 2026-07-30):
// it hangs off the test client "[regression] Coco Republic Test", and a MAJOR master
// with no client is invalid (the create endpoint refuses one). Owner chose the clean
// slate — re-register Coco Republic and its product properly later.
const TEST_MASTER_CODES = ['RD200_TEST', 'CANDLE_240G', 'MAJ_RD200_TEST', 'MC00001'];
const TEST_VARIANT_SKUS = ['Muse_RDTEST00001', 'Muse_CANDLEG00001'];
const TEST_OTHER_CODES = ['DIF_00001'];                       // "Test Diffuser"
const TEST_CLIENT_NAMES = ['Fabricio Test', '[regression] Coco Republic Test'];
// The real MUSE catalog + the STANDARD templates — must survive untouched.
const KEEP_MASTERS = ['RD200', 'RS100', 'TS10', 'CS00001', 'CS00002'];

function fail(msg) { console.error('  FAIL - ' + msg); throw new Error(msg); }
function ok(msg) { console.log('  ok   - ' + msg); }

(async () => {
  const pool = new Pool({ connectionString: DB.replace('-pooler', ''), ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public' });
  const client = await pool.connect();
  try {
    console.log(`\nSM/MUSE test-data cleanup — ${COMMIT ? 'COMMIT' : 'DRY-RUN'}  (${DB.replace(/:[^:@/]+@/, ':***@')})\n`);

    // ── Pre-flight ────────────────────────────────────────────────────────
    console.log('Pre-flight:');
    const orders = (await client.query('SELECT id, order_number, client_id, created_by FROM production_orders')).rows;
    ok(`${orders.length} production orders found`);

    // Prove no order belongs to a non-test client (nothing real gets deleted).
    const realClientOrders = (await client.query(
      `SELECT po.id, po.order_number, c.name FROM production_orders po
       JOIN clients c ON c.id = po.client_id
       WHERE c.name <> ALL($1)`, [TEST_CLIENT_NAMES]
    )).rows;
    if (realClientOrders.length) {
      realClientOrders.forEach(r => console.error(`      order ${r.order_number} belongs to non-test client "${r.name}"`));
      fail(`${realClientOrders.length} order(s) belong to a client that is NOT in the test list — refusing to delete`);
    }
    ok('no order belongs to a non-test client');

    // Snapshot the real catalog so we can prove we did not touch it.
    const keptBefore = (await client.query(
      `SELECT product_code, (SELECT count(*)::int FROM products v WHERE v.master_product_id = p.id AND v.archived = false) AS variants
       FROM products p WHERE p.product_code = ANY($1) ORDER BY product_code`, [KEEP_MASTERS]
    )).rows;
    ok(`real catalog snapshot: ${keptBefore.map(r => `${r.product_code}=${r.variants}v`).join(', ')}`);
    const oilsBefore = (await client.query(`SELECT count(*)::int n FROM sa.products WHERE category = 'OILS'`)).rows[0].n;
    const oilStockBefore = (await client.query(`SELECT COALESCE(SUM("currentStock"),0)::numeric t FROM sa.products WHERE category = 'OILS'`)).rows[0].t;
    ok(`SA Fragrance Library baseline: ${oilsBefore} oils, ${Number(oilStockBefore).toLocaleString()} mL total (must not change)`);

    const unlinkedTx = (await client.query(`SELECT count(*)::int n FROM transactions WHERE production_order_id IS NULL`)).rows[0].n;
    console.log(`  note - ${unlinkedTx} transactions have NO order link — left untouched (separate decision)`);

    // Products tied to the test clients (products.client_id is ON DELETE SET NULL)
    const clientProducts = (await client.query(
      `SELECT p.id, p.product_code, p.name, p.current_stock, c.name AS client
       FROM products p JOIN clients c ON c.id = p.client_id WHERE c.name = ANY($1)`, [TEST_CLIENT_NAMES]
    )).rows;
    if (clientProducts.length) {
      console.log(`  note - ${clientProducts.length} product(s) belong to a test client:`);
      clientProducts.forEach(p => console.log(`         ${p.product_code} "${p.name}" stock=${p.current_stock} (client: ${p.client})`));
    }

    await client.query('BEGIN');

    // ── 1. Transactions linked to the test orders ─────────────────────────
    const txDel = await client.query('DELETE FROM transactions WHERE production_order_id IS NOT NULL');
    console.log(`\nDeleted ${txDel.rowCount} order-linked transactions.`);

    // ── 2. External processing rows (all belong to the test orders) ───────
    const epDel = await client.query('DELETE FROM external_processing');
    console.log(`Deleted ${epDel.rowCount} external_processing rows.`);

    // ── 3. The orders themselves (cascades lines/jobs/components/reservations/…) ──
    const ordDel = await client.query('DELETE FROM production_orders');
    console.log(`Deleted ${ordDel.rowCount} production orders (+ cascaded children).`);

    // ── 4. BOM rows owned by the test masters (product_type is a string, no FK) ──
    const bomDel = await client.query('DELETE FROM product_bom WHERE product_type = ANY($1)', [TEST_MASTER_CODES]);
    console.log(`Deleted ${bomDel.rowCount} product_bom rows owned by test masters.`);

    // ── 5. Test variants first, then their masters (master_product_id is SET NULL,
    //       so children must go first or they'd be left orphaned), then extras. ──
    const varDel = await client.query('DELETE FROM products WHERE sku = ANY($1)', [TEST_VARIANT_SKUS]);
    console.log(`Deleted ${varDel.rowCount} test variants.`);
    const mastDel = await client.query('DELETE FROM products WHERE product_code = ANY($1)', [TEST_MASTER_CODES]);
    console.log(`Deleted ${mastDel.rowCount} test masters.`);
    const otherDel = await client.query('DELETE FROM products WHERE product_code = ANY($1)', [TEST_OTHER_CODES]);
    console.log(`Deleted ${otherDel.rowCount} other test products (Test Diffuser).`);

    // ── 6. Test clients (cascades client_stock / labels / sku mappings) ───
    const cliDel = await client.query('DELETE FROM clients WHERE name = ANY($1)', [TEST_CLIENT_NAMES]);
    console.log(`Deleted ${cliDel.rowCount} test clients.`);

    // ── Post-flight asserts ───────────────────────────────────────────────
    console.log('\nPost-flight:');
    const ordersLeft = (await client.query('SELECT count(*)::int n FROM production_orders')).rows[0].n;
    if (ordersLeft !== 0) fail(`${ordersLeft} production orders still present`);
    ok('production orders table is empty');

    for (const [t, col] of [['production_order_lines', null], ['production_jobs', null], ['stock_reservations', null], ['production_order_components', null]]) {
      const n = (await client.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
      if (n !== 0) fail(`${t} still has ${n} rows (cascade did not fire as expected)`);
      ok(`${t} cleared by cascade`);
    }

    const keptAfter = (await client.query(
      `SELECT product_code, (SELECT count(*)::int FROM products v WHERE v.master_product_id = p.id AND v.archived = false) AS variants
       FROM products p WHERE p.product_code = ANY($1) ORDER BY product_code`, [KEEP_MASTERS]
    )).rows;
    if (keptAfter.length !== keptBefore.length) fail('a real master disappeared');
    for (let i = 0; i < keptBefore.length; i++) {
      if (keptBefore[i].product_code !== keptAfter[i].product_code || keptBefore[i].variants !== keptAfter[i].variants) {
        fail(`real master ${keptBefore[i].product_code} changed: ${keptBefore[i].variants} -> ${keptAfter[i].variants} variants`);
      }
    }
    ok(`real catalog untouched: ${keptAfter.map(r => `${r.product_code}=${r.variants}v`).join(', ')}`);

    const oilsAfter = (await client.query(`SELECT count(*)::int n FROM sa.products WHERE category = 'OILS'`)).rows[0].n;
    const oilStockAfter = (await client.query(`SELECT COALESCE(SUM("currentStock"),0)::numeric t FROM sa.products WHERE category = 'OILS'`)).rows[0].t;
    if (oilsAfter !== oilsBefore || String(oilStockAfter) !== String(oilStockBefore)) fail('the SA Fragrance Library changed — it must never be touched');
    ok(`SA Fragrance Library untouched: ${oilsAfter} oils, ${Number(oilStockAfter).toLocaleString()} mL`);

    const testLeft = (await client.query(
      `SELECT count(*)::int n FROM products WHERE product_code = ANY($1) OR sku = ANY($2) OR product_code = ANY($3)`,
      [TEST_MASTER_CODES, TEST_VARIANT_SKUS, TEST_OTHER_CODES]
    )).rows[0].n;
    if (testLeft !== 0) fail(`${testLeft} test product(s) still present`);
    ok('all test products removed');

    const clientsLeft = (await client.query('SELECT name FROM clients ORDER BY name')).rows.map(r => r.name);
    ok(`clients remaining: ${clientsLeft.length ? clientsLeft.join(', ') : '(none)'}`);

    if (COMMIT) { await client.query('COMMIT'); console.log('\nCOMMITTED.'); }
    else { await client.query('ROLLBACK'); console.log('\nDRY-RUN rolled back (pass --commit to apply).'); }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\nFAILED — rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
