const { query } = require('../db')
const { enqueueInventoryAdjust } = require('./shopify-sync')

async function adjustProductStock(productId, delta, type, notes, userId, orderId, lineId, qFn) {
  const qry = qFn || query
  // Guard: prevent stock going negative (deductions only)
  if (delta < 0) {
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
  if (p.shopify_inventory_item_id) {
    await enqueueInventoryAdjust(p.id, delta).catch(() => {})
  }
  return p
}

module.exports = { adjustProductStock }
