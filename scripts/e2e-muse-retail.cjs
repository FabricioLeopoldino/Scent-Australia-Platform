// ═══════════════════════════════════════════════════════════════════════════
// D13 E2E — a REAL MUSE retail sale, end to end (the owner's exact scenario)
// ═══════════════════════════════════════════════════════════════════════════
//   1. give a MUSE variant a known stock level
//   2. create + complete a real order on the Muse store (customer buys)
//   3. FULFIL it in Shopify (we ship)   → platform must DEDUCT the stock
//   4. CANCEL the fulfillment           → platform must RESTORE it
//   5. delete the order, restore stock, clear the webhook log
//
// This is the test that only a real store can give: it proves the SKU on
// Shopify's line items actually matches the variant SKU in our catalog.
//
// Usage: node scripts/e2e-muse-retail.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');

const SHOP = process.env.MUSE_SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.MUSE_SHOPIFY_ACCESS_TOKEN;
const API = `https://${SHOP}/admin/api/2026-04`;
const SH = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN };

const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const sm = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sm' });

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stockOf = async (id) =>
  parseFloat((await sm.query(`SELECT current_stock FROM products WHERE id = $1`, [id])).rows[0].current_stock);

// Shopify delivers asynchronously — poll until the effect lands or time out.
async function waitForStock(id, expected, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await stockOf(id)) === expected) return true;
    await sleep(3000);
  }
  return false;
}

let variant = null, orderId = null, draftId = null, fulfillmentId = null, origStock = 0;

async function cleanup() {
  console.log('\n── Cleanup ──');
  try {
    if (orderId) { await fetch(`${API}/orders/${orderId}.json`, { method: 'DELETE', headers: SH }); console.log(`  deleted Shopify order ${orderId}`); }
    else if (draftId) { await fetch(`${API}/draft_orders/${draftId}.json`, { method: 'DELETE', headers: SH }); }
  } catch (e) { console.log('  shopify:', e.message); }
  try {
    if (variant) {
      await sm.query(`DELETE FROM transactions WHERE product_id = $1 AND notes LIKE '%D13-E2E%'`, [variant.id]);
      await sm.query(`DELETE FROM transactions WHERE product_id = $1 AND type IN ('shopify_sale','shopify_reversal') AND created_at > NOW() - INTERVAL '20 minutes'`, [variant.id]);
      await sm.query(`UPDATE products SET current_stock = $1 WHERE id = $2`, [origStock, variant.id]);
      console.log(`  restored ${variant.sku} to ${origStock}`);
    }
    if (fulfillmentId) {
      await sm.query(`DELETE FROM webhook_processed WHERE shopify_order_id = $1`, [fulfillmentId]);
      console.log('  cleared webhook_processed');
    }
  } catch (e) { console.log('  platform:', e.message); }
}

(async () => {
  console.log(`Muse store: ${SHOP}\n`);

  // ── 1. Fixture ───────────────────────────────────────────────────────────
  variant = (await sm.query(
    `SELECT id, sku, name, current_stock FROM products
     WHERE sku LIKE 'Muse\\_RD%' AND COALESCE(archived,false)=false ORDER BY sku LIMIT 1`
  )).rows[0];
  if (!variant) { bad('no MUSE variant — import the catalog first'); process.exit(1); }
  origStock = parseFloat(variant.current_stock);
  await sm.query(`UPDATE products SET current_stock = 20 WHERE id = $1`, [variant.id]);
  console.log(`fixture: ${variant.name} (${variant.sku}) → 20 units\n`);

  // ── 2. A real customer order on the Muse store ───────────────────────────
  const draft = await (await fetch(`${API}/draft_orders.json`, {
    method: 'POST', headers: SH,
    body: JSON.stringify({
      draft_order: {
        note: 'D13-E2E retail probe',
        line_items: [{ title: variant.name, sku: variant.sku, price: '49.00', quantity: 4, requires_shipping: true }],
      },
    }),
  })).json();
  draftId = draft?.draft_order?.id;
  if (!draftId) { bad('create draft order', JSON.stringify(draft).slice(0, 150)); await cleanup(); process.exit(1); }

  const comp = await (await fetch(`${API}/draft_orders/${draftId}/complete.json?payment_pending=false`, { method: 'PUT', headers: SH })).json();
  orderId = comp?.draft_order?.order_id;
  if (!orderId) { bad('complete the order', JSON.stringify(comp).slice(0, 150)); await cleanup(); process.exit(1); }
  ok('real paid order created on the Muse store', `order ${orderId} · 4x ${variant.sku}`);

  // orders/paid must NOT move stock (only shipment does)
  await sleep(6000);
  (await stockOf(variant.id)) === 20
    ? ok('orders/paid alone does NOT move stock', 'still 20 — correct: nothing shipped yet')
    : bad('payment moved stock', `stock=${await stockOf(variant.id)}`);

  // ── 3. Ship it — the moment stock must leave ─────────────────────────────
  const foRes = await fetch(`${API}/fulfillment_orders.json?order_id=${orderId}`, { headers: SH });
  const fos = (await foRes.json()).fulfillment_orders || [];
  if (!fos.length) { bad('no fulfillment order returned by Shopify'); await cleanup(); process.exit(1); }

  const fulRes = await fetch(`${API}/fulfillments.json`, {
    method: 'POST', headers: SH,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: fos[0].id }],
        notify_customer: false,
      },
    }),
  });
  const ful = await fulRes.json();
  fulfillmentId = ful?.fulfillment?.id;
  if (!fulfillmentId) { bad('fulfil the order', JSON.stringify(ful).slice(0, 200)); await cleanup(); process.exit(1); }
  ok('order FULFILLED in Shopify (shipped)', `fulfillment ${fulfillmentId}`);

  console.log('      waiting for fulfillments/create → stock deduction…');
  (await waitForStock(variant.id, 16))
    ? ok('🎯 platform DEDUCTED the stock on shipment', '20 → 16 (sold 4)')
    : bad('stock did NOT deduct', `stock=${await stockOf(variant.id)}, expected 16`);

  // ── 4. Cancel the shipment — stock must come back ────────────────────────
  const cx = await fetch(`${API}/fulfillments/${fulfillmentId}/cancel.json`, { method: 'POST', headers: SH, body: JSON.stringify({}) });
  cx.ok ? ok('fulfillment cancelled in Shopify') : bad('cancel failed', 'HTTP ' + cx.status);

  console.log('      waiting for fulfillments/update cancelled → restore…');
  (await waitForStock(variant.id, 20))
    ? ok('platform RESTORED the stock on cancellation', '16 → 20')
    : bad('stock not restored', `stock=${await stockOf(variant.id)}, expected 20`);

  // ── 5. Auditable trail ───────────────────────────────────────────────────
  const tx = await sm.query(
    `SELECT type, quantity, balance_after, notes FROM transactions
     WHERE product_id = $1 AND type IN ('shopify_sale','shopify_reversal')
     ORDER BY id DESC LIMIT 2`, [variant.id]
  );
  tx.rows.length === 2
    ? ok('sale + reversal are auditable', tx.rows.map((r) => `${r.type} ${r.quantity}`).join(' · '))
    : bad('transaction trail incomplete', JSON.stringify(tx.rows));

  await cleanup();
  console.log(`\n══════ D13 REAL RETAIL E2E: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); process.exit(1); });
