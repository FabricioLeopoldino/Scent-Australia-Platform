const { query } = require('../db')

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] // 1m 5m 15m 1h 6h
const MAX_ATTEMPTS = 5

async function enqueueDraftOrder(productionOrderId) {
  await query(
    `INSERT INTO pending_shopify_sync (action_type, payload, next_retry_at)
     VALUES ('draft_order', $1::jsonb, NOW())`,
    [JSON.stringify({ production_order_id: productionOrderId })]
  )
}

async function processDraftOrder(payload) {
  if (!process.env.SHOPIFY_SHOP_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Shopify not configured')
  }

  const order = await query(
    `SELECT po.*, c.shopify_customer_id FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE po.id = $1`,
    [payload.production_order_id]
  )
  if (!order.rows[0]) throw new Error('Order not found')

  const lines = await query(
    `SELECT pol.*, pf.name as fragrance_name, master.name as master_name
     FROM production_order_lines pol
     LEFT JOIN products pf ON pol.fragrance_id = pf.id
     LEFT JOIN products master ON master.product_code = pol.product_type AND master.is_master = true
     WHERE pol.production_order_id = $1`,
    [payload.production_order_id]
  )

  // FR-HOOK-5 (shared store): no SKUs on SM draft-order line items.
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
      note: `SM Order: ${order.rows[0].order_number} | Due: ${order.rows[0].due_date || 'TBD'}`,
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
  if (!response.ok) throw new Error(data.errors ? JSON.stringify(data.errors) : 'Shopify API error')

  await query(
    `UPDATE production_orders SET shopify_draft_order_id = $1, status = 'confirmed', updated_at = NOW() WHERE id = $2`,
    [data.draft_order.id, payload.production_order_id]
  )
}

let cachedLocationId = null
async function getPrimaryLocationId() {
  if (cachedLocationId) return cachedLocationId
  const res = await fetch(
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2026-04/locations.json`,
    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } }
  )
  const data = await res.json()
  cachedLocationId = data.locations?.[0]?.id || null
  return cachedLocationId
}

async function enqueueInventoryAdjust(productId, delta) {
  await query(
    `INSERT INTO pending_shopify_sync (action_type, payload, next_retry_at) VALUES ('inventory_adjust', $1::jsonb, NOW())`,
    [JSON.stringify({ product_id: productId, delta })]
  )
}

async function processInventoryAdjust(payload) {
  if (!process.env.SHOPIFY_SHOP_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Shopify not configured')
  }
  const prod = await query(`SELECT shopify_inventory_item_id FROM products WHERE id = $1`, [payload.product_id])
  const inventoryItemId = prod.rows[0]?.shopify_inventory_item_id
  if (!inventoryItemId) return // product was never published to Shopify — nothing to sync

  const locationId = await getPrimaryLocationId()
  if (!locationId) throw new Error('Could not resolve Shopify location')

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2026-04/inventory_levels/adjust.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available_adjustment: payload.delta })
    }
  )
  const data = await response.json()
  if (!response.ok) throw new Error(data.errors ? JSON.stringify(data.errors) : 'Shopify inventory adjust failed')
}

async function runRetryQueue() {
  try {
    const pending = await query(
      `SELECT * FROM pending_shopify_sync WHERE status = 'pending' AND next_retry_at <= NOW() ORDER BY next_retry_at ASC LIMIT 10`
    )
    for (const item of pending.rows) {
      const attempts = item.attempts + 1
      try {
        if (item.action_type === 'draft_order') {
          await processDraftOrder(item.payload)
        } else if (item.action_type === 'inventory_adjust') {
          await processInventoryAdjust(item.payload)
        }
        await query(`UPDATE pending_shopify_sync SET status = 'done', attempts = $1 WHERE id = $2`, [attempts, item.id])
        console.log(`[shopify-sync] Item ${item.id} processed OK (attempt ${attempts})`)
      } catch (e) {
        const nextDelay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]
        const nextRetry = new Date(Date.now() + nextDelay)
        const newStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
        await query(
          `UPDATE pending_shopify_sync SET attempts = $1, last_error = $2, next_retry_at = $3, status = $4 WHERE id = $5`,
          [attempts, e.message, nextRetry.toISOString(), newStatus, item.id]
        )
        console.warn(`[shopify-sync] Item ${item.id} failed (attempt ${attempts}): ${e.message}`)
      }
    }
  } catch (e) {
    console.error('[shopify-sync] Queue error:', e.message)
  }
}

function startSyncCron() {
  setInterval(runRetryQueue, 60_000)
  console.log('[shopify-sync] Retry cron started (60s interval)')
}

async function registerWebhooks() {
  const domain = process.env.SHOPIFY_SHOP_DOMAIN
  const token  = process.env.SHOPIFY_ACCESS_TOKEN
  // PLATFORM PORT (Phase 5): callback targets the platform receiver at the
  // public platform URL. https-only guard prevents local dev boots from
  // registering localhost callbacks against the real store.
  const host   = process.env.PLATFORM_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL

  if (!domain || !token) return
  if (!host || !host.startsWith('https://')) {
    console.log('[shopify-webhooks] No public https URL — skipping registration (local dev)')
    return
  }

  const callbackUrl = `${host}/api/webhook/shopify/sa` // platform receiver, shared SA store (OD1)
  const topics = ['orders/paid', 'orders/cancelled']

  for (const topic of topics) {
    try {
      // Check if already registered
      const list = await fetch(
        `https://${domain}/admin/api/2026-04/webhooks.json?topic=${topic}`,
        { headers: { 'X-Shopify-Access-Token': token } }
      )
      const { webhooks } = await list.json()
      const exists = webhooks?.some(w => w.address === callbackUrl)
      if (exists) {
        console.log(`[shopify-webhooks] ${topic} already registered`)
        continue
      }

      const res = await fetch(`https://${domain}/admin/api/2026-04/webhooks.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ webhook: { topic, address: callbackUrl, format: 'json' } })
      })
      const data = await res.json()
      if (data.webhook?.id) {
        console.log(`[shopify-webhooks] Registered ${topic} → ${callbackUrl}`)
      } else {
        console.warn(`[shopify-webhooks] Failed to register ${topic}:`, JSON.stringify(data))
      }
    } catch (e) {
      console.warn(`[shopify-webhooks] Error registering ${topic}:`, e.message)
    }
  }
}

module.exports = { enqueueDraftOrder, enqueueInventoryAdjust, startSyncCron, registerWebhooks }
