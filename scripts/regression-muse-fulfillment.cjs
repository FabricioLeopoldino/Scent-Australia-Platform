// ═══════════════════════════════════════════════════════════════════════════
// D13 REGRESSION — MUSE retail: stock leaves on shipment, returns on cancel
// ═══════════════════════════════════════════════════════════════════════════
// Replays signed Shopify fulfillment webhooks against the running platform and
// asserts the exact stock effects. Covers the traps:
//   · deduct on fulfillments/create
//   · restore on fulfillments/update status=cancelled
//   · redelivery is a no-op (idempotency)
//   · a non-cancel fulfillments/update (tracking added) moves nothing
//   · an unknown SKU is skipped, never guessed
//   · NO Shopify push is queued (Shopify already moved its own count —
//     pushing would deduct twice)
//   · insufficient stock never drives the balance negative
//
// Usage: REGRESSION_BASE=http://localhost:3010 node scripts/regression-muse-fulfillment.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';
const SECRET = process.env.SM_SHOPIFY_WEBHOOK_SECRET || process.env.MUSE_SHOPIFY_WEBHOOK_SECRET;
const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const sm = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sm' });

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(topic, body) {
  const raw = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64');
  const res = await fetch(`${BASE}/api/webhook/shopify/muse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Hmac-Sha256': hmac },
    body: raw,
  });
  await sleep(1200); // handler answers 200 first, then works async
  return res.status;
}

const stockOf = async (sku) =>
  parseFloat((await sm.query(`SELECT current_stock FROM products WHERE sku = $1`, [sku])).rows[0].current_stock);

const FID = 900000000 + Math.floor(Math.random() * 99999999); // unique per run
let SKU = null;

async function cleanup() {
  await sm.query(`DELETE FROM webhook_processed WHERE shopify_order_id BETWEEN $1 AND $2`, [FID, FID + 10]);
  if (SKU) {
    await sm.query(
      `DELETE FROM transactions WHERE product_id = (SELECT id FROM products WHERE sku = $1) AND notes LIKE '%D13-PROBE%'`,
      [SKU]
    );
  }
}

(async () => {
  // Fixture: a real MUSE variant, given a known stock level
  const v = (await sm.query(
    `SELECT id, sku, name FROM products WHERE sku LIKE 'Muse\\_RD%' AND COALESCE(archived,false)=false ORDER BY sku LIMIT 1`
  )).rows[0];
  if (!v) { bad('no MUSE variant found — import the catalog first'); process.exit(1); }
  SKU = v.sku;
  await sm.query(`UPDATE products SET current_stock = 10 WHERE id = $1`, [v.id]);
  console.log(`fixture: ${v.name} (${SKU}) set to 10 units\n`);

  const order = { name: '#D13-PROBE', order_id: FID };

  // ── 1. Shipment deducts ──────────────────────────────────────────────────
  await send('fulfillments/create', {
    id: FID, order_id: FID, status: 'success', ...order,
    line_items: [{ sku: SKU, quantity: 3 }],
  });
  let s = await stockOf(SKU);
  s === 7 ? ok('fulfillments/create deducts stock', '10 → 7 (shipped 3)')
          : bad('shipment did not deduct correctly', `stock=${s}, expected 7`);

  // ── 2. Redelivery is a no-op ─────────────────────────────────────────────
  await send('fulfillments/create', {
    id: FID, order_id: FID, status: 'success', ...order,
    line_items: [{ sku: SKU, quantity: 3 }],
  });
  s = await stockOf(SKU);
  s === 7 ? ok('redelivery of the same fulfillment is a no-op', 'still 7')
          : bad('redelivery deducted twice', `stock=${s}, expected 7`);

  // ── 3. A non-cancel update moves nothing ─────────────────────────────────
  await send('fulfillments/update', {
    id: FID, order_id: FID, status: 'success', ...order,
    line_items: [{ sku: SKU, quantity: 3 }],
  });
  s = await stockOf(SKU);
  s === 7 ? ok('fulfillments/update (tracking added) moves no stock', 'still 7')
          : bad('a non-cancel update changed stock', `stock=${s}`);

  // ── 4. Cancellation restores ─────────────────────────────────────────────
  await send('fulfillments/update', {
    id: FID, order_id: FID, status: 'cancelled', ...order,
    line_items: [{ sku: SKU, quantity: 3 }],
  });
  s = await stockOf(SKU);
  s === 10 ? ok('fulfillments/update cancelled restores stock', '7 → 10')
           : bad('cancellation did not restore', `stock=${s}, expected 10`);

  // ── 5. Cancellation redelivery is a no-op ────────────────────────────────
  await send('fulfillments/update', {
    id: FID, order_id: FID, status: 'cancelled', ...order,
    line_items: [{ sku: SKU, quantity: 3 }],
  });
  s = await stockOf(SKU);
  s === 10 ? ok('cancellation redelivery is a no-op', 'still 10')
           : bad('cancellation applied twice', `stock=${s}`);

  // ── 6. Unknown SKU is skipped, never guessed ─────────────────────────────
  const before = await stockOf(SKU);
  await send('fulfillments/create', {
    id: FID + 1, order_id: FID + 1, status: 'success', name: '#D13-PROBE',
    line_items: [{ sku: 'NOT_OURS_12345', quantity: 5 }],
  });
  (await stockOf(SKU)) === before
    ? ok('unknown SKU is skipped, nothing guessed')
    : bad('an unknown SKU changed our stock');

  // ── 7. NO Shopify push queued (the double-deduction trap) ────────────────
  const queued = parseInt((await sm.query(
    `SELECT COUNT(*)::int n FROM pending_shopify_sync WHERE action_type = 'inventory_adjust' AND created_at > NOW() - INTERVAL '2 minutes'`
  )).rows[0].n);
  queued === 0
    ? ok('no inventory push queued to Shopify', 'Shopify already moved its own count')
    : bad('a Shopify inventory push was queued — stock would deduct TWICE', `${queued} queued`);

  // ── 8. Stock never goes negative ─────────────────────────────────────────
  await sm.query(`UPDATE products SET current_stock = 2 WHERE sku = $1`, [SKU]);
  await send('fulfillments/create', {
    id: FID + 2, order_id: FID + 2, status: 'success', name: '#D13-PROBE',
    line_items: [{ sku: SKU, quantity: 99 }],
  });
  s = await stockOf(SKU);
  s >= 0
    ? ok('oversell never drives stock negative', `stock=${s}`)
    : bad('stock went NEGATIVE', `stock=${s}`);

  // ── 9. The sale wrote an auditable transaction ────────────────────────────
  const tx = await sm.query(
    `SELECT type, quantity, balance_after FROM transactions
     WHERE product_id = (SELECT id FROM products WHERE sku = $1) AND type IN ('shopify_sale','shopify_reversal')
     ORDER BY id DESC LIMIT 2`, [SKU]
  );
  tx.rows.length >= 2
    ? ok('sale + reversal wrote auditable transactions', tx.rows.map((r) => r.type).join(', '))
    : bad('transactions missing', JSON.stringify(tx.rows));

  await cleanup();
  await sm.query(`UPDATE products SET current_stock = 0 WHERE sku = $1`, [SKU]);
  console.log(`\n══════ D13 MUSE FULFILLMENT: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); process.exit(1); });
