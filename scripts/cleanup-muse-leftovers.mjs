// Removes what the 2026-08-10 audit found sitting in production, owner approved.
//
//   · 6 MUSE variants with no oil — the '- alternate' and 'Gif' rows mis-keyed
//     on 2026-07-09. Their SKUs were re-pointed on the live store on 2026-08-07,
//     so nothing sellable references them any more.
//   · Regression fixtures that were never meant to outlive their run: the test
//     masters and their BOMs, the test production orders built from them, the
//     only row in sm.clients ("[regression] Coco Republic Test"), and a ready
//     formula holding 300 units of imaginary stock.
//   · 47 transactions rows orphaned by regression-fragrance-library*.cjs, which
//     deletes its products but only cleans sa.transactions, not sm.
//
// Deliberately NOT touched: the 7 fragrances whose oil is at zero (a purchasing
// decision, not junk) and the duplicate commercial names (confirmed intentional
// — one oil may sell under several names).
//
// Dry run by default. Pass --commit to apply.
//   node scripts/cleanup-muse-leftovers.mjs
//   node scripts/cleanup-muse-leftovers.mjs --commit
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const COMMIT = process.argv.includes('--commit');
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

const NO_OIL_SKUS = ['Muse_RD00079', 'Muse_RS00079', 'Muse_TS00079',
                     'Muse_RD00098', 'Muse_RS00098', 'Muse_TS00098'];
const TEST_CODES = ['RD200_TEST', 'CANDLE_240G', 'MAJ_RD200_TEST', 'RF-ZZ_REGRE'];

const show = (title, rows, fmt) => {
  console.log(`\n── ${title} (${rows.length})`);
  for (const r of rows) console.log(`   ${fmt(r)}`);
};

try {
  // ── 1. The six variants with no oil ──────────────────────────────────────
  const noOil = (await pool.query(
    `SELECT id, sku, name, current_stock, oil_id FROM products WHERE sku = ANY($1::text[])`,
    [NO_OIL_SKUS])).rows;
  show('MUSE variants with no oil', noOil, (r) => `${r.sku.padEnd(14)} stock=${r.current_stock} oil=${r.oil_id ?? 'NULL'}  ${r.name}`);
  const stillLinked = noOil.filter((r) => r.oil_id);
  const withStock = noOil.filter((r) => Number(r.current_stock) !== 0);
  if (stillLinked.length || withStock.length) {
    console.error(`\n❌ REFUSING: ${stillLinked.length} now have an oil, ${withStock.length} hold stock. Re-check before deleting.`);
    process.exit(1);
  }

  // ── 2. Regression fixtures ───────────────────────────────────────────────
  const fixtures = (await pool.query(
    `SELECT id, product_code, name, current_stock, is_master, archived FROM products WHERE product_code = ANY($1::text[])`,
    [TEST_CODES])).rows;
  show('regression fixture products', fixtures, (r) => `${r.product_code.padEnd(16)} stock=${String(r.current_stock).padEnd(6)} master=${r.is_master} archived=${r.archived}  ${r.name}`);

  const testOrders = (await pool.query(
    `SELECT DISTINCT po.id, po.order_number, po.status FROM production_orders po
       JOIN production_order_lines pol ON pol.production_order_id = po.id
      WHERE pol.product_type = ANY($1::text[]) ORDER BY po.id`, [TEST_CODES])).rows;
  show('production orders built from those fixtures', testOrders, (r) => `${r.order_number} (${r.status})`);

  const realOrders = (await pool.query(
    `SELECT count(*) n FROM production_orders po WHERE NOT EXISTS (
       SELECT 1 FROM production_order_lines pol WHERE pol.production_order_id = po.id
         AND pol.product_type = ANY($1::text[]))`, [TEST_CODES])).rows[0].n;
  console.log(`   → production orders NOT from fixtures (kept): ${realOrders}`);

  const testClient = (await pool.query(
    `SELECT id, name FROM clients WHERE name ILIKE '%regression%'`)).rows;
  show('test clients', testClient, (r) => `id=${r.id} ${r.name}`);

  // ── 3. Orphaned transactions ─────────────────────────────────────────────
  const orphanTx = (await pool.query(
    `SELECT product_code, count(*) n FROM transactions WHERE product_id IS NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;
  show('transactions rows whose product no longer exists', orphanTx, (r) => `${String(r.n).padEnd(4)} ${r.product_code}`);

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --commit.');
    process.exit(0);
  }

  // ── Apply, children before parents ───────────────────────────────────────
  console.log('\nApplying…');
  const orderIds = testOrders.map((r) => r.id);
  if (orderIds.length) {
    await pool.query(`DELETE FROM audit_log WHERE entity_type='production_order' AND entity_id = ANY($1::int[])`, [orderIds]);
    for (const t of ['production_order_components', 'stock_reservations', 'production_order_lines', 'production_jobs'])
      await pool.query(`DELETE FROM ${t} WHERE production_order_id = ANY($1::int[])`, [orderIds]);
    const d = await pool.query(`DELETE FROM production_orders WHERE id = ANY($1::int[])`, [orderIds]);
    console.log(`  production orders removed: ${d.rowCount}`);
  }

  const fixtureIds = fixtures.map((r) => r.id);
  const allProductIds = [...fixtureIds, ...noOil.map((r) => r.id)];
  if (allProductIds.length) {
    await pool.query(`DELETE FROM audit_log WHERE entity_type='product' AND entity_id = ANY($1::int[])`, [allProductIds]);
    await pool.query(`DELETE FROM transactions WHERE product_id = ANY($1::int[])`, [allProductIds]);
    await pool.query(`DELETE FROM product_bom WHERE component_product_id = ANY($1::int[])`, [allProductIds]);
  }
  await pool.query(`DELETE FROM product_bom WHERE product_type = ANY($1::text[])`, [TEST_CODES]);
  const dv = await pool.query(`DELETE FROM products WHERE id = ANY($1::int[])`, [allProductIds]);
  console.log(`  products removed: ${dv.rowCount}`);

  if (testClient.length) {
    const d = await pool.query(`DELETE FROM clients WHERE id = ANY($1::int[])`, [testClient.map((r) => r.id)]);
    console.log(`  clients removed: ${d.rowCount}`);
  }
  const dt = await pool.query(`DELETE FROM transactions WHERE product_id IS NULL`);
  console.log(`  orphaned transactions removed: ${dt.rowCount}`);

  // The legacy junction still carries a row per master↔fragrance pair. Removing
  // a variant leaves its row behind with nothing to point at, which integrity-sm
  // reports as "every MUSE master link has its variant". Phase B made the
  // variant itself the link, so these rows are history — but history that
  // matches a deleted variant is just a dangling row.
  const dj = await pool.query(
    `DELETE FROM muse_master_fragrances mmf
      WHERE NOT EXISTS (SELECT 1 FROM products v
                         WHERE v.master_product_id = mmf.master_product_id
                           AND v.fragrance_id = mmf.fragrance_id
                           AND COALESCE(v.archived,false) = false)`);
  console.log(`  dangling legacy master↔fragrance links removed: ${dj.rowCount}`);
  console.log('\n✅ done');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
