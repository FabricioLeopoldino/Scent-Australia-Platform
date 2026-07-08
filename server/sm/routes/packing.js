const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query } = require('../db')
const { auth, auditLog } = require('../auth')

router.get('/packing-records', auth, async (req, res) => {
  try {
    const { production_order_id } = req.query
    let q = `
      SELECT pr.*, u.name as created_by_name,
        po.order_number, po.client_id, po.notes as order_notes,
        c.name as client_name_joined,
        pj.notes_on_completion,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'id', ep.id,
            'processing_type', ep.processing_type,
            'product_name', ep.product_name,
            'supplier', ep.supplier,
            'notes', ep.notes,
            'short_return_reason', ep.short_return_reason,
            'qty_requested', ep.qty_requested,
            'qty_sent', ep.qty_sent,
            'qty_returned', ep.qty_returned,
            'status', ep.status
          ) ORDER BY ep.id), '[]'::json)
          FROM external_processing ep
          WHERE ep.production_order_id = pr.production_order_id
            AND (ep.notes IS NOT NULL OR ep.short_return_reason IS NOT NULL)
        ) as external_processing_notes
      FROM packing_records pr
      LEFT JOIN users u ON pr.created_by = u.id
      LEFT JOIN production_orders po ON pr.production_order_id = po.id
      LEFT JOIN clients c ON po.client_id = c.id
      LEFT JOIN production_jobs pj ON pj.production_order_id = pr.production_order_id AND pj.status = 'completed'
      WHERE 1=1`
    const params = []
    if (production_order_id) { params.push(production_order_id); q += ` AND pr.production_order_id = $${params.length}` }
    q += ` ORDER BY pr.created_at DESC`
    res.json((await query(q, params)).rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/packing-records/:id', auth, async (req, res) => {
  try {
    const result = await query(`
      SELECT pr.*, u.name as created_by_name,
        po.order_number, po.client_id, po.notes as order_notes,
        c.name as client_name_joined,
        pj.notes_on_completion,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'id', ep.id,
            'processing_type', ep.processing_type,
            'product_name', ep.product_name,
            'supplier', ep.supplier,
            'notes', ep.notes,
            'short_return_reason', ep.short_return_reason,
            'qty_requested', ep.qty_requested,
            'qty_sent', ep.qty_sent,
            'qty_returned', ep.qty_returned,
            'status', ep.status
          ) ORDER BY ep.id), '[]'::json)
          FROM external_processing ep
          WHERE ep.production_order_id = pr.production_order_id
            AND (ep.notes IS NOT NULL OR ep.short_return_reason IS NOT NULL)
        ) as external_processing_notes
      FROM packing_records pr
      LEFT JOIN users u ON pr.created_by = u.id
      LEFT JOIN production_orders po ON pr.production_order_id = po.id
      LEFT JOIN clients c ON po.client_id = c.id
      LEFT JOIN production_jobs pj ON pj.production_order_id = pr.production_order_id AND pj.status = 'completed'
      WHERE pr.id = $1`, [req.params.id])
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/packing-records', auth, async (req, res) => {
  try {
    const { production_order_id, pallet_count, packed_by, notes, photos, line_items } = req.body
    if (!production_order_id) return res.status(400).json({ error: 'production_order_id required' })
    const orderRes = await query(
      `SELECT po.order_number, c.name as client_name FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE po.id = $1`,
      [production_order_id]
    )
    const clientName = orderRes.rows[0]?.client_name || null
    const items = line_items || []
    const totalPacked = items.reduce((sum, li) => sum + (li.total_packed || 0), 0)
    const result = await query(
      `INSERT INTO packing_records (production_order_id, client_name, pallet_count, total_products_packed, packed_by, notes, photos, line_items, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [production_order_id, clientName, pallet_count != null ? pallet_count : 0, totalPacked || null, packed_by || null, notes || null,
       JSON.stringify(photos || []), JSON.stringify(items), req.user.id]
    )
    await auditLog(req.user.id, 'packing_record_created', 'packing_record', result.rows[0].id,
      `Packing record for order #${production_order_id}`, { pallet_count, packed_by })
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
