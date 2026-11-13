const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const { query, withTransaction } = require('../db')
const { auth, auditLog } = require('../auth')
const { adjustProductStock } = require('../services/stock-service')
const { ensureMuseSku } = require('./masters')
const {
  consumeFragranceOil, restoreFragranceOil, productionSector,
  resolveOrderSegment, resolveCandleOil, LINE_OIL_SELECT,
} = require('../services/fragrance-library')
const { setOrderStatus } = require('../services/order-status')
const { candleOilFor, sendCandleOil, returnCandleOil, requireOilRole, CandleOilError } = require('../services/candle-oil')

// The oil each line of an order takes, with the unit of the variant being made
// (services/fragrance-library.js LINE_OIL_SELECT). ONE query for the debit and
// for the shortage warning, so the warning can never look at a different stock
// from the one production will draw.
const OIL_LINES_SQL =
  `${LINE_OIL_SELECT} WHERE pol.production_order_id = $1 AND pol.oil_id IS NOT NULL AND pol.oil_qty_ml > 0`

// What a queued order would leave short if it started now: [{ name, need,
// have, unit }]. A WARNING only — production is never blocked on stock (owner,
// 10 Nov 2026: "sim mas não trava"). It replaces the "Stock reserved" chip,
// which only said that reservation rows existed and stayed green with the
// stock below zero.
// Oil: what the order's unit can use — its own stock, MUSE (shared), then SA,
// the order sa.sector_draw takes it in. Another MUSE unit's oil does not count.
// ponytail: each order is checked alone against today's stock; two queued
// orders wanting the same last bottle both read OK. Net the queue when it matters.
async function orderShortages(order) {
  const short = (await query(
    `SELECT p.name, p.unit, SUM(poc.quantity_required)::float AS need, p.current_stock::float AS have
       FROM production_order_components poc JOIN products p ON p.id = poc.product_id
      WHERE poc.production_order_id = $1 AND poc.source = 'general_stock'
      GROUP BY p.id, p.name, p.unit, p.current_stock
     HAVING SUM(poc.quantity_required) > p.current_stock
     UNION ALL
     SELECT MAX(poc.product_name) || ' (client stock)', MAX(poc.unit), SUM(poc.quantity_required)::float, cs.quantity::float
       FROM production_order_components poc JOIN client_stock cs ON cs.id = poc.client_stock_id
      WHERE poc.production_order_id = $1 AND poc.source = 'client_stock'
      GROUP BY cs.id, cs.quantity
     HAVING SUM(poc.quantity_required) > cs.quantity`, [order.id])).rows

  const oilLines = (await query(OIL_LINES_SQL, [order.id])).rows
  if (oilLines.length) {
    const segment = await resolveOrderSegment(order, query)
    const need = new Map()   // "oil|stock" → mL
    for (const l of oilLines) {
      // A candle pours its candle version where one exists (D17 Block A).
      l.pours = l.is_candle ? await resolveCandleOil(query, l.oil_id) : l.oil_id
      const k = `${l.pours}|${productionSector(segment, l.business_unit)}`
      need.set(k, (need.get(k) || 0) + parseFloat(l.oil_qty_ml))
    }
    const oils = (await query(
      `SELECT p.id, p.name, p.unit, p."currentStock"::float AS total, COALESCE(h.held, 0)::float AS held,
              COALESCE(h.muse, 0)::float AS muse, COALESCE(h.muse_atelier, 0)::float AS muse_atelier,
              COALESCE(h.muse_library, 0)::float AS muse_library, COALESCE(h.muse_archive, 0)::float AS muse_archive
         FROM sa.products p LEFT JOIN sa.sector_held h ON h.product_id = p.id
        WHERE p.id = ANY($1)`, [[...new Set(oilLines.map((l) => l.pours))]])).rows
    for (const [k, ml] of need) {
      const [oilId, sector] = k.split('|')
      const o = oils.find((x) => x.id === oilId)
      if (!o) { short.push({ name: `Oil ${oilId} (not in the Fragrance Library)`, need: ml, have: 0, unit: 'mL' }); continue }
      const have = (o.total - o.held) + Math.max(o.muse, 0) + Math.max(o[sector.toLowerCase()], 0)
      if (ml > have) short.push({ name: o.name, need: ml, have, unit: o.unit || 'mL' })
    }
  }
  return short
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
        `SELECT pol.*, pf.name as fragrance_name, oil.name as oil_name, cl.label_name, cl.artwork_version, cl.quantity as label_stock,
                pfg.name as fg_product_name,
                ep.id as labels_ep_id, ep.status as labels_ep_status,
                ep.supplier as labels_ep_supplier, ep.expected_return as labels_ep_eta,
                ep.qty_requested as labels_ep_qty_requested, ep.qty_returned as labels_ep_qty_returned
         FROM production_order_lines pol
         LEFT JOIN products pf ON pol.fragrance_id = pf.id
         LEFT JOIN sa.products oil ON oil.id = pol.oil_id
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
      // Only while queued: once started, the stock has already been taken.
      order.shortages = order.status === 'queued' ? await orderShortages(order) : null
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
    await setOrderStatus(orderId, targetStatus)
    return { job: existingJob.rows[0], skipped_debit: true }
  }

  return await withTransaction(async (client) => {
    const tq = (text, params) => client.query(text, params)

    const jobRow = await tq(
      `INSERT INTO production_jobs (production_order_id, started_by, status) VALUES ($1,$2,'in_production') RETURNING *`,
      [orderId, userId]
    )
    await setOrderStatus(orderId, targetStatus, { tq })

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
    // The unit of the VARIANT being made picks the MUSE stock the oil is drawn
    // from first (Stage 1, fix rounds 1–2). Not the master's: every master
    // (TS10, RS100, RD200…) is 'library', and The Library and The Archive share
    // masters. The variant is the sm product under that master (product_type =
    // the master's code, as the order screens join) carrying this line's oil.
    // When several match, the one the line names first (`variant_name`, which
    // the MUSE webhook writes from the sold variant — fix round 3, F2), then a
    // live one before an archived one, then the oldest (lowest id). None → The
    // Library.
    const oilLines = await tq(OIL_LINES_SQL, [orderId])
    if (oilLines.rows.length > 0) {
      const segment = await resolveOrderSegment(order.rows[0], tq)
      for (const line of oilLines.rows) {
        // D17.3: a candle's oil is not taken here. It leaves with the glasses
        // for the filler and is debited then, for the amount that actually
        // left (services/candle-oil.js). Taking it here as well was the double
        // debit that block exists to prevent.
        if (line.is_candle) continue
        await consumeFragranceOil(tq, line.oil_id, line.oil_qty_ml, segment, `Production: ${order.rows[0].order_number}`, line.business_unit)
        await tq(`UPDATE production_order_lines SET oil_debited_at = NOW() WHERE id = $1`, [line.id])
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
        // The client's reserved stock physically went into this production run — record the
        // exact debit even if it drives the balance negative (short on their own stock), rather
        // than clamping to zero and silently discarding the shortfall. Mirrors the allow-and-log
        // philosophy already used for oil (Fragrance Library) and MUSE retail fulfillment.
        const csUpd = await tq(`UPDATE client_stock SET quantity = quantity - $1 WHERE id = $2 RETURNING quantity`, [comp.total_qty, comp.client_stock_id])
        if (parseFloat(csUpd.rows[0]?.quantity) < 0) {
          console.warn(`[production] client_stock ${comp.client_stock_id} short — now ${csUpd.rows[0].quantity} (recorded; investigate physical count)`)
        }
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
      // Same allow-and-log philosophy as client_stock above — the labels were physically
      // consumed; record the real debit rather than clamping the shortfall away.
      const clUpd = await tq(`UPDATE client_labels SET quantity = quantity - $1 WHERE id = $2 RETURNING quantity`, [ll.quantity, ll.label_client_label_id])
      if (parseFloat(clUpd.rows[0]?.quantity) < 0) {
        console.warn(`[production] client_labels ${ll.label_client_label_id} short — now ${clUpd.rows[0].quantity} (recorded; investigate physical count)`)
      }
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

    // D17 B3 safety net. A candle's oil is recorded when it goes to the filler,
    // not at Start — so a candle line can now finish with no oil ever taken
    // (sent by someone who may not record oil, or filled in-house one day).
    // Never a block: said loudly, on the screen and in Activity, so it is fixed.
    const candleNoOil = (await query(
      `SELECT pol.line_number FROM production_order_lines pol
        WHERE pol.production_order_id = $1 AND pol.is_candle AND pol.oil_id IS NOT NULL AND pol.oil_debited_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM external_processing ep
                           WHERE ep.production_order_line_id = pol.id AND ep.oil_qty_sent_ml IS NOT NULL)
        ORDER BY pol.line_number`, [req.params.id])).rows.map((r) => r.line_number)
    if (candleNoOil.length) {
      console.error(`⚠️  [candle-oil] ${order.rows[0].order_number} completed with NO oil recorded for candle line(s) ${candleNoOil.join(', ')}`)
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
      await setOrderStatus(parseInt(req.params.id), isMuse ? 'fulfilled' : 'completed', { tq })

      for (const ll of (line_leftovers || [])) {
        if (ll.leftover_formula_ml && parseFloat(ll.leftover_formula_ml) > 0) {
          const lineRow = await tq(
            `SELECT pol.fragrance_id, pol.oil_id, p.name as fragrance_name, p.product_code as fragrance_code,
                    oil.name as oil_name, oil."productCode" as oil_code
             FROM production_order_lines pol
             LEFT JOIN products p ON p.id = pol.fragrance_id
             LEFT JOIN sa.products oil ON oil.id = pol.oil_id
             WHERE pol.id = $1`,
            [ll.line_id]
          )
          const lr = lineRow.rows[0]
          // D14: once oil is mixed into ethanol it's no longer pure oil, so it
          // can never go back to sa.products (that's what restoreFragranceOil
          // is for — unmixed oil only). The leftover MIXTURE becomes a Ready
          // Formula for future reuse, exactly like the legacy fragrance_id
          // path (owner, 2026-07-16).
          if (lr?.fragrance_id || lr?.oil_id) {
            const fn = lr.fragrance_name || lr.oil_name
            const rfCode = lr.fragrance_code || lr.oil_code || lr.oil_id
            // Full code: cutting it to 8 characters gave every FRAG_000xx oil the same RF code.
            const code = `RF-${String(rfCode || fn).toUpperCase().replace(/\s+/g, '-')}`
            const rfName = `Ready Formula — ${fn}`
            let rfProd = await tq(
              `SELECT * FROM products WHERE category = 'READY_FORMULA' AND (product_code = $1 OR name = $2)
               ORDER BY (product_code = $1) DESC LIMIT 1`, [code, rfName])
            if (!rfProd.rows[0]) {
              rfProd = await tq(
                `INSERT INTO products (name, product_code, category, unit, current_stock) VALUES ($1,$2,'READY_FORMULA','ml',0) RETURNING *`,
                [rfName, code]
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
              // Same allow-and-log philosophy — labels lost/damaged already happened; record it.
              const wasteUpd = await tq(`UPDATE client_labels SET quantity = quantity - $1 WHERE id = $2 RETURNING quantity`, [debitQty, label_client_label_id])
              if (parseFloat(wasteUpd.rows[0]?.quantity) < 0) {
                console.warn(`[production] client_labels ${label_client_label_id} short — now ${wasteUpd.rows[0].quantity} (waste recorded; investigate physical count)`)
              }
              await tq(
                `INSERT INTO client_label_transactions (client_label_id, client_id, type, quantity, production_order_id, notes, user_id) VALUES ($1,$2,'waste',$3,$4,'Labels lost or damaged in production',$5)`,
                [label_client_label_id, client_id, debitQty, parseInt(req.params.id), req.user.id]
              )
            }
          }
        }
      }

      // Increment FG stock only for MUSE orders (Standard ships direct, Major waits for client OK)
      // Match master by product_code + segment='MUSE'; find/create variant by
      // (master_id, oil_id) — D14 — falling back to the legacy
      // (master_id, fragrance_id) pairing for any pre-D14 line.
      if (isMuse) {
        const fgLines = await tq(
          `SELECT pol.id as line_id, pol.product_type, pol.quantity, pol.fragrance_id, pol.oil_id, pol.variant_name,
                  master.id as master_id, master.name as master_name, master.volume_ml as master_volume,
                  master.volume_unit as master_volume_unit,
                  frag.name as fragrance_name, frag.product_code as fragrance_code,
                  oil.name as oil_name, oil."productCode" as oil_code
           FROM production_order_lines pol
           LEFT JOIN products master ON master.product_code = pol.product_type
             AND master.is_master = true AND master.segment = 'MUSE' AND master.client_id IS NULL
           LEFT JOIN products frag ON frag.id = pol.fragrance_id
           LEFT JOIN sa.products oil ON oil.id = pol.oil_id
           WHERE pol.production_order_id = $1`,
          [req.params.id]
        )
        for (const fl of fgLines.rows) {
          const usesOil = !!fl.oil_id
          if (!fl.master_id || (!fl.fragrance_id && !fl.oil_id)) {
            console.warn(`[manufacturing/complete] MUSE order ${order.rows[0].order_number} line ${fl.line_id} missing master or fragrance/oil — skipping variant increment`)
            continue
          }

          // Lock master row to prevent race on variant auto-create
          await tq(`SELECT id FROM products WHERE id = $1 FOR UPDATE`, [fl.master_id])

          // Find existing variant
          let variant = await tq(
            usesOil
              ? `SELECT id FROM products WHERE master_product_id = $1 AND oil_id = $2 AND segment = 'MUSE' AND is_master = false LIMIT 1`
              : `SELECT id FROM products WHERE master_product_id = $1 AND fragrance_id = $2 AND segment = 'MUSE' AND is_master = false LIMIT 1`,
            [fl.master_id, usesOil ? fl.oil_id : fl.fragrance_id]
          )

          // Auto-create variant if missing (with ON CONFLICT for race safety)
          if (!variant.rows[0]) {
            // Commercial name: the line's explicit override (e.g. "Afterglow")
            // if the person building the recipe typed one, else auto-
            // concatenate master + oil/fragrance name (same graceful default
            // as before D14 — just no longer the only option, since the
            // commercial name and the oil's internal name are allowed to
            // differ, D14.2).
            // variant_name overrides only the SCENT part ("Afterglow" instead
            // of the oil's own name "Santal") — the master/format prefix is
            // always kept, so every MUSE product name still reads
            // "<Format> — <Scent>" consistently, regardless of which name
            // supplied the scent half.
            const scentName = fl.variant_name || (usesOil ? fl.oil_name : fl.fragrance_name)
            const scentCode = usesOil ? (fl.oil_code || fl.oil_id) : (fl.fragrance_code || fl.fragrance_id)
            const variantCode = `${fl.product_type}-${scentCode}`
            const variantName = `${fl.master_name || fl.product_type} — ${scentName || 'Unknown'}`
            const created = await tq(
              `INSERT INTO products
                (name, product_code, category, segment, is_master, master_product_id, fragrance_id, oil_id,
                 unit, current_stock, volume_ml, volume_unit, client_id, price)
               VALUES ($1, $2, 'FINISHED_GOOD', 'MUSE', false, $3, $4, $5, 'units', 0, $6, $7, NULL,
                       (SELECT price FROM products WHERE id = $3))
               ON CONFLICT (product_code) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [variantName, variantCode, fl.master_id, usesOil ? null : fl.fragrance_id, usesOil ? fl.oil_id : null, fl.master_volume, fl.master_volume_unit || 'ml']
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
          `SELECT pol.fragrance_id, pol.oil_id, pol.oil_pct, pol.quantity,
                  COALESCE(p.name, oil.name) as fragrance_name,
                  master.volume_ml as master_volume,
                  (SELECT v.business_unit FROM products v
                     JOIN products m ON m.id = v.master_product_id
                    WHERE m.product_code = pol.product_type AND m.category = 'FINISHED_GOOD' AND v.oil_id = pol.oil_id
                    ORDER BY (v.name IS DISTINCT FROM pol.variant_name), (v.archived IS TRUE), v.id LIMIT 1) AS business_unit
           FROM production_order_lines pol
           LEFT JOIN products p ON p.id = pol.fragrance_id
           LEFT JOIN sa.products oil ON oil.id = pol.oil_id
           LEFT JOIN products master ON master.product_code = pol.product_type AND master.is_master = true
           WHERE pol.id = $1 AND pol.production_order_id = $2`,
          [ll.line_id, req.params.id]
        )
        const fl = lineRow.rows[0]
        if (!fl || !(fl.fragrance_id || fl.oil_id)) continue

        const extraNote = `Extra ${extraMl} ml added during ${order.rows[0].order_number}${ll.extra_fragrance_reason ? ` — ${ll.extra_fragrance_reason}` : ''}`
        if (fl.oil_id) {
          // D17 Block F1: a Library oil line — same audited path as the start debit.
          await consumeFragranceOil(tq, fl.oil_id, extraMl, segment, extraNote, fl.business_unit)
        } else {
          await adjustProductStock(fl.fragrance_id, -extraMl, 'production_debit', extraNote,
            req.user.id, parseInt(req.params.id), null, tq)
        }

        // Strength log: compute equivalent actual % used so the Oil % History chart stays useful
        const standardPct = parseFloat(fl.oil_pct) || 25
        const volume = parseFloat(fl.master_volume) || 0
        const qty = parseInt(fl.quantity) || 0
        const standardFragMl = qty * volume * (standardPct / 100)
        const actualFragMl = standardFragMl + extraMl
        const totalFormulaMl = qty * volume || 1
        const actualPct = (actualFragMl / totalFormulaMl) * 100
        await tq(
          `INSERT INTO fragrance_strength_log (fragrance_id, oil_id, fragrance_name, production_order_id, standard_pct, actual_pct_used, was_adjusted, adjustment_reason, batch_reference, date_used, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,(NOW() AT TIME ZONE 'Australia/Sydney')::date,$9)`,
          [fl.fragrance_id || null, fl.oil_id || null, fl.fragrance_name, parseInt(req.params.id), standardPct,
           Number(actualPct.toFixed(2)), ll.extra_fragrance_reason || `Added ${extraMl} ml extra`,
           order.rows[0].order_number, req.user.id]
        )
      }
    })

    await auditLog(req.user.id, 'production_completed', 'production_order', parseInt(req.params.id), order.rows[0].order_number, { line_leftovers_count: (line_leftovers || []).length, ...(candleNoOil.length ? { candle_lines_without_oil: candleNoOil } : {}) })
    res.json({ success: true, candle_lines_without_oil: candleNoOil })
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

// What a candle line will pour and what its recipe asks for — for the "Send
// for Filling" window, which shows the oil (the candle version where one
// exists) and offers the calculated amount to be rounded up by hand.
router.get('/manufacturing/:id/lines/:lineId/candle-oil', auth, async (req, res) => {
  try {
    const info = await candleOilFor(query, req.params.lineId)
    if (!info || info.line.production_order_id !== parseInt(req.params.id)) return res.json(null)
    const { line, ...oil } = info
    res.json(oil)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

// The line leaves for the filler. One transaction: the line's status, the
// external-processing record of what is out (D17 R7 — this door used to leave
// none, so candles sent from here were on no list), the order's status and,
// when given, the oil that went with the glasses (admin/root, D17.14).
router.post('/manufacturing/:id/lines/:lineId/send-for-filling', auth, async (req, res) => {
  try {
    const { supplier, eta, oil_sent_ml } = req.body
    const oilMl = parseFloat(oil_sent_ml) || 0
    if (oilMl > 0) requireOilRole(req.user)
    const orderId = parseInt(req.params.id), lineId = parseInt(req.params.lineId)
    const out = await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)
      const line = (await tq(
        `SELECT pol.*, po.order_number, po.client_id, oil.name AS oil_name
           FROM production_order_lines pol
           JOIN production_orders po ON po.id = pol.production_order_id
           LEFT JOIN sa.products oil ON oil.id = pol.oil_id
          WHERE pol.id = $1 AND pol.production_order_id = $2 FOR UPDATE OF pol`, [lineId, orderId])).rows[0]
      if (!line) throw new CandleOilError('Line not found', 404)
      if (line.line_status === 'sent_for_filling') throw new CandleOilError('This line is already out for filling')
      await tq(
        `UPDATE production_order_lines SET candle_status = 'sent_for_filling', line_status = 'sent_for_filling', sent_for_filling_at = NOW(), filling_supplier = $1 WHERE id = $2`,
        [supplier || null, lineId])
      const ep = (await tq(
        `INSERT INTO external_processing (production_order_id, production_order_line_id, client_id, product_name, processing_type, qty_sent, supplier, expected_return, sent_date, status)
         VALUES ($1,$2,$3,$4,'candle_filling',$5,$6,$7,(NOW() AT TIME ZONE 'Australia/Sydney')::date,'sent') RETURNING id`,
        [orderId, lineId, line.client_id || null,
         line.variant_name || `${line.product_type}${line.oil_name ? ` — ${line.oil_name}` : ''}`,
         line.quantity, supplier || null, eta || null])).rows[0]
      const oil = oilMl > 0 ? await sendCandleOil(tq, { epId: ep.id, ml: oilMl }) : null
      await setOrderStatus(orderId, 'waiting_external', { tq })
      return { line, ep, oil }
    })
    await auditLog(req.user.id, 'line_sent_for_filling', 'production_order', orderId, out.line.order_number, {
      line: out.line.product_type, supplier: supplier || null, external_processing_id: out.ep.id,
      ...(out.oil?.ml ? { oil: out.oil.oil.code, oil_name: out.oil.oil.name, oil_sent_ml: out.oil.ml } : {}),
      ...(out.oil?.skipped ? { oil_not_taken: 'already taken when production started' } : {}),
    })
    res.json({ success: true, external_processing_id: out.ep.id, oil_sent_ml: out.oil?.ml || 0, oil_skipped: out.oil?.skipped || null })
  } catch (e) {
    if (e instanceof CandleOilError) return res.status(e.status).json({ error: e.message })
    res.status(500).json({ error: sanitizeError(e) })
  }
})

// The candles are back. With them, optionally, the oil the filler did not use
// (admin/root): it goes back onto the record that sent it, so nobody picks the
// oil again (D17.12). The line's records at the filler are closed with it.
router.post('/manufacturing/:id/lines/:lineId/receive-from-filling', auth, async (req, res) => {
  try {
    const oilMl = parseFloat(req.body?.oil_returned_ml) || 0
    if (oilMl > 0) requireOilRole(req.user)
    const line = await query(`SELECT * FROM production_order_lines WHERE id = $1 AND production_order_id = $2`, [req.params.lineId, req.params.id])
    if (!line.rows[0]) return res.status(404).json({ error: 'Line not found' })
    const l = line.rows[0]
    const newStatus = (!l.needs_labeling && !l.needs_packing) ? 'done' : 'filling_done'
    const isDone = newStatus === 'done'
    await withTransaction(async (client) => {
      const tq = (text, params) => client.query(text, params)
      if (oilMl > 0) {
        const withOil = (await tq(
          `SELECT id FROM external_processing
            WHERE production_order_line_id = $1 AND processing_type = 'candle_filling' AND oil_qty_sent_ml IS NOT NULL
            ORDER BY id DESC LIMIT 1`, [l.id])).rows[0]
        if (!withOil) throw new CandleOilError('No oil was recorded as sent for this line, so none can come back on it')
        await returnCandleOil(tq, { epId: withOil.id, ml: oilMl })
      }
      await tq(
        `UPDATE external_processing
            SET status = 'done', qty_returned = COALESCE(qty_sent, qty_returned),
                actual_return = COALESCE(actual_return, (NOW() AT TIME ZONE 'Australia/Sydney')::date)
          WHERE production_order_line_id = $1 AND processing_type = 'candle_filling' AND status IN ('requested','sent','partial')`, [l.id])
      await tq(
        `UPDATE production_order_lines SET candle_status = 'received_from_filling', line_status = $1, received_from_filling_at = NOW(), line_completed_at = CASE WHEN $2 THEN NOW() ELSE NULL END WHERE id = $3`,
        [newStatus, isDone, req.params.lineId]
      )
    })
    const pending = await query(`SELECT COUNT(*) FROM production_order_lines WHERE production_order_id = $1 AND line_status = 'sent_for_filling'`, [req.params.id])
    if (parseInt(pending.rows[0].count) === 0) {
      await setOrderStatus(parseInt(req.params.id), 'in_production')
    }
    const ord5 = await query(`SELECT order_number FROM production_orders WHERE id = $1`, [req.params.id])
    await auditLog(req.user.id, 'line_received_from_filling', 'production_order', parseInt(req.params.id), ord5.rows[0]?.order_number, { line: l.product_type, ...(oilMl > 0 ? { oil_returned_ml: oilMl } : {}) })
    res.json({ success: true, line_status: newStatus })
  } catch (e) {
    if (e instanceof CandleOilError) return res.status(e.status).json({ error: e.message })
    res.status(500).json({ error: sanitizeError(e) })
  }
})

router.get('/ready-formula/available', auth, async (req, res) => {
  try {
    const { fragrance_id, oil_id } = req.query
    if (!fragrance_id && !oil_id) return res.status(400).json({ error: 'fragrance_id or oil_id required' })
    // D14: a Ready Formula is matched by name regardless of which identity
    // (legacy sm fragrance, or a Fragrance Library oil) produced the leftover —
    // see the /complete leftover-crediting loop, which creates these by name.
    let name
    if (oil_id) {
      const oil = await query(`SELECT name FROM sa.products WHERE id = $1`, [oil_id])
      if (!oil.rows[0]) return res.json([])
      name = oil.rows[0].name
    } else {
      const fragrance = await query(`SELECT name FROM products WHERE id = $1`, [fragrance_id])
      if (!fragrance.rows[0]) return res.json([])
      name = fragrance.rows[0].name
    }
    const result = await query(
      `SELECT * FROM products WHERE category = 'READY_FORMULA' AND name ILIKE $1 AND current_stock > 0`,
      [`%${name}%`]
    )
    res.json(result.rows)
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
module.exports.startProductionInternal = startProductionInternal
