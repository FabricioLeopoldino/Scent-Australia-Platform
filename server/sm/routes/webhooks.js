const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const crypto = require('crypto')
const { query, withTransaction } = require('../db')
const { auth, auditLog } = require('../auth')
const { enqueueDraftOrder, buildDraftOrderPayload } = require('../services/shopify-sync')
const { adjustProductStock } = require('../services/stock-service')
const { computeFinishedGoodBom } = require('../services/bom-builder')
const { consumeFragranceOil, restoreFragranceOil } = require('../services/fragrance-library')
const { setOrderStatus } = require('../services/order-status')

const processingOrders = new Set()
const processingFulfillments = new Set()

// ═══════════════════════════════════════════════════════════════════════════
// MUSE RETAIL FULFILLMENT (D13, owner 2026-07-14)
// ═══════════════════════════════════════════════════════════════════════════
// The SM module was built for B2B: a production order becomes a Shopify draft
// order, the client pays, and orders/paid only updates references — the goods
// were made to order, so no finished-good stock moves.
//
// MUSE is RETAIL: produce → finished-good stock → customer buys → we ship.
// Nothing was deducting that stock (owner found it by fulfilling a real MUSE
// order and watching stock stay put). Fixed here, mirroring the SA model that
// 25 regression checks already prove:
//
//   fulfillments/create           → stock leaves the shelf   → deduct
//   fulfillments/update cancelled → it came back             → restore
//
// Deducting at SHIPMENT (not at payment) matches physical reality: an order
// paid then cancelled before shipping never moves stock at all.
//
// NO Shopify push: our MUSE products publish with inventory_management:'shopify',
// so Shopify ALREADY decremented its own count on the sale. Pushing our delta
// back would deduct it twice (skipShopifyPush).
// ═══════════════════════════════════════════════════════════════════════════
const FULFILLMENT_TOPICS = ['fulfillments/create', 'fulfillments/update'];

async function smFulfillmentHandler(req, res, topic, body) {
  const fulfillmentId = body.id;
  const orderId = body.order_id;
  const status = String(body.status || '').toLowerCase();
  // Shopify sends fulfillments/update for many reasons; only a cancellation
  // moves stock back. Anything else (tracking added, etc.) is a no-op.
  const isCancel = topic === 'fulfillments/update' && status === 'cancelled';
  const isShip = topic === 'fulfillments/create' && status !== 'cancelled';
  if (!isShip && !isCancel) {
    console.log(`[muse-fulfil] ${topic} status=${status} — no stock impact, skipped`);
    return;
  }

  const key = `fulfillment_${fulfillmentId}`;
  if (processingFulfillments.has(key)) return;
  processingFulfillments.add(key);

  try {
    const webhookType = isCancel ? 'muse_reversal' : 'muse_sale';
    // Idempotency: Shopify redelivers. Same fulfillment + same effect = once.
    const already = await query(
      `SELECT id FROM webhook_processed WHERE shopify_order_id = $1 AND webhook_type = $2`,
      [fulfillmentId, webhookType]
    );
    if (already.rows[0]) {
      console.log(`[muse-fulfil] already processed ${key} (${webhookType})`);
      return;
    }

    const lines = Array.isArray(body.line_items) ? body.line_items : [];
    if (!lines.length) {
      console.log(`[muse-fulfil] ${key} has no line items — nothing to do`);
      return;
    }

    const results = [];
    await withTransaction(async (client) => {
      const tq = (t, p) => client.query(t, p);
      for (const li of lines) {
        const sku = (li.sku || '').trim();
        const qty = parseInt(li.quantity, 10) || 0;
        if (!sku || qty <= 0) continue;

        // MUSE variants carry the STORE sku (Muse_RD00001) — that is the join.
        const prod = await tq(
          `SELECT id, name, current_stock FROM products WHERE sku = $1 FOR UPDATE`,
          [sku]
        );
        if (!prod.rows[0]) {
          // Not one of ours (e.g. an SA product sold on another store) — skip,
          // never guess. Logged so a mismatch is visible, not silent.
          console.warn(`[muse-fulfil] SKU ${sku} not found in SM — skipped`);
          continue;
        }
        const p = prod.rows[0];
        const note = isCancel
          ? `Reversal: Shopify Order ${body.name || orderId} — fulfillment ${fulfillmentId} cancelled (${qty}x)`
          : `Shopify Order ${body.name || orderId} — fulfilled (${qty}x)`;
        const txType = isCancel ? 'shopify_reversal' : 'shopify_sale';
        // Shopify already moved its own count (skipShopifyPush); the sale is a
        // physical fact already shipped, so never let one short line refuse and
        // roll back the whole fulfillment — record it and allow negative.
        const opts = { skipShopifyPush: true, allowNegative: true };

        // D16 — MUSE make-to-order: if the variant has an oil_id AND its master
        // defines a BOM, the finished good was NOT pre-produced. Deduct its full
        // BOM here instead of a finished-good stock row: oil from the shared
        // Fragrance Library (MUSE bucket) + ethanol + packaging. On cancel, restore
        // all. Variants without oil_id/BOM keep the legacy finished-good deduction.
        const bom = await computeFinishedGoodBom(tq, p.id, qty);
        if (bom.makeToOrder) {
          if (isCancel) {
            await restoreFragranceOil(tq, bom.oil.oil_id, bom.oil.ml, 'MUSE', `${note} — oil restored`);
          } else {
            await consumeFragranceOil(tq, bom.oil.oil_id, bom.oil.ml, 'MUSE', `${note} — MUSE retail sale`);
          }
          const matResults = [];
          for (const m of bom.materials) {
            const u = await adjustProductStock(
              m.product_id, isCancel ? m.qty : -m.qty, txType, note, null, null, null, tq, opts
            );
            matResults.push({ code: m.product_code, qty: m.qty, unit: m.unit, stock_after: parseFloat(u.current_stock) });
          }
          results.push({ sku, name: p.name, qty, make_to_order: true, oil_ml: bom.oil.ml, materials: matResults });
        } else {
          const delta = isCancel ? qty : -qty;
          const updated = await adjustProductStock(p.id, delta, txType, note, null, null, null, tq, opts);
          const stockAfter = parseFloat(updated.current_stock);
          const oversold = isShip && stockAfter < 0;
          if (oversold) {
            console.warn(`[muse-fulfil] ${sku} oversold — stock now ${stockAfter} (sale recorded; investigate physical count)`);
          }
          results.push({ sku, name: p.name, qty, delta, stock_after: stockAfter, oversold });
        }
      }

      await tq(
        `INSERT INTO webhook_processed (shopify_order_id, webhook_type) VALUES ($1, $2)`,
        [fulfillmentId, webhookType]
      );
    });

    if (results.length) {
      const summary = results.map((r) => `${r.sku} ${r.delta > 0 ? '+' : ''}${r.delta}`).join(', ');
      console.log(`[muse-fulfil] ${webhookType} ${key} → ${summary}`);
      await auditLog(0, isCancel ? 'muse_fulfillment_reversed' : 'muse_fulfillment_sale',
        'product', null, body.name || String(orderId),
        { fulfillment_id: fulfillmentId, order_id: orderId, lines: results });
    } else {
      console.log(`[muse-fulfil] ${key} matched no SM products — nothing deducted`);
    }
  } finally {
    processingFulfillments.delete(key);
  }
}

async function smWebhookHandler(req, res) {
  const topic = req.headers['x-shopify-topic'] || 'unknown'
  console.log(`[webhook] received topic=${topic}`)

  // HMAC verification — for API-registered webhooks, secret = SHOPIFY_API_SECRET (client secret)
  const secret = req.hmacVerified ? null : (process.env.SM_SHOPIFY_WEBHOOK_SECRET || process.env.SM_SHOPIFY_API_SECRET)
  if (secret) {
    const hmac = req.headers['x-shopify-hmac-sha256']
    const body = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)))
    const digest = crypto.createHmac('sha256', secret).update(body).digest('base64')
    if (!hmac || digest !== hmac) {
      console.warn(`[webhook] HMAC mismatch — topic=${topic} expected=${digest} got=${hmac}`)
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  res.status(200).json({ received: true })

  try {
    const rawBodyStr = Buffer.isBuffer(req.body) ? req.body.toString() : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))

    // D13 — MUSE retail: stock leaves on shipment, returns on cancellation.
    if (FULFILLMENT_TOPICS.includes(topic)) {
      return await smFulfillmentHandler(req, res, topic, JSON.parse(rawBodyStr))
    }

    if (!['orders/paid', 'orders/cancelled'].includes(topic)) return

    const rawBody = rawBodyStr
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
          // force: a cancellation coming FROM Shopify is the customer's decision
          // arriving from outside. Refusing it because of our own state machine
          // would silently drop the event — worse than recording a late cancel.
          // This is the ONE deliberate bypass; everything else validates.
          await setOrderStatus(order.id, 'cancelled', {
            force: true,
            extra: { shopify_order_id: shopifyOrderId, shopify_order_number: body.name },
          })
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
}
router.post('/webhook/shopify', smWebhookHandler)

router.post('/shopify/draft-order', auth, async (req, res) => {
  try {
    const { production_order_id } = req.body
    if (!process.env.SM_SHOPIFY_SHOP_DOMAIN || !process.env.SM_SHOPIFY_ACCESS_TOKEN) {
      return res.status(503).json({ error: 'Shopify not configured' })
    }

    // Built by the SHARED builder (services/shopify-sync). This route used to
    // construct its own query + line titles, which is how it kept printing
    // "— N/A" for Fragrance Library lines long after the retry path was fixed:
    // the oil join simply didn't exist here. One builder now, no drift.
    const draftOrder = await buildDraftOrderPayload(production_order_id)

    const response = await fetch(
      `https://${process.env.SM_SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/draft_orders.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SM_SHOPIFY_ACCESS_TOKEN },
        body: JSON.stringify(draftOrder)
      }
    )

    const data = await response.json()
    if (!response.ok) {
      // Shopify down — queue for retry instead of failing the user
      await enqueueDraftOrder(production_order_id)
      return res.json({ queued: true, message: 'Shopify unavailable — draft order queued for retry' })
    }

    // Record the Shopify ids, and advance the COMMERCIAL lifecycle only if the
    // order is still sitting in 'draft'. It used to force status='confirmed'
    // unconditionally, which silently erased a physical state like
    // 'waiting_external' or 'in_production' — publishing an order that was out at
    // a supplier would have reset it as if nothing were dispatched.
    // (Consistent with STATUS_TRANSITIONS, where 'confirmed' may only follow 'draft'.)
    await query(
      `UPDATE production_orders
          SET shopify_draft_order_id = $1,
              shopify_draft_order_number = $2,
              status = CASE WHEN status = 'draft' THEN 'confirmed' ELSE status END,
              updated_at = NOW()
        WHERE id = $3`,
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
module.exports.smWebhookHandler = smWebhookHandler
