// Completes OUR half of the 50ml Library Refill, so the format is ready before
// the vessels land and before marketing registers the 87 variants on the store.
//
// WHY THIS EXISTS (2026-08-13). RF50 was created as a master but left
// `standard: false` in muse-fragrance.js for two stated reasons: it had no
// price, and its recipe was empty. The price arrived ($49). This fills both
// gaps that are ours to fill.
//
// WHY THE EMPTY RECIPE MATTERED. A master with no components produces without
// consuming anything. A refill would have been "made" out of nothing, silently,
// and the shortage would never appear. Registering the vessel at zero stock is
// what makes a preorder tell the truth: it can be sold, it cannot be produced
// yet.
//
// WHAT IS DELIBERATELY NOT HERE:
//   - a lid, a label, a carton. Nobody has specified them. Guessed components
//     invent shortages for things that may not exist, which is worse than an
//     honest gap. Add them when marketing sends the artwork.
//   - flipping `standard: true`. That makes EVERY new fragrance mint a refill
//     variant and try to publish it, and the store has no refill products yet.
//     Flip it when the vessels arrive AND marketing has registered.
//
// The oil is not a recipe row: RF50 carries is_pure_oil with 100% oil, so the
// builder derives 50ml of neat oil per unit from the master.
//
// Idempotent — safe to run twice. Writes only to sm. Never touches sa.
//
// Run:  node scripts/setup-refill-50ml.cjs          (dry run, shows the plan)
//       node scripts/setup-refill-50ml.cjs --apply  (writes)
require('dotenv').config();
const { Pool } = require('pg');
const { getMasterAttrs } = require('../server/sm/services/bom-builder');

const APPLY = process.argv.includes('--apply');
const PRICE = 49;
const VESSEL = {
  name: 'Empty Bottle - Library Refill 50ml',
  category: 'COMPONENT',
  unit: 'units',
  segment: 'MUSE', // the Finished Goods / stock pages filter on this — without
                   // it the component exists but is invisible on screen.
};

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false },
  options: '-c search_path=sm,public',
});

const log = (s = '') => console.log(s);

// A script that writes straight to the database bypasses the audit the routes
// write, so the change lands with no author, no timestamp and no reason. That
// gap was found on 2026-08-13: this script's own first run left zero rows in
// audit_log, transactions and product_bom_history, while the same actions done
// on screen record `product_created`.
//
// Idempotent by design: it only writes a row when one is not already there, so
// re-running records nothing twice AND a change applied before this existed
// still gets its entry on the next run.
async function audit(q, action, entityId, entityName, details) {
  const seen = await q(
    `SELECT 1 FROM audit_log WHERE action = $1 AND entity_id = $2 LIMIT 1`,
    [action, entityId]);
  if (seen.rowCount) return false;
  await q(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
     VALUES (NULL, $1, 'product', $2, $3, $4)`,
    [action, entityId, entityName, JSON.stringify({ ...details, via: 'script setup-refill-50ml.cjs' })]);
  return true;
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (t, p) => client.query(t, p);

    const master = (await q(
      `SELECT id, price FROM products WHERE product_code = 'RF50' AND is_master = true`)).rows[0];
    if (!master) throw new Error('RF50 master not found — nothing to set up');

    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — 50ml Library Refill\n`);

    // 1. Price -------------------------------------------------------------
    const priceWasSet = master.price != null && Number(master.price) === PRICE;
    if (priceWasSet) {
      log(`  1. price          already ${PRICE}, unchanged`);
    } else {
      log(`  1. price          ${master.price ?? 'NULL'} → ${PRICE}`);
      await q(`UPDATE products SET price = $1 WHERE id = $2`, [PRICE, master.id]);
    }
    if (await audit(q, 'product_updated', master.id, 'Library Refill 50ml',
      { price: { from: priceWasSet ? 'set before this audit existed' : master.price, to: PRICE } })) {
      log(`     audit          product_updated recorded`);
    }

    // 2. The vessel --------------------------------------------------------
    // Matched by name, not by code: re-running must not mint a second COMP_.
    let vessel = (await q(
      `SELECT id, product_code, current_stock, segment FROM products WHERE name = $1`,
      [VESSEL.name])).rows[0];

    if (vessel) {
      log(`  2. vessel         already exists as ${vessel.product_code} (stock ${vessel.current_stock})`);
    } else {
      // Continue the COMP_ sequence the other vessels use.
      const next = ((await q(
        "SELECT max(substring(product_code from '[0-9]+$')::int) m" +
        " FROM products WHERE product_code LIKE 'COMP@_%' ESCAPE '@'")).rows[0].m || 0) + 1;
      const code = `COMP_${String(next).padStart(5, '0')}`;
      vessel = (await q(
        `INSERT INTO products (name, product_code, category, unit, segment,
                               current_stock, min_stock_level)
         VALUES ($1, $2, $3, $4, $5, 0, 0) RETURNING id, product_code, current_stock, segment`,
        [VESSEL.name, code, VESSEL.category, VESSEL.unit, VESSEL.segment])).rows[0];
      log(`  2. vessel         created ${code} at stock 0  (250 units in transit, ETA end of September)`);
    }
    if (await audit(q, 'product_created', vessel.id, VESSEL.name,
      { product_code: vessel.product_code, category: VESSEL.category, segment: VESSEL.segment, current_stock: 0 })) {
      log(`     audit          product_created recorded`);
    }

    // 3. The recipe --------------------------------------------------------
    const existing = (await q(
      `SELECT id, is_active FROM product_bom
        WHERE product_type = 'RF50' AND component_product_id = $1`, [vessel.id])).rows[0];
    if (existing?.is_active) {
      log(`  3. recipe         vessel already in the RF50 recipe`);
    } else if (existing) {
      await q(`UPDATE product_bom SET is_active = true WHERE id = $1`, [existing.id]);
      log(`  3. recipe         re-activated the existing RF50 line`);
    } else {
      await q(
        `INSERT INTO product_bom (product_type, component_product_id, component_group,
                                  quantity_per_unit, quantity_formula, sort_order)
         VALUES ('RF50', $1, 'core', 1, 'fixed', 1)`, [vessel.id]);
      log(`  3. recipe         1 × ${vessel.product_code} per refill (core)`);
    }

    // A recipe change is traced by product_bom_history, not audit_log — the same
    // mechanism routes/bom.js uses (saveBomSnapshot). Writing the snapshot here
    // means the RF50 recipe has a version 1 to roll back to, exactly as it would
    // if it had been built on screen.
    if (!(await q(`SELECT 1 FROM product_bom_history WHERE product_type = 'RF50' LIMIT 1`)).rowCount) {
      const snap = (await q(
        `SELECT pb.id, pb.component_product_id, pb.quantity_formula, pb.quantity_per_unit,
                pb.sort_order, pb.component_group, p.name AS component_name,
                p.product_code AS component_code, p.unit AS component_unit,
                p.category AS component_category
           FROM product_bom pb JOIN products p ON pb.component_product_id = p.id
          WHERE pb.product_type = 'RF50' AND pb.is_active = true
          ORDER BY pb.sort_order, pb.id`)).rows;
      await q(
        `INSERT INTO product_bom_history (product_type, version, action, changed_by, snapshot)
         VALUES ('RF50', 1, 'add', NULL, $1::jsonb)`, [JSON.stringify(snap)]);
      log(`     history        RF50 recipe version 1 recorded`);
    }

    // 4. Prove it ----------------------------------------------------------
    log('\n  What one refill now costs the warehouse:');
    const attrs = await getMasterAttrs('RF50', q);
    const oilMl = attrs.isPureOil ? attrs.volume : attrs.volume * (attrs.defaultOilPct / 100);
    log(`     oil            ${oilMl}ml   (pure oil: ${attrs.isPureOil})`);
    const recipe = (await q(
      `SELECT p.product_code, p.name, p.current_stock, pb.quantity_per_unit, pb.component_group
         FROM product_bom pb JOIN products p ON p.id = pb.component_product_id
        WHERE pb.product_type = 'RF50' AND pb.is_active = true ORDER BY pb.sort_order`)).rows;
    for (const r of recipe) {
      const short = Number(r.current_stock) < Number(r.quantity_per_unit);
      log(`     ${r.component_group.padEnd(8)}       ${r.quantity_per_unit} × ${r.product_code}  stock ${r.current_stock}${short ? '   ← SHORTAGE, as it should be' : ''}`);
    }
    if (!recipe.length) log('     (recipe still empty — the run did not take)');

    if (APPLY) {
      await client.query('COMMIT');
      log('\n✅ committed\n');
    } else {
      await client.query('ROLLBACK');
      log('\n↩  rolled back — re-run with --apply to keep it\n');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ rolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
