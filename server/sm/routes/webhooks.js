const express = require('express')
const { sanitizeError } = require('../errors')
const router = express.Router()
const crypto = require('crypto')
const { query, withTransaction } = require('../db')
const { auth, auditLog } = require('../auth')
const { enqueueDraftOrder, buildDraftOrderPayload } = require('../services/shopify-sync')
const { adjustProductStock } = require('../services/stock-service')
const { computeFinishedGoodBom, buildLineComponents } = require('../services/bom-builder')
const { consumeFragranceOil } = require('../services/fragrance-library')
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

// ═══════════════════════════════════════════════════════════════════════════
// MAKE-TO-ORDER INGESTION (owner-designed 2026-08-06, built 2026-08-07)
// ═══════════════════════════════════════════════════════════════════════════
// SM stays manual: the coordinator creates the order here and it becomes a
// Shopify draft order. MUSE is inverting — with "The Atelier" the customer
// configures on the site and the order lands in Shopify already assembled.
//
// Such an order was INVISIBLE to the platform. The orders/paid handler below
// only ever LOOKED for a production order (by draft_order_id, or by an
// "SM Order: SM-###" note we wrote ourselves) and, finding none, logged
// NOT FOUND and did nothing. Nobody learned there was something to make.
//
// The STOCK half already works and is deliberately untouched here:
// smFulfillmentHandler consumes the BOM at fulfilment when no finished stock
// exists (D16). What was missing is the WORK QUEUE.
//
// The rule that removes the need for a per-product make-to-order flag:
//
//     need = quantity ordered − finished stock on hand
//       need <= 0  → ships from the shelf, produce nothing
//       need >  0  → one production line for the difference
//
// Right for make-to-order (nothing on hand), make-to-stock (enough on hand)
// and the partial case, with no mode anyone has to keep in sync — and it
// mirrors what the warehouse already does when it produces on availability.
//
// Born as 'draft' on purpose (owner: "a pessoa que cuida da Muse meio que
// lança a order para manufacturing queue"). The office reviews, then pushes
// it to 'queued' — the transition where createReservations already runs, so
// reservations are NOT taken here and the manual and automatic paths converge.
//
// Numbering stays on the shared SM-### sequence. A 'MUSE-' prefix was the
// original plan and is wrong: getNextOrderNumber parses the previous number
// back out with replace('SM-',''), so one MUSE-numbered row would make every
// later order SM-NaN. The Shopify identity lives in shopify_order_number.
async function planLinesFromShopifyOrder(tq, body) {
  const toProduce = [];
  const unmatched = [];
  for (const li of (Array.isArray(body.line_items) ? body.line_items : [])) {
    const sku = (li.sku || '').trim();
    const qty = parseInt(li.quantity, 10) || 0;
    const title = li.title || li.name || '(untitled)';
    if (qty <= 0) continue;
    if (!sku) { unmatched.push({ reason: 'no_sku', title, qty }); continue; }

    const r = await tq(
      `SELECT p.id, p.name, p.current_stock, p.oil_id, p.fragrance_id,
              m.product_code AS master_code, m.default_oil_pct
         FROM products p
         LEFT JOIN products m ON m.id = p.master_product_id
        WHERE p.sku = $1`,
      [sku]
    );
    const v = r.rows[0];
    if (!v) { unmatched.push({ reason: 'sku_not_found', sku, title, qty }); continue; }
    // No master means no BOM. Creating the line anyway would produce an order
    // that can be started while debiting nothing — the exact dangling state
    // validateProductTypes exists to prevent on the manual path.
    if (!v.master_code) { unmatched.push({ reason: 'no_master', sku, title, qty }); continue; }

    const need = qty - (parseFloat(v.current_stock) || 0);
    if (need <= 0) continue; // covered by finished stock already on the shelf

    toProduce.push({
      product_type: v.master_code,
      oil_id: v.oil_id || null,
      fragrance_id: v.fragrance_id || null,
      oil_pct: parseFloat(v.default_oil_pct) || 25,
      quantity: Math.ceil(need),
      variant_name: v.name,
    });
  }
  return { toProduce, unmatched };
}

async function createProductionOrderFromShopify(body, shopifyOrderId) {
  const orderRef = body.name || String(shopifyOrderId);
  const { getNextOrderNumber } = require('./production-orders');

  const plan = await withTransaction(async (client) => {
    const tq = (text, params) => client.query(text, params);
    const { toProduce, unmatched } = await planLinesFromShopifyOrder(tq, body);
    if (toProduce.length === 0) return { toProduce, unmatched, order: null };

    const orderNumber = await getNextOrderNumber();
    const ord = (await tq(
      // created_by stays NULL — no person created this one, and the column has
      // an FK to users so a sentinel id would not insert. NULL is also how the
      // UI already distinguishes a system-born order from a typed one.
      `INSERT INTO production_orders
         (order_number, client_id, order_type, notes, status, created_by,
          shopify_order_id, shopify_order_number)
       VALUES ($1, NULL, 'STANDARD', $2, 'draft', NULL, $3, $4) RETURNING *`,
      [orderNumber, `Auto-created from Shopify order ${orderRef}`, shopifyOrderId, body.name || null]
    )).rows[0];

    for (let i = 0; i < toProduce.length; i++) {
      const line = toProduce[i];
      const dbLine = (await tq(
        `INSERT INTO production_order_lines
           (production_order_id, line_number, product_type, fragrance_id, oil_id,
            variant_name, oil_pct, quantity, unit_price, is_candle)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9) RETURNING *`,
        [ord.id, i + 1, line.product_type, line.fragrance_id, line.oil_id,
         line.variant_name, line.oil_pct, line.quantity,
         ['CANDLE_240G', 'CANDLE_400G'].includes(line.product_type)]
      )).rows[0];
      // Same BOM builder the manual path uses — without it the order would
      // start and debit nothing.
      await buildLineComponents(ord.id, dbLine, line, null, tq);
    }
    return { toProduce, unmatched, order: ord };
  });

  if (plan.order) {
    console.log(`[muse-order] ${orderRef} → ${plan.order.order_number} (draft, ${plan.toProduce.length} line(s) to produce)`);
    await auditLog(0, 'shopify_order_ingested', 'production_order', plan.order.id, plan.order.order_number, {
      shopify_order: orderRef, shopify_order_id: shopifyOrderId,
      lines: plan.toProduce.map((l) => ({ product_type: l.product_type, qty: l.quantity, variant: l.variant_name })),
    });
  } else {
    console.log(`[muse-order] ${orderRef} — every line is covered by finished stock, no production order created`);
  }

  // Lines we could not plan. Unlike the fulfilment alarm nothing has shipped
  // yet, so this is a warning, not a loss — but it means the production order
  // is short and somebody has to add the missing work by hand.
  if (plan.unmatched.length > 0) {
    console.error(
      `⚠️  [muse-order] INCOMPLETE — order ${orderRef}: ` +
      plan.unmatched.map((u) => `"${u.title}" ×${u.qty} (${u.reason}${u.sku ? ` ${u.sku}` : ''})`).join(' | ')
    );
    try {
      await auditLog(0, 'shopify_order_unmatched', 'production_order', plan.order?.id || null, orderRef, {
        shopify_order: orderRef, shopify_order_id: shopifyOrderId, unmatched: plan.unmatched,
      });
    } catch (e) {
      console.error(`[muse-order] could not record the incomplete-order alarm: ${e.message}`);
    }
  }
}

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
    // Lines we could NOT act on. A shipped sale that moves no stock is the most
    // expensive kind of silence, so these are collected and raised at the end
    // instead of being dropped (see the alarm after the transaction).
    const unmatched = [];
    await withTransaction(async (client) => {
      const tq = (t, p) => client.query(t, p);
      for (const li of lines) {
        const sku = (li.sku || '').trim();
        const qty = parseInt(li.quantity, 10) || 0;
        if (qty <= 0) continue; // nothing shipped on this line — genuinely nothing to do
        if (!sku) {
          // The SKU is the ONLY join to our catalogue. Without it the goods have
          // left the building and no stock moved. This used to `continue`
          // silently; MUSE went retail on 2026-08-10 with a catalogue marketing
          // rebuilt by hand, so a variant created without a SKU is a real risk.
          unmatched.push({ reason: 'no_sku', title: li.title || li.name || '(untitled)', qty });
          continue;
        }

        // MUSE variants carry the STORE sku (Muse_RD00001) — that is the join.
        const prod = await tq(
          `SELECT id, name, current_stock FROM products WHERE sku = $1 FOR UPDATE`,
          [sku]
        );
        if (!prod.rows[0]) {
          // Not one of ours (e.g. an SA product sold on another store) — skip,
          // never guess. Collected for the alarm below so a mismatch surfaces
          // in Activity, not only in a log line nobody reads.
          unmatched.push({ reason: 'sku_not_found', sku, title: li.title || li.name || '(untitled)', qty });
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

        // ── MUSE stock model (D16 + hybrid, owner 2026-07-24) ────────────────
        // A finished-good variant can be sold two ways, and the choice is made
        // PER SALE by whether pre-made stock exists:
        //
        //   SALE with finished stock on hand  → deduct the finished good.
        //     Covers pre-produced batches and imports (e.g. 1000 units made in
        //     China, entered via Add Stock / PO receive). The oil was consumed
        //     THERE, not from our Library, so we must NOT debit the BOM.
        //
        //   SALE with no finished stock       → make-to-order: consume the BOM
        //     (oil from the shared Fragrance Library + ethanol + packaging). This
        //     is the default MUSE flow — produce on demand.
        //
        //   CANCELLATION (any)                → credit the finished good. A
        //     cancelled fulfillment means a PHYSICAL finished unit came back (or
        //     never shipped); it exists as stock now, whatever its origin. We do
        //     NOT "un-produce" it back into oil — the next sale consumes it via
        //     the rule above. This makes the two directions net out correctly:
        //     produce-on-demand → cancel → one unit now sits in finished stock.
        const finishedStock = parseFloat(p.current_stock) || 0;
        const bom = await computeFinishedGoodBom(tq, p.id, qty);
        const produceNow = isShip && bom.makeToOrder && finishedStock <= 0;

        if (produceNow) {
          await consumeFragranceOil(tq, bom.oil.oil_id, bom.oil.ml, 'MUSE', `${note} — MUSE retail sale (made to order)`);
          const matResults = [];
          for (const m of bom.materials) {
            const u = await adjustProductStock(m.product_id, -m.qty, txType, note, null, null, null, tq, opts);
            matResults.push({ code: m.product_code, qty: m.qty, unit: m.unit, stock_after: parseFloat(u.current_stock) });
          }
          results.push({ sku, name: p.name, qty, make_to_order: true, oil_ml: bom.oil.ml, materials: matResults });
        } else {
          // Finished-good movement: sale deducts, cancellation credits.
          const delta = isCancel ? qty : -qty;
          const updated = await adjustProductStock(p.id, delta, txType, note, null, null, null, tq, opts);
          const stockAfter = parseFloat(updated.current_stock);
          const oversold = isShip && stockAfter < 0;
          if (oversold) {
            console.warn(`[muse-fulfil] ${sku} oversold — stock now ${stockAfter} (sale recorded; investigate physical count)`);
          }
          results.push({ sku, name: p.name, qty, delta, from_finished_stock: true, stock_after: stockAfter, oversold });
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

    // ── ALARM: goods shipped that moved no stock ──────────────────────────
    // Raised OUTSIDE the transaction on purpose: a reporting failure must never
    // roll back a stock movement that did succeed. Every line here means
    // product physically left and the system does not know, so it is logged as
    // an error and written to Activity where the office can see it — not left
    // as a console line nobody greps.
    if (unmatched.length > 0) {
      const orderRef = body.name || String(orderId);
      console.error(
        `🚨 [muse-fulfil] STOCK NOT DEDUCTED — order ${orderRef}, fulfillment ${fulfillmentId}: ` +
        unmatched.map((u) => u.reason === 'no_sku'
          ? `"${u.title}" ×${u.qty} HAS NO SKU`
          : `"${u.title}" ×${u.qty} sku=${u.sku} not in catalogue`).join(' | ') +
        ' — link the product and adjust stock by hand.'
      );
      try {
        await auditLog(0, 'muse_fulfillment_unmatched', 'product', null, orderRef, {
          fulfillment_id: fulfillmentId, order_id: orderId,
          shopify_order: orderRef, unmatched,
        });
      } catch (e) {
        // Never let the alarm itself break the webhook — Shopify would retry a
        // fulfillment whose stock has already moved.
        console.error(`[muse-fulfil] could not record the unmatched-line alarm: ${e.message}`);
      }
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
      } else if (topic === 'orders/paid') {
        // Nothing of ours matched — this order was born on the Muse site, not
        // here. Turn it into production work. (A cancellation with no match is
        // genuinely nothing to do: we never had the order.)
        await createProductionOrderFromShopify(body, shopifyOrderId)
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
    // Report whether the Shopify customer got attached. The team is expected to
    // name clients exactly as they are in Shopify so the auto-link resolves; when
    // it doesn't (typo, or several customers match), the draft order still goes
    // through but carries NO contact/shipping address — the user has to know that
    // immediately instead of discovering it in Shopify later.
    const customerLinked = !!draftOrder.draft_order.customer
    res.json({
      draft_order_id: data.draft_order.id,
      draft_order_number: data.draft_order.name,
      draft_order_url: data.draft_order.invoice_url,
      customer_linked: customerLinked,
      customer_warning: customerLinked ? null
        : 'No matching Shopify customer — the draft order has no contact or shipping address. Check the client name matches Shopify exactly, or link it manually in Shopify.',
    })
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
