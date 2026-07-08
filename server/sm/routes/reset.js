const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth } = require('../auth')

// Safety: only works in development or with explicit env flag
router.post('/reset-database', auth, async (req, res) => {
  if (process.env.ALLOW_DB_RESET !== 'true') {
    return res.status(403).json({ error: 'DB reset not enabled. Set ALLOW_DB_RESET=true in .env to allow.' })
  }
  try {
    // Truncate in reverse dependency order, reset sequences
    await query(`TRUNCATE TABLE
      shipping_labels,
      packing_records,
      fragrance_strength_log,
      production_jobs,
      stock_reservations,
      production_order_components,
      production_order_lines,
      external_processing,
      production_orders,
      client_label_transactions,
      client_labels,
      client_stock_transactions,
      client_stock,
      customer_sku_mappings,
      client_product_bom,
      clients,
      purchase_orders,
      transactions,
      audit_log,
      webhook_processed,
      product_bom_history,
      product_bom,
      bom_rules,
      product_attachments,
      products,
      suppliers
      RESTART IDENTITY CASCADE`)

    res.json({ success: true, message: 'Database cleared. Schema and users preserved.' })
  } catch (e) {
    res.status(500).json({ error: sanitizeError(e) })
  }
})

module.exports = router
