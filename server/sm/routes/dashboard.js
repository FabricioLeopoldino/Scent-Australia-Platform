const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth } = require('../auth')

router.get('/dashboard/priority-watchlist', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT p.*, COALESCE(pending_po.qty, 0) as pending_po_qty
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(quantity - quantity_received) as qty
        FROM purchase_orders WHERE status IN ('pending','partial') GROUP BY product_id
      ) pending_po ON pending_po.product_id = p.id
      WHERE p.min_stock_level > 0 AND p.current_stock < p.min_stock_level
      ORDER BY (p.current_stock - p.min_stock_level) ASC
      LIMIT 20
    `)
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/dashboard/active-orders', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT po.*, c.name as client_name
      FROM production_orders po
      LEFT JOIN clients c ON po.client_id = c.id
      WHERE po.status NOT IN ('draft','fulfilled','cancelled','completed')
      ORDER BY po.due_date ASC NULLS LAST, po.created_at ASC
      LIMIT 20
    `)
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// REMOVED 2026-07-30: /dashboard/candles-in-progress and /dashboard/labels-pending.
// Both were orphans (no frontend ever called them) and both were superseded by the
// External Processing page, which is the real mechanism for work sent to suppliers:
//   · labels at the print shop  -> external_processing, processing_type = 'labels'
//   · candles at the filler     -> external_processing, processing_type = 'candle_filling'
//     (creating that EP also advances production_order_lines.candle_status)
// `labels-pending` was additionally BROKEN: it filtered on
// production_order_lines.labels_required/labels_received, and a repo-wide search showed
// `labels_received` and `labels_ordered_at` are never written by any code — so it would
// have listed every label line as "pending" forever, even after it came back. Building a
// page on it would have shown permanently wrong data.
// The equivalent (correct) views now live on the External Processing page via its type
// filter, fed by /dashboard/external-processing below.

router.get('/dashboard/stats', auth, async (req, res) => {
  try {
    const [products, orders, lowStock, pendingPos, largeClients] = await Promise.allSettled([
      query(`SELECT COUNT(*) FROM products`),
      query(`SELECT COUNT(*) FROM production_orders WHERE status NOT IN ('draft','fulfilled','cancelled','completed')`),
      query(`SELECT COUNT(*) FROM products WHERE current_stock < min_stock_level AND min_stock_level > 0`),
      query(`SELECT COUNT(*) FROM purchase_orders WHERE status IN ('pending','partial')`),
      query(`SELECT c.id, c.name, COUNT(cs.id) as reserved_count, SUM(cs.quantity) as total_reserved FROM clients c LEFT JOIN client_stock cs ON cs.client_id = c.id WHERE c.is_large_client = true GROUP BY c.id, c.name ORDER BY c.name`),
    ])
    res.json({
      total_products: products.status === 'fulfilled' ? parseInt(products.value.rows[0].count) : 0,
      active_orders: orders.status === 'fulfilled' ? parseInt(orders.value.rows[0].count) : 0,
      low_stock: lowStock.status === 'fulfilled' ? parseInt(lowStock.value.rows[0].count) : 0,
      pending_pos: pendingPos.status === 'fulfilled' ? parseInt(pendingPos.value.rows[0].count) : 0,
      large_clients: largeClients.status === 'fulfilled' ? largeClients.value.rows : [],
    })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/dashboard/external-processing', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT ep.*, po.order_number, c.name as client_name
       FROM external_processing ep
       LEFT JOIN production_orders po ON ep.production_order_id = po.id
       LEFT JOIN clients c ON ep.client_id = c.id
       WHERE ep.status IN ('requested','sent','partial')
       ORDER BY ep.expected_return ASC NULLS LAST, ep.sent_date ASC
       LIMIT 25`
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/dashboard/incoming-summary', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT po.id, po.order_number, po.supplier, po.status,
              po.estimated_delivery_date, po.quantity, po.quantity_received,
              p.name as product_name, p.product_code, p.unit
       FROM purchase_orders po
       JOIN products p ON po.product_id = p.id
       WHERE po.status IN ('pending','partial')
       ORDER BY po.estimated_delivery_date ASC NULLS LAST, po.created_at ASC
       LIMIT 20`
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/dashboard/warehouse-queue', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT po.id, po.order_number, po.status, po.due_date, po.order_type,
              c.name as client_name, po.created_at,
              po.external_type, po.external_supplier, po.external_expected_at,
              COUNT(pol.id) as line_count,
              COUNT(CASE WHEN pol.line_status = 'done' THEN 1 END) as lines_done,
              COUNT(CASE WHEN pol.line_status = 'sent_for_filling' THEN 1 END) as lines_sent_filling,
              COUNT(CASE WHEN pol.line_status = 'filling_done' THEN 1 END) as lines_filling_done,
              COUNT(CASE WHEN pol.line_status = 'labeling_done' THEN 1 END) as lines_labeling_done,
              STRING_AGG(DISTINCT COALESCE(
                (SELECT p.name FROM products p WHERE p.product_code = pol.product_type LIMIT 1),
                pol.product_type
              ), ', ') as product_types,
              BOOL_OR(pol.is_candle) as has_candle
       FROM production_orders po
       LEFT JOIN clients c ON po.client_id = c.id
       LEFT JOIN production_order_lines pol ON pol.production_order_id = po.id
       WHERE po.status NOT IN ('draft','fulfilled','cancelled')
       GROUP BY po.id, c.name
       ORDER BY po.due_date ASC NULLS LAST, po.created_at ASC
       LIMIT 50`
    )
    res.json(result.rows)
  } catch (e) {
    console.error('[dashboard/warehouse-queue]', e.message)
    res.status(500).json({ error: sanitizeError(e) })
  }
})

router.get('/dashboard/draft-orders', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT po.id, po.order_number, po.due_date, po.created_at, po.order_type,
              po.client_id, c.name as client_name,
              COUNT(pol.id) as line_count
       FROM production_orders po
       LEFT JOIN clients c ON po.client_id = c.id
       LEFT JOIN production_order_lines pol ON pol.production_order_id = po.id
       WHERE po.status = 'draft'
       GROUP BY po.id, c.name
       ORDER BY po.created_at DESC
       LIMIT 20`
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// ── Oil position behind the MUSE range ───────────────────────────────────────
//
// WHY (2026-08-13). The manager's stated requirement is that oil never runs out.
// Scent Australia already warns on low stock and it is genuinely in use — 187 of
// 325 oils carry a minimum. But the warning lives in SA, on SA's own dashboard,
// and the person running MUSE never sees it. Worse, 22 of the oils behind live
// MUSE products carry NO minimum at all, so for those the warning can never fire
// however low they get.
//
// Read-only against sa.products. MUSE never writes there — oil is only ever
// debited through the audited consumption path in fragrance-library.js.
//
// Three states, kept apart on purpose. This is the same distinction that turned
// 445 false alarms into 10 real ones on this dashboard: "below a minimum someone
// deliberately set" and "nobody ever set one" are different problems, and
// merging them produces an alarm nobody reads.
router.get('/dashboard/oil-position', auth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT o."productCode" AS product_code, o.name, o.id AS oil_id,
             o."currentStock"::float AS stock, o."minStockLevel"::float AS min_stock,
             o.unit, o.exclusivity, count(v.id)::int AS variant_count
        FROM sa.products o
        JOIN products v ON v.oil_id = o.id AND COALESCE(v.archived, false) = false
        JOIN products m ON m.id = v.master_product_id AND m.segment = 'MUSE'
       WHERE o.category = 'OILS'
       GROUP BY o.id, o."productCode", o.name, o."currentStock", o."minStockLevel", o.unit, o.exclusivity`)

    const hasMin = (r) => r.min_stock > 0
    // Sorted by how much room is left, so the most urgent reads first.
    const below = rows.filter((r) => hasMin(r) && r.stock <= r.min_stock)
      .sort((a, b) => (a.stock - a.min_stock) - (b.stock - b.min_stock))
    // Not an alarm — an unanswered question. Ordered by how many products depend
    // on it, because that is what makes deciding a minimum worth the time.
    const noMinimum = rows.filter((r) => !hasMin(r))
      .sort((a, b) => b.variant_count - a.variant_count || a.stock - b.stock)

    res.json({
      total: rows.length,
      below,
      no_minimum: noMinimum,
      healthy: rows.length - below.length - noMinimum.length,
    })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Dashboard alerts (reservation displacements, etc.)
router.get('/dashboard/alerts', auth, async (req, res) => {
  try {
    const { include_acknowledged } = req.query
    let q = `
      SELECT da.*, po.order_number as related_order_number, p.name as related_product_name
      FROM dashboard_alerts da
      LEFT JOIN production_orders po ON da.related_order_id = po.id
      LEFT JOIN products p ON da.related_product_id = p.id
      WHERE 1=1`
    if (include_acknowledged !== '1') q += ` AND da.acknowledged = false`
    q += ` ORDER BY da.created_at DESC LIMIT 50`
    const result = await query(q)
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/dashboard/alerts/:id/acknowledge', auth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE dashboard_alerts SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Alert not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/dashboard/alerts/acknowledge-all', auth, async (req, res) => {
  try {
    await query(
      `UPDATE dashboard_alerts SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = $1 WHERE acknowledged = false`,
      [req.user.id]
    )
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
