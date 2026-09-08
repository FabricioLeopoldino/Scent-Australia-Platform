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
// ═══════════════════════════════════════════════════════════════════════════

// What an unmatched line records, beyond the reason it did not match.
//
// The Atelier has not launched, so nobody can say yet how its orders will be
// shaped — whether the finish arrives as a variant option, a line-item property
// or a separate product. Guessing is what caused a week of rework, so the alarm
// captures the whole line instead: the first real Atelier order answers the
// question by itself, with nobody having to be watching when it lands.
//
// Three sellable variants on the store already hint at the answer (Room Spray /
// Standard, Room Spray / Metallic foil, Graphic design service) — none has a
// SKU, so all three would arrive here.
//
// ONE definition, used by both unmatched paths: the order webhook
// (shopify_order_unmatched) and the fulfilment webhook
// (muse_fulfillment_unmatched). They are separate code and it would be easy to
// instrument only the first — the regression caught exactly that mistake — and
// two copies is how the webhook topics and the format lists drifted apart.
//
// properties is where personalisation rides; capped so a pasted brief cannot
// bloat the audit row. Internal, admin/root only, like the order itself.
const lineShape = (li) => ({
  variant_title: li.variant_title || null,
  variant_id: li.variant_id || null,
  product_id: li.product_id || null,
  vendor: li.vendor || null,
  price: li.price || null,
  properties: Array.isArray(li.properties) && li.properties.length
    ? li.properties.slice(0, 10).map((p) => ({ name: p.name, value: String(p.value ?? '').slice(0, 200) }))
    : null,
});

async function planLinesFromShopifyOrder(tq, body) {
  const toProduce = [];
  const unmatched = [];
  const fromStock = [];   // matched, and the shelf already covers it — pick, don't make
  const shape = lineShape;
  for (const li of (Array.isArray(body.line_items) ? body.line_items : [])) {
    const sku = (li.sku || '').trim();
    const qty = parseInt(li.quantity, 10) || 0;
    const title = li.title || li.name || '(untitled)';
    if (qty <= 0) continue;
    if (!sku) { unmatched.push({ reason: 'no_sku', title, qty, ...shape(li) }); continue; }

    const r = await tq(
      `SELECT p.id, p.name, p.current_stock, p.oil_id, p.fragrance_id,
              m.product_code AS master_code, m.default_oil_pct
         FROM products p
         LEFT JOIN products m ON m.id = p.master_product_id
        WHERE p.sku = $1`,
      [sku]
    );
    const v = r.rows[0];
    if (!v) { unmatched.push({ reason: 'sku_not_found', sku, title, qty, ...shape(li) }); continue; }
    // No master means no BOM. Creating the line anyway would produce an order
    // that can be started while debiting nothing — the exact dangling state
    // validateProductTypes exists to prevent on the manual path.
    if (!v.master_code) { unmatched.push({ reason: 'no_master', sku, title, qty, ...shape(li) }); continue; }

    const need = qty - (parseFloat(v.current_stock) || 0);
    if (need <= 0) {
      // Covered by finished stock, so there is nothing to MAKE — but somebody
      // still has to pick it and post it. This used to `continue` and the line
      // was gone: order #1022 (Daniel Edwards, 17 Aug, one Adventure Room Spray
      // off a shelf of one) left exactly one row in the whole platform, in
      // webhook_processed, and appeared on no screen at all. Kept so the order
      // can be shown as waiting to ship.
      fromStock.push({ sku, title, qty, product_id: v.id, variant_name: v.name });
      continue;
    }

    toProduce.push({
      product_type: v.master_code,
      oil_id: v.oil_id || null,
      fragrance_id: v.fragrance_id || null,
      oil_pct: parseFloat(v.default_oil_pct) || 25,
      quantity: Math.ceil(need),
      variant_name: v.name,
      // Same shape() already used for the unmatched alarm — a matched line
      // (has a SKU) used to drop this on the floor entirely. Metallic Foil,
      // an uploaded label, a chosen finish: none of it is a component, all of
      // it is something a human needs to read before producing the line.
      properties: shape(li).properties,
    });
  }
  return { toProduce, unmatched, fromStock };
}

async function createProductionOrderFromShopify(body, shopifyOrderId) {
  const orderRef = body.name || String(shopifyOrderId);
  const { getNextOrderNumber } = require('./production-orders');

  // getNextOrderNumber reads the highest existing number and adds one — there is
  // no sequence behind it. Two MUSE orders paid seconds apart therefore compute
  // the SAME number, the second INSERT violates UNIQUE(order_number), the
  // transaction rolls back and the exception is swallowed by the handler's
  // catch. That paid order would produce nothing and say nothing, and Shopify
  // will not redeliver because the 200 was already sent. Retrying on exactly
  // that collision is the fix; anything else rethrows.
  const attempt = async () => await withTransaction(async (client) => {
    const tq = (text, params) => client.query(text, params);
    const { toProduce, unmatched, fromStock } = await planLinesFromShopifyOrder(tq, body);
    // fromStock has to come back HERE above all: this is the branch a
    // shelf-covered order takes, and without it plan.fromStock is undefined and
    // the "waiting to ship" audit never fires — on the one path it exists for.
    if (toProduce.length === 0) return { toProduce, unmatched, fromStock, order: null };

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
      // needs_packing = true (owner, 2026-08-10: a MUSE order from the site
      // always ships packed). Without it buildLineComponents skips every
      // component_group='packing' row, so the production order would omit the
      // packaging — and the sticks on a reed diffuser — while a make-to-order
      // shipment of the SAME product consumes them: two material bills for one
      // product. Each master only carries its own packing rows, so this stays
      // correct per format (sticks exist on RD200 alone).
      const dbLine = (await tq(
        `INSERT INTO production_order_lines
           (production_order_id, line_number, product_type, fragrance_id, oil_id,
            variant_name, oil_pct, quantity, unit_price, is_candle, needs_packing,
            customer_properties)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,true,$10) RETURNING *`,
        [ord.id, i + 1, line.product_type, line.fragrance_id, line.oil_id,
         line.variant_name, line.oil_pct, line.quantity,
         ['CANDLE_240G', 'CANDLE_400G'].includes(line.product_type),
         line.properties ? JSON.stringify(line.properties) : null]
      )).rows[0];
      // Same BOM builder the manual path uses — without it the order would
      // start and debit nothing.
      await buildLineComponents(ord.id, dbLine, line, null, tq);
    }
    return { toProduce, unmatched, fromStock, order: ord };
  });

  let plan;
  for (let tries = 0; ; tries++) {
    try { plan = await attempt(); break; }
    catch (e) {
      const collision = e.code === '23505' && String(e.constraint || e.detail || '').includes('order_number');
      if (!collision || tries >= 4) throw e;
      console.warn(`[muse-order] order number collision on ${orderRef}, retrying (${tries + 1})`);
      await new Promise((r) => setTimeout(r, 150 * (tries + 1)));
    }
  }

  if (plan.order) {
    console.log(`[muse-order] ${orderRef} → ${plan.order.order_number} (draft, ${plan.toProduce.length} line(s) to produce)`);
    await auditLog(0, 'shopify_order_ingested', 'production_order', plan.order.id, plan.order.order_number, {
      shopify_order: orderRef, shopify_order_id: shopifyOrderId,
      lines: plan.toProduce.map((l) => ({ product_type: l.product_type, qty: l.quantity, variant: l.variant_name })),
    });
  } else if (plan.fromStock?.length) {
    // Nothing to MAKE, but the goods still have to be picked and posted. Until
    // 2026-08-18 this branch was a console.log and nothing else, so an order
    // that shipped off the shelf existed nowhere a person could see it. Order
    // #1022 — a real customer, paid on a Sunday — sat unshipped and unknown
    // until the Monday preflight noticed a webhook that had moved nothing.
    //
    // This gets WORSE as the range builds up finished stock, which is the plan
    // for the Library: the more they hold, the more orders vanish.
    //
    // The audit row is what /dashboard/awaiting-shipment reads, and it is
    // cleared by the fulfilment webhook writing muse_fulfillment_sale for the
    // same Shopify order id.
    console.log(`[muse-order] ${orderRef} — covered by finished stock, nothing to make; waiting to ship`);
    await auditLog(0, 'shopify_order_ready_to_ship', 'production_order', null, orderRef, {
      shopify_order: orderRef,
      shopify_order_id: shopifyOrderId,
      lines: plan.fromStock.map((l) => ({ sku: l.sku, qty: l.qty, variant: l.variant_name || l.title })),
    });
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
    // A production order for this same Shopify order changes what the shipment
    // is allowed to do (2026-08-10). Read it ONCE, before the lines.
    //   already debited  — start production has run, so the oil and materials
    //                      are accounted for. Consuming again here is the
    //                      double-count proven on 2026-08-10: 1000 mL taken for
    //                      a 500 mL batch.
    //   still open       — nothing has been made through it, so this shipment
    //                      IS the production. The order must not stay behind to
    //                      be run a second time.
    const poRows = isShip && orderId ? (await query(
      `SELECT id, order_number, status FROM production_orders WHERE shopify_order_id = $1`,
      [orderId])).rows : [];
    const DEBITED = ['in_production', 'waiting_external', 'completed', 'fulfilled'];
    const poDebited = poRows.find((r) => DEBITED.includes(r.status));
    const poOpen = poRows.find((r) => ['draft', 'queued'].includes(r.status));
    const staleOrders = [];

    await withTransaction(async (client) => {
      const tq = (t, p) => client.query(t, p);
      for (let i = 0; i < lines.length; i++) {
        const li = lines[i];
        const sku = (li.sku || '').trim();
        const qty = parseInt(li.quantity, 10) || 0;
        const title = li.title || li.name || '(untitled)';
        if (qty <= 0) continue; // nothing shipped on this line — genuinely nothing to do
        if (!sku) {
          // The SKU is the ONLY join to our catalogue. Without it the goods have
          // left the building and no stock moved. This used to `continue`
          // silently; MUSE went retail on 2026-08-10 with a catalogue marketing
          // rebuilt by hand, so a variant created without a SKU is a real risk.
          // ...and this is the path that matters most for the Atelier: goods
          // that actually shipped. lineShape brings back what the line was.
          unmatched.push({ reason: 'no_sku', title, qty, ...lineShape(li) });
          continue;
        }

        // ── Each line is isolated by a savepoint ─────────────────────────────
        // Everything below runs in ONE transaction so the stock movements and
        // the webhook_processed marker commit together. But before this, a throw
        // on any single line — lockOil rejecting a missing or exclusivity-locked
        // oil is the live case — aborted the whole transaction, so a three-line
        // shipment moved NO stock at all. Worse, the 200 has already been sent,
        // so Shopify never retries, and the alarm below was skipped too: goods
        // gone, nothing recorded, nothing said. A savepoint undoes only the line
        // that failed and lets the rest of the shipment stand.
        const sp = `muse_line_${i}`;
        await tq(`SAVEPOINT ${sp}`);
        try {
        // MUSE variants carry the STORE sku (Muse_RD00001) — that is the join.
        const prod = await tq(
          `SELECT id, name, current_stock FROM products WHERE sku = $1 FOR UPDATE`,
          [sku]
        );
        if (!prod.rows[0]) {
          // Not one of ours (e.g. an SA product sold on another store) — skip,
          // never guess. Collected for the alarm below so a mismatch surfaces
          // in Activity, not only in a log line nobody reads.
          await tq(`RELEASE SAVEPOINT ${sp}`);
          unmatched.push({ reason: 'sku_not_found', sku, title, qty, ...lineShape(li) });
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

        if (isCancel) {
          // Unchanged: a returned unit exists as finished stock whatever made it.
          const updated = await adjustProductStock(p.id, qty, txType, note, null, null, null, tq, opts);
          results.push({ sku, name: p.name, qty, delta: qty, from_finished_stock: true, stock_after: parseFloat(updated.current_stock) });
          await tq(`RELEASE SAVEPOINT ${sp}`);
          continue;
        }

        // ── Split the line: shelf first, make the remainder ──────────────────
        // This used to be all-or-nothing on `finishedStock <= 0`, so ANY stock
        // on the shelf sent the WHOLE quantity down the shelf branch. Two on the
        // shelf and five sold drove stock to −3 while the three units actually
        // made consumed no oil, no ethanol and no packaging — invisible until
        // someone noticed the negative balance.
        const fromShelf = Math.min(qty, Math.max(0, finishedStock));
        const toMake = qty - fromShelf;
        const line = { sku, name: p.name, qty, from_shelf: fromShelf, made: toMake };

        if (fromShelf > 0) {
          const u = await adjustProductStock(p.id, -fromShelf, txType, `${note} — ${fromShelf} from stock`, null, null, null, tq, opts);
          line.stock_after = parseFloat(u.current_stock);
        }

        if (toMake > 0) {
          if (poDebited) {
            // Production already took the materials for these units; it simply
            // has not been marked complete, which is why the shelf is short.
            // Consuming again is the double-count. Record and raise it instead.
            line.deferred_to = poDebited.order_number;
            unmatched.push({
              reason: 'production_not_completed', sku, title, qty: toMake,
              production_order: poDebited.order_number, production_status: poDebited.status,
            });
          } else {
            const bom = await computeFinishedGoodBom(tq, p.id, toMake);
            if (bom.makeToOrder) {
              await consumeFragranceOil(tq, bom.oil.oil_id, bom.oil.ml, 'MUSE', `${note} — ${toMake} made to order`);
              const matResults = [];
              for (const m of bom.materials) {
                const u = await adjustProductStock(m.product_id, -m.qty, txType, note, null, null, null, tq, opts);
                matResults.push({ code: m.product_code, qty: m.qty, unit: m.unit, stock_after: parseFloat(u.current_stock) });
              }
              line.oil_ml = bom.oil.ml;
              line.materials = matResults;
              if (poOpen && !staleOrders.some((s) => s.id === poOpen.id)) staleOrders.push(poOpen);
            } else {
              // No oil or no BOM: nothing can be consumed, so the shortfall can
              // only be recorded as an oversell. Loud, because a sale that
              // consumes nothing is exactly the silence we are trying to remove.
              const u = await adjustProductStock(p.id, -toMake, txType, `${note} — ${toMake} with no BOM to consume`, null, null, null, tq, opts);
              line.stock_after = parseFloat(u.current_stock);
              line.oversold = true;
              unmatched.push({ reason: 'no_bom_to_consume', sku, title, qty: toMake });
            }
          }
        }
        results.push(line);
        await tq(`RELEASE SAVEPOINT ${sp}`);
        } catch (e) {
          // Undo THIS line only; the rest of the shipment stands.
          await tq(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
          console.error(`[muse-fulfil] line ${sku} failed and was rolled back: ${e.message}`);
          unmatched.push({ reason: 'line_failed', sku, title, qty, error: e.message });
        }
      }

      // An open production order whose goods have now shipped is finished work,
      // not pending work. Leaving it would let the office run it later and burn
      // a second batch of oil for units already with the customer.
      for (const s of staleOrders) {
        await setOrderStatus(s.id, 'cancelled', {
          tq, force: true,
          extra: { notes: `Closed automatically: Shopify order ${body.name || orderId} shipped before this was produced` },
        });
        console.log(`[muse-fulfil] ${s.order_number} closed — its goods shipped as made-to-order`);
      }

      await tq(
        `INSERT INTO webhook_processed (shopify_order_id, webhook_type) VALUES ($1, $2)`,
        [fulfillmentId, webhookType]
      );
    });

    if (results.length) {
      const summary = results.map((r) => r.delta !== undefined
        ? `${r.sku} ${r.delta > 0 ? '+' : ''}${r.delta}`
        : `${r.sku} ${r.from_shelf ? `${r.from_shelf} from stock` : ''}${r.from_shelf && r.made ? ' + ' : ''}${r.made ? `${r.made} made` : ''}`.trim()
      ).join(', ');
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

    // A refund is NOT a cancellation, and Shopify sends no orders/cancelled for
    // one. Order #1020 (2026-08-10) was paid, then refunded with its items
    // removed — the ONLY event we ever received was orders/paid, so SM-001 sat
    // in draft as real work for an order that no longer existed. The warehouse
    // could have produced it and found out at the shipping screen, after the
    // labour was spent.
    //
    // This deliberately does NOT change the order's status. A refund can be
    // partial, can be goodwill, and can arrive long after the goods shipped;
    // deciding any of that automatically would be guessing with someone's stock,
    // and orders/cancelled already exists for the unambiguous case. What was
    // actually lost here was the CHANCE TO STOP, so that is what this restores:
    // the order becomes impossible to miss.
    if (topic === 'refunds/create') {
      const body = JSON.parse(rawBodyStr)
      // body.id is the REFUND id — the order is body.order_id. Getting this
      // wrong would look up a production order that cannot exist.
      const shopifyOrderId = body.order_id
      const refundId = body.id
      if (!shopifyOrderId) { console.warn('[muse-refund] refund with no order_id — ignored'); return }

      // Keyed per refund, not per order: partial refunds are normal, and a
      // second one carries new information. VARCHAR(50) holds this comfortably.
      const wtype = `refunds/create#${refundId}`
      const claimed = await query(
        `INSERT INTO webhook_processed (shopify_order_id, webhook_type) VALUES ($1, $2)
         ON CONFLICT (shopify_order_id, webhook_type) DO NOTHING RETURNING id`,
        [shopifyOrderId, wtype]
      )
      if (!claimed.rows[0]) { console.log(`[muse-refund] refund ${refundId} already processed`); return }

      const po = await query(`SELECT * FROM production_orders WHERE shopify_order_id = $1`, [shopifyOrderId])
      const order = po.rows[0]
      const units = (Array.isArray(body.refund_line_items) ? body.refund_line_items : [])
        .reduce((n, li) => n + (parseInt(li.quantity, 10) || 0), 0)

      if (!order) {
        // Every MUSE line was covered by finished stock, or the sale predates the
        // ingestion — no production work exists to warn about. Still worth a line
        // in the log so a refund is never invisible.
        console.log(`[muse-refund] refund ${refundId} on Shopify order ${shopifyOrderId} — no production order of ours`)
        return
      }

      const stamp = `⚠️ REFUNDED on Shopify (${units} unit(s), refund ${refundId}) — confirm before producing`
      await query(
        `UPDATE production_orders
            SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $1 ELSE notes || E'\\n' || $1 END,
                updated_at = NOW()
          WHERE id = $2`,
        [stamp, order.id]
      )
      console.error(`⚠️  [muse-refund] ${order.order_number} (${order.status}) — Shopify order refunded, ${units} unit(s). Status NOT changed; a human decides.`)
      await auditLog(0, 'shopify_order_refunded', 'production_order', order.id, order.order_number, {
        shopify_order_id: shopifyOrderId, refund_id: refundId, units, order_status: order.status,
      })
      return
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
      // Orders WE created from a Shopify order (the Atelier / make-to-order path
      // below) carry neither a draft_order_id nor an "SM Order:" note — they are
      // stamped with shopify_order_id. Without this lookup they could never be
      // found again, so a CANCELLATION would sail past and the production order
      // would sit in draft as if nothing had happened: the warehouse could make
      // an order the customer already cancelled. Payment releases production
      // (owner, 2026-08-10), so the reverse signal has to land too.
      if (!prodOrder.rows[0]) {
        prodOrder = await query(`SELECT * FROM production_orders WHERE shopify_order_id = $1`, [shopifyOrderId])
        if (prodOrder.rows[0]) console.log(`[webhook] matched by shopify_order_id: ${prodOrder.rows[0].order_number}`)
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
