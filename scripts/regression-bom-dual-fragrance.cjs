// Proves a production line never charges its fragrance twice.
//
// WHY THIS EXISTS (2026-08-11). bom-builder.js has always carried the comment
// "a line's fragrance component is EITHER the legacy sm fragrance_id OR (D14) a
// Fragrance Library oil_id — never both". That was a convention, not a rule, and
// production disagrees with it: D14.9 deliberately kept fragrance_id on all 366
// active MUSE variants as a rollback cushion, so every line built from one
// arrives holding BOTH ids. The builder then created the legacy component AND
// set the D14 oil quantity — the same 75 mL charged to two different records.
//
// Found on the first real order through the Shopify path (#1020 → SM-001): the
// owner opened the screen and the pick list read "Vetiver D'Hiver — 75 ml" on
// two separate rows. The database damage was mild (the second debit lands on an
// archived FRAG_* record); the operational damage was not — the person producing
// adds them up and pours 150.
//
// The guard lives in buildLineComponents, which BOTH order paths call, so the
// manual screen and the Shopify ingestion are covered by one condition.
//
// Runs entirely inside a transaction and ROLLS BACK: no test rows survive, not
// even on failure. Never writes to `sa` — it only reads one oil id to satisfy
// the FK on production_order_lines.oil_id.
//
// Run: node scripts/regression-bom-dual-fragrance.cjs
require('dotenv').config();
const { Pool } = require('pg');
const { buildLineComponents } = require('../server/sm/services/bom-builder');

if (!process.env.PLATFORM_DATABASE_URL) {
  console.error('PLATFORM_DATABASE_URL required.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

const TAG = `ZZBOM${String(Date.now()).slice(-7)}`;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// 3 units × 100 ml at 25% oil → 75 ml fragrance, 225 ml ethanol.
const QTY = 3, VOLUME = 100, OIL_PCT = 25;
const EXPECT_FRAG = QTY * VOLUME * (OIL_PCT / 100);
const EXPECT_ETH = QTY * VOLUME * ((100 - OIL_PCT) / 100);

(async () => {
  const client = await pool.connect();
  const tq = (text, params) => client.query(text, params);
  try {
    await client.query('BEGIN');

    const oilId = (await tq(`SELECT id FROM sa.products WHERE id LIKE 'OIL%' LIMIT 1`)).rows[0]?.id;
    if (!oilId) throw new Error('no Fragrance Library oil found to reference');

    // ── Disposable catalogue ────────────────────────────────────────────────
    const ethanolId = (await tq(
      `INSERT INTO products (name, product_code, category, unit, current_stock)
       VALUES ($1,$2,'RAW_MATERIAL','ml',100000) RETURNING id`,
      [`${TAG} ethanol`, `${TAG}_ETH`])).rows[0].id;

    const bottleId = (await tq(
      `INSERT INTO products (name, product_code, category, unit, current_stock)
       VALUES ($1,$2,'COMPONENT','units',1000) RETURNING id`,
      [`${TAG} bottle`, `${TAG}_BOT`])).rows[0].id;

    // The legacy sm fragrance record — the one that must NOT be charged when an oil is present.
    const legacyFragId = (await tq(
      `INSERT INTO products (name, product_code, category, unit, current_stock)
       VALUES ($1,$2,'FRAGRANCE','mL',5000) RETURNING id`,
      [`${TAG} legacy frag`, `${TAG}_FRG`])).rows[0].id;

    const masterCode = `${TAG}_M`;
    await tq(
      `INSERT INTO products (name, product_code, category, unit, is_master, segment, current_stock, volume_ml, default_oil_pct)
       VALUES ($1,$2,'FINISHED_GOOD','units',true,'MUSE',0,$3,$4)`,
      [`${TAG} master`, masterCode, VOLUME, OIL_PCT]);

    await tq(
      `INSERT INTO product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
       VALUES ($1,$2,'ethanol_pct',0,1,'production',true)`, [masterCode, ethanolId]);
    await tq(
      `INSERT INTO product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
       VALUES ($1,$2,'fixed',1,2,'production',true)`, [masterCode, bottleId]);

    const orderId = (await tq(
      `INSERT INTO production_orders (order_number, client_id, order_type, notes, status, created_by)
       VALUES ($1,NULL,'STANDARD','regression — rolled back','draft',NULL) RETURNING id`,
      [`${TAG}`])).rows[0].id;

    // Build one line, run the builder against it, read back what it produced.
    let lineNo = 0;
    const runCase = async (fragId, oil) => {
      lineNo += 1;
      const line = (await tq(
        `INSERT INTO production_order_lines
           (production_order_id, line_number, product_type, fragrance_id, oil_id,
            variant_name, oil_pct, quantity, unit_price, is_candle, needs_packing)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,false,false) RETURNING *`,
        [orderId, lineNo, masterCode, fragId, oil, `${TAG} v${lineNo}`, OIL_PCT, QTY])).rows[0];
      await buildLineComponents(orderId, line, {}, null, tq);
      const comps = (await tq(
        `SELECT product_id, product_code, quantity_required FROM production_order_components
          WHERE production_order_line_id = $1`, [line.id])).rows;
      const after = (await tq(`SELECT oil_qty_ml FROM production_order_lines WHERE id = $1`, [line.id])).rows[0];
      return {
        comps,
        legacy: comps.find((c) => c.product_id === legacyFragId),
        ethanol: comps.find((c) => c.product_id === ethanolId),
        bottle: comps.find((c) => c.product_id === bottleId),
        oilQty: after.oil_qty_ml === null ? null : parseFloat(after.oil_qty_ml),
      };
    };

    // ── Case 1 — BOTH ids, which is every MUSE variant in production today ──
    console.log('\nCase 1 — line carries fragrance_id AND oil_id (the live MUSE shape)');
    const both = await runCase(legacyFragId, oilId);
    check(!both.legacy, 'the legacy fragrance component is NOT created',
      both.legacy ? `got ${both.legacy.quantity_required} of ${both.legacy.product_code}` : '');
    check(both.oilQty === EXPECT_FRAG, `the oil quantity is charged once: ${EXPECT_FRAG} ml`, `got ${both.oilQty}`);
    check(both.comps.length === 2, 'exactly 2 components (ethanol + bottle), no third fragrance row',
      `got ${both.comps.length}: ${both.comps.map((c) => c.product_code).join(', ')}`);
    check(both.ethanol && parseFloat(both.ethanol.quantity_required) === EXPECT_ETH,
      `ethanol unaffected: ${EXPECT_ETH} ml`, `got ${both.ethanol?.quantity_required}`);
    // The regression this file exists to prevent: fragrance charged on both rails.
    const charged = (both.legacy ? parseFloat(both.legacy.quantity_required) : 0) + (both.oilQty || 0);
    check(charged === EXPECT_FRAG, `total fragrance charged across BOTH rails is ${EXPECT_FRAG} ml, not ${EXPECT_FRAG * 2}`,
      `got ${charged}`);

    // ── Case 2 — legacy only: unchanged behaviour, nothing regressed ────────
    console.log('\nCase 2 — legacy fragrance_id only (pre-D14 orders must still work)');
    const legacyOnly = await runCase(legacyFragId, null);
    check(!!legacyOnly.legacy, 'the legacy fragrance component IS still created');
    check(legacyOnly.legacy && parseFloat(legacyOnly.legacy.quantity_required) === EXPECT_FRAG,
      `charged ${EXPECT_FRAG} ml`, `got ${legacyOnly.legacy?.quantity_required}`);
    check(legacyOnly.oilQty === null || legacyOnly.oilQty === 0, 'no oil quantity set', `got ${legacyOnly.oilQty}`);

    // ── Case 3 — oil only: the shape everything should converge on ──────────
    console.log('\nCase 3 — oil_id only (the D14 model)');
    const oilOnly = await runCase(null, oilId);
    check(!oilOnly.legacy, 'no legacy fragrance component');
    check(oilOnly.oilQty === EXPECT_FRAG, `oil charged ${EXPECT_FRAG} ml`, `got ${oilOnly.oilQty}`);
    check(oilOnly.comps.length === 2, 'exactly 2 components', `got ${oilOnly.comps.length}`);

    await client.query('ROLLBACK');
    console.log('\nrolled back — no rows kept');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`\nFATAL ${e.message}`);
    failed++;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(failed === 0 ? '\n✅ all checks passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
