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
//   · an oversold line is RECORDED (stock allowed negative — the sale already
//     shipped) and never rolls back the healthy lines in the same fulfillment
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
// The handler answers 200 first then commits async; against a remote Neon a fixed
// sleep races the commit. Poll the expected end-state (bounded) for determinism.
const waitUntil = async (fn, ms = 15000, gap = 400) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(gap); }
  return false;
};

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
let SKU = null, SKU2 = null, ORIG1 = null, ORIG2 = null;

async function cleanup() {
  await sm.query(`DELETE FROM webhook_processed WHERE shopify_order_id BETWEEN $1 AND $2`, [FID, FID + 10]);
  // Delete the probe transactions AND restore each variant's original stock, so a
  // run — even one that ships/oversells fixtures — leaves the catalog untouched.
  for (const [s, orig] of [[SKU, ORIG1], [SKU2, ORIG2]]) {
    if (!s) continue;
    await sm.query(
      `DELETE FROM transactions WHERE product_id = (SELECT id FROM products WHERE sku = $1) AND notes LIKE '%D13-PROBE%'`,
      [s]
    );
    if (orig !== null) await sm.query(`UPDATE products SET current_stock = $1 WHERE sku = $2`, [orig, s]);
  }
}

(async () => {
  // Fixtures: two real MUSE variants (the mixed-fulfillment check needs a second).
  // Original stock captured so cleanup restores them exactly.
  const vs = (await sm.query(
    `SELECT id, sku, name, current_stock FROM products WHERE sku LIKE 'Muse\\_RD%' AND COALESCE(archived,false)=false ORDER BY sku LIMIT 2`
  )).rows;
  if (vs.length < 2) { bad('need at least 2 MUSE variants — import the catalog first'); process.exit(1); }
  const v = vs[0], v2 = vs[1];
  SKU = v.sku; SKU2 = v2.sku;
  ORIG1 = parseFloat(v.current_stock); ORIG2 = parseFloat(v2.current_stock);
  await sm.query(`UPDATE products SET current_stock = 10 WHERE id = $1`, [v.id]);
  console.log(`fixture: ${v.name} (${SKU}) set to 10 units; 2nd variant ${v2.name} (${SKU2})\n`);

  const order = { name: '#D13-PROBE', order_id: FID };

  // ── 1. Shipment deducts ──────────────────────────────────────────────────
  await send('fulfillments/create', {
    id: FID, order_id: FID, status: 'success', ...order,
    line_items: [{ sku: SKU, quantity: 3 }],
  });
  await waitUntil(async () => (await stockOf(SKU)) === 7);
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
  await waitUntil(async () => (await stockOf(SKU)) === 10);
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

  // ── 8. An oversold line is RECORDED and never drops the healthy lines ──────
  // The retail sale already shipped on Shopify — refusing it would roll back the
  // whole fulfillment and lose the sale. So a mixed order with one short line must
  // record BOTH: the healthy line deducts normally, the short line goes negative.
  await sm.query(`UPDATE products SET current_stock = 2 WHERE sku = $1`, [SKU]);   // short line
  await sm.query(`UPDATE products SET current_stock = 50 WHERE sku = $1`, [SKU2]); // healthy line
  await send('fulfillments/create', {
    id: FID + 2, order_id: FID + 2, status: 'success', name: '#D13-PROBE',
    line_items: [{ sku: SKU2, quantity: 5 }, { sku: SKU, quantity: 99 }],
  });
  await waitUntil(async () => (await stockOf(SKU)) === 2 - 99 && (await stockOf(SKU2)) === 50 - 5);
  const shortAfter = await stockOf(SKU);
  const healthyAfter = await stockOf(SKU2);
  shortAfter === 2 - 99
    ? ok('oversold line is recorded — stock allowed negative (sale not lost)', `${SKU}: 2 → ${shortAfter}`)
    : bad('oversold line was not recorded correctly', `stock=${shortAfter}, expected ${2 - 99}`);
  healthyAfter === 50 - 5
    ? ok('a short line does NOT roll back the healthy line in the same fulfillment', `${SKU2}: 50 → ${healthyAfter}`)
    : bad('the healthy line was rolled back by the short line', `stock=${healthyAfter}, expected 45`);

  // ── 9. The sale wrote an auditable transaction ────────────────────────────
  const tx = await sm.query(
    `SELECT type, quantity, balance_after FROM transactions
     WHERE product_id = (SELECT id FROM products WHERE sku = $1) AND type IN ('shopify_sale','shopify_reversal')
     ORDER BY id DESC LIMIT 2`, [SKU]
  );
  tx.rows.length >= 2
    ? ok('sale + reversal wrote auditable transactions', tx.rows.map((r) => r.type).join(', '))
    : bad('transactions missing', JSON.stringify(tx.rows));

  await cleanup(); // deletes probe transactions AND restores both variants' original stock
  console.log(`\n══════ D13 MUSE FULFILLMENT: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); process.exit(1); });
