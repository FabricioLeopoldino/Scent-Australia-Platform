const express = require('express')
const router = express.Router()
const { query, withTransaction } = require('../db')
const { auth, requireRole, auditLog } = require('../auth')
const { adjustProductStock } = require('../services/stock-service')

router.post('/stock/add', auth, async (req, res) => {
  try {
    const { product_id, quantity, notes } = req.body
    if (!product_id || !quantity || quantity <= 0) return res.status(400).json({ error: 'product_id and positive quantity required' })
    const p = await adjustProductStock(product_id, quantity, 'add', notes, req.user.id)
    res.json(p)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/stock/remove', auth, async (req, res) => {
  try {
    const { product_id, quantity, notes } = req.body
    if (!product_id || !quantity || quantity <= 0) return res.status(400).json({ error: 'product_id and positive quantity required' })
    const p = await adjustProductStock(product_id, -quantity, 'remove', notes, req.user.id)
    res.json(p)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/stock/adjust', auth, async (req, res) => {
  try {
    const { product_id, new_stock, notes } = req.body
    if (product_id === undefined || new_stock === undefined) return res.status(400).json({ error: 'product_id and new_stock required' })
    const p = await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)
      const current = await tq(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [product_id])
      if (!current.rows[0]) throw new Error('Product not found')
      const delta = parseFloat(new_stock) - parseFloat(current.rows[0].current_stock)
      return adjustProductStock(product_id, delta, 'adjust', notes, req.user.id, null, null, tq)
    })
    res.json(p)
  } catch (e) { res.status(e.message === 'Product not found' ? 404 : 500).json({ error: e.message }) }
})

router.get('/purchase-orders', auth, async (req, res) => {
  try {
    const { product_id } = req.query
    let q = `SELECT po.*, p.name as product_name, p.product_code, p.unit FROM purchase_orders po JOIN products p ON po.product_id = p.id WHERE 1=1`
    const params = []
    if (product_id) { params.push(product_id); q += ` AND po.product_id = $${params.length}` }
    q += ` ORDER BY po.created_at DESC`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/products/:id/incoming', auth, async (req, res) => {
  try {
    const { order_number, quantity, supplier, estimated_delivery_date, notes } = req.body
    if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Valid quantity required' })
    const prod = await query(`SELECT * FROM products WHERE id = $1`, [req.params.id])
    if (!prod.rows[0]) return res.status(404).json({ error: 'Product not found' })
    const result = await query(
      `INSERT INTO purchase_orders (product_id, order_number, quantity, supplier, estimated_delivery_date, notes, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, order_number || null, quantity, supplier || prod.rows[0].supplier || null, estimated_delivery_date || null, notes || null, req.user.name]
    )
    await auditLog(req.user.id, 'po_created', 'product', parseInt(req.params.id), prod.rows[0].name, { quantity, supplier })
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/settings', auth, async (req, res) => {
  try {
    const result = await query(`SELECT key, value FROM system_settings`)
    const obj = {}
    result.rows.forEach(r => { obj[r.key] = r.value })
    res.json(obj)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.put('/settings', auth, requireRole('admin', 'root'), async (req, res) => {
  try {
    const updates = req.body
    for (const [key, value] of Object.entries(updates)) {
      await query(`INSERT INTO system_settings (key, value, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`, [key, String(value)])
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/purchase-orders/:poId/receive', auth, async (req, res) => {
  try {
    const { quantity_received, force_accept, discrepancy_reason } = req.body
    const po = await query(`SELECT po.*, p.name as product_name, p.unit FROM purchase_orders po JOIN products p ON po.product_id = p.id WHERE po.id = $1`, [req.params.poId])
    if (!po.rows[0]) return res.status(404).json({ error: 'PO not found' })
    const record = po.rows[0]
    const expected = parseFloat(record.quantity) - parseFloat(record.quantity_received)
    const received = parseFloat(quantity_received)

    // Tolerance check runs outside transaction (read-only)
    if (!force_accept && expected > 0) {
      const settings = await query(`SELECT key, value FROM system_settings WHERE key IN ('receiving_tolerance_pct','receiving_tolerance_units')`)
      const s = {}; settings.rows.forEach(r => { s[r.key] = parseFloat(r.value) })
      const tolPct = s['receiving_tolerance_pct'] || 0
      const tolUnits = s['receiving_tolerance_units'] || 0
      const diff = Math.abs(received - expected)
      const pctDiff = expected > 0 ? (diff / expected) * 100 : 0
      const withinTol = diff <= tolUnits || pctDiff <= tolPct
      if (!withinTol && diff > 0.001) {
        return res.json({
          tolerance_exceeded: true,
          expected, received, difference: received - expected,
          tolerance_pct: tolPct, tolerance_units: tolUnits,
          diff_pct: pctDiff.toFixed(1),
        })
      }
    }

    const newReceived = parseFloat(record.quantity_received) + received
    const newStatus = newReceived >= parseFloat(record.quantity) * 0.999 ? 'received' : 'partial'
    const notes_extra = discrepancy_reason ? ` | Discrepancy: ${discrepancy_reason}` : ''

    await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)
      await tq(`UPDATE purchase_orders SET quantity_received = $1, status = $2 WHERE id = $3`, [newReceived, newStatus, req.params.poId])
      await adjustProductStock(record.product_id, received, 'po_received', `PO received: ${record.order_number || 'N/A'}${notes_extra}`, req.user.id, null, null, tq)
    })

    await auditLog(req.user.id, 'po_received', 'product', record.product_id, record.product_name, { quantity_received: received, po_id: record.id, discrepancy_reason })
    res.json({ success: true, new_status: newStatus })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/purchase-orders/:poId', auth, async (req, res) => {
  try {
    const mode = req.query.mode || 'cancel'
    const po = await query(`SELECT po.*, p.name as product_name FROM purchase_orders po JOIN products p ON po.product_id = p.id WHERE po.id = $1`, [req.params.poId])
    if (!po.rows[0]) return res.status(404).json({ error: 'PO not found' })
    const record = po.rows[0]
    if (mode === 'discard') {
      if (!['pending', 'cancelled'].includes(record.status)) return res.status(400).json({ error: 'Only pending or cancelled POs can be discarded' })
      await query(`DELETE FROM purchase_orders WHERE id = $1`, [req.params.poId])
      await auditLog(req.user.id, 'po_discarded', 'product', record.product_id, record.product_name, { po_id: req.params.poId })
    } else {
      await query(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1`, [req.params.poId])
      await auditLog(req.user.id, 'po_cancelled', 'product', record.product_id, record.product_name, { po_id: req.params.poId })
    }
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/transactions', auth, async (req, res) => {
  try {
    const { product_id, type, from, to, limit } = req.query
    let q = `SELECT t.*, u.name as user_name FROM transactions t LEFT JOIN users u ON t.user_id = u.id WHERE 1=1`
    const params = []
    if (product_id) { params.push(product_id); q += ` AND t.product_id = $${params.length}` }
    if (type) { params.push(type); q += ` AND t.type = $${params.length}` }
    if (from) { params.push(from); q += ` AND t.created_at >= $${params.length}` }
    if (to) { params.push(to); q += ` AND t.created_at <= $${params.length}` }
    q += ` ORDER BY t.created_at DESC LIMIT ${parseInt(limit) || 5000}`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
