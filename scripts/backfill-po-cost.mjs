// Copy the Shopify cost onto open purchase orders that have none.
//
// WHY (2026-10-28, owner approved). Stage 1 stores a line's cost when a Shopify
// PO is accepted (PRD_STAGE_1_FRAGRANCE_LIBRARY.md S8). A PO accepted by the
// code before Stage 1 has no cost, so its delivery after the release would read
// "No price on the PO" even when Shopify has one. Release checklist §10 item 4.
//
// Same rule as the acceptance, from the same function: Shopify's cost per item
// ÷ bottle size, ex GST; 0 = no price. Only open lines (pending / partial) with
// no cost are filled; a stored cost is never changed. Safe to re-run: a cost
// typed in Shopify after the PO was accepted is picked up the same way.
//
//   PLATFORM_DATABASE_URL=<sectors-dev> node scripts/backfill-po-cost.mjs            # dry run
//   PLATFORM_DATABASE_URL=<sectors-dev> node scripts/backfill-po-cost.mjs --apply    # writes
//
// Refuses any database but the Neon branch sectors-dev unless --production is
// passed too. Reads Shopify, never writes to it.
import 'dotenv/config';
import { readIncomingPurchaseOrders, costPerMl } from '../server/sa/shopify-purchase-orders.js';

const url = process.env.PLATFORM_DATABASE_URL || '';
const APPLY = process.argv.includes('--apply');
if (!url.includes('ep-old-water-') && !process.argv.includes('--production')) {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the sectors-dev branch (ep-old-water-). Pass --production as well to run it elsewhere.');
  process.exit(1);
}

// Imported only after the check: importing it opens a pool on PLATFORM_DATABASE_URL.
const { saPool } = await import('../server/db.js');

const client = await saPool.connect();
try {
  // Shopify first, as the accept route does: no transaction held open across a network call.
  const products = (await client.query(
    `SELECT id, "productCode", name, "currentStock", unit, "shopifySkus", status
       FROM products WHERE status = 'active'`)).rows
    .map((r) => ({ ...r, shopifySkus: typeof r.shopifySkus === 'string' ? JSON.parse(r.shopifySkus) : r.shopifySkus }));
  const { orders } = await readIncomingPurchaseOrders(products);
  const shopifyLines = new Map(orders.flatMap((o) => o.lines.map((l) => [l.lineId, l])));

  await client.query('BEGIN');
  const open = (await client.query(
    `SELECT po.id, po.order_number, po.quantity, po.status, po.shopify_line_id, p.name
       FROM purchase_orders po JOIN products p ON p.id = po.product_id
      WHERE po.shopify_line_id IS NOT NULL AND po.cost_per_unit IS NULL
        AND po.status IN ('pending', 'partial')
      ORDER BY po.order_number, p.name
      FOR UPDATE OF po`)).rows;

  const filled = [];
  console.log(`Open Shopify PO lines with no cost on ${new URL(url).host}: ${open.length} — ${APPLY ? 'APPLY' : 'dry run'}\n`);
  for (const po of open) {
    const line = shopifyLines.get(po.shopify_line_id);
    const cost = line ? costPerMl(line.unitCost, line.bottleMl) : null;
    const why = !line ? 'not in Shopify any more — left as is'
      : cost == null ? `no price in Shopify (${line.unitCost ?? 'empty'}) — stays "No price on the PO"`
      : `$${line.unitCost} per ${line.bottleMl} mL bottle = $${(cost * 1000).toFixed(2)}/L`;
    console.log(`  ${String(po.order_number ?? '').padEnd(8)} ${po.name.padEnd(32)} ${String(po.quantity).padStart(8)} mL  ${why}`);
    if (cost == null) continue;
    await client.query(`UPDATE purchase_orders SET cost_per_unit = $1 WHERE id = $2`, [cost, po.id]);
    filled.push({ id: po.id, order: po.order_number, name: po.name, costPerMl: cost });
  }

  if (filled.length) {
    const actor = (await client.query(`SELECT id FROM users WHERE role = 'root' ORDER BY id LIMIT 1`)).rows[0];
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'po_cost_backfilled', 'purchase_order', NULL, 'Stage 1 release', $2)`,
      [actor?.id ?? null, JSON.stringify({ lines: filled, rule: 'Shopify cost per item / bottle mL, ex GST' })]);
  }
  await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
  console.log(`\n${filled.length} to fill. ${APPLY ? 'Written.' : 'Nothing written. Run with --apply to write.'}`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('ROLLED BACK:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await saPool.end();
}
