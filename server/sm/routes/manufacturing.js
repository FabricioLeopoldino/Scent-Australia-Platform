const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query, withTransaction } = require('../db')
const { auth, auditLog } = require('../auth')
const { adjustProductStock } = require('../services/stock-service')
const { ensureMuseSku } = require('./masters')
const { consumeFragranceOil, restoreFragranceOil } = require('../services/fragrance-library')

// D14: which of the 4 usage buckets (SA is the 4th, native to the SA module)
// an order belongs to — MUSE (no client) vs a B2B client, split by
// is_large_client into Major vs Standard. Shared by startProductionInternal
// (the debit) and /complete (finished-goods + reporting) so the two can never
// disagree about which bucket an order's oil consumption lands in.
async function resolveOrderSegment(order, tq) {
  const qry = tq || query
  const isMuse = !order.client_id
  if (isMuse) return 'MUSE'
  const cli = await qry(`SELECT is_large_client FROM clients WHERE id = $1`, [order.client_id])
  return cli.rows[0]?.is_large_client ? 'MAJOR' : 'STANDARD'
}

router.get('/manufacturing/queue', auth, async (req, res) => {
  try {
    const { order_type, sort } = req.query
    let q = `SELECT po.*, c.name as client_name FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE po.status IN ('queued','in_production','waiting_external')`
    const params = []
    if (order_type && order_type !== 'ALL') {
      if (order_type === 'CANDLE') {
        q += ` AND EXISTS (SELECT 1 FROM production_order_lines pol WHERE pol.production_order_id = po.id AND pol.is_candle = true)`
      } else {
        params.push(order_type)
        q += ` AND po.order_type = $${params.length}`
      }
    }
    const sortMap = { client: 'c.name ASC, po.due_date ASC NULLS LAST', created: 'po.created_at DESC' }
    q += ` ORDER BY ${sortMap[sort] || 'po.due_date ASC NULLS LAST, po.created_at ASC'}`
    const result = await query(q, params)

    for (const order of result.rows) {
      const lines = await query(
        `SELECT pol.*, pf.name as fragrance_name, cl.label_name, cl.artwork_version, cl.quantity as label_stock,
                pfg.name as fg_product_name,
                ep.id as labels_ep_id, ep.status as labels_ep_status,
                ep.supplier as labels_ep_supplier, ep.expected_return as labels_ep_eta,
                ep.qty_requested as labels_ep_qty_requested, ep.qty_returned as labels_ep_qty_returned
         FROM production_order_lines pol
         LEFT JOIN products pf ON pol.fragrance_id = pf.id
         LEFT JOIN client_labels cl ON cl.id = pol.label_client_label_id
         LEFT JOIN products pfg ON pfg.product_code = pol.product_type AND pfg.category = 'FINISHED_GOOD'
         LEFT JOIN LATERAL (
           SELECT id, status, supplier, expected_return, qty_requested, qty_returned
           FROM external_processing
           WHERE production_order_line_id = pol.id AND processing_type = 'labels'
           ORDER BY created_at DESC LIMIT 1
         ) ep ON true
         WHERE pol.production_order_id = $1 ORDER BY pol.line_number`,
        [order.id]
      )
      order.lines = lines.rows

      const resv = await query(
        `SELECT COUNT(*) as total, COUNT(CASE WHEN status='reserved' THEN 1 END) as reserved FROM stock_reservations WHERE production_order_id = $1`,
        [order.id]
      )
      order.stock_reserved = parseInt(resv.rows[0].total) > 0
      order.stock_all_reserved = parseInt(resv.rows[0].reserved) === parseInt(resv.rows[0].total) && parseInt(resv.rows[0].total) > 0
      order.labels_short = lines.rows.some(l => l.label_client_label_id && l.label_stock !== null && parseInt(l.label_stock) < parseInt(l.quantity))
      order.labels_eta = lines.rows.filter(l => l.labels_eta).map(l => l.labels_eta).sort()[0] || null

      const job = await query(`SELECT * FROM production_jobs WHERE production_order_id = $1 ORDER BY created_at DESC LIMIT 1`, [order.id])
      order.job = job.rows[0] || null
    }

    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// Internal helper — runs full "start production" logic (debit stock + create job).
// Can be called from /start endpoint, or from PUT /status, or from POST /external-processing with set_waiting.
// Idempotent: if production_jobs already exists for this order, it's a no-op for the debit (just updates status).
// `targetStatus` lets caller choose between 'in_production' (normal start) or 'waiting_external' (EP set_waiting flow).
async function startProductionInternal(orderId, userId, targetStatus = 'in_production') {
  const order = await query(`SELECT * FROM production_orders WHERE id = $1`, [orderId])
  if (!order.rows[0]) throw new Error('Order not found')

  // Check if production_jobs already exists — if so, skip the debit (already done)
  const existingJob = await query(`SELECT id FROM production_jobs WHERE production_order_id = $1 LIMIT 1`, [orderId])
  if (existingJob.rows[0]) {
    // Job already exists — just update order status if needed (e.g., resume from waiting_external)
    await query(`UPDATE production_orders SET status = $1, updated_at = NOW() WHERE id = $2`, [targetStatus, orderId])
    return { job: existingJob.rows[0], skipped_debit: true }
  }

  return await withTransaction(async (client) => {
    const tq = (text, params) => client.query(text, params)

    const jobRow = await tq(
      `INSERT INTO production_jobs (production_order_id, started_by, status) VALUES ($1,$2,'in_production') RETURNING *`,
      [orderId, userId]
    )
    await tq(`UPDATE production_orders SET status = $1, updated_at = NOW() WHERE id = $2`, [targetStatus, orderId])

    // Safety net: if reservations are missing (e.g. order was edited and the recreate
    // step failed for some reason), rebuild them from production_order_components so
    // the debit loop below has rows to consume. Otherwise the order would silently
    // proceed to in_production without any stock being debited.
    const resvCheck = await tq(`SELECT COUNT(*) as n FROM stock_reservations WHERE production_order_id = $1 AND status = 'reserved'`, [orderId])
    if (parseInt(resvCheck.rows[0].n) === 0) {
      await tq(
        `INSERT INTO stock_reservations (production_order_id, production_order_line_id, product_id, product_code, source, quantity_reserved, status, priority)
         SELECT production_order_id, production_order_line_id, product_id, product_code, 'general_stock', quantity_required, 'reserved', 'normal'
         FROM production_order_components
         WHERE production_order_id = $1 AND source = 'general_stock' AND product_id IS NOT NULL`,
        [orderId]
      )
      await tq(
        `INSERT INTO stock_reservations (production_order_id, production_order_line_id, client_stock_id, product_code, source, quantity_reserved, status, priority)
         SELECT production_order_id, production_order_line_id, client_stock_id, product_code, 'client_stock', quantity_required, 'reserved', 'normal'
         FROM production_order_components
         WHERE production_order_id = $1 AND source = 'client_stock' AND client_stock_id IS NOT NULL`,
        [orderId]
      )
    }

    const reservations = await tq(`SELECT * FROM stock_reservations WHERE production_order_id = $1 AND status = 'reserved'`, [orderId])
    for (const res_item of reservations.rows) {
      if (res_item.source === 'general_stock' && res_item.product_id) {
        await tq(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [res_item.product_id])
        await adjustProductStock(res_item.product_id, -res_item.quantity_reserved, 'production_debit',
          `Production: ${order.rows[0].order_number}`, userId, orderId, null, tq)
        await tq(`UPDATE stock_reservations SET status = 'consumed', quantity_consumed = $1 WHERE id = $2`, [res_item.quantity_reserved, res_item.id])
      }
    }

    // D14 Fragrance Library — direct debit, no reservation (D14.6). Each line
    // with an oil_id got its mL precomputed at order creation (bom-builder.js);
    // debit it now, tagged with the order's segment (SA/SM-Std/SM-Major/MUSE
    // usage traceability, D14.5). Negative stock is allowed here on purpose —
    // see fragrance-library.js.
    const oilLines = await tq(
      `SELECT id, oil_id, oil_qty_ml FROM production_order_lines
       WHERE production_order_id = $1 AND oil_id IS NOT NULL AND oil_qty_ml > 0`,
      [orderId]
    )
    if (oilLines.rows.length > 0) {
      const segment = await resolveOrderSegment(order.rows[0], tq)
      for (const line of oilLines.rows) {
        await consumeFragranceOil(tq, line.oil_id, line.oil_qty_ml, segment, `Production: ${order.rows[0].order_number}`)
      }
    }

    // Ready formula direct debit
    const rfLines = await tq(
      `SELECT pol.*, p.id as rf_id, p.current_stock as rf_stock
       FROM production_order_lines pol
       JOIN products p ON p.id = pol.ready_formula_id
       WHERE pol.production_order_id = $1 AND pol.use_ready_formula = true AND pol.ready_formula_id IS NOT NULL`,
      [orderId]
    )
    for (const pol of rfLines.rows) {
      const volume = { TRAVEL_SPRAY_10ML:10, ROOM_SPRAY_50ML:50, ROOM_SPRAY_100ML:100, REED_DIFFUSER_200ML:200, MICRO_OIL_15ML:15, CANDLE_240G:240, CANDLE_400G:400 }[pol.product_type] || 0
      const oilPct = parseFloat(pol.oil_pct) || 25
      const qty = parseInt(pol.quantity)
      const ethanolQty = qty * volume * ((100 - oilPct) / 100)
      const fragQty = pol.product_type === 'MICRO_OIL_15ML' ? qty * volume : qty * volume * (oilPct / 100)
      const totalFormula = ethanolQty + (pol.fragrance_id ? fragQty : 0)
      const rfAvail = parseFloat(pol.rf_stock)
      const rfToDebit = Math.min(rfAvail, totalFormula)
      if (rfToDebit > 0) {
        await tq(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [pol.rf_id])
        await adjustProductStock(pol.rf_id, -rfToDebit, 'production_debit',
          `Ready formula: ${order.rows[0].order_number}`, userId, orderId, null, tq)
      }
      await tq(`UPDATE stock_reservations SET status = 'consumed', quantity_consumed = quantity_reserved WHERE production_order_id = $1 AND product_id = $2 AND status = 'reserved'`,
        [orderId, pol.rf_id])
    }

    // Major Client: debit client_stock
    if (order.rows[0].order_type === 'LARGE_CLIENT' && order.rows[0].client_id) {
      const clientComps = await tq(
        `SELECT poc.client_stock_id, SUM(poc.quantity_required) as total_qty, poc.unit, cs.client_id as cs_client_id
         FROM production_order_components poc
         JOIN client_stock cs ON cs.id = poc.client_stock_id
         WHERE poc.production_order_id = $1 AND poc.source = 'client_stock' AND poc.client_stock_id IS NOT NULL
         GROUP BY poc.client_stock_id, poc.unit, cs.client_id`,
        [orderId]
      )
      for (const comp of clientComps.rows) {
        await tq(`SELECT id FROM client_stock WHERE id = $1 FOR UPDATE`, [comp.client_stock_id])
        await tq(`UPDATE client_stock SET quantity = GREATEST(0, quantity - $1) WHERE id = $2`, [comp.total_qty, comp.client_stock_id])
        await tq(
          `INSERT INTO client_stock_transactions (client_stock_id, client_id, type, quantity, unit, notes, user_id) VALUES ($1,$2,'remove',$3,$4,$5,$6)`,
          [comp.client_stock_id, comp.cs_client_id, comp.total_qty, comp.unit, `Used in ${order.rows[0].order_number}`, userId]
        )
      }
    }

    // Client labels debit
    const labelLines = await tq(
      `SELECT pol.label_client_label_id, pol.quantity, cl.client_id
       FROM production_order_lines pol
       JOIN client_labels cl ON cl.id = pol.label_client_label_id
       WHERE pol.production_order_id = $1 AND pol.label_client_label_id IS NOT NULL`,
      [orderId]
    )
    for (const ll of labelLines.rows) {
      await tq(`UPDATE client_labels SET quantity = GREATEST(0, quantity - $1) WHERE id = $2`, [ll.quantity, ll.label_client_label_id])
      await tq(
        `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, production_order_id, notes, user_id) VALUES ($1,$2,'used',$3,$4,'Used in production',$5)`,
        [ll.label_client_label_id, ll.client_id, ll.quantity, orderId, userId]
      )
    }

    await auditLog(userId, 'production_started', 'production_order', orderId, order.rows[0].order_number, { target_status: targetStatus })
    return { job: jobRow.rows[0], skipped_debit: false }
  })
}

router.post('/manufacturing/:id/start', auth, async (req, res) => {
  try {
    const order = await query(`SELECT status FROM production_orders WHERE id = $1`, [req.params.id])
    if (!order.rows[0]) return res.status(404).json({ error: 'Not found' })
    if (!['queued', 'waiting_external'].includes(order.rows[0].status)) {
      return res.status(400).json({ error: 'Order must be queued or waiting_external to start' })
    }

    const result = await startProductionInternal(parseInt(req.params.id), req.user.id, 'in_production')
    res.json(result.job)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})


router.post('/manufacturing/:id/complete', auth, async (req, res) => {
  try {
    const { line_leftovers, notes_on_completion } = req.body
    const order = await query(
      `SELECT po.*, c.name as client_name FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE po.id = $1`,
      [req.params.id]
    )
    if (!order.rows[0]) return res.status(404).json({ error: 'Not found' })

    const pendingLines = await query(`SELECT id FROM production_order_lines WHERE production_order_id = $1 AND line_status != 'done'`, [req.params.id])
    if (pendingLines.rows.length > 0) {
      return res.status(400).json({ error: `${pendingLines.rows.length} line(s) not yet completed. Mark all lines as done first.` })
    }

    // Safety net: guarantee the BOM stock was debited before completing. If the order
    // somehow reached completion without ever being formally started, run the start/debit
    // logic now. Idempotent — skips if a production_jobs row already exists.
    const jobExists = await query(`SELECT id FROM production_jobs WHERE production_order_id = $1 LIMIT 1`, [req.params.id])
    if (!jobExists.rows[0]) {
      await startProductionInternal(parseInt(req.params.id), req.user.id, 'in_production')
    }

    await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)

      const segment = await resolveOrderSegment(order.rows[0], tq)
      const isMuse = segment === 'MUSE'

      await tq(`UPDATE production_jobs SET completed_at = NOW(), status = 'completed', notes_on_completion = $1 WHERE production_order_id = $2`, [notes_on_completion || null, req.params.id])
      // MUSE: auto-fulfill (products land in internal stock as variants)
      // Standard/Major: status='completed' (await shipping / client OK)
      await tq(`UPDATE production_orders SET status = $1, updated_at = NOW() WHERE id = $2`, [isMuse ? 'fulfilled' : 'completed', req.params.id])

      for (const ll of (line_leftovers || [])) {
        if (ll.leftover_formula_ml && parseFloat(ll.leftover_formula_ml) > 0) {
          const lineRow = await tq(
            `SELECT pol.fragrance_id, p.name as fragrance_name, p.product_code as fragrance_code
             FROM production_order_lines pol LEFT JOIN products p ON p.id = pol.fragrance_id
             WHERE pol.id = $1`,
            [ll.line_id]
          )
          if (lineRow.rows[0]?.fragrance_id) {
            const fn = lineRow.rows[0].fragrance_name
            let rfProd = await tq(`SELECT * FROM products WHERE category = 'READY_FORMULA' AND name ILIKE $1 LIMIT 1`, [`%${fn}%`])
            if (!rfProd.rows[0]) {
              rfProd = await tq(
                `INSERT INTO products (name, product_code, category, unit, current_stock) VALUES ($1,$2,'READY_FORMULA','ml',0) RETURNING *`,
                [`Ready Formula — ${fn}`, `RF-${lineRow.rows[0].fragrance_code || fn.substring(0,8).toUpperCase().replace(/\s+/g,'-')}`]
              )
            }
            await adjustProductStock(rfProd.rows[0].id, parseFloat(ll.leftover_formula_ml), 'ready_formula_in',
              `Leftover from ${order.rows[0].order_number}`, req.user.id, parseInt(req.params.id), null, tq)
          }
        }
        if (ll.leftover_labels_qty != null && parseInt(ll.leftover_labels_qty) >= 0) {
          const labelLine = await tq(
            `SELECT pol.label_client_label_id, pol.quantity as line_qty, cl.client_id
             FROM production_order_lines pol
             JOIN client_labels cl ON cl.id = pol.label_client_label_id
             WHERE pol.id = $1 AND pol.label_client_label_id IS NOT NULL`,
            [ll.line_id]
          )
          if (labelLine.rows[0]) {
            const { label_client_label_id, client_id, line_qty } = labelLine.rows[0]
            const leftover = parseInt(ll.leftover_labels_qty)
            const lineQty = parseInt(line_qty) || 0

            // Total labels received from external processing for THIS line + label
            const epRow = await tq(
              `SELECT COALESCE(SUM(qty_returned), 0) as total_returned
               FROM external_processing
               WHERE production_order_line_id = $1 AND client_label_id = $2 AND processing_type = 'labels'`,
              [ll.line_id, label_client_label_id]
            )
            const totalReturned = parseFloat(epRow.rows[0]?.total_returned || 0)

            // If EP supplied labels: enforce "leftover = authoritative remaining from this order".
            //   This order's net effect on stock should equal `leftover`.
            //   Already applied during lifecycle: +totalReturned (EP return) - lineQty (production debit).
            //   Adjustment needed at complete: leftover - (totalReturned - lineQty).
            //   Negative → labels lost/damaged → record as 'waste'.
            // If no EP for this label (legacy path): keep additive behavior (+leftover).
            let delta, isWaste
            if (totalReturned > 0) {
              delta = leftover - (totalReturned - lineQty)
              isWaste = delta < 0
            } else {
              delta = leftover
              isWaste = false
            }

            if (delta > 0) {
              await tq(`UPDATE client_labels SET quantity = quantity + $1 WHERE id = $2`, [delta, label_client_label_id])
              await tq(
                `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, production_order_id, notes, user_id) VALUES ($1,$2,'received',$3,$4,'Leftover from production',$5)`,
                [label_client_label_id, client_id, delta, parseInt(req.params.id), req.user.id]
              )
            } else if (delta < 0) {
              const debitQty = Math.abs(delta)
              await tq(`UPDATE client_labels SET quantity = GREATEST(0, quantity - $1) WHERE id = $2`, [debitQty, label_client_label_id])
              await tq(
                `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, production_order_id, notes, user_id) VALUES ($1,$2,'waste',$3,$4,'Labels lost or damaged in production',$5)`,
                [label_client_label_id, client_id, debitQty, parseInt(req.params.id), req.user.id]
              )
            }
          }
        }
      }

      // Increment FG stock only for MUSE orders (Standard ships direct, Major waits for client OK)
      // Match master by product_code + segment='MUSE'; find/create variant by (master_id, fragrance_id)
      if (isMuse) {
        const fgLines = await tq(
          `SELECT pol.id as line_id, pol.product_type, pol.quantity, pol.fragrance_id,
                  master.id as master_id, master.name as master_name, master.volume_ml as master_volume,
                  master.volume_unit as master_volume_unit,
                  frag.name as fragrance_name, frag.product_code as fragrance_code
           FROM production_order_lines pol
           LEFT JOIN products master ON master.product_code = pol.product_type
             AND master.is_master = true AND master.segment = 'MUSE' AND master.client_id IS NULL
           LEFT JOIN products frag ON frag.id = pol.fragrance_id
           WHERE pol.production_order_id = $1`,
          [req.params.id]
        )
        for (const fl of fgLines.rows) {
          if (!fl.master_id || !fl.fragrance_id) {
            console.warn(`[manufacturing/complete] MUSE order ${order.rows[0].order_number} line ${fl.line_id} missing master or fragrance — skipping variant increment`)
            continue
          }

          // Lock master row to prevent race on variant auto-create
          await tq(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [fl.master_id])

          // Find existing variant
          let variant = await tq(
            `SELECT id FROM products
             WHERE master_product_id = $1 AND fragrance_id = $2
               AND segment = 'MUSE' AND is_master = false
             LIMIT 1`,
            [fl.master_id, fl.fragrance_id]
          )

          // Auto-create variant if missing (with ON CONFLICT for race safety)
          if (!variant.rows[0]) {
            const variantCode = `${fl.product_type}-${fl.fragrance_code || fl.fragrance_id}`
            const variantName = `${fl.master_name || fl.product_type} — ${fl.fragrance_name || 'Unknown'}`
            const created = await tq(
              `INSERT INTO products
                (name, product_code, category, segment, is_master, master_product_id, fragrance_id,
                 unit, current_stock, volume_ml, volume_unit, client_id, price)
               VALUES ($1, $2, 'FINISHED_GOOD', 'MUSE', false, $3, $4, 'units', 0, $5, $6, NULL,
                       (SELECT price FROM products WHERE id = $3))
               ON CONFLICT (product_code) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [variantName, variantCode, fl.master_id, fl.fragrance_id, fl.master_volume, fl.master_volume_unit || 'ml']
            )
            variant = created
            // Auto-assign MUSE SKU + barcode to the freshly created variant
            await ensureMuseSku(tq, created.rows[0].id)
          }

          await adjustProductStock(
            variant.rows[0].id,
            parseFloat(fl.quantity),
            'production_in',
            `Produced: ${order.rows[0].order_number}`,
            req.user.id,
            parseInt(req.params.id),
            fl.line_id,
            tq
          )
        }
      }

      // Consume any remaining stock reservations for this order
      await tq(
        `UPDATE stock_reservations SET status = 'consumed', quantity_consumed = quantity_reserved WHERE production_order_id = $1 AND status = 'reserved'`,
        [req.params.id]
      )

      // Per-line extra fragrance top-up. The warehouse adds N ml of the line's fragrance
      // beyond the BOM (because the dose felt weak, batch variance, etc.). Debit that exact
      // amount from the fragrance product stock + log to strength_log so the catalog still
      // shows the "actual % used" equivalent.
      // Replaces the older order-level oil_adjusted/actual_oil_pct flow — much simpler for
      // non-technical warehouse staff: they just enter "I added 50 ml extra of Santal".
      for (const ll of (line_leftovers || [])) {
        const extraMl = parseFloat(ll.extra_fragrance_ml)
        if (!extraMl || extraMl <= 0) continue
        const lineRow = await tq(
          `SELECT pol.fragrance_id, pol.oil_pct, pol.quantity, p.name as fragrance_name,
                  master.volume_ml as master_volume
           FROM production_order_lines pol
           LEFT JOIN products p ON p.id = pol.fragrance_id
           LEFT JOIN products master ON master.product_code = pol.product_type AND master.is_master = true
           WHERE pol.id = $1`,
          [ll.line_id]
        )
        const fl = lineRow.rows[0]
        if (!fl || !fl.fragrance_id) continue

        // Debit the extra ml from fragrance stock
        await adjustProductStock(
          fl.fragrance_id, -extraMl, 'production_debit',
          `Extra ${extraMl} ml added during ${order.rows[0].order_number}${ll.extra_fragrance_reason ? ` — ${ll.extra_fragrance_reason}` : ''}`,
          req.user.id, parseInt(req.params.id), null, tq
        )

        // Strength log: compute equivalent actual % used so the Oil % History chart stays useful
        const standardPct = parseFloat(fl.oil_pct) || 25
        const volume = parseFloat(fl.master_volume) || 0
        const qty = parseInt(fl.quantity) || 0
        const standardFragMl = qty * volume * (standardPct / 100)
        const actualFragMl = standardFragMl + extraMl
        const totalFormulaMl = qty * volume || 1
        const actualPct = (actualFragMl / totalFormulaMl) * 100
        await tq(
          `INSERT INTO fragrance_strength_log (fragrance_id, fragrance_name, production_order_id, standard_pct, actual_pct_used, was_adjusted, adjustment_reason, batch_reference, date_used, created_by)
           VALUES ($1,$2,$3,$4,$5,true,$6,$7,CURRENT_DATE,$8)`,
          [fl.fragrance_id, fl.fragrance_name, parseInt(req.params.id), standardPct,
           Number(actualPct.toFixed(2)), ll.extra_fragrance_reason || `Added ${extraMl} ml extra`,
           order.rows[0].order_number, req.user.id]
        )
      }
    })

    await auditLog(req.user.id, 'production_completed', 'production_order', parseInt(req.params.id), order.rows[0].order_number, { line_leftovers_count: (line_leftovers || []).length })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/manufacturing/:id/lines/:lineId/filling-done', auth, async (req, res) => {
  try {
    const line = await query(`SELECT * FROM production_order_lines WHERE id = $1 AND production_order_id = $2`, [req.params.lineId, req.params.id])
    if (!line.rows[0]) return res.status(404).json({ error: 'Line not found' })
    const l = line.rows[0]
    const newStatus = (!l.needs_labeling && !l.needs_packing) ? 'done' : 'filling_done'
    const isDone = newStatus === 'done'
    await query(
      `UPDATE production_order_lines SET line_status = $1, line_started_at = COALESCE(line_started_at, NOW()), line_completed_at = CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id = $3`,
      [newStatus, isDone, req.params.lineId]
    )
    const ord1 = await query(`SELECT order_number FROM production_orders WHERE id = $1`, [req.params.id])
    await auditLog(req.user.id, 'line_filling_done', 'production_order', parseInt(req.params.id), ord1.rows[0]?.order_number, { line: l.product_type, newStatus })
    res.json({ success: true, line_status: newStatus })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/manufacturing/:id/lines/:lineId/labeling-done', auth, async (req, res) => {
  try {
    const line = await query(`SELECT * FROM production_order_lines WHERE id = $1 AND production_order_id = $2`, [req.params.lineId, req.params.id])
    if (!line.rows[0]) return res.status(404).json({ error: 'Line not found' })
    const newStatus = line.rows[0].needs_packing ? 'labeling_done' : 'done'
    const isDone = newStatus === 'done'
    await query(
      `UPDATE production_order_lines SET line_status = $1, line_completed_at = CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id = $3`,
      [newStatus, isDone, req.params.lineId]
    )
    const ord2 = await query(`SELECT order_number FROM production_orders WHERE id = $1`, [req.params.id])
    await auditLog(req.user.id, 'line_labeling_done', 'production_order', parseInt(req.params.id), ord2.rows[0]?.order_number, { line: line.rows[0].product_type, newStatus })
    res.json({ success: true, line_status: newStatus })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/manufacturing/:id/lines/:lineId/packing-done', auth, async (req, res) => {
  try {
    await query(`UPDATE production_order_lines SET line_status = 'done', line_completed_at = NOW() WHERE id = $1 AND production_order_id = $2`, [req.params.lineId, req.params.id])
    const [lineRow3, ord3] = await Promise.all([
      query(`SELECT product_type FROM production_order_lines WHERE id = $1`, [req.params.lineId]),
      query(`SELECT order_number FROM production_orders WHERE id = $1`, [req.params.id]),
    ])
    await auditLog(req.user.id, 'line_packing_done', 'production_order', parseInt(req.params.id), ord3.rows[0]?.order_number, { line: lineRow3.rows[0]?.product_type })
    res.json({ success: true, line_status: 'done' })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/manufacturing/:id/lines/:lineId/send-for-filling', auth, async (req, res) => {
  try {
    const { supplier } = req.body
    await query(
      `UPDATE production_order_lines SET candle_status = 'sent_for_filling', line_status = 'sent_for_filling', sent_for_filling_at = NOW(), filling_supplier = $1 WHERE id = $2 AND production_order_id = $3`,
      [supplier || null, req.params.lineId, req.params.id]
    )
    await query(`UPDATE production_orders SET status = 'waiting_external', updated_at = NOW() WHERE id = $1`, [req.params.id])
    const [lineRow4, ord4] = await Promise.all([
      query(`SELECT product_type FROM production_order_lines WHERE id = $1`, [req.params.lineId]),
      query(`SELECT order_number FROM production_orders WHERE id = $1`, [req.params.id]),
    ])
    await auditLog(req.user.id, 'line_sent_for_filling', 'production_order', parseInt(req.params.id), ord4.rows[0]?.order_number, { line: lineRow4.rows[0]?.product_type, supplier: supplier || null })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.post('/manufacturing/:id/lines/:lineId/receive-from-filling', auth, async (req, res) => {
  try {
    const line = await query(`SELECT * FROM production_order_lines WHERE id = $1 AND production_order_id = $2`, [req.params.lineId, req.params.id])
    if (!line.rows[0]) return res.status(404).json({ error: 'Line not found' })
    const l = line.rows[0]
    const newStatus = (!l.needs_labeling && !l.needs_packing) ? 'done' : 'filling_done'
    const isDone = newStatus === 'done'
    await query(
      `UPDATE production_order_lines SET candle_status = 'received_from_filling', line_status = $1, received_from_filling_at = NOW(), line_completed_at = CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id = $3`,
      [newStatus, isDone, req.params.lineId]
    )
    const pending = await query(`SELECT COUNT(*) FROM production_order_lines WHERE production_order_id = $1 AND line_status = 'sent_for_filling'`, [req.params.id])
    if (parseInt(pending.rows[0].count) === 0) {
      await query(`UPDATE production_orders SET status = 'in_production', updated_at = NOW() WHERE id = $1`, [req.params.id])
    }
    const ord5 = await query(`SELECT order_number FROM production_orders WHERE id = $1`, [req.params.id])
    await auditLog(req.user.id, 'line_received_from_filling', 'production_order', parseInt(req.params.id), ord5.rows[0]?.order_number, { line: l.product_type })
    res.json({ success: true, line_status: newStatus })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/ready-formula/available', auth, async (req, res) => {
  try {
    const { fragrance_id } = req.query
    if (!fragrance_id) return res.status(400).json({ error: 'fragrance_id required' })
    const fragrance = await query(`SELECT * FROM products WHERE id = $1`, [fragrance_id])
    if (!fragrance.rows[0]) return res.json([])
    const result = await query(
      `SELECT * FROM products WHERE category = 'READY_FORMULA' AND name ILIKE $1 AND current_stock > 0`,
      [`%${fragrance.rows[0].name}%`]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
module.exports.startProductionInternal = startProductionInternal
