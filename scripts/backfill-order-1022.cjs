// Records order #1022 as waiting to ship.
//
// WHY. #1022 (Daniel Edwards, paid 2026-08-17, one Adventure Room Spray) came in
// before the code that records a shelf-covered order existed. It is a real,
// paid, unshipped order and the platform holds exactly one row about it — a
// line in webhook_processed. Without this it stays invisible even after the fix,
// because the webhook that would have written the audit row already ran.
//
// Everything below is read from the store, not assumed: the order name, its
// Shopify id, and its line items. It refuses if the order is no longer paid and
// unfulfilled, so re-running after it ships does nothing.
//
// Idempotent. Writes one audit row.
//
// Run:  node scripts/backfill-order-1022.cjs            (dry run)
//       node scripts/backfill-order-1022.cjs --apply
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const ORDER_GID = 'gid://shopify/Order/7040349798613';

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});
const log = (s = '') => console.log(s);

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — record #1022 as waiting to ship\n`);

    // ── What the store actually says, right now ───────────────────────────
    const dom = process.env.MUSE_SHOPIFY_SHOP_DOMAIN;
    const tok = process.env.MUSE_SHOPIFY_ACCESS_TOKEN;
    if (!dom || !tok) throw new Error('MUSE Shopify credentials not configured');
    const r = await fetch(`https://${dom}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query{ order(id:"${ORDER_GID}"){ name legacyResourceId
                  displayFinancialStatus displayFulfillmentStatus
                  lineItems(first:50){ nodes{ title quantity sku } } } }`,
      }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(`Shopify: ${JSON.stringify(j.errors).slice(0, 200)}`);
    const o = j.data?.order;
    if (!o) throw new Error('order not found on the store');

    log(`  order            ${o.name}  (${o.legacyResourceId})`);
    log(`  payment          ${o.displayFinancialStatus}`);
    log(`  fulfilment       ${o.displayFulfillmentStatus}`);

    // Refuse rather than record something untrue.
    if (o.displayFinancialStatus !== 'PAID' || o.displayFulfillmentStatus !== 'UNFULFILLED') {
      log('\n  Not paid-and-unfulfilled any more — nothing to record.\n');
      await client.query('ROLLBACK');
      return;
    }

    const already = await client.query(
      `SELECT 1 FROM audit_log WHERE action = 'shopify_order_ready_to_ship'
        AND details->>'shopify_order_id' = $1 LIMIT 1`, [String(o.legacyResourceId)]);
    if (already.rowCount) {
      log('\n  Already recorded — nothing to do.\n');
      await client.query('ROLLBACK');
      return;
    }

    // ── Lines, matched against our catalogue so the picker sees real names ──
    const lines = [];
    for (const li of o.lineItems.nodes) {
      const v = (await client.query(
        `SELECT name, current_stock::float s FROM products WHERE sku = $1`, [li.sku])).rows[0];
      lines.push({ sku: li.sku, qty: li.quantity, variant: v?.name || li.title });
      log(`  line             ${li.quantity} × ${li.sku}  ${v ? `${v.name} (shelf ${v.s})` : '— NOT IN OUR CATALOGUE'}`);
      if (!v) throw new Error(`SKU ${li.sku} is not in the catalogue — refusing to record a line we cannot pick`);
    }

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES (NULL, 'shopify_order_ready_to_ship', 'production_order', NULL, $1, $2)`,
      [o.name, JSON.stringify({
        shopify_order: o.name,
        shopify_order_id: String(o.legacyResourceId),
        lines,
        via: 'script backfill-order-1022.cjs — arrived before the code that records this existed',
      })]);
    log(`\n  recorded         shopify_order_ready_to_ship for ${o.name}`);

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
