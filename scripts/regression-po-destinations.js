// P6 (owner, 29–30 Oct 2026): the Shopify PO destination names the company.
// OFFLINE — Shopify is a stub and no database is opened, so it runs anywhere.
//
// Pins what the read must do with every destination Payal can pick:
//   SA Warehouse     → SA
//   SA Custom Orders → MUSE The Atelier
//   MUSE             → MUSE (The Library and The Archive)
//   anything else    → shown with its error, NEVER dropped (a rename in Shopify
//                      must reach a person, not hide the order)
// and that the old guards still hold (drafts, archived, before the cut-off).
//
// Run: node scripts/regression-po-destinations.js
import { readIncomingPurchaseOrders, SINCE } from '../server/sa/shopify-purchase-orders.js';
import { PO_DESTINATIONS, destinationByStock } from '../shared/sectors.js';

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const after = '2026-10-29T03:00:00Z';
const po = (name, destination, extra = {}) => ({
  id: `gid://shopify/InventoryPurchaseOrder/${name}`, name, status: 'ORDERED', dateCreated: after, orderedAt: after, archivedAt: null,
  origin: { supplierName: 'Luxaroma' }, destination: destination == null ? null : { name: destination },
  transfers: { pageInfo: { hasNextPage: false }, nodes: [] },
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [{
    id: `gid://shopify/Line/${name}`, totalQuantity: 10, supplierSku: null, unitCost: { amount: 0 },
    inventoryItem: { variant: { sku: 'SA_1L_00002', title: '1L' } },
  }] },
  ...extra,
});
const raw = [
  po('#PO901', 'SA Warehouse'),
  po('#PO902', 'SA Custom Orders'),
  po('#PO903', 'MUSE'),
  po('#PO904', 'MUSE Atelier'),            // a rename nobody told the platform about
  po('#PO905', null),                      // no destination at all
  po('#PO906', 'MUSE', { status: 'DRAFT' }),
  po('#PO907', 'MUSE', { archivedAt: after }),
  po('#PO908', 'MUSE', { dateCreated: '2026-09-01T00:00:00Z' }),
];

process.env.SA_SHOPIFY_SHOP_DOMAIN = 'stub';
process.env.SA_SHOPIFY_ACCESS_TOKEN = 'stub';
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { inventoryPurchaseOrders: { pageInfo: { hasNextPage: false }, nodes: raw } } }) });

try {
  const products = [{ id: 'OIL_2', productCode: 'FRAG_0002', name: 'Allure', currentStock: 1000, unit: 'mL', status: 'active', shopifySkus: { SA_1L: 'SA_1L_00002' } }];
  const { orders } = await readIncomingPurchaseOrders(products);
  const by = Object.fromEntries(orders.map((o) => [o.number, o]));

  console.log('\n1. Each destination names its company');
  check(by['#PO901']?.destinationStock === 'SA' && by['#PO901'].destinationLabel === 'Scent Australia (SA Warehouse)', 'SA Warehouse → SA');
  check(by['#PO902']?.destinationStock === 'MUSE_ATELIER' && by['#PO902'].destinationLabel === 'MUSE The Atelier', 'SA Custom Orders → MUSE The Atelier');
  check(by['#PO903']?.destinationStock === 'MUSE' && by['#PO903'].destinationLabel === 'MUSE (The Library and The Archive)', 'MUSE → MUSE (The Library and The Archive)');
  check([901, 902, 903].every((n) => by[`#PO${n}`].destinationError === null), 'a known destination carries no error');

  console.log('\n2. An unknown destination is shown with its error, never dropped');
  check(by['#PO904']?.destinationStock === null && /"MUSE Atelier" is not linked to a company/.test(by['#PO904'].destinationError || ''),
    'a renamed location', by['#PO904']?.destinationError);
  check(by['#PO905']?.destinationStock === null && /"\(none\)"/.test(by['#PO905'].destinationError || ''), 'no destination at all');
  check(by['#PO904']?.lines.length === 1 && by['#PO904'].lines[0].matched, 'its lines are still read, so a person sees what is on it');

  console.log('\n3. The old guards still hold');
  check(!by['#PO906'], 'a draft is skipped');
  check(!by['#PO907'], 'an archived order is skipped');
  check(!by['#PO908'], `an order before the cut-off (${SINCE}) is skipped`);

  console.log('\n4. What each destination may be received into');
  check(destinationByStock('SA').receiveInto.join() === 'SA', 'SA Warehouse: SA only');
  check(destinationByStock('MUSE_ATELIER').receiveInto.join() === 'MUSE_ATELIER', 'SA Custom Orders: MUSE The Atelier only');
  check(destinationByStock('MUSE').receiveInto.join() === 'MUSE,MUSE_LIBRARY,MUSE_ARCHIVE', 'MUSE: MUSE (shared), The Library, The Archive');
  check(PO_DESTINATIONS.every((d) => !d.receiveInto.includes('MAIN')), 'never the main store — a Shopify PO already says whose oil it is');
  check(destinationByStock(null) === null, 'a manual order has no destination');
} finally {
  globalThis.fetch = realFetch;
}

console.log(failed ? `\n❌ ${failed} failed` : '\n✅ po-destinations: all checks passed');
process.exit(failed ? 1 : 0);
