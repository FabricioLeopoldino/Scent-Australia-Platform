// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 E2E — real order on the Muse store → platform reacts (D12)
// ═══════════════════════════════════════════════════════════════════════════
// Proves the whole chain with a REAL Shopify order (the Muse store is the
// owner's build/playground store — no live sales):
//   1. create an SM production order in the platform      (API)
//   2. create + complete a draft order on the Muse store  (Shopify API)
//        → Shopify delivers orders/paid to the platform receiver
//   3. assert the platform matched it by the 'SM Order: SM-###' note
//   4. cancel the order on Shopify
//        → orders/cancelled delivered
//   5. assert status=cancelled AND stock reservations released
//   6. clean up everything it created (Shopify order + platform order)
//
// Usage: node scripts/e2e-muse-webhooks.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const PLATFORM = process.env.E2E_BASE || 'https://scent-australia-platform-1.onrender.com';
const SHOP = process.env.MUSE_SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.MUSE_SHOPIFY_ACCESS_TOKEN;
const API = `https://${SHOP}/admin/api/2026-04`;

const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const sm = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sm' });

const platToken = jwt.sign(
  { id: 1, name: 'Root', role: 'root', modules: ['SA', 'SM', 'MUSE'], must_change_password: false },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '30m' }
);
const PH = { 'Content-Type': 'application/json', Authorization: `Bearer ${platToken}` };
const SH = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN };

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll the DB until predicate true or timeout — Shopify delivery is async.
async function waitFor(label, fn, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(3000);
  }
  return false;
}

let smOrderId = null, smOrderNumber = null, shopifyOrderId = null, draftId = null;

async function cleanup() {
  console.log('\n── Cleanup ──');
  try {
    if (shopifyOrderId) {
      await fetch(`${API}/orders/${shopifyOrderId}.json`, { method: 'DELETE', headers: SH });
      console.log(`  deleted Shopify order ${shopifyOrderId}`);
    } else if (draftId) {
      await fetch(`${API}/draft_orders/${draftId}.json`, { method: 'DELETE', headers: SH });
      console.log(`  deleted Shopify draft ${draftId}`);
    }
  } catch (e) { console.log('  shopify cleanup:', e.message); }
  try {
    if (smOrderId) {
      await sm.query(`DELETE FROM stock_reservations WHERE production_order_id = $1`, [smOrderId]);
      await sm.query(`DELETE FROM production_order_components WHERE production_order_id = $1`, [smOrderId]);
      await sm.query(`DELETE FROM production_order_lines WHERE production_order_id = $1`, [smOrderId]);
      await sm.query(`DELETE FROM production_orders WHERE id = $1`, [smOrderId]);
      console.log(`  deleted platform order ${smOrderNumber}`);
    }
    if (shopifyOrderId) {
      await sm.query(`DELETE FROM webhook_processed WHERE shopify_order_id = $1`, [String(shopifyOrderId)]);
      console.log('  cleared webhook_processed rows');
    }
  } catch (e) { console.log('  platform cleanup:', e.message); }
}

(async () => {
  console.log(`Platform: ${PLATFORM}\nMuse store: ${SHOP}\n`);

  // ── 1. SM production order in the platform ───────────────────────────────
  const master = (await sm.query(`SELECT product_code FROM products WHERE product_code = 'RD200' AND is_master`)).rows[0];
  const frag = (await sm.query(`SELECT id, name FROM products WHERE category='FRAGRANCE' AND COALESCE(archived,false)=false ORDER BY id LIMIT 1`)).rows[0];
  if (!master || !frag) { bad('catalog missing RD200/fragrance'); await cleanup(); process.exit(1); }

  const create = await fetch(`${PLATFORM}/api/sm/production-orders`, {
    method: 'POST', headers: PH,
    body: JSON.stringify({
      order_type: 'STANDARD', client_id: null, notes: 'E2E webhook probe',
      lines: [{ product_type: master.product_code, fragrance_id: frag.id, oil_pct: 25, quantity: 2 }],
    }),
  });
  const created = await create.json();
  smOrderId = created?.id || created?.order?.id;
  smOrderNumber = created?.order_number || created?.order?.order_number;
  if (!smOrderId || !smOrderNumber) { bad('create SM production order', JSON.stringify(created).slice(0, 200)); await cleanup(); process.exit(1); }
  ok('SM production order created', `${smOrderNumber} (${master.product_code} × ${frag.name})`);

  const resv0 = parseInt((await sm.query(`SELECT COUNT(*) n FROM stock_reservations WHERE production_order_id=$1 AND status='reserved'`, [smOrderId])).rows[0].n);
  console.log(`      reservations held: ${resv0}`);

  // ── 2. Draft order on the Muse store, carrying the SM note ───────────────
  const draftRes = await fetch(`${API}/draft_orders.json`, {
    method: 'POST', headers: SH,
    body: JSON.stringify({
      draft_order: {
        note: `SM Order: ${smOrderNumber}`,
        line_items: [{ title: `E2E probe — ${smOrderNumber}`, price: '1.00', quantity: 1 }],
      },
    }),
  });
  const draft = await draftRes.json();
  draftId = draft?.draft_order?.id;
  if (!draftId) { bad('create Shopify draft order', JSON.stringify(draft).slice(0, 200)); await cleanup(); process.exit(1); }
  ok('Shopify draft order created', `#${draftId} · note "SM Order: ${smOrderNumber}"`);

  // ── 3. Complete it → Shopify fires orders/paid ───────────────────────────
  const compRes = await fetch(`${API}/draft_orders/${draftId}/complete.json?payment_pending=false`, { method: 'PUT', headers: SH });
  const comp = await compRes.json();
  shopifyOrderId = comp?.draft_order?.order_id;
  if (!shopifyOrderId) { bad('complete draft order', JSON.stringify(comp).slice(0, 200)); await cleanup(); process.exit(1); }
  ok('draft completed → real paid order', `Shopify order ${shopifyOrderId}`);

  console.log('      waiting for orders/paid delivery…');
  const paidOk = await waitFor('paid', async () => {
    const r = await sm.query(`SELECT shopify_order_id FROM production_orders WHERE id=$1`, [smOrderId]);
    return r.rows[0]?.shopify_order_id === String(shopifyOrderId);
  });
  paidOk
    ? ok('orders/paid → platform matched by note and stored the Shopify reference')
    : bad('orders/paid did not reach/match the platform within 60s');

  const hooked = await sm.query(`SELECT webhook_type FROM webhook_processed WHERE shopify_order_id=$1`, [String(shopifyOrderId)]);
  hooked.rows.some((r) => r.webhook_type === 'orders/paid')
    ? ok('orders/paid logged in webhook_processed (idempotency guard)')
    : bad('orders/paid not logged in webhook_processed');

  // Reservations must be UNTOUCHED by paid (the owner's duplicate-reservation fix)
  const resv1 = parseInt((await sm.query(`SELECT COUNT(*) n FROM stock_reservations WHERE production_order_id=$1 AND status='reserved'`, [smOrderId])).rows[0].n);
  resv1 === resv0
    ? ok('orders/paid left reservations untouched', `${resv1} still reserved`)
    : bad('orders/paid changed reservations', `${resv0} → ${resv1}`);

  // ── 4. Cancel on Shopify → orders/cancelled ──────────────────────────────
  await fetch(`${API}/orders/${shopifyOrderId}/cancel.json`, { method: 'POST', headers: SH, body: JSON.stringify({}) });
  ok('Shopify order cancelled');

  console.log('      waiting for orders/cancelled delivery…');
  const cxOk = await waitFor('cancelled', async () => {
    const r = await sm.query(`SELECT status FROM production_orders WHERE id=$1`, [smOrderId]);
    return r.rows[0]?.status === 'cancelled';
  });
  cxOk
    ? ok('orders/cancelled → platform order set to cancelled')
    : bad('orders/cancelled did not reach/match the platform within 60s');

  const resv2 = parseInt((await sm.query(`SELECT COUNT(*) n FROM stock_reservations WHERE production_order_id=$1 AND status='reserved'`, [smOrderId])).rows[0].n);
  resv2 === 0
    ? ok('orders/cancelled released every stock reservation', `${resv0} → 0`)
    : bad('reservations not released', `${resv2} still reserved`);

  await cleanup();
  console.log(`\n══════ PHASE 5 E2E: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup(); process.exit(1); });
