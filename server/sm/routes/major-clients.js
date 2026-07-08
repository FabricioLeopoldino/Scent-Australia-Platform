const express = require('express')
const router = express.Router()
const { query } = require('../db')
const { auth } = require('../auth')

// List Major Clients (is_large_client = true)
router.get('/major-clients', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM products p WHERE p.client_id = c.id AND p.is_master = true AND p.archived = false) as master_count,
              (SELECT COUNT(*) FROM client_stock cs WHERE cs.client_id = c.id) as client_stock_count,
              (SELECT COUNT(*) FROM client_labels cl WHERE cl.client_id = c.id AND cl.is_obsolete = false) as label_count,
              (SELECT COUNT(*) FROM production_orders po WHERE po.client_id = c.id AND po.status IN ('completed','ready_to_ship')) as awaiting_ship_count
       FROM clients c
       WHERE c.is_large_client = true
       ORDER BY c.name`
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Get Major Client detail + their masters
router.get('/major-clients/:id', auth, async (req, res) => {
  try {
    const clientRes = await query(
      `SELECT * FROM clients WHERE id = $1 AND is_large_client = true`,
      [req.params.id]
    )
    if (!clientRes.rows[0]) return res.status(404).json({ error: 'Major client not found' })

    const masters = await query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM major_client_master_fragrances WHERE master_product_id = p.id) as fragrance_count,
              (SELECT COUNT(*) FROM product_bom WHERE product_type = p.product_code AND is_active = true) as bom_component_count
       FROM products p
       WHERE p.client_id = $1 AND p.is_master = true AND p.archived = false
       ORDER BY p.name`,
      [req.params.id]
    )

    res.json({ ...clientRes.rows[0], masters: masters.rows })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Major Client's full stock summary: client_stock components + orders awaiting ship
router.get('/major-clients/:id/stock-summary', auth, async (req, res) => {
  try {
    const clientRes = await query(
      `SELECT id, name FROM clients WHERE id = $1 AND is_large_client = true`,
      [req.params.id]
    )
    if (!clientRes.rows[0]) return res.status(404).json({ error: 'Major client not found' })

    // 1. Components owned by client (from China)
    const clientStock = await query(
      `SELECT * FROM client_stock WHERE client_id = $1 ORDER BY category, product_name`,
      [req.params.id]
    )

    // 2. Custom labels
    const labels = await query(
      `SELECT * FROM client_labels WHERE client_id = $1 AND is_obsolete = false ORDER BY label_name`,
      [req.params.id]
    )

    // 3. Orders awaiting ship — grouped by master+fragrance
    const awaitingShip = await query(
      `SELECT
         po.id as order_id, po.order_number, po.status, po.created_at, po.updated_at,
         po.due_date, po.notes,
         pol.id as line_id, pol.product_type, pol.quantity, pol.fragrance_id, pol.line_status,
         master.name as master_name, master.product_code as master_code,
         frag.name as fragrance_name, frag.product_code as fragrance_code
       FROM production_orders po
       JOIN production_order_lines pol ON pol.production_order_id = po.id
       LEFT JOIN products master ON master.product_code = pol.product_type
         AND master.is_master = true AND master.client_id = $1
       LEFT JOIN products frag ON frag.id = pol.fragrance_id
       WHERE po.client_id = $1
         AND po.status IN ('completed','ready_to_ship')
       ORDER BY po.created_at DESC, pol.line_number`,
      [req.params.id]
    )

    // Group lines by master + fragrance
    const grouped = {}
    for (const row of awaitingShip.rows) {
      const key = `${row.master_code || row.product_type}__${row.fragrance_id || 'no-frag'}`
      if (!grouped[key]) {
        grouped[key] = {
          master_code: row.master_code || row.product_type,
          master_name: row.master_name || row.product_type,
          fragrance_id: row.fragrance_id,
          fragrance_name: row.fragrance_name,
          total_quantity: 0,
          orders: [],
        }
      }
      grouped[key].total_quantity += parseInt(row.quantity)
      grouped[key].orders.push({
        order_id: row.order_id,
        order_number: row.order_number,
        status: row.status,
        quantity: parseInt(row.quantity),
        created_at: row.created_at,
        due_date: row.due_date,
        notes: row.notes,
        line_status: row.line_status,
      })
    }

    res.json({
      client: clientRes.rows[0],
      client_stock: clientStock.rows,
      labels: labels.rows,
      awaiting_ship_grouped: Object.values(grouped),
      awaiting_ship_total_units: awaitingShip.rows.reduce((s, r) => s + parseInt(r.quantity), 0),
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
