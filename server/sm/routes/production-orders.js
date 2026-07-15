const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query, withTransaction } = require('../db')
const { auth, auditLog } = require('../auth')
const { buildLineComponents } = require('../services/bom-builder')
const { startProductionInternal } = require('./manufacturing')

// If production already started (production_jobs exists) and labels weren't debited yet
// (because they didn't exist when start ran), debit them now and log transaction.
// This handles the case where labels arrive AFTER production starts (common with EP flow).
async function debitLabelIfProductionStarted(labelId, lineId, orderId, clientId, userId) {
  if (!labelId || !lineId || !orderId) return
  // Check production has started
  const jobCheck = await query(`SELECT id FROM production_jobs WHERE production_order_id = $1 LIMIT 1`, [orderId])
  if (!jobCheck.rows[0]) return  // Not started yet — labels will debit at start time

  // Check if this label was already debited for this production order (avoid double-debit)
  const already = await query(
    `SELECT id FROM client_label_transactions
     WHERE client_label_id = $1 AND production_order_id = $2 AND type = 'used' LIMIT 1`,
    [labelId, orderId]
  )
  if (already.rows[0]) return  // already debited

  // Get line quantity
  const lineRow = await query(`SELECT quantity FROM production_order_lines WHERE id = $1`, [lineId])
  const qty = parseInt(lineRow.rows[0]?.quantity || 0)
  if (qty <= 0) return

  // Debit
  await query(`UPDATE client_labels SET quantity = GREATEST(0, quantity - $1) WHERE id = $2`, [qty, labelId])
  await query(
    `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, production_order_id, notes, user_id)
     VALUES ($1, $2, 'used', $3, $4, 'Used in production (late link via EP return)', $5)`,
    [labelId, clientId || null, qty, orderId, userId]
  )
}

// Resolve reservation priority from order's client segment
async function resolveOrderPriority(orderId, qFn) {
  const qry = qFn || query
  const r = await qry(
    `SELECT c.is_large_client FROM production_orders po
     LEFT JOIN clients c ON po.client_id = c.id WHERE po.id = $1`,
    [orderId]
  )
  return r.rows[0]?.is_large_client ? 'high' : 'normal'
}

// Check what 'normal' reservations would be displaced by a 'high' priority request
async function previewDisplacement(productId, requiredQty, excludeOrderId, qFn) {
  const qry = qFn || query
  const stockRow = await qry(`SELECT current_stock FROM products WHERE id = $1`, [productId])
  const currentStock = parseFloat(stockRow.rows[0]?.current_stock || 0)

  const reservedRow = await qry(
    `SELECT COALESCE(SUM(quantity_reserved), 0) as total
     FROM stock_reservations
     WHERE product_id = $1 AND status = 'reserved'
       AND production_order_id != $2`,
    [productId, excludeOrderId]
  )
  const totalReserved = parseFloat(reservedRow.rows[0].total)
  const available = Math.max(0, currentStock - totalReserved)

  if (available >= requiredQty) {
    return { needs_displacement: false, available, currentStock, totalReserved }
  }

  const shortfall = requiredQty - available
  const candidates = await qry(
    `SELECT sr.id, sr.quantity_reserved, sr.production_order_id, sr.priority,
            po.order_number, po.client_id, c.name as client_name, c.is_large_client
     FROM stock_reservations sr
     JOIN production_orders po ON sr.production_order_id = po.id
     LEFT JOIN clients c ON po.client_id = c.id
     WHERE sr.product_id = $1 AND sr.status = 'reserved'
       AND sr.priority = 'normal'
       AND sr.production_order_id != $2
     ORDER BY sr.created_at ASC`,
    [productId, excludeOrderId]
  )

  let remaining = shortfall
  const toDisplace = []
  for (const c of candidates.rows) {
    if (remaining <= 0) break
    const take = Math.min(parseFloat(c.quantity_reserved), remaining)
    toDisplace.push({
      reservation_id: c.id,
      order_number: c.order_number,
      order_id: c.production_order_id,
      client_name: c.client_name,
      quantity_to_displace: take,
      remaining_after: parseFloat(c.quantity_reserved) - take,
    })
    remaining -= take
  }

  return {
    needs_displacement: toDisplace.length > 0,
    available, currentStock, totalReserved,
    required: requiredQty,
    shortfall,
    would_displace: toDisplace,
    can_satisfy: remaining <= 0,
  }
}

async function createReservations(orderId, displaceLowPriority = false, userId = null) {
  const priority = await resolveOrderPriority(orderId)

  // Idempotent: clear any existing 'reserved' rows so re-running doesn't double up.
  // Consumed/cancelled rows are preserved (audit trail of production runs).
  await query(`DELETE FROM stock_reservations WHERE production_order_id = $1 AND status = 'reserved'`, [orderId])

  const comps = await query(
    `SELECT * FROM production_order_components WHERE production_order_id = $1 AND source = 'general_stock'`,
    [orderId]
  )
  for (const comp of comps.rows) {
    if (!comp.product_id) continue

    // High priority: check & execute displacement if needed
    if (priority === 'high' && displaceLowPriority) {
      const preview = await previewDisplacement(comp.product_id, parseFloat(comp.quantity_required), orderId)
      if (preview.needs_displacement) {
        for (const d of preview.would_displace) {
          await query(
            `UPDATE stock_reservations
             SET quantity_reserved = quantity_reserved - $1
             WHERE id = $2`,
            [d.quantity_to_displace, d.reservation_id]
          )
          await query(
            `INSERT INTO dashboard_alerts (alert_type, severity, message, related_order_id, related_product_id, details)
             VALUES ('reservation_displaced', 'warning', $1, $2, $3, $4::jsonb)`,
            [
              `Reservation reduced by ${d.quantity_to_displace} ${comp.unit || 'units'} for ${comp.product_code || 'product'} — displaced by higher priority order`,
              d.order_id,
              comp.product_id,
              JSON.stringify({ displaced_by_order_id: orderId, quantity_displaced: d.quantity_to_displace, product_code: comp.product_code })
            ]
          )
        }
      }
    }

    await query(
      `INSERT INTO stock_reservations (production_order_id, production_order_line_id, product_id, product_code, source, quantity_reserved, status, priority)
       VALUES ($1,$2,$3,$4,'general_stock',$5,'reserved',$6)
       ON CONFLICT (production_order_id, product_id) WHERE product_id IS NOT NULL AND client_stock_id IS NULL
       DO UPDATE SET quantity_reserved = stock_reservations.quantity_reserved + EXCLUDED.quantity_reserved`,
      [orderId, comp.production_order_line_id, comp.product_id, comp.product_code, comp.quantity_required, priority]
    )
  }

  const csComps = await query(
    `SELECT * FROM production_order_components WHERE production_order_id = $1 AND source = 'client_stock' AND client_stock_id IS NOT NULL`,
    [orderId]
  )
  for (const comp of csComps.rows) {
    await query(
      `INSERT INTO stock_reservations (production_order_id, production_order_line_id, client_stock_id, product_code, source, quantity_reserved, status, priority)
       VALUES ($1,$2,$3,$4,'client_stock',$5,'reserved',$6)
       ON CONFLICT (production_order_id, client_stock_id) WHERE client_stock_id IS NOT NULL
       DO UPDATE SET quantity_reserved = stock_reservations.quantity_reserved + EXCLUDED.quantity_reserved`,
      [orderId, comp.production_order_line_id, comp.client_stock_id, comp.product_code, comp.quantity_required, priority]
    )
  }
}

async function getNextOrderNumber() {
  const result = await query(`SELECT order_number FROM production_orders ORDER BY id DESC LIMIT 1`)
  if (!result.rows[0]) return 'SM-001'
  const last = result.rows[0].order_number
  const num = parseInt(last.replace('SM-', '')) + 1
  return `SM-${String(num).padStart(3, '0')}`
}

// Pre-flight check: would a Major Client order need to displace MUSE/Standard reservations?
// Frontend calls this before confirming order creation. Returns list of would-be displacements.
router.post('/reservations/check-displacement', auth, async (req, res) => {
  try {
    const { client_id, components } = req.body
    // components: [{ product_id, quantity_required }, ...]
    if (!Array.isArray(components) || components.length === 0) {
      return res.status(400).json({ error: 'components array required' })
    }

    let priority = 'normal'
    if (client_id) {
      const cli = await query(`SELECT is_large_client FROM clients WHERE id = $1`, [client_id])
      priority = cli.rows[0]?.is_large_client ? 'high' : 'normal'
    }

    if (priority !== 'high') {
      return res.json({ priority, displacements: [], any_displacement: false })
    }

    const displacements = []
    for (const comp of components) {
      if (!comp.product_id) continue
      const preview = await previewDisplacement(
        parseInt(comp.product_id),
        parseFloat(comp.quantity_required),
        0  // no order to exclude (this is pre-creation)
      )
      if (preview.needs_displacement) {
        const prodInfo = await query(`SELECT product_code, name, unit FROM products WHERE id = $1`, [comp.product_id])
        displacements.push({
          product_id: comp.product_id,
          product_code: prodInfo.rows[0]?.product_code,
          product_name: prodInfo.rows[0]?.name,
          unit: prodInfo.rows[0]?.unit,
          ...preview,
        })
      }
    }

    res.json({ priority, displacements, any_displacement: displacements.length > 0 })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/production-orders', auth, async (req, res) => {
  try {
    const { status, order_type, client_id } = req.query
    let q = `SELECT po.*, c.name as client_name FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE 1=1`
    const params = []
    if (status) { params.push(status); q += ` AND po.status = $${params.length}` }
    if (order_type) { params.push(order_type); q += ` AND po.order_type = $${params.length}` }
    if (client_id) { params.push(client_id); q += ` AND po.client_id = $${params.length}` }
    q += ` ORDER BY po.created_at DESC`
    const result = await query(q, params)
    for (const order of result.rows) {
      const lines = await query(
        `SELECT pol.*, p.name as fragrance_name, pfg.name as fg_product_name, pfg.volume_ml, pfg.default_oil_pct
         FROM production_order_lines pol
         LEFT JOIN products p ON pol.fragrance_id = p.id
         LEFT JOIN products pfg ON pfg.product_code = pol.product_type AND pfg.category = 'FINISHED_GOOD'
         WHERE pol.production_order_id = $1 ORDER BY pol.line_number`,
        [order.id]
      )
      order.lines = lines.rows
    }
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// In-production quantities for MUSE finished goods — per master + fragrance.
// MUSE finished goods are produced (not reserved); this is the incoming/queued qty.
router.get('/muse/in-production', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT m.id as master_id, pol.fragrance_id, SUM(pol.quantity) as qty
       FROM production_order_lines pol
       JOIN production_orders po ON po.id = pol.production_order_id
       JOIN products m ON m.product_code = pol.product_type AND m.is_master = true AND m.segment = 'MUSE'
       WHERE po.client_id IS NULL
         AND po.status NOT IN ('fulfilled','cancelled')
       GROUP BY m.id, pol.fragrance_id`
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/production-orders/:id', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT po.*, c.name as client_name FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE po.id = $1`,
      [req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' })
    const order = result.rows[0]
    const lines = await query(
      `SELECT pol.*, pf.name as fragrance_name, pp.name as packaging_name, pfg.name as fg_product_name, pfg.volume_ml, pfg.default_oil_pct
       FROM production_order_lines pol
       LEFT JOIN products pf ON pol.fragrance_id = pf.id
       LEFT JOIN products pp ON pol.packaging_component_id = pp.id
       LEFT JOIN products pfg ON pfg.product_code = pol.product_type AND pfg.category = 'FINISHED_GOOD'
       WHERE pol.production_order_id = $1 ORDER BY pol.line_number`,
      [order.id]
    )
    order.lines = lines.rows
    for (const line of order.lines) {
      const comps = await query(
        `SELECT poc.*, p.current_stock FROM production_order_components poc LEFT JOIN products p ON poc.product_id = p.id WHERE poc.production_order_line_id = $1`,
        [line.id]
      )
      line.components = comps.rows
    }
    const ep = await query(
      `SELECT * FROM external_processing WHERE production_order_id = $1 ORDER BY sent_date DESC`,
      [order.id]
    )
    order.external_processing = ep.rows
    res.json(order)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/production-orders', auth, async (req, res) => {
  try {
    const { client_id, order_type, due_date, notes, lines, displace_low_priority } = req.body
    if (!lines || lines.length === 0) return res.status(400).json({ error: 'At least one line item required' })

    const orderNumber = await getNextOrderNumber()

    const order = await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)

      const orderResult = await tq(
        `INSERT INTO production_orders (order_number, client_id, order_type, due_date, notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'draft',$6) RETURNING *`,
        [orderNumber, client_id || null, order_type || 'STANDARD', due_date || null, notes || null, req.user.id]
      )
      const ord = orderResult.rows[0]

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const lineResult = await tq(
          `INSERT INTO production_order_lines (production_order_id, line_number, product_type, fragrance_id, oil_id, variant_name, oil_pct, packaging_component_id, label_client_label_id, quantity, unit_price, is_candle, labels_required, labels_supplier, labels_eta, needs_labeling, needs_packing, labels_order_qty, use_ready_formula, ready_formula_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
          [ord.id, i + 1, line.product_type, line.fragrance_id || null, line.oil_id || null, line.variant_name || null, line.oil_pct || 25,
           line.packaging_component_id || null, line.label_client_label_id || null, line.quantity,
           ['CANDLE_240G', 'CANDLE_400G'].includes(line.product_type),
           !!(line.labels_supplier || line.labels_eta), line.labels_supplier || null, line.labels_eta || null,
           line.needs_labeling || false, line.needs_packing || false,
           line.labels_order_qty ? parseInt(line.labels_order_qty) : null,
           line.use_ready_formula || false, line.ready_formula_id ? parseInt(line.ready_formula_id) : null]
        )
        const dbLine = lineResult.rows[0]
        await buildLineComponents(ord.id, dbLine, line, client_id, tq)

        if (line.component_overrides && line.component_overrides.length > 0) {
          for (const ovr of line.component_overrides) {
            if (ovr.product_id) {
              if (parseFloat(ovr.quantity_required) === 0) {
                await tq(`DELETE FROM production_order_components WHERE production_order_line_id = $1 AND product_id = $2`, [dbLine.id, ovr.product_id])
              } else {
                await tq(
                  `UPDATE production_order_components SET quantity_required = $1, was_overridden = true, override_reason = $2 WHERE production_order_line_id = $3 AND product_id = $4`,
                  [ovr.quantity_required, ovr.override_reason || null, dbLine.id, ovr.product_id]
                )
              }
            } else if (ovr.label_id) {
              await tq(
                `UPDATE production_order_components SET quantity_required = $1, was_overridden = true, override_reason = $2 WHERE production_order_line_id = $3 AND product_name ILIKE '%label%'`,
                [ovr.quantity_required, ovr.override_reason || null, dbLine.id]
              )
            }
          }
        }
      }

      return ord
    })

    await createReservations(order.id, !!displace_low_priority, req.user.id)
    const clientRow = client_id ? (await query(`SELECT name FROM clients WHERE id = $1`, [client_id])).rows[0] : null
    await auditLog(req.user.id, 'production_order_created', 'production_order', order.id, orderNumber, { client: clientRow?.name || 'MUSE Internal', order_type, displaced: !!displace_low_priority })

    const linesRes = await query(
      `SELECT pol.*, pf.name as fragrance_name, pfg.name as fg_product_name, cl.label_name
       FROM production_order_lines pol
       LEFT JOIN products pf ON pol.fragrance_id = pf.id
       LEFT JOIN products pfg ON pfg.product_code = pol.product_type AND pfg.category = 'FINISHED_GOOD'
       LEFT JOIN client_labels cl ON cl.id = pol.label_client_label_id
       WHERE pol.production_order_id = $1 ORDER BY pol.line_number`,
      [order.id]
    )
    res.status(201).json({ ...order, id: order.id, order_number: orderNumber, lines: linesRes.rows, client_name: clientRow?.name || null })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: sanitizeError(e) })
  }
})

// Edit a draft order — replaces metadata + lines + components. Only allowed while
// the order is still 'draft' (before Shopify/queue/manufacturing touched anything).
router.put('/production-orders/:id', auth, async (req, res) => {
  try {
    const { client_id, order_type, due_date, notes, lines } = req.body
    const orderId = parseInt(req.params.id)
    if (!lines || lines.length === 0) return res.status(400).json({ error: 'At least one line item required' })

    const cur = await query(`SELECT * FROM production_orders WHERE id = $1`, [orderId])
    if (!cur.rows[0]) return res.status(404).json({ error: 'Not found' })
    if (cur.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft orders can be edited' })
    }

    await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)

      await tq(
        `UPDATE production_orders SET client_id=$1, order_type=$2, due_date=$3, notes=$4, updated_at=NOW() WHERE id=$5`,
        [client_id || null, order_type || 'STANDARD', due_date || null, notes || null, orderId]
      )

      // Wipe lines — CASCADE removes production_order_components + any reservations.
      await tq(`DELETE FROM production_order_lines WHERE production_order_id = $1`, [orderId])

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const lineResult = await tq(
          `INSERT INTO production_order_lines (production_order_id, line_number, product_type, fragrance_id, oil_id, variant_name, oil_pct, packaging_component_id, label_client_label_id, quantity, unit_price, is_candle, labels_required, labels_supplier, labels_eta, needs_labeling, needs_packing, labels_order_qty, use_ready_formula, ready_formula_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
          [orderId, i + 1, line.product_type, line.fragrance_id || null, line.oil_id || null, line.variant_name || null, line.oil_pct || 25,
           line.packaging_component_id || null, line.label_client_label_id || null, line.quantity,
           ['CANDLE_240G', 'CANDLE_400G'].includes(line.product_type),
           !!(line.labels_supplier || line.labels_eta), line.labels_supplier || null, line.labels_eta || null,
           line.needs_labeling || false, line.needs_packing || false,
           line.labels_order_qty ? parseInt(line.labels_order_qty) : null,
           line.use_ready_formula || false, line.ready_formula_id ? parseInt(line.ready_formula_id) : null]
        )
        const dbLine = lineResult.rows[0]
        await buildLineComponents(orderId, dbLine, line, client_id, tq)

        if (line.component_overrides && line.component_overrides.length > 0) {
          for (const ovr of line.component_overrides) {
            if (ovr.product_id) {
              if (parseFloat(ovr.quantity_required) === 0) {
                await tq(`DELETE FROM production_order_components WHERE production_order_line_id = $1 AND product_id = $2`, [dbLine.id, ovr.product_id])
              } else {
                await tq(
                  `UPDATE production_order_components SET quantity_required = $1, was_overridden = true, override_reason = $2 WHERE production_order_line_id = $3 AND product_id = $4`,
                  [ovr.quantity_required, ovr.override_reason || null, dbLine.id, ovr.product_id]
                )
              }
            } else if (ovr.label_id) {
              await tq(
                `UPDATE production_order_components SET quantity_required = $1, was_overridden = true, override_reason = $2 WHERE production_order_line_id = $3 AND product_name ILIKE '%label%'`,
                [ovr.quantity_required, ovr.override_reason || null, dbLine.id]
              )
            }
          }
        }
      }
    })

    // Lines + components were rebuilt — old reservations were CASCADE-deleted with the lines.
    // Recreate reservations from the new components (mirrors POST flow).
    await createReservations(orderId)

    const clientRow = client_id ? (await query(`SELECT name FROM clients WHERE id = $1`, [client_id])).rows[0] : null
    await auditLog(req.user.id, 'production_order_edited', 'production_order', orderId, cur.rows[0].order_number, { client: clientRow?.name || 'MUSE Internal', order_type })

    const linesRes = await query(
      `SELECT pol.*, pf.name as fragrance_name, pfg.name as fg_product_name, cl.label_name
       FROM production_order_lines pol
       LEFT JOIN products pf ON pol.fragrance_id = pf.id
       LEFT JOIN products pfg ON pfg.product_code = pol.product_type AND pfg.category = 'FINISHED_GOOD'
       LEFT JOIN client_labels cl ON cl.id = pol.label_client_label_id
       WHERE pol.production_order_id = $1 ORDER BY pol.line_number`,
      [orderId]
    )
    res.json({ ...cur.rows[0], client_id: client_id || null, order_type: order_type || 'STANDARD', due_date: due_date || null, notes: notes || null, lines: linesRes.rows, client_name: clientRow?.name || null })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: sanitizeError(e) })
  }
})

router.put('/production-orders/:id/status', auth, async (req, res) => {
  try {
    const { status, external_type, external_supplier, external_expected_at } = req.body
    const orderId = parseInt(req.params.id)

    // Transitioning to 'in_production' for the first time?
    // If no production_jobs exists yet, run the full start logic (debit stock + create job).
    // Stock is debited ONLY when the warehouse actually starts production — 'waiting_external'
    // (external processing requested) keeps the BOM reserved, not debited.
    if (status === 'in_production') {
      const jobCheck = await query(`SELECT id FROM production_jobs WHERE production_order_id = $1 LIMIT 1`, [orderId])
      if (!jobCheck.rows[0]) {
        // First time entering production — debit stock now
        await startProductionInternal(orderId, req.user.id, status)
        return res.json({ success: true, started: true })
      }
    }

    if (status === 'waiting_external') {
      await query(
        `UPDATE production_orders SET status = $1, external_type = $2, external_supplier = $3, external_expected_at = $4, updated_at = NOW() WHERE id = $5`,
        [status, external_type || null, external_supplier || null, external_expected_at || null, orderId]
      )
    } else {
      await query(`UPDATE production_orders SET status = $1, updated_at = NOW() WHERE id = $2`, [status, orderId])
    }

    if (status === 'queued') {
      await createReservations(orderId)
    }

    // Cleanup: only mark EP as done. Do NOT force reservations to 'consumed' — that should only happen via
    // real production debit (startProductionInternal) or via complete handler. Marking 'consumed' here
    // without debiting stock creates the illusion that stock was consumed when it wasn't.
    if (['completed', 'fulfilled'].includes(status)) {
      await query(
        `UPDATE external_processing SET status = 'done', actual_return = COALESCE(actual_return, NOW()) WHERE production_order_id = $1 AND status IN ('sent','partial')`,
        [orderId]
      )
    }
    if (status === 'cancelled') {
      await query(
        `UPDATE stock_reservations SET status = 'cancelled' WHERE production_order_id = $1 AND status = 'reserved'`,
        [parseInt(req.params.id)]
      )
    }

    const orderRow = await query(`SELECT order_number FROM production_orders WHERE id = $1`, [req.params.id])
    await auditLog(req.user.id, 'production_order_status_changed', 'production_order', parseInt(req.params.id), orderRow.rows[0]?.order_number, { status })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// ?mode=cancel → soft-cancel (status=cancelled, stays visible in filter)
// ?mode=discard → hard-delete (only for draft/cancelled, removes permanently)
router.delete('/production-orders/:id', auth, async (req, res) => {
  try {
    const userId = req.query.userId || req.user.id
    const mode = req.query.mode || 'cancel'
    const po = await query(`SELECT * FROM production_orders WHERE id = $1`, [req.params.id])
    if (!po.rows[0]) return res.status(404).json({ error: 'Not found' })
    if (mode === 'discard') {
      if (!['draft', 'cancelled'].includes(po.rows[0].status)) {
        return res.status(400).json({ error: 'Only draft or cancelled orders can be permanently deleted' })
      }
      await query(`DELETE FROM production_orders WHERE id = $1`, [req.params.id])
      await auditLog(userId, 'production_order_deleted', 'production_order', parseInt(req.params.id), po.rows[0].order_number, {})
      res.json({ success: true, mode: 'deleted' })
    } else {
      if (!['draft', 'confirmed'].includes(po.rows[0].status)) {
        return res.status(400).json({ error: 'Only draft or confirmed orders can be cancelled' })
      }
      await query(`UPDATE production_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [req.params.id])
      await query(`UPDATE stock_reservations SET status = 'cancelled' WHERE production_order_id = $1 AND status = 'reserved'`, [req.params.id])
      await auditLog(userId, 'production_order_cancelled', 'production_order', parseInt(req.params.id), po.rows[0].order_number, {})
      res.json({ success: true, mode: 'cancelled' })
    }
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// ── External Processing ──────────────────────────────────────────────────────

router.post('/external-processing', auth, async (req, res) => {
  try {
    const { production_order_id, production_order_line_id, client_id, product_name, processing_type, qty_requested, qty_sent, supplier, expected_return, notes, client_label_id, set_waiting } = req.body
    if (!product_name || !processing_type) return res.status(400).json({ error: 'product_name and processing_type required' })
    const isLabels = processing_type === 'labels'
    const hasSent = !isLabels && qty_sent && parseFloat(qty_sent) > 0
    const epStatus = isLabels ? 'requested' : (hasSent ? 'sent' : 'requested')
    const result = await query(
      `INSERT INTO external_processing (production_order_id, production_order_line_id, client_id, product_name, processing_type, qty_requested, qty_sent, supplier, expected_return, sent_date, status, notes, client_label_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${hasSent ? 'NOW()' : 'NULL'},$10,$11,$12) RETURNING *`,
      [production_order_id || null, production_order_line_id || null, client_id || null, product_name, processing_type,
       qty_requested ? parseFloat(qty_requested) : null, hasSent ? parseFloat(qty_sent) : null,
       supplier || null, expected_return || null, epStatus, notes || null, client_label_id || null]
    )
    // Candle filling EP → advance the linked line status so manufacturing queue doesn't ask to send again
    if (processing_type === 'candle_filling' && production_order_line_id) {
      await query(
        `UPDATE production_order_lines SET candle_status = 'sent_for_filling', line_status = 'sent_for_filling', sent_for_filling_at = COALESCE(sent_for_filling_at, NOW()), filling_supplier = COALESCE(filling_supplier, $1) WHERE id = $2`,
        [supplier || null, production_order_line_id]
      )
    }
    if (set_waiting && production_order_id) {
      // Requesting external processing does NOT debit stock. The BOM stays reserved
      // and is only debited when the warehouse actually starts production
      // (startProductionInternal, triggered by Start/Resume Production → in_production).
      await query(
        `UPDATE production_orders SET status = 'waiting_external', external_type = $1, external_supplier = $2, updated_at = NOW() WHERE id = $3`,
        [processing_type, supplier || null, production_order_id]
      )
    }
    await auditLog(req.user.id, 'external_processing_created', 'external_processing', result.rows[0].id, product_name, { processing_type, qty_sent })
    res.status(201).json(result.rows[0])
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/external-processing/:id/return', auth, async (req, res) => {
  try {
    const { qty_returned, notes, short_return_reason, create_label, label_name, artwork_version, applicable_product_type } = req.body
    if (!qty_returned) return res.status(400).json({ error: 'qty_returned required' })
    const ep = await query(`SELECT * FROM external_processing WHERE id = $1`, [req.params.id])
    if (!ep.rows[0]) return res.status(404).json({ error: 'Not found' })
    const item = ep.rows[0]
    const qtyReturned = parseFloat(qty_returned)
    const isLabels = item.processing_type === 'labels'
    const refQty = isLabels ? parseFloat(item.qty_requested || 0) : parseFloat(item.qty_sent || 0)
    const totalReturned = parseFloat(item.qty_returned || 0) + qtyReturned
    if (refQty > 0 && totalReturned < refQty && !short_return_reason?.trim()) {
      return res.status(400).json({ error: 'Justification required when quantity returned is less than expected' })
    }
    const newStatus = totalReturned >= refQty ? 'done' : 'partial'
    await query(
      `UPDATE external_processing SET qty_returned = $1, actual_return = NOW(), status = $2, notes = COALESCE($3, notes), short_return_reason = COALESCE($4, short_return_reason) WHERE id = $5`,
      [totalReturned, newStatus, notes || null, short_return_reason || null, req.params.id]
    )

    let labelId = item.client_label_id
    // Fallback: if no client_label_id on EP, look it up from the linked production order line
    if (!labelId && item.processing_type === 'labels' && item.production_order_line_id) {
      const polLabel = await query(
        `SELECT label_client_label_id FROM production_order_lines WHERE id = $1 AND label_client_label_id IS NOT NULL`,
        [item.production_order_line_id]
      )
      if (polLabel.rows[0]) labelId = polLabel.rows[0].label_client_label_id
    }

    // Auto-create label if EP is for labels and no existing label is associated (prevents labels from disappearing)
    const shouldAutoCreate = item.processing_type === 'labels' && !labelId && item.client_id
    if (create_label || shouldAutoCreate) {
      const finalName = label_name || item.product_name || `Label from EP #${item.id}`

      // '--None--' was chosen on the EP (no linked label) → this is a NEW label, typically a new
      // artwork version the client requested. Auto-increment the version: if v1/v3 already exist
      // for this name, the new one becomes v4. To re-stock the SAME artwork, link the EP to the
      // existing label instead of leaving it None (that path adds quantity on top).
      let version = artwork_version
      if (!version) {
        const sameName = await query(
          `SELECT artwork_version FROM client_labels
           WHERE client_id = $1 AND LOWER(TRIM(label_name)) = LOWER(TRIM($2))`,
          [item.client_id, finalName]
        )
        const maxNum = sameName.rows.reduce((mx, r) => {
          const m = String(r.artwork_version || '').match(/(\d+)/)
          return Math.max(mx, m ? parseInt(m[1], 10) : 0)
        }, 0)
        version = 'v' + (maxNum + 1)
      }

      const newLabel = await query(
        `INSERT INTO client_labels (client_id, label_name, artwork_version, applicable_product_type, quantity, supplier, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [item.client_id, finalName, version, applicable_product_type || null, qtyReturned, item.supplier || null, `Auto-created from EP return — ${item.product_name}`]
      )
      labelId = newLabel.rows[0].id

      await query(`UPDATE external_processing SET client_label_id = $1 WHERE id = $2`, [labelId, req.params.id])

      // Also link the label back to the production_order_line so leftover credit works at complete time
      if (item.production_order_line_id) {
        await query(
          `UPDATE production_order_lines SET label_client_label_id = $1 WHERE id = $2 AND label_client_label_id IS NULL`,
          [labelId, item.production_order_line_id]
        )
      }

      await query(
        `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, notes, user_id) VALUES ($1,$2,'received',$3,$4,$5)`,
        [labelId, item.client_id, qtyReturned, notes || `External processing return — ${item.product_name}`, req.user.id]
      )

      // If production already started, debit the labels now (start handler ran before label was linked)
      await debitLabelIfProductionStarted(labelId, item.production_order_line_id, item.production_order_id, item.client_id, req.user.id)
    } else if (labelId) {
      // Existing label: just add quantity
      await query(`UPDATE client_labels SET quantity = quantity + $1 WHERE id = $2`, [qtyReturned, labelId])
      if (item.client_id) {
        await query(
          `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, notes, user_id) VALUES ($1,$2,'received',$3,$4,$5)`,
          [labelId, item.client_id, qtyReturned, notes || 'External processing return', req.user.id]
        )
      }
      // Link back to the production_order_line if not already linked
      if (item.production_order_line_id) {
        await query(
          `UPDATE production_order_lines SET label_client_label_id = $1 WHERE id = $2 AND label_client_label_id IS NULL`,
          [labelId, item.production_order_line_id]
        )
      }
      // If production already started, debit labels now
      await debitLabelIfProductionStarted(labelId, item.production_order_line_id, item.production_order_id, item.client_id, req.user.id)
    }

    // Candle filling fully returned → advance the linked production_order_line status
    // (parity with /manufacturing/:id/lines/:lineId/receive-from-filling endpoint)
    if (item.processing_type === 'candle_filling' && item.production_order_line_id && newStatus === 'done') {
      const lineRow = await query(
        `SELECT needs_labeling, needs_packing FROM production_order_lines WHERE id = $1`,
        [item.production_order_line_id]
      )
      if (lineRow.rows[0]) {
        const { needs_labeling, needs_packing } = lineRow.rows[0]
        const advanceTo = (!needs_labeling && !needs_packing) ? 'done' : 'filling_done'
        const isDone = advanceTo === 'done'
        await query(
          `UPDATE production_order_lines SET candle_status = 'received_from_filling', line_status = $1, received_from_filling_at = NOW(),
                  line_completed_at = CASE WHEN $2 THEN NOW() ELSE NULL END
           WHERE id = $3 AND line_status = 'sent_for_filling'`,
          [advanceTo, isDone, item.production_order_line_id]
        )
        // If no more lines waiting, bring order back to in_production
        const pending = await query(
          `SELECT COUNT(*) FROM production_order_lines WHERE production_order_id = $1 AND line_status = 'sent_for_filling'`,
          [item.production_order_id]
        )
        if (parseInt(pending.rows[0].count) === 0 && item.production_order_id) {
          await query(`UPDATE production_orders SET status = 'in_production', updated_at = NOW() WHERE id = $1 AND status = 'waiting_external'`, [item.production_order_id])
        }
      }
    }

    await auditLog(req.user.id, 'external_processing_returned', 'external_processing', item.id, item.product_name, { qty_returned: qtyReturned, newStatus })
    res.json({ success: true, status: newStatus, label_id: labelId })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/external-processing/:id/mark-sent', auth, async (req, res) => {
  try {
    const { qty_sent } = req.body
    if (!qty_sent || parseFloat(qty_sent) <= 0) return res.status(400).json({ error: 'qty_sent required' })
    await query(
      `UPDATE external_processing SET qty_sent = $1, sent_date = NOW(), status = 'sent' WHERE id = $2`,
      [parseFloat(qty_sent), req.params.id]
    )
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.put('/external-processing/:id/close', auth, async (req, res) => {
  try {
    await query(
      `UPDATE external_processing SET status = 'done', actual_return = COALESCE(actual_return, NOW()) WHERE id = $1`,
      [req.params.id]
    )
    await auditLog(req.user.id, 'external_processing_closed', 'external_processing', parseInt(req.params.id), null, {})
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
