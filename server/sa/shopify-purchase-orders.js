// Reads supplier purchase orders raised in Shopify. READ-ONLY, always.
//
// WHY THIS FILE (2026-09-18/21). Ordering moves to Shopify for the Fragrance
// Library. The full decision record, including everything that was tested live
// and everything that turned out to be wrong, is in
// PRD_SHOPIFY_PO_INTEGRATION.md. Three things from it that this file depends on:
//
//   1. Read `inventoryPurchaseOrders`, NOT `inventoryTransfers`. The September
//      plan used transfers because the purchase-order API was blocked by a
//      shop-level feature preview. That block is gone. Reading the PO gives its
//      real number — the one Payal sees — which transfers never did.
//   2. `unstable` is the only version carrying this field. It can change without
//      notice, so every failure here is caught and reported as "could not reach
//      Shopify". A screen that shows nothing is recoverable; a screen that shows
//      a stale list as current is not.
//   3. A purchase order carries no "received" anywhere. Receiving stays in the
//      platform. This file never looks for it.
//
// API quirks, each of which cost a round trip to find:
//   - No `sortKey`, no `reverse`. Results are oldest-first, so the newest PO is
//     on the LAST page. `first: 250` alone silently misses it.
//   - `origin` is an InventorySupplierSnapshot whose only field is supplierName.
//   - Line items expose `totalQuantity`, not `quantity`.

const API_VERSION = 'unstable';

// Only these destinations are stock we care about. #PO250 and #PO251 are
// Print Express labels into "SA Custom Orders" — real purchase orders, but not
// oil, and they must not raise an expectation of incoming stock.
const WATCHED_DESTINATIONS = ['SA Warehouse'];

// Shopify NEVER closes a purchase order. #PO76 was raised in July 2025, was
// delivered long ago, and still reads ORDERED today — so "ORDERED" means "was
// placed", not "is still coming". Reading the whole store surfaced 94 of them,
// almost all history. Found on the first real run, 2026-09-21, which is what
// delivery 1 existed to find.
//
// The cut-off is the honest filter: this integration begins when ordering moves
// to Shopify, and everything raised before that belongs to the old process,
// which is being closed by hand. Set SA_SHOPIFY_PO_SINCE to move it.
const SINCE = process.env.SA_SHOPIFY_PO_SINCE || '2026-09-18';

// Shopify timestamps are UTC; the cut-off is a date a person picked in Sydney.
// Comparing them raw drops every order raised before about 10am on the cut-off
// day, because its UTC date is the day before. The same mistake cost the History
// report a day of movements in September.
const sydneyDate = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

// Volume behind each sellable variant prefix, in mL. An unknown prefix is an
// unmatched line, never a guess — the quantity is what becomes stock.
const VARIANT_ML = { SA_CA: 400, SA_HF: 500, SA_CDIFF: 700, SA_1L: 1000, SA_PRO: 1000 };

const QUERY = `
  query POs($after: String) {
    inventoryPurchaseOrders(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name status dateCreated orderedAt archivedAt
        origin { supplierName }
        destination { name }
        transfers(first: 50) { pageInfo { hasNextPage } nodes { name status } }
        lineItems(first: 250) {
          pageInfo { hasNextPage }
          nodes {
            id totalQuantity supplierSku
            unitCost { amount }
            inventoryItem { variant { sku title } }
          }
        }
      }
    }
  }`;

async function shopifyGraphQL(query, variables) {
  const shop = process.env.SA_SHOPIFY_SHOP_DOMAIN || process.env.SA_SHOPIFY_STORE_NAME;
  const token = process.env.SA_SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token) throw new Error('Shopify credentials are not configured');
  const host = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
  // A hung request must not hold anything open. Without this a slow Shopify
  // could pin a database client for as long as it liked, and the pool is ten.
  const res = await fetch(`https://${host}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(' | '));
  if (!body.data) throw new Error(`Shopify returned no data (HTTP ${res.status})`);
  return body.data;
}

/** Every purchase order in the store, oldest first. Pages, because the newest is last. */
async function fetchAllPurchaseOrders() {
  const all = [];
  let after = null;
  // A ceiling rather than `while (true)`, but hitting it THROWS. Returning a
  // truncated list would be far worse than failing: results are oldest-first, so
  // the newest orders would be the ones lost — and because their line ids would
  // then be missing from what the store is believed to hold, real pending orders
  // would be reported as deleted in Shopify, with a Remove button next to them.
  // A page that says it could not read is recoverable; one that invites deleting
  // live orders is not.
  for (let page = 0; page < 10; page++) {
    const data = await shopifyGraphQL(QUERY, { after });
    const conn = data.inventoryPurchaseOrders;
    all.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return all;
    after = conn.pageInfo.endCursor;
  }
  throw new Error('More purchase orders than this can page through (2,500+). Raise the limit before trusting this screen.');
}

/**
 * Resolve a Shopify line to a platform product and a quantity in the product's
 * own unit.
 *
 * Returns { product, ml, reason }. `reason` is set when it could NOT be
 * resolved, and the caller must show the line rather than drop it. Real codes
 * already seen in this store: SA_1L_068 (a zero short), SA_1L_000, SA_0001, and
 * lines carrying no code at all. Silently skipping those is the same fault that
 * let SA_1L_157 sell 30 litres against SA_1L_00157 without debiting anything.
 */
function resolveLine(line, productsBySku) {
  const sku = line.inventoryItem?.variant?.sku?.trim();
  if (!sku) return { reason: 'the line carries no product code' };

  const product = productsBySku.get(sku);
  if (!product) return { sku, reason: `no active product carries the code ${sku}` };

  const prefix = Object.keys(VARIANT_ML).find((p) => sku.startsWith(`${p}_`));
  if (!prefix) return { sku, product, reason: `${sku} is not a known bottle size` };

  const qty = Number(line.totalQuantity);
  if (!Number.isFinite(qty) || qty <= 0) return { sku, product, reason: `quantity reads "${line.totalQuantity}"` };

  return { sku, product, ml: qty * VARIANT_ML[prefix], bottles: qty, bottleMl: VARIANT_ML[prefix] };
}

/**
 * What Shopify says is on order, mapped onto platform products.
 *
 * `products` is the SA catalogue, already loaded by the caller — this file does
 * not touch the database.
 */
async function readIncomingPurchaseOrders(products) {
  // Keyed on the SKU VALUE, the same way a sale is matched, so the two can never
  // disagree about what a code means.
  const bySku = new Map();
  for (const p of products) {
    if (p.status === 'inactive') continue;
    for (const value of Object.values(p.shopifySkus || {})) {
      if (value) bySku.set(String(value).trim(), p);
    }
  }

  const raw = await fetchAllPurchaseOrders();

  const orders = [];
  for (const po of raw) {
    // A draft is not a commitment. Four existed on 18 September.
    if (po.status !== 'ORDERED') continue;
    if (po.archivedAt) continue;
    const destination = po.destination?.name || '';
    if (!WATCHED_DESTINATIONS.includes(destination)) continue;
    if (sydneyDate(po.dateCreated) < SINCE) continue;

    const lines = po.lineItems.nodes.map((l) => {
      const r = resolveLine(l, bySku);
      return {
        lineId: l.id,
        sku: r.sku || null,
        supplierSku: l.supplierSku || null,
        title: l.inventoryItem?.variant?.title || null,
        quantity: Number(l.totalQuantity) || 0,
        unitCost: l.unitCost?.amount != null ? Number(l.unitCost.amount) : null,
        matched: !r.reason,
        reason: r.reason || null,
        productCode: r.product?.productCode || null,
        productName: r.product?.name || null,
        currentStock: r.product ? Number(r.product.currentStock) : null,
        unit: r.product?.unit || null,
        incomingMl: r.ml ?? null,
        bottles: r.bottles ?? null,
        bottleMl: r.bottleMl ?? null,
      };
    });

    orders.push({
      origin: 'shopify',
      shopifyId: po.id,          // the gid — what an acceptance is keyed on, never the number
      number: po.name,           // '#PO253' — the number Payal sees
      status: po.status,
      supplier: po.origin?.supplierName || null,
      destination,
      dateCreated: po.dateCreated,
      dateCreatedLocal: sydneyDate(po.dateCreated),
      orderedAt: po.orderedAt,
      transfers: po.transfers.nodes.map((t) => `${t.name} (${t.status})`),
      // The closest thing Shopify gives to "it arrived". A transfer that is
      // TRANSFERRED was received there; the platform still records arrival
      // itself, but a person reading the screen should know.
      // Only when the whole list was read. With a truncated one, five
      // TRANSFERRED out of six would read as "received in Shopify" when it is
      // not — a claim worth nothing unless it is certain.
      arrivedInShopify: !po.transfers.pageInfo?.hasNextPage
        && po.transfers.nodes.length > 0
        && po.transfers.nodes.every((t) => t.status === 'TRANSFERRED'),
      lines,
      unmatchedCount: lines.filter((l) => !l.matched).length,
    });
  }

  // Newest first for a person reading the screen; the API gives oldest first.
  orders.sort((a, b) => String(b.dateCreated).localeCompare(String(a.dateCreated)));

  // Every line id the store still has, across ALL purchase orders — before the
  // cut-off and the destination filter are applied. It is how the caller tells
  // "this order was deleted in Shopify" from "this order is simply not shown
  // here". A deleted purchase order vanishes from the API completely (verified
  // 2026-09-21), so absence is the only signal there is, and it must not be
  // confused with being filtered out.
  // Only orders that are STILL live count. An order archived, or put back to
  // draft, keeps its line ids but is no longer something to expect — without
  // this it would be neither shown on the page nor flagged, while the platform
  // went on counting the oil as on its way.
  const live = raw.filter((po) => po.status === 'ORDERED' && !po.archivedAt);
  // A truncated line list would make the lines past the limit look deleted.
  const truncated = live.find((po) => po.lineItems.pageInfo?.hasNextPage);
  if (truncated) {
    throw new Error(`${truncated.name} has more lines than can be read at once. Raise the limit before trusting this screen.`);
  }
  const liveLineIds = new Set(live.flatMap((po) => po.lineItems.nodes.map((l) => l.id)));

  return { orders, liveLineIds };
}

export { readIncomingPurchaseOrders, VARIANT_ML, WATCHED_DESTINATIONS, API_VERSION, SINCE };
