const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const crypto = require('crypto')
const { query, withTransaction } = require('../db')
const { auth, auditLog } = require('../auth')
const { enqueueDraftOrder } = require('../services/shopify-sync')

const processingOrders = new Set()

router.post('/webhook/shopify', async (req, res) => {
  const topic = req.headers['x-shopify-topic'] || 'unknown'
  console.log(`[webhook] received topic=${topic}`)

  // HMAC verification — for API-registered webhooks, secret = SHOPIFY_API_SECRET (client secret)
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET
  if (secret) {
    const hmac = req.headers['x-shopify-hmac-sha256']
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    const digest = crypto.createHmac('sha256', secret).update(body).digest('base64')
    if (!hmac || digest !== hmac) {
      console.warn(`[webhook] HMAC mismatch — topic=${topic} expected=${digest} got=${hmac}`)
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  res.status(200).json({ received: true })

  try {
    if (!['orders/paid', 'orders/cancelled'].includes(topic)) return

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString() : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    const body = JSON.parse(rawBody)
    const shopifyOrderId = body.id

    console.log(`[webhook] ${topic} shopifyOrderId=${shopifyOrderId} name=${body.name}`)

    if (processingOrders.has(shopifyOrderId)) return
    processingOrders.add(shopifyOrderId)

    try {
      const already = await query(`SELECT id FROM webhook_processed WHERE shopify_order_id = $1 AND webhook_type = $2`, [shopifyOrderId, topic])
      if (already.rows[0]) { console.log(`[webhook] already processed ${shopifyOrderId}`); return }

      // Shopify doesn't reliably send draft_order_id — match by SM order number in note
      let prodOrder = { rows: [] }
      if (body.draft_order_id) {
        prodOrder = await query(`SELECT * FROM production_orders WHERE shopify_draft_order_id = $1`, [body.draft_order_id])
      }
      if (!prodOrder.rows[0] && body.note) {
        const match = body.note.match(/SM Order:\s*(SM-\d+)/)
        if (match) {
          prodOrder = await query(`SELECT * FROM production_orders WHERE order_number = $1`, [match[1]])
          console.log(`[webhook] matched by note: ${match[1]}`)
        }
      }
      console.log(`[webhook] production order match: ${prodOrder.rows[0]?.order_number || 'NOT FOUND'}`)

      if (prodOrder.rows[0]) {
        const order = prodOrder.rows[0]

        if (topic === 'orders/cancelled') {
          await query(
            `UPDATE production_orders SET status = 'cancelled', shopify_order_id = $1, shopify_order_number = $2, updated_at = NOW() WHERE id = $3`,
            [shopifyOrderId, body.name, order.id]
          )
          // Release any stock reservations
          await query(`UPDATE stock_reservations SET status = 'released' WHERE production_order_id = $1 AND status = 'reserved'`, [order.id])
          console.log(`[webhook] cancelled ${order.order_number} — stock reservations released`)
          await auditLog(0, 'shopify_order_cancelled', 'production_order', order.id, order.order_number, { shopify_order_id: shopifyOrderId })
        } else {
          // Only update Shopify references — reservations are managed by the production flow
          await query(
            `UPDATE production_orders SET shopify_order_id = $1, shopify_order_number = $2, updated_at = NOW() WHERE id = $3`,
            [shopifyOrderId, body.name || body.order_number, order.id]
          )
          console.log(`[webhook] updated ${order.order_number} → Shopify ${body.name}`)
          await auditLog(0, 'shopify_payment_confirmed', 'production_order', order.id, order.order_number, { shopify_order_id: shopifyOrderId, shopify_order_number: body.name })
        }
      }

      await query(`INSERT INTO webhook_processed (shopify_order_id, webhook_type) VALUES ($1,$2)`, [shopifyOrderId, topic])
    } finally {
      processingOrders.delete(shopifyOrderId)
    }
  } catch (e) {
    console.error('[webhook] error:', e.message)
  }
})

router.post('/shopify/draft-order', auth, async (req, res) => {
  try {
    const { production_order_id } = req.body
    if (!process.env.SHOPIFY_SHOP_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
      return res.status(503).json({ error: 'Shopify not configured' })
    }

    const order = await query(
      `SELECT po.*, c.shopify_customer_id FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE po.id = $1`,
      [production_order_id]
    )
    if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' })

    const lines = await query(
      `SELECT pol.*, pf.name as fragrance_name, master.name as master_name
       FROM production_order_lines pol
       LEFT JOIN products pf ON pol.fragrance_id = pf.id
       LEFT JOIN products master ON master.product_code = pol.product_type AND master.is_master = true
       WHERE pol.production_order_id = $1`,
      [production_order_id]
    )

    const lineItems = lines.rows.map(l => ({
      title: `${l.master_name || l.product_type.replace(/_/g, ' ')} — ${l.fragrance_name || 'N/A'}`,
      quantity: l.quantity,
      price: '0.00',
      requires_shipping: true
    }))

    const draftOrder = {
      draft_order: {
        send_receipt: false,
        send_invoice: false,
        line_items: lineItems,
        note: `SM Order: ${order.rows[0].order_number} | Due: ${order.rows[0].due_date || 'TBD'}${order.rows[0].notes ? '\n\n' + order.rows[0].notes : ''}`,
        tags: 'SA Custom Orders'
      }
    }

    if (order.rows[0].shopify_customer_id) {
      draftOrder.draft_order.customer = { id: order.rows[0].shopify_customer_id }
    }

    const response = await fetch(
      `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/draft_orders.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN },
        body: JSON.stringify(draftOrder)
      }
    )

    const data = await response.json()
    if (!response.ok) {
      // Shopify down — queue for retry instead of failing the user
      await enqueueDraftOrder(production_order_id)
      return res.json({ queued: true, message: 'Shopify unavailable — draft order queued for retry' })
    }

    await query(
      `UPDATE production_orders SET shopify_draft_order_id = $1, shopify_draft_order_number = $2, status = 'confirmed', updated_at = NOW() WHERE id = $3`,
      [data.draft_order.id, data.draft_order.name, production_order_id]
    )
    res.json({ draft_order_id: data.draft_order.id, draft_order_number: data.draft_order.name, draft_order_url: data.draft_order.invoice_url })
  } catch (e) {
    // Network error — queue for retry
    await enqueueDraftOrder(production_order_id).catch(() => {})
    res.json({ queued: true, message: 'Shopify unreachable — draft order queued for retry' })
  }
})

router.get('/shopify-webhook/recent', auth, async (req, res) => {
  try {
    const received = await query(`SELECT * FROM webhook_processed ORDER BY processed_at DESC LIMIT 20`)
    const orders = await query(
      `SELECT order_number, shopify_draft_order_id, shopify_draft_order_number, shopify_order_id, shopify_order_number, status, updated_at
       FROM production_orders WHERE shopify_draft_order_id IS NOT NULL ORDER BY updated_at DESC LIMIT 10`
    )
    res.json({ webhooks_processed: received.rows, orders_with_shopify: orders.rows })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

router.get('/shopify-sync/status', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT status, COUNT(*) as count FROM pending_shopify_sync GROUP BY status`
    )
    const counts = { pending: 0, failed: 0, done: 0 }
    result.rows.forEach(r => { counts[r.status] = parseInt(r.count) })
    const failed = await query(
      `SELECT id, action_type, attempts, last_error, created_at FROM pending_shopify_sync WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20`
    )
    res.json({ counts, failed_items: failed.rows })
  } catch (e) { res.status(500).json({ error: sanitizeError(e) }) }
})

module.exports = router
