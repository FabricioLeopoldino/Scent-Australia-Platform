const { query } = require('../db')

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] // 1m 5m 15m 1h 6h
const MAX_ATTEMPTS = 5

async function enqueueDraftOrder(productionOrderId) {
  await query(
    `INSERT INTO pending_shopify_sync (action_type, payload, next_retry_at)
     VALUES ('draft_order', $1::jsonb, NOW())`,
    [JSON.stringify({ production_order_id: productionOrderId })]
  )
  kickDrain() // don't wait for the next window — see startSyncCron
}

// ── Shopify customer lookup ─────────────────────────────────────────────────
// Linking a client to a Shopify customer is what makes the draft order carry the
// real contact + shipping/billing address (Shopify fills them from the customer
// record). Without it the draft order has no customer at all.
//
// SAFETY — why this never guesses: Shopify's customer search matches addresses,
// tags, company names and notes as well as the name, so a bare term can return
// unrelated people (Shopify's own API docs warn about exactly this). Auto-linking
// the wrong customer would send an order to the wrong address, so the rule is:
// link automatically ONLY when the search returns exactly one candidate. Zero or
// several → leave it unlinked and let a human pick.
//
// (Matching is case-insensitive on Shopify's side, and because company is one of
// the searched fields, a client saved as "Oz Candles" can still resolve to the
// customer whose contact name is "Attn: Eric".)
async function searchShopifyCustomers(term) {
  if (!process.env.SM_SHOPIFY_SHOP_DOMAIN || !process.env.SM_SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Shopify not configured')
  }
  const q = String(term || '').trim()
  if (!q) return []
  const res = await fetch(
    `https://${process.env.SM_SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/customers/search.json?query=${encodeURIComponent(q)}&limit=10`,
    { headers: { 'X-Shopify-Access-Token': process.env.SM_SHOPIFY_ACCESS_TOKEN } }
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.errors ? JSON.stringify(data.errors) : 'Shopify customer search failed')
  return (data.customers || []).map(c => {
    const a = c.default_address || {}
    return {
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || a.name || '(no name)',
      email: c.email || null,
      phone: c.phone || a.phone || null,
      company: a.company || null,
      address: [a.address1, a.city, a.province_code || a.province, a.zip, a.country].filter(Boolean).join(', ') || null,
    }
  })
}

// Resolve (and remember) the Shopify customer for a client that has no link yet.
// Returns the customer id when it could link unambiguously, otherwise null.
// Persisting the id means the lookup happens once, not on every publish.
async function resolveShopifyCustomerForClient(clientId, clientName) {
  try {
    const matches = await searchShopifyCustomers(clientName)
    if (matches.length !== 1) return null          // 0 = not found, >1 = ambiguous → never guess
    await query(`UPDATE clients SET shopify_customer_id = $1 WHERE id = $2 AND shopify_customer_id IS NULL`, [matches[0].id, clientId])
    console.log(`[shopify] auto-linked client "${clientName}" -> Shopify customer ${matches[0].id} (${matches[0].name})`)
    return matches[0].id
  } catch (e) {
    console.warn(`[shopify] customer auto-link skipped for "${clientName}": ${e.message}`)
    return null                                     // never block publishing on lookup failure
  }
}

// Builds the Shopify draft-order payload for a production order.
//
// SHARED ON PURPOSE: two paths create draft orders — the direct publish route
// (routes/webhooks.js, what the "Shopify" button calls) and this queued retry.
// They used to build the payload independently, and it bit us: the oil-name fix
// was applied to the retry path while the primary route kept printing "— N/A"
// for every Fragrance Library line. One builder, so they cannot drift again.
async function buildDraftOrderPayload(productionOrderId) {
  const order = await query(
    `SELECT po.*, c.shopify_customer_id, c.name AS client_name FROM production_orders po LEFT JOIN clients c ON po.client_id = c.id WHERE po.id = $1`,
    [productionOrderId]
  )
  if (!order.rows[0]) throw new Error('Order not found')
  const o = order.rows[0]

  const lines = await query(
    `SELECT pol.*, pf.name as fragrance_name, master.name as master_name, oil.name as oil_name
     FROM production_order_lines pol
     LEFT JOIN products pf ON pol.fragrance_id = pf.id
     LEFT JOIN products master ON master.product_code = pol.product_type AND master.is_master = true
     LEFT JOIN sa.products oil ON oil.id = pol.oil_id
     WHERE pol.production_order_id = $1
     ORDER BY pol.line_number`,
    [productionOrderId]
  )

  // FR-HOOK-5 (shared store): no SKUs on SM draft-order line items.
  // Scent name resolves in priority: commercial variant_name → legacy fragrance
  // → D14 Fragrance Library oil name → 'N/A'.
  const lineItems = lines.rows.map(l => ({
    title: `${l.master_name || l.product_type.replace(/_/g, ' ')} — ${l.variant_name || l.fragrance_name || l.oil_name || 'N/A'}`,
    quantity: l.quantity,
    price: '0.00',
    requires_shipping: true
  }))

  // The note used to be system text ONLY — whatever the user typed on the order
  // never reached Shopify — and the due date was a raw JS Date
  // ("Thu Jul 30 2026 00:00:00 GMT+1000 (Australian Eastern Standard Time)").
  // User note first (that's what a human reads), system reference underneath.
  const due = o.due_date
    ? new Date(o.due_date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
    : 'TBD'
  const note = [o.notes && o.notes.trim(), `SM Order: ${o.order_number} | Due: ${due}`]
    .filter(Boolean).join('\n\n')

  const draftOrder = {
    draft_order: { send_receipt: false, send_invoice: false, line_items: lineItems, note, tags: 'SA Custom Orders' }
  }
  // Attach the customer so Shopify fills in contact + shipping/billing address.
  // If the client was never linked, try to resolve it by name now (and remember it).
  // send_receipt/send_invoice stay false above, so attaching a customer still never
  // emails them — the order just carries the right address.
  let customerId = o.shopify_customer_id
  if (!customerId && o.client_id && o.client_name) {
    customerId = await resolveShopifyCustomerForClient(o.client_id, o.client_name)
  }
  if (customerId) draftOrder.draft_order.customer = { id: customerId }
  return draftOrder
}

async function processDraftOrder(payload) {
  if (!process.env.SM_SHOPIFY_SHOP_DOMAIN || !process.env.SM_SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Shopify not configured')
  }

  const draftOrder = await buildDraftOrderPayload(payload.production_order_id)

  const response = await fetch(
    `https://${process.env.SM_SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/draft_orders.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SM_SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify(draftOrder)
    }
  )
  const data = await response.json()
  if (!response.ok) throw new Error(data.errors ? JSON.stringify(data.errors) : 'Shopify API error')

  // Same rule as the direct publish route: only advance the commercial lifecycle
  // if the order is still 'draft'. A queued retry must never reset a physical
  // state (waiting_external / in_production) that moved on while Shopify was down.
  await query(
    `UPDATE production_orders
        SET shopify_draft_order_id = $1,
            status = CASE WHEN status = 'draft' THEN 'confirmed' ELSE status END,
            updated_at = NOW()
      WHERE id = $2`,
    [data.draft_order.id, payload.production_order_id]
  )
}

let cachedLocationId = null
async function getPrimaryLocationId() {
  if (cachedLocationId) return cachedLocationId
  const res = await fetch(
    `https://${process.env.SM_SHOPIFY_SHOP_DOMAIN}/admin/api/2026-04/locations.json`,
    { headers: { 'X-Shopify-Access-Token': process.env.SM_SHOPIFY_ACCESS_TOKEN } }
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
  kickDrain() // don't wait for the next window — see startSyncCron
}

async function processInventoryAdjust(payload) {
  if (!process.env.SM_SHOPIFY_SHOP_DOMAIN || !process.env.SM_SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Shopify not configured')
  }
  const prod = await query(`SELECT shopify_inventory_item_id FROM products WHERE id = $1`, [payload.product_id])
  const inventoryItemId = prod.rows[0]?.shopify_inventory_item_id
  if (!inventoryItemId) return // product was never published to Shopify — nothing to sync

  const locationId = await getPrimaryLocationId()
  if (!locationId) throw new Error('Could not resolve Shopify location')

  const response = await fetch(
    `https://${process.env.SM_SHOPIFY_SHOP_DOMAIN}/admin/api/2026-04/inventory_levels/adjust.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SM_SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available_adjustment: payload.delta })
    }
  )
  const data = await response.json()
  if (!response.ok) throw new Error(data.errors ? JSON.stringify(data.errors) : 'Shopify inventory adjust failed')
}

// CUTOVER GATE (D12): the Muse store is LIVE with real Active products. Until
// SM_SHOPIFY_SYNC_ENABLED=true (set only at cutover), the queue accumulates
// but never writes to Shopify — staging/local activity can't touch real
// inventory or create real draft orders. Mirrors SA's SHOPIFY_SYNC_ENABLED.
function outboundEnabled() {
  return String(process.env.SM_SHOPIFY_SYNC_ENABLED || '').toLowerCase() === 'true'
}

// One drain at a time. Two overlapping runs would SELECT the same pending row
// and push it to Shopify twice — a duplicate draft order for a real client.
// Needed since enqueue* now kicks a drain immediately (2026-08-10); it also
// closes a pre-existing hole where a drain slower than the 60s tick overlapped
// with the next one.
let draining = false

async function runRetryQueue() {
  if (!outboundEnabled()) return // queue drains only after cutover
  if (draining) return
  draining = true
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
  } finally {
    draining = false
  }
}

// Kick a drain without making the caller wait for Shopify. The common case —
// Shopify is up — then completes in a second or two at ANY hour, so gating the
// cron below to warehouse hours costs no responsiveness. If it fails, the row
// stays 'pending' and the cron retries it in the next window.
function kickDrain() {
  if (!outboundEnabled()) return
  setImmediate(() => { runRetryQueue().catch(() => {}) })
}

// COST (2026-08-10): this cron was the reason the Neon compute never reached
// its 5-minute autosuspend. With SM_SHOPIFY_SYNC_ENABLED=true in production,
// runRetryQueue queries pending_shopify_sync every 60 seconds forever — 1,440
// queries a day against a table that is almost always EMPTY, because the only
// things that feed it are the office creating draft orders and stock changes on
// published products. MUSE retail sales skip it entirely (skipShopifyPush —
// Shopify already moved its own count). Nobody fills this queue overnight.
//
// So the cron now runs only inside the warehouse window, reusing the single
// definition in shared/warehouse-hours.js (unit-tested by
// scripts/regression-warehouse-hours.js). That window is ALREADY held awake by
// the keep-alive in server/sa/index.js, so polling inside it costs nothing
// extra, and outside it the polling simply stops.
//
// Nothing is lost when it is closed: a failure near 17:00 waiting on its 6h
// backoff just retries at 06:30 instead of 23:00. The row stays 'pending'.
//
// The helper is ESM and this module is CommonJS, hence the dynamic import.
// startSyncCron is called without await (server/index.js:226), so the extra
// tick before the timer exists is harmless.
async function startSyncCron() {
  const { withinWarehouseHours } = await import('../../../shared/warehouse-hours.js')
  setInterval(() => { if (withinWarehouseHours()) runRetryQueue() }, 60_000)
  console.log(
    outboundEnabled()
      ? '[shopify-sync] Retry cron started (60s, warehouse hours only) — OUTBOUND LIVE'
      : '[shopify-sync] Retry cron started (60s, warehouse hours only) — outbound DISABLED (set SM_SHOPIFY_SYNC_ENABLED=true at cutover)'
  )
}

async function registerWebhooks() {
  const domain = process.env.SM_SHOPIFY_SHOP_DOMAIN
  const token  = process.env.SM_SHOPIFY_ACCESS_TOKEN
  // PLATFORM PORT (Phase 5): callback targets the platform receiver at the
  // public platform URL. https-only guard prevents local dev boots from
  // registering localhost callbacks against the real store.
  const host   = process.env.PLATFORM_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL

  if (!domain || !token) return
  if (!host || !host.startsWith('https://')) {
    console.log('[shopify-webhooks] No public https URL — skipping registration (local dev)')
    return
  }

  // D12: SM/MUSE live on the MUSE store — the receiver route is /muse.
  const callbackUrl = `${host}/api/webhook/shopify/muse`
  // D13: fulfillments included — MUSE is retail, so shipping must deduct the
  // finished-good stock (orders/paid alone never moved it).
  //
  // THIS ARRAY IS THE ONLY THING THAT REGISTERS A TOPIC. platform.shopify_stores
  // also has a `topics` column and it is read by nothing — adding a topic there
  // and not here ships a handler the store will never call. That happened on
  // 2026-08-11 with refunds/create: the code was live and correct, and Shopify
  // had no subscription, so the fix sat inert until the live store was listed.
  // Adding a topic means editing HERE and in SM_TOPICS (platform/webhooks.js).
  const topics = ['orders/paid', 'orders/cancelled', 'refunds/create', 'fulfillments/create', 'fulfillments/update']

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

// ═══════════════════════════════════════════════════════════════════════════
// Create a MUSE product on the store, in the shape the live catalogue uses.
//
// Read off the "Terre" product on 2026-08-11, which is the pattern marketing
// settled on: ONE product per fragrance, three variants under a single option
// called "Choose Your Format", inventory NOT tracked, and the Shopify taxonomy
// category set (that field drives tax rates and cross-channel search, and the
// REST endpoint cannot set it at all — hence GraphQL).
//
// It only ever CREATES. There is no product id in the call, so it has no way to
// reach an existing product, and it is born DRAFT so marketing finishes the
// images, copy and metafields before anything is sellable.
//
// The one way to make a mess is running it twice, so it refuses if any of the
// codes is already on the store. Shopify itself accepts duplicate SKUs without
// complaint — 253 of them exist there today — so that check has to happen here.
const MUSE_CATEGORY = 'gid://shopify/TaxonomyCategory/hg-3-40-7' // Home & Garden > Decor > Home Fragrances > Reed Diffusers
const FORMAT_OPTION = 'Choose Your Format'

async function shopifyGraphQL(query, variables) {
  const domain = process.env.SM_SHOPIFY_SHOP_DOMAIN
  const token = process.env.SM_SHOPIFY_ACCESS_TOKEN
  if (!domain || !token) throw new Error('Shopify is not configured')
  const r = await fetch(`https://${domain}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const j = await r.json()
  if (j.errors) throw new Error(`Shopify: ${JSON.stringify(j.errors)}`)
  return j.data
}

// Which of these codes already exist on the store, on any product.
async function skusOnStore(skus) {
  const found = []
  for (const sku of skus) {
    const d = await shopifyGraphQL(
      `query($q: String!) { productVariants(first: 5, query: $q) { nodes { sku product { id title status } } } }`,
      { q: `sku:${sku}` })
    for (const n of d.productVariants.nodes) {
      if (n.sku === sku) found.push({ sku, productId: n.product.id, title: n.product.title, status: n.product.status })
    }
  }
  return found
}

// The product this set of codes ALREADY belongs to, if it is exactly one.
//
// This exists because of a real half-finished publish (2026-08-11): the store
// product was created and the platform then failed to record its ids, leaving
// the codes live on Shopify while the platform believed nothing was published.
// Retrying hit "already on the store" and stopped — a dead end that needed a
// hand-written fix. Now that state heals itself.
//
// It demands ALL our codes on ONE product before adopting, so it can never
// attach us to somebody else's product that happens to share a code.
async function findProductBySkus(skus) {
  const hits = await skusOnStore(skus)
  if (!hits.length) return null
  const ids = [...new Set(hits.map((h) => h.productId))]
  if (ids.length > 1 || hits.length !== skus.length) {
    return { conflict: hits.map((h) => `${h.sku} → "${h.title}" [${h.status}]`) }
  }
  const d = await shopifyGraphQL(
    `query($id: ID!) { product(id: $id) { id title status handle
       variants(first: 20) { nodes { id sku inventoryItem { id } } } } }`, { id: ids[0] })
  return { product: d.product }
}

// lines: [{ format, sku, price }] in the order they should appear.
async function createMuseProductOnShopify({ title, lines }) {
  // Same gate as every other outbound call: a staging or local boot must never
  // create real products on the live store.
  if (!outboundEnabled()) throw new Error('Shopify publishing is disabled (SM_SHOPIFY_SYNC_ENABLED)')
  if (!title || !lines?.length) throw new Error('A title and at least one format are required')
  const priceless = lines.filter((l) => l.price == null || Number(l.price) <= 0)
  if (priceless.length) throw new Error(`No price on: ${priceless.map((l) => l.format).join(', ')}`)

  const clash = await skusOnStore(lines.map((l) => l.sku))
  if (clash.length) throw new Error(`Already on the store: ${clash.map((c) => `${c.sku} → "${c.title}" [${c.status}]`).join(' · ')}`)

  const input = {
    title,
    status: 'DRAFT',
    category: MUSE_CATEGORY,
    productOptions: [{ name: FORMAT_OPTION, values: lines.map((l) => ({ name: l.format })) }],
    variants: lines.map((l) => ({
      optionValues: [{ optionName: FORMAT_OPTION, name: l.format }],
      price: String(Number(l.price).toFixed(2)),
      sku: l.sku,
      // Barcode IS the code (owner, 2026-08-11). Keeping them identical means
      // the scanner in the warehouse and the order line from the store resolve
      // through the same string, so there is no second identifier to keep in
      // step — the whole reason the code is minted in one place.
      barcode: l.barcode || l.sku,
      // The live catalogue is untracked: tracked + deny + zero stock would make
      // the product unbuyable the moment marketing activates it.
      inventoryItem: { tracked: false },
    })),
  }

  const d = await shopifyGraphQL(
    `mutation Create($input: ProductSetInput!) {
       productSet(synchronous: true, input: $input) {
         product {
           id title status handle
           variants(first: 10) { nodes { id sku inventoryItem { id } } }
         }
         userErrors { field message }
       }
     }`, { input })

  const errs = d.productSet.userErrors || []
  if (errs.length) throw new Error(errs.map((e) => `${(e.field || []).join('.')} ${e.message}`).join(' · '))
  return d.productSet.product
}

module.exports = { buildDraftOrderPayload, enqueueDraftOrder, enqueueInventoryAdjust, startSyncCron, registerWebhooks, createMuseProductOnShopify, skusOnStore, findProductBySkus, shopifyGraphQL }
