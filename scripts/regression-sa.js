// ═══════════════════════════════════════════════════════════════════════
// Phase 2d — SA module regression suite (PRD §12 Phase 2d Verify)
//
// Runs against a LOCAL platform server (localhost:3000) + the platform Neon
// (schema sa = migrated snapshot). Read-write, self-reverting: every test
// restores the stock it touches and the cleanup section removes test rows.
// Reused in Phase 6 rehearsals and as the pre-cutover gate.
//
// Usage:  node scripts/regression-sa.js       (server must be running)
// Exit 0 = ALL PASS.
// ═══════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import crypto from 'crypto';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
const { Pool } = pkg;

const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';
const WEBHOOK_SECRET =
  process.env.SA_SHOPIFY_WEBHOOK_SECRET || process.env.SCENT_SHOPIFY_WEBHOOK_SECRET;

const db = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false },
  options: '-c search_path=sa,public',
});

const results = [];
let TOKEN = null;

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const near = (a, b, eps = 0.011) => Math.abs(parseFloat(a) - parseFloat(b)) < eps;

// ── Setup / teardown ──────────────────────────────────────────────────────
async function setup() {
  const hash = bcrypt.hashSync('RegressionTest1!', 10);
  const u = await db.query(
    `INSERT INTO platform.users (name, password_hash, role, must_change_password)
     VALUES ('__regression', $1, 'root', false)
     ON CONFLICT (name) DO UPDATE SET password_hash = $1, must_change_password = false
     RETURNING id`,
    [hash]
  );
  const uid = u.rows[0].id;
  await db.query(`INSERT INTO platform.user_modules (user_id, module) VALUES ($1,'SA') ON CONFLICT DO NOTHING`, [uid]);
  await db.query(
    `INSERT INTO users (id, name, password, role, must_change_password)
     VALUES ($1,'__regression',$2,'root',false) ON CONFLICT (id) DO NOTHING`,
    [uid, hash]
  );
  const login = await api('POST', '/api/platform/auth/login', { name: '__regression', password: 'RegressionTest1!' });
  if (login.status !== 200) throw new Error('Regression user login failed');
  TOKEN = login.json.token;
  return uid;
}

async function cleanup(uid) {
  await db.query(`DELETE FROM transactions WHERE shopify_order_id LIKE '#TESTREG%' OR notes LIKE '[regression]%'`);
  await db.query(`DELETE FROM audit_log WHERE user_id = $1`, [uid]);
  await db.query(`DELETE FROM webhook_processed WHERE order_id LIKE '%TESTREG%' OR order_id LIKE 'fulfillment_990%'`);
  await db.query(`DELETE FROM webhook_queue WHERE idempotency_key LIKE '%TESTREG%' OR idempotency_key LIKE 'fulfillment_990%'`);
  await db.query(`DELETE FROM purchase_orders WHERE order_number = 'TESTREG-PO-1'`);
  await db.query(`DELETE FROM products WHERE name = '[regression] Temp Product'`);
  await db.query(`DELETE FROM users WHERE name = '__regression'`);
  await db.query(`DELETE FROM platform.users WHERE name = '__regression'`);
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function testProductsCrud() {
  const create = await api('POST', '/api/sa/products', {
    name: '[regression] Temp Product',
    category: 'RAW_MATERIALS',
    unit: 'units',
    currentStock: 5,
    minStockLevel: 1,
    unitPerBox: 1,
  });
  const ok1 = create.status === 200 || create.status === 201;
  const pid = create.json?.product?.id || create.json?.id;
  record('products: create', ok1 && !!pid, `id=${pid}`);

  const upd = await api('PUT', `/api/sa/products/${pid}`, { name: '[regression] Temp Product', minStockLevel: 2 });
  record('products: update', upd.status === 200);

  const del = await api('DELETE', `/api/sa/products/${pid}`);
  record('products: delete', del.status === 200);
}

async function testStockOps() {
  const before = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );

  const add = await api('POST', '/api/sa/stock/add', { productId: 'OIL_1', quantity: 5, notes: '[regression] add' });
  record('stock: add +5', add.status === 200 && near(add.json.newStock, before + 5));

  const rem = await api('POST', '/api/sa/stock/remove', { productId: 'OIL_1', quantity: 5, notes: '[regression] remove' });
  record('stock: remove -5', rem.status === 200 && near(rem.json.newStock, before));

  // adjust is delta-based with direction: type ∈ {add, remove}
  const adj = await api('POST', '/api/sa/stock/adjust', { productId: 'OIL_1', quantity: 3, type: 'add', note: '[regression] adjust' });
  const adjBack = await api('POST', '/api/sa/stock/adjust', { productId: 'OIL_1', quantity: 3, type: 'remove', note: '[regression] adjust-back' });
  const finalStock = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  record('stock: adjust + restore', adj.status === 200 && adjBack.status === 200 && near(finalStock, before));
}

async function testPurchaseOrder() {
  const before = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  const create = await api('POST', '/api/sa/products/OIL_1/incoming', {
    orderNumber: 'TESTREG-PO-1',
    quantity: 100,
    supplier: 'Firmenich',
    estimatedDeliveryDate: '2026-08-01',
    notes: '[regression] po',
  });
  record('po: create', create.status === 200 || create.status === 201);

  const poRow = await db.query(`SELECT id FROM purchase_orders WHERE order_number = 'TESTREG-PO-1' ORDER BY id DESC LIMIT 1`);
  const poId = poRow.rows[0]?.id;
  const recv = await api('POST', `/api/sa/purchase-orders/${poId}/receive`, { quantityReceived: 100, notes: '[regression] receive' });
  const after = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  record('po: receive full (+100)', recv.status === 200 && near(after, before + 100));

  // revert
  await api('POST', '/api/sa/stock/remove', { productId: 'OIL_1', quantity: 100, notes: '[regression] po revert' });
  const reverted = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  record('po: stock reverted', near(reverted, before));
}

async function testFormulasReadyStock() {
  const list = await api('GET', '/api/sa/formulas');
  const f = Array.isArray(list.json) ? list.json[0] : null;
  record('formulas: list', list.status === 200 && !!f, `count=${Array.isArray(list.json) ? list.json.length : 0}`);
  if (!f) return;

  const beforeMl = parseFloat(f.ready_stock_ml) || 0;
  const recv = await api('POST', `/api/sa/formulas/${f.id}/ready-stock/receive`, { quantityMl: 500, notes: '[regression] ready' });
  const adj = await api('PUT', `/api/sa/formulas/${f.id}/ready-stock/adjust`, { quantityMl: beforeMl });
  const finalMl = parseFloat(
    (await db.query(`SELECT ready_stock_ml FROM formulas WHERE id = $1`, [f.id])).rows[0].ready_stock_ml
  );
  record('formulas: ready-stock receive + adjust back', recv.status === 200 && adj.status === 200 && near(finalMl, beforeMl));
}

async function testScentedGroup() {
  const containers = await api('GET', '/api/sa/scented-containers');
  const ids = (containers.json || []).map((c) => c.id);
  record('scented: containers list', containers.status === 200 && ids.length >= 1, `count=${ids.length}`);
  if (ids.length === 0) return;

  const frag = await db.query(`SELECT id FROM products WHERE category = 'OILS' AND status = 'active' LIMIT 1`);
  const create = await api('POST', '/api/sa/scented-product-groups', {
    group_name: '[regression] Test Line',
    fragrance_product_id: frag.rows[0].id,
    container_ids: [ids[0]],
  });
  const gid = create.json?.group?.id || create.json?.id;
  record('scented: group create (atomic)', (create.status === 200 || create.status === 201) && !!gid, `group=${gid}`);

  const del = await api('DELETE', `/api/sa/scented-product-groups/${gid}?cascade=true`);
  const left = await db.query(`SELECT COUNT(*) FROM scented_product_groups WHERE id = $1`, [gid || -1]);
  record('scented: cascade delete', del.status === 200 && left.rows[0].count === '0');
}

async function testTechStock() {
  const before = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  const t1 = await api('POST', '/api/sa/tech-stock/transfer', { productId: 'OIL_1', quantity: 10, notes: '[regression] t' });
  const t2 = await api('POST', '/api/sa/tech-stock/remove', { productId: 'OIL_1', quantity: 2, notes: '[regression] t' });
  const t3 = await api('POST', '/api/sa/tech-stock/return', { productId: 'OIL_1', quantity: 8, notes: '[regression] t' });
  const t4 = await api('POST', '/api/sa/tech-stock/return-input', { productId: 'OIL_1', quantity: 2, notes: '[regression] t' });
  const t5 = await api('POST', '/api/sa/tech-stock/remove', { productId: 'OIL_1', quantity: 2, notes: '[regression] t' });

  const tech = await db.query(`SELECT quantity FROM tech_stock WHERE product_id = 'OIL_1'`);
  const techQty = parseFloat(tech.rows[0]?.quantity || 0);
  const mainAfter = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  // Net effect: main −10 +8 = −2 (2 mL consumed in service); tech back to 0
  const ok = [t1, t2, t3, t4, t5].every((r) => r.status === 200) && near(techQty, 0) && near(mainAfter, before - 2);
  record('tech-stock: transfer/remove/return/return-input cycle', ok, `tech=${techQty} mainΔ=${(mainAfter - before).toFixed(1)}`);

  await api('POST', '/api/sa/stock/add', { productId: 'OIL_1', quantity: 2, notes: '[regression] tech revert' });
  const restored = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  record('tech-stock: stock restored', near(restored, before));
}

async function testDemandPlanningConsistency() {
  const rep = await api('GET', '/api/sa/dashboard/replenishment');
  const items = Array.isArray(rep.json) ? rep.json : rep.json?.products || rep.json?.items || [];
  record('demand-planning: responds', rep.status === 200 && items.length > 500, `items=${items.length}`);

  // realStock must equal products.currentStock for sampled products.
  // The API reports oils in LITERS (mL / 1000, 1-decimal rounding) — convert.
  let checked = 0, mismatches = 0;
  for (const it of items.slice(0, 25)) {
    const row = await db.query(`SELECT "currentStock", unit FROM products WHERE id = $1`, [it.id]);
    if (!row.rows[0]) continue;
    checked++;
    const R = row.rows[0].unit === 'mL' ? 1000 : 1;
    if (!near(it.realStock, parseFloat(row.rows[0].currentStock) / R, 0.06)) mismatches++;
  }
  record('demand-planning: realStock consistency (25 sampled)', checked > 0 && mismatches === 0, `mismatches=${mismatches}`);
}

// ── Webhook replay (the critical path) ────────────────────────────────────
function sign(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body)).digest('base64');
}

async function postWebhook(topic, payload, { badHmac = false, noHmac = false } = {}) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic };
  if (!noHmac) headers['X-Shopify-Hmac-Sha256'] = badHmac ? sign(body + 'x') : sign(body);
  const res = await fetch(`${BASE}/api/webhook/shopify/sa`, { method: 'POST', headers, body });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function testWebhooks() {
  // Snapshot of ALL product stocks — strongest possible net-zero check
  const snapAll = async () => {
    const r = await db.query(`SELECT id, "currentStock"::numeric(20,3) AS s FROM products ORDER BY id`);
    return new Map(r.rows.map((x) => [x.id, String(x.s)]));
  };

  const oil = await db.query(
    `SELECT id, name, "currentStock", "shopifySkus"->>'SA_CA' AS sku
     FROM products WHERE category = 'OILS' AND "shopifySkus" ? 'SA_CA' LIMIT 1`
  );
  const { id: prodId, sku } = oil.rows[0];
  const before = parseFloat(oil.rows[0].currentStock);
  const snapBefore = await snapAll();

  const FID = 990000001; // fulfillment id → idempotency key fulfillment_990000001
  const payload = { id: FID, name: '#TESTREG1', status: 'success', line_items: [{ sku, quantity: 1 }] };

  // (a) invalid HMAC → 401
  const bad = await postWebhook('fulfillments/create', payload, { badHmac: true });
  record('webhook: invalid HMAC rejected', bad.status === 401);
  const missing = await postWebhook('fulfillments/create', payload, { noHmac: true });
  record('webhook: missing HMAC rejected', missing.status === 401);

  // (b) valid delivery → oil debited 400 mL (SA_CA) + BOM components
  const ok = await postWebhook('fulfillments/create', payload);
  await new Promise((r) => setTimeout(r, 4000)); // handler responds 200 early, then commits
  const afterCreate = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = $1`, [prodId])).rows[0].currentStock
  );
  const saleTx = await db.query(`SELECT COUNT(*) FROM transactions WHERE shopify_order_id = '#TESTREG1' AND type = 'shopify_sale'`);
  record('webhook: fulfillment debits oil −400 mL', ok.status === 200 && near(afterCreate, before - 400), `stock ${before}→${afterCreate}`);
  record('webhook: shopify_sale transactions written', parseInt(saleTx.rows[0].count) >= 1, `rows=${saleTx.rows[0].count}`);

  // (c) redelivery → idempotent (no double debit)
  const again = await postWebhook('fulfillments/create', payload);
  await new Promise((r) => setTimeout(r, 2500));
  const afterDup = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = $1`, [prodId])).rows[0].currentStock
  );
  const saleTx2 = await db.query(`SELECT COUNT(*) FROM transactions WHERE shopify_order_id = '#TESTREG1' AND type = 'shopify_sale'`);
  record(
    'webhook: redelivery is a no-op (3-layer guard)',
    again.status === 200 && near(afterDup, afterCreate) && saleTx.rows[0].count === saleTx2.rows[0].count
  );

  // (d) fulfillments/update cancelled → symmetric reversal, ALL stocks restored
  const cancel = await postWebhook('fulfillments/update', { ...payload, status: 'cancelled' });
  await new Promise((r) => setTimeout(r, 4000));
  const snapAfter = await snapAll();
  let diffs = 0;
  for (const [id, s] of snapBefore) if (snapAfter.get(id) !== s) diffs++;
  const revTx = await db.query(`SELECT COUNT(*) FROM transactions WHERE shopify_order_id = '#TESTREG1' AND type = 'shopify_reversal'`);
  record('webhook: cancellation reversal restores EVERY product exactly', cancel.status === 200 && diffs === 0, `stock diffs=${diffs}`);
  record('webhook: shopify_reversal transactions written', parseInt(revTx.rows[0].count) >= 1, `rows=${revTx.rows[0].count}`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!WEBHOOK_SECRET) throw new Error('SA_SHOPIFY_WEBHOOK_SECRET / SCENT_SHOPIFY_WEBHOOK_SECRET not set');
  console.log('══════════ SA REGRESSION SUITE (Phase 2d) ══════════\n');
  const uid = await setup();
  try {
    await testProductsCrud();
    await testStockOps();
    await testPurchaseOrder();
    await testFormulasReadyStock();
    await testScentedGroup();
    await testTechStock();
    await testDemandPlanningConsistency();
    await testWebhooks();
  } finally {
    await cleanup(uid);
    await db.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n══════════ RESULT: ${failed.length === 0 ? '✅ ALL PASS' : `❌ ${failed.length} FAILED`} (${results.length} checks) ══════════`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Regression error:', e);
  process.exit(1);
});
