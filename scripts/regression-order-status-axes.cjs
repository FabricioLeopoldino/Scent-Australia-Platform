// ═══════════════════════════════════════════════════════════════════════════
// COMMERCIAL vs PHYSICAL order state — the two axes must not overwrite each other
// ═══════════════════════════════════════════════════════════════════════════
// Owner-reported (2026-07-22): marking an order "Waiting External" (to get labels
// or send candles for filling) made the Shopify button disappear, because it was
// gated on status==='draft'. The workaround was to never use the feature — so the
// system never knew which orders were actually out at a supplier.
//
// Creating the Shopify draft order is a COMMERCIAL step. Where the order sits in
// the PHYSICAL lifecycle (queued / waiting_external / in_production) is a separate
// axis. Publishing must therefore:
//   · be possible from any live status (not just draft)
//   · advance draft → confirmed ONLY when still draft
//   · never overwrite a physical status that has already moved on
//
// Shopify itself is never called here — SM_SHOPIFY_SYNC_ENABLED gates the real
// publish, and this asserts the DB-side rule that the publish routes apply.
//
// Usage: node scripts/regression-order-status-axes.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');

const sm = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false },
  options: '-c search_path=sm,public',
});

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };

// The exact statement both publish paths use (direct route + queued retry).
const PUBLISH_SQL = `
  UPDATE production_orders
     SET shopify_draft_order_id = $1,
         status = CASE WHEN status = 'draft' THEN 'confirmed' ELSE status END,
         updated_at = NOW()
   WHERE id = $2
  RETURNING status, shopify_draft_order_id`;

(async () => {
  const c = await sm.connect();
  try {
    await c.query('BEGIN'); // everything below is rolled back — touches no real data

    const master = (await c.query(`SELECT product_code FROM products WHERE is_master = true LIMIT 1`)).rows[0];
    if (!master) { bad('a master exists to build a probe order'); await c.query('ROLLBACK'); return; }

    // Build one probe order we can re-stage into each status.
    const ord = (await c.query(
      `INSERT INTO production_orders (order_number, order_type, status) VALUES ('__AXES_PROBE','STANDARD','draft') RETURNING id`
    )).rows[0];

    // 1. From 'draft' → publishing advances the commercial axis.
    let r = await c.query(PUBLISH_SQL, [111111, ord.id]);
    r.rows[0].status === 'confirmed' && String(r.rows[0].shopify_draft_order_id) === '111111'
      ? ok("draft → publishing advances to 'confirmed' and records the draft id")
      : bad('draft publish did not confirm', JSON.stringify(r.rows[0]));

    // 2. From each physical status → publishing records the id but PRESERVES status.
    for (const physical of ['queued', 'waiting_external', 'in_production']) {
      await c.query(`UPDATE production_orders SET status = $1, shopify_draft_order_id = NULL WHERE id = $2`, [physical, ord.id]);
      r = await c.query(PUBLISH_SQL, [222222, ord.id]);
      const row = r.rows[0];
      row.status === physical && String(row.shopify_draft_order_id) === '222222'
        ? ok(`${physical} → publishing keeps the physical status and still records the draft id`)
        : bad(`${physical} was overwritten by publishing`, `status=${row.status} (expected ${physical})`);
    }

    // 3. The regression that started this: an order out at a supplier must remain
    //    out at a supplier after being sent to Shopify.
    await c.query(`UPDATE production_orders SET status = 'waiting_external', shopify_draft_order_id = NULL WHERE id = $1`, [ord.id]);
    await c.query(PUBLISH_SQL, [333333, ord.id]);
    const after = (await c.query(`SELECT status, shopify_draft_order_id FROM production_orders WHERE id = $1`, [ord.id])).rows[0];
    after.status === 'waiting_external' && String(after.shopify_draft_order_id) === '333333'
      ? ok('owner scenario: waiting-external order can be published without losing that state')
      : bad('owner scenario still broken', JSON.stringify(after));

    await c.query('ROLLBACK');
    ok('probe rolled back — no data committed');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    bad('probe error', e.message);
  } finally {
    c.release();
  }

  console.log(`\n══════ ORDER STATUS AXES: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})();
