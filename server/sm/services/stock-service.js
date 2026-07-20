const { query } = require('../db')
const { enqueueInventoryAdjust } = require('./shopify-sync')

// opts.skipShopifyPush — set for movements that ORIGINATED in Shopify (a retail
// sale or its reversal). Shopify already applied them to its own inventory
// (our MUSE products publish with inventory_management:'shopify'), so pushing
// the delta back would deduct it a SECOND time. Movements that originate here
// (production, manual adjust, receiving) still push — we stay the source of truth.
async function adjustProductStock(productId, delta, type, notes, userId, orderId, lineId, qFn, opts = {}) {
  const qry = qFn || query
  // Guard: prevent stock going negative (deductions only).
  // opts.allowNegative — opt-out for movements that record a PHYSICAL fact which
  // already happened and cannot be refused: a MUSE retail sale Shopify already
  // shipped. Refusing it would roll back the whole fulfillment and lose the sale;
  // instead we record it and let the balance go negative (a signal to investigate,
  // mirroring the SA/oil model). Production/BOM consumption keeps the guard.
  if (delta < 0 && !opts.allowNegative) {
    const check = await qry(`SELECT current_stock FROM products WHERE id = $1`, [productId])
    if (!check.rows[0]) throw new Error('Product not found')
    const newStock = parseFloat(check.rows[0].current_stock) + delta
    if (newStock < 0) throw new Error(`Insufficient stock: available ${check.rows[0].current_stock}, requested ${Math.abs(delta)}`)
  }
  const result = await qry(`UPDATE products SET current_stock = current_stock + $1 WHERE id = $2 RETURNING *`, [delta, productId])
  const p = result.rows[0]
  if (!p) throw new Error('Product not found')
  await qry(
    `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, production_order_id, production_order_line_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [p.id, p.product_code, p.name, p.category, type, Math.abs(delta), p.unit, p.current_stock, notes || null, orderId || null, lineId || null, userId || null]
  )
  // System is the source of truth — push the delta to Shopify if this product is published there
  if (p.shopify_inventory_item_id && !opts.skipShopifyPush) {
    await enqueueInventoryAdjust(p.id, delta).catch(() => {})
  }
  return p
}

module.exports = { adjustProductStock }
