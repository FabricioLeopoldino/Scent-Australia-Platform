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

// It writes to stock and compares every product before/after: the Neon branch
// sectors-dev only, unless the person running it says otherwise on purpose.
if (!(process.env.PLATFORM_DATABASE_URL || '').includes('ep-old-water-') && process.env.REGRESSION_ALLOW_PRODUCTION !== '1') {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the sectors-dev branch (ep-old-water-). Set REGRESSION_ALLOW_PRODUCTION=1 to override.');
  process.exit(1);
}

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

async function cleanup(uid, startedAt) {
  try {
    await cleanupRows(uid, startedAt);
  } finally {
    await db.query(`DELETE FROM users WHERE name = '__regression'`);
    // platform.audit_log's FK is ON DELETE SET NULL: the login row would stay behind, unowned.
    await db.query(`DELETE FROM platform.audit_log WHERE user_id IN (SELECT id FROM platform.users WHERE name = '__regression')`);
    await db.query(`DELETE FROM platform.users WHERE name = '__regression'`);
  }
}

async function cleanupRows(uid, startedAt) {
  // '%TESTREG%' too: the PO receipt writes "PO Received: TESTREG-PO-1 …", which
  // the '[regression]%' prefix missed — 35 such rows sat in production (23 Oct 2026).
  // Contains, not prefix: a reasoned adjustment is written "Correcting a count — [regression] …".
  await db.query(`DELETE FROM transactions WHERE shopify_order_id LIKE '#TESTREG%' OR notes LIKE '%[regression]%' OR notes LIKE '%TESTREG%'`);
  // sa.products has an AFTER UPDATE trigger (track_stock_changes) that logs EVERY
  // currentStock change into direct_stock_changes — app-driven or not. This suite
  // moves real oils (the webhook test) and restores them, so it leaves round-trip
  // rows behind: the stock is correct but the log keeps the noise forever.
  // Deleting our OWN rows only: scoped to this run's time window (§18 rule —
  // a test restores the balance AND removes what it wrote).
  if (startedAt) {
    await db.query(`DELETE FROM direct_stock_changes WHERE changed_at >= $1`, [startedAt]);
  }
  await db.query(`DELETE FROM audit_log WHERE user_id = $1`, [uid]);
  await db.query(`DELETE FROM webhook_processed WHERE order_id LIKE '%TESTREG%' OR order_id LIKE 'fulfillment_990%'`);
  await db.query(`DELETE FROM webhook_queue WHERE idempotency_key LIKE '%TESTREG%' OR idempotency_key LIKE 'fulfillment_990%'`);
  await db.query(`DELETE FROM purchase_orders WHERE order_number = 'TESTREG-PO-1'`);
  // Receiving an oil's PO writes a stock movement too (PRD_STAGE_1_FRAGRANCE_LIBRARY.md
  // S7, a SUPPLIER → SA receipt): left behind, it is a receipt in Armani Woods' history that never happened.
  await db.query(`DELETE FROM sector_movements WHERE reference LIKE 'TESTREG%'`);
  await db.query(`DELETE FROM products WHERE name = '[regression] Temp Product'`);
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
  // A reason is required since the stock-reasons change (shared/stock-reasons.js).
  const adj = await api('POST', '/api/sa/stock/adjust', { productId: 'OIL_1', quantity: 3, type: 'add', reason: 'correction', note: '[regression] adjust' });
  const adjBack = await api('POST', '/api/sa/stock/adjust', { productId: 'OIL_1', quantity: 3, type: 'remove', reason: 'correction', note: '[regression] adjust-back' });
  const finalStock = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  record('stock: adjust + restore', adj.status === 200 && adjBack.status === 200 && near(finalStock, before));
}

async function testPurchaseOrder() {
  const before = parseFloat(
    (await db.query(`SELECT "currentStock" FROM products WHERE id = 'OIL_1'`)).rows[0].currentStock
  );
  // No route raises an order any more: every order starts in Shopify (H4 D3).
  const create = await api('POST', '/api/sa/products/OIL_1/incoming', { orderNumber: 'TESTREG-PO-1', quantity: 100 });
  record('po: a manual order is refused (410, raise it in Shopify)', create.status === 410);

  // The row an accepted Shopify line stores, so the receipt itself is still tested.
  const poRow = await db.query(
    `INSERT INTO purchase_orders (product_id, order_number, quantity, supplier, notes, added_by)
     VALUES ('OIL_1', 'TESTREG-PO-1', 100, 'Firmenich', '[regression] po', 'regression') RETURNING id`);
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

// testTechStock removed 23 Oct 2026: Tech Stock was retired on 31/08/2026, its
// endpoints no longer move stock, and the test's "revert" (+2 mL) left Armani
// Woods 2 mL over on every run.

async function testDemandPlanningConsistency() {
  const rep = await api('GET', '/api/sa/dashboard/replenishment');
  const items = Array.isArray(rep.json) ? rep.json : rep.json?.products || rep.json?.items || [];
  // The list is the planned categories only (379 on 23 Oct 2026), not every product;
  // a floor still catches a filter that empties most of it.
  record('demand-planning: responds', rep.status === 200 && items.length > 200, `items=${items.length}`);

  // realStock must equal SA's balance — the total minus what the main store
  // and the MUSE stocks hold (PRD_STAGE_1_FRAGRANCE_LIBRARY.md S2) — for sampled products.
  // The API reports oils in LITERS (mL / 1000, 1-decimal rounding) — convert.
  let checked = 0, mismatches = 0;
  for (const it of items.slice(0, 25)) {
    const row = await db.query(
      `SELECT p."currentStock" - COALESCE(h.held, 0) AS "currentStock", p.unit
         FROM products p LEFT JOIN sector_held h ON h.product_id = p.id WHERE p.id = $1`, [it.id]);
    if (!row.rows[0]) continue;
    checked++;
    const R = row.rows[0].unit === 'mL' ? 1000 : 1;
    if (!near(it.realStock, parseFloat(row.rows[0].currentStock) / R, 0.06)) mismatches++;
  }
  record('demand-planning: realStock consistency (25 sampled)', checked > 0 && mismatches === 0, `mismatches=${mismatches}`);
}

// ── Demand Planning is SA's own movements ──
// MUSE and Atelier production is not SA demand, even when it takes SA's oil
// (S5 / R6, PRD_STAGE_1_FRAGRANCE_LIBRARY.md — the one intended difference from
// live, PRD §6); a manual SA removal is. Proven on a disposable fixture oil via
// the per-product detail endpoint, which shares DEMAND_TX_TYPES and
// EXCLUDE_NON_DEMAND with the headline replenishment query. A MUSE use typed
// by hand (a `remove`) is proven in regression-sectors.js.
async function testDemandCountsFragranceConsumption() {
  const create = await api('POST', '/api/sa/products', {
    name: '[regression] D14.7 DP Oil', category: 'OILS', unit: 'mL', currentStock: 0,
  });
  const pid = create.json?.id;
  if (!pid) { record('demand: fixture oil created', false, `status=${create.status}`); return; }

  // Demand Planning forecasts the SA Warehouse only (owner, 21 Oct 2026): MUSE
  // and Custom Orders production are NOT demand, a manual removal is. Dated-now
  // movements on the SAME oil. No currentStock touch → no trigger rows.
  const insTx = (type, qty, reason = null) => db.query(
    `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, reason)
     VALUES ($1, $2, $3, 'OILS', $4, $5, 'mL', 0, '[regression] D14.7 dp', $6)`,
    [pid, create.json?.productCode || pid, '[regression] D14.7 DP Oil', type, qty, reason]
  );
  await insTx('muse_production', 250);
  await insTx('sm_std_production', 300);
  await insTx('sm_major_production', 350);
  await insTx('remove', 100, 'sample'); // a removal with no reason is unpatterned, not demand
  // Reversals credit oil back: never demand, or a reversed production counts twice.
  await insTx('muse_reversal', 70);
  await insTx('sm_std_reversal', 80);
  await insTx('sm_major_reversal', 90);

  const detail = await api('GET', `/api/sa/products/${pid}/transactions?days=30`);
  const rows = detail.json?.dailySales || [];
  const total = rows.reduce((s, r) => s + r.volume_l, 0);
  record('demand: MUSE / Atelier production is not SA demand, nor any reversal — only the SA removal counts',
    rows.length === 1 && near(total, 0.1), `rows=${JSON.stringify(rows)}`);
  record('demand: a manual SA removal still counts (100 mL → 0.1 L)',
    near(rows.find((r) => r.type === 'Manual')?.volume_l, 0.1), `rows=${JSON.stringify(rows)}`);

  await db.query(`DELETE FROM transactions WHERE product_id = $1`, [pid]);
  await db.query(`DELETE FROM products WHERE id = $1`, [pid]);
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

  // The webhook handler responds 200 early and commits asynchronously; against a
  // remote Neon a fixed sleep races the commit. Poll the expected end-state
  // (bounded) instead of guessing a duration — deterministic regardless of latency.
  const waitUntil = async (fn, ms = 20000, gap = 750) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, gap));
    }
    return false;
  };
  const stockOf = async (id) =>
    parseFloat((await db.query(`SELECT "currentStock" FROM products WHERE id = $1`, [id])).rows[0].currentStock);

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
  // Wait for the async commit to land (debit applied AND sale row written).
  await waitUntil(async () => {
    const s = await stockOf(prodId);
    const n = (await db.query(`SELECT COUNT(*) FROM transactions WHERE shopify_order_id = '#TESTREG1' AND type = 'shopify_sale'`)).rows[0].count;
    return near(s, before - 400) && parseInt(n) >= 1;
  });
  const afterCreate = await stockOf(prodId);
  const saleTx = await db.query(`SELECT COUNT(*) FROM transactions WHERE shopify_order_id = '#TESTREG1' AND type = 'shopify_sale'`);
  record('webhook: fulfillment debits oil −400 mL', ok.status === 200 && near(afterCreate, before - 400), `stock ${before}→${afterCreate}`);
  record('webhook: shopify_sale transactions written', parseInt(saleTx.rows[0].count) >= 1, `rows=${saleTx.rows[0].count}`);

  // (c) redelivery → idempotent (no double debit). Can't poll for "nothing
  // happens"; give a hypothetical bad double-debit time to appear, then assert
  // it did not.
  const again = await postWebhook('fulfillments/create', payload);
  await new Promise((r) => setTimeout(r, 3000));
  const afterDup = await stockOf(prodId);
  const saleTx2 = await db.query(`SELECT COUNT(*) FROM transactions WHERE shopify_order_id = '#TESTREG1' AND type = 'shopify_sale'`);
  record(
    'webhook: redelivery is a no-op (3-layer guard)',
    again.status === 200 && near(afterDup, afterCreate) && saleTx.rows[0].count === saleTx2.rows[0].count
  );

  // (d) fulfillments/update cancelled → symmetric reversal, ALL stocks restored
  const cancel = await postWebhook('fulfillments/update', { ...payload, status: 'cancelled' });
  // Poll until every product is back to its pre-test value (reversal committed).
  const restored = await waitUntil(async () => {
    const snap = await snapAll();
    for (const [id, s] of snapBefore) if (snap.get(id) !== s) return false;
    return true;
  });
  const snapAfter = await snapAll();
  let diffs = 0;
  for (const [id, s] of snapBefore) if (snapAfter.get(id) !== s) diffs++;
  const revTx = await db.query(`SELECT COUNT(*) FROM transactions WHERE shopify_order_id = '#TESTREG1' AND type = 'shopify_reversal'`);
  record('webhook: cancellation reversal restores EVERY product exactly', cancel.status === 200 && restored && diffs === 0, `stock diffs=${diffs}`);
  record('webhook: shopify_reversal transactions written', parseInt(revTx.rows[0].count) >= 1, `rows=${revTx.rows[0].count}`);
}

// ── D15: Fragrance Library exclusivity on the oil form (Part B + §10) ──────
async function testExclusivity() {
  const create = await api('POST', '/api/sa/products', {
    name: '[regression] Excl Oil', category: 'OILS', unit: 'mL', currentStock: 0, exclusivity: 'MUSE',
  });
  const pid = create.json?.id;
  record('D15 exclusivity: create persists MUSE', create.json?.exclusivity === 'MUSE', `id=${pid}`);

  // §10 guarantee: an exclusive oil is withheld from Shopify but STILL gets its
  // 5 sale SKUs, so making it shared later needs no backfill.
  const skus = await db.query(`SELECT "shopifySkus" FROM products WHERE id = $1`, [pid]);
  const skuKeys = Object.keys(skus.rows[0]?.shopifySkus || {});
  record('D15 §10: exclusive oil still gets its 5 sale SKUs (no backfill needed later)',
    skuKeys.length === 5, skuKeys.join(','));

  const toSm = await api('PUT', `/api/sa/products/${pid}`, { exclusivity: 'SM' });
  record('D15 exclusivity: update MUSE → SM', toSm.json?.exclusivity === 'SM');

  // The COALESCE trap: an unrelated edit must NOT silently clear exclusivity.
  const rename = await api('PUT', `/api/sa/products/${pid}`, { name: '[regression] Excl Oil' });
  record('D15 exclusivity: an unrelated edit does not clear it', rename.json?.exclusivity === 'SM');

  // The sentinel: 'SHARED' must land as a real SQL NULL, not the string.
  const toShared = await api('PUT', `/api/sa/products/${pid}`, { exclusivity: 'SHARED' });
  const raw = await db.query(`SELECT exclusivity FROM products WHERE id = $1`, [pid]);
  record('D15 exclusivity: SHARED sentinel clears to real NULL',
    toShared.json?.exclusivity === null && raw.rows[0]?.exclusivity === null,
    `db=${JSON.stringify(raw.rows[0]?.exclusivity)}`);

  const bogus = await api('PUT', `/api/sa/products/${pid}`, { exclusivity: 'BOGUS' });
  record('D15 exclusivity: invalid value rejected', bogus.status === 400, `status=${bogus.status}`);

  await db.query(`DELETE FROM transactions WHERE product_id = $1`, [pid]);
  await db.query(`DELETE FROM products WHERE id = $1`, [pid]);
}

// ── D15: cross-company Oil Usage report — the arithmetic finance/director sees ──
async function testOilUsageReportMath() {
  const { buildOilUsageSheets } = await import('../src/sa/utils/excelExport.js');
  // The owner's own worked example: started 10 L, ended 8 L, MUSE used 2 L,
  // SA used 7 L, SM-Standard used 1 L — which only closes if 8 L was replenished.
  const ledger = [
    { id: 1, product_id: 'X', product_code: 'FRAG_9999', product_name: 'Fragrance X', type: 'muse_production',   quantity: 2000, unit: 'mL', balance_after: 8000, notes: 'Production: SM-101',      created_at: '2026-07-01T09:00:00Z' },
    { id: 2, product_id: 'X', product_code: 'FRAG_9999', product_name: 'Fragrance X', type: 'shopify_sale',      quantity: 7000, unit: 'mL', balance_after: 1000, notes: 'Shopify Order #555',     created_at: '2026-07-02T09:00:00Z' },
    { id: 3, product_id: 'X', product_code: 'FRAG_9999', product_name: 'Fragrance X', type: 'sm_std_production', quantity: 1000, unit: 'mL', balance_after: 0,    notes: 'Production: SM-102',      created_at: '2026-07-03T09:00:00Z' },
    { id: 4, product_id: 'X', product_code: 'FRAG_9999', product_name: 'Fragrance X', type: 'incoming',          quantity: 8000, unit: 'mL', balance_after: 8000, notes: 'PO received',             created_at: '2026-07-04T09:00:00Z' },
  ];
  const { summaryRows, detailRows } = buildOilUsageSheets(ledger);
  const s = summaryRows[0];
  // In LITRES since 2026-09-29. The ledger stores mL and the report said so
  // nowhere, so the owner had to ask whether a figure was litres or millilitres.
  // The report now converts and states the unit; these expectations moved with
  // it, deliberately — the arithmetic below is unchanged.
  record('D15 report: the unit is stated, not left to be guessed',
    s['Unit'] === 'L', `unit=${s['Unit']}`);
  record('D15 report: per-company usage split is exact',
    s['MUSE Used'] === 2 && s['SM-Standard Used'] === 1 && s['SM-Major Used'] === 0 && s['SA Used'] === 7,
    `MUSE=${s['MUSE Used']} SM-Std=${s['SM-Standard Used']} SA=${s['SA Used']}`);
  const balances = s['Opening Stock'] + s['Replenished (+)']
    - s['MUSE Used'] - s['SM-Standard Used'] - s['SM-Major Used'] - s['SA Used']
    + s['Direct Adj. (count/manual)'] === s['Closing Stock'];
  record('D15 report: Opening + Replenished − Used(all) + DirectAdj = Closing',
    balances && s['Opening Stock'] === 10 && s['Closing Stock'] === 8,
    `${s['Opening Stock']} + ${s['Replenished (+)']} − 10 = ${s['Closing Stock']}`);
  // Each oil's opening and closing belong to its own first and last movement in
  // the period, which two oils rarely share — so the report has to say which day
  // each figure is from, or it cannot be checked afterwards.
  // The property the Direct Adj. column exists for: the printed row must add up.
  // A first version divided then rounded, leaving rows where 10 − 1.24 = 8.76
  // against a printed closing of 8.77 — the residual could no longer absorb the
  // gap, so it stopped meaning "off-ledger change" and started meaning "rounding".
  const oddLedger = [
    { id: 1, product_id: 'Y', product_code: 'FRAG_8888', product_name: 'Odd', type: 'add',             quantity: 10000, unit: 'mL', balance_after: 10000, notes: '', created_at: '2026-07-01T09:00:00Z' },
    { id: 2, product_id: 'Y', product_code: 'FRAG_8888', product_name: 'Odd', type: 'muse_production', quantity: 1235,  unit: 'mL', balance_after: 8765,  notes: '', created_at: '2026-07-02T09:00:00Z' },
  ];
  const odd = buildOilUsageSheets(oddLedger).summaryRows[0];
  const oddBalances = Math.abs(
    (odd['Opening Stock'] + odd['Replenished (+)'] - odd['MUSE Used'] - odd['SM-Standard Used']
     - odd['SM-Major Used'] - odd['SA Used'] + odd['Direct Adj. (count/manual)'])
    - odd['Closing Stock']) < 1e-9;
  record('D15 report: the row adds up on figures that are not round litres',
    oddBalances && odd['MUSE Used'] === 1.235,
    `${odd['Opening Stock']} + ${odd['Replenished (+)']} − ${odd['MUSE Used']} = ${odd['Closing Stock']}`);
  // A millilitre is 0.001 L. At two decimals a 4 mL movement reported as zero.
  const tiny = buildOilUsageSheets([
    oddLedger[0],
    { ...oddLedger[1], quantity: 4, balance_after: 9996 },
  ]).summaryRows[0];
  record('D15 report: a 4 mL movement is not rounded away to nothing',
    tiny['MUSE Used'] === 0.004, `MUSE=${tiny['MUSE Used']}`);
  // A transaction can carry a BOM's unit rather than the oil's own. Converting on
  // the first row that has one would relabel the whole oil as litres while its
  // figures stayed in millilitres.
  const mixed = buildOilUsageSheets([
    { ...oddLedger[0], unit: 'L' },
    oddLedger[1],
  ]).summaryRows[0];
  record('D15 report: mixed units are left raw and named, never silently converted',
    mixed['Unit'] === 'L/mL' && mixed['Opening Stock'] === 0,
    `unit=${mixed['Unit']} opening=${mixed['Opening Stock']}`);

  record('D15 report: each row carries the dates its own figures come from',
    !!s['Opening At'] && s['Opening At'] !== '-' && !!s['Closing At'] && s['Closing At'] !== '-',
    `${s['Opening At']} → ${s['Closing At']}`);
  // A clean ledger (no off-ledger edits) must report ZERO direct adjustment —
  // otherwise the column would hide arithmetic errors instead of surfacing real
  // manual corrections.
  record('D15 report: a fully-explained ledger shows zero Direct Adj.',
    s['Direct Adj. (count/manual)'] === 0, `adj=${s['Direct Adj. (count/manual)']}`);
  // And when stock DID move off-ledger, the column must catch exactly the gap:
  // same ledger, but the closing balance jumped 500 higher than the movements explain.
  const gapped = buildOilUsageSheets(ledger.map((r, i) =>
    i === ledger.length - 1 ? { ...r, balance_after: 8500 } : r)).summaryRows[0];
  record('D15 report: an off-ledger stock change is surfaced as Direct Adj.',
    gapped['Direct Adj. (count/manual)'] === 0.5, `adj=${gapped['Direct Adj. (count/manual)']}`);
  // A reversal must net against its OWN business, never count as replenishment.
  const withReversal = buildOilUsageSheets([...ledger,
    { id: 5, product_id: 'X', product_code: 'FRAG_9999', product_name: 'Fragrance X', type: 'muse_reversal', quantity: 500, unit: 'mL', balance_after: 8500, notes: 'cancelled', created_at: '2026-07-05T09:00:00Z' },
  ]).summaryRows[0];
  record('D15 report: a reversal nets against its own business, not "Replenished"',
    withReversal['MUSE Used'] === 1.5 && withReversal['Replenished (+)'] === 8,
    `MUSE=${withReversal['MUSE Used']} Replenished=${withReversal['Replenished (+)']}`);
  record('D15 report: detail sheet has one row per movement + order refs',
    detailRows.length === 4 && detailRows.some((r) => r['Order #'] === '#555') && detailRows.some((r) => r['Order #'] === 'SM-101'),
    `${detailRows.length} rows`);
}

// ── §18 test-data discipline: the suite must leave production untouched ────
// Snapshot-before → compare-after. Enforces the owner's rule (2026-07-16) as an
// invariant instead of a habit: a test that leaks stock or leaves audit rows
// behind goes RED here rather than silently dirtying the live SA ledger.
async function snapshotStock() {
  const r = await db.query(`SELECT id, "currentStock" FROM products`);
  return new Map(r.rows.map((x) => [x.id, String(x.currentStock)]));
}

async function testNoResidue(before, startedAt) {
  const after = await snapshotStock();
  const drifted = [];
  for (const [id, stock] of before) {
    const now = after.get(id);
    if (now !== undefined && now !== stock) drifted.push(`${id}: ${stock}→${now}`);
  }
  record('§18 residue: every pre-existing product stock restored exactly',
    drifted.length === 0, drifted.length ? drifted.slice(0, 5).join(', ') : 'zero drift');

  const leftoverProducts = [...after.keys()].filter((id) => !before.has(id));
  record('§18 residue: no test product left behind',
    leftoverProducts.length === 0, leftoverProducts.join(', ') || 'none');

  const leftoverTx = await db.query(
    `SELECT COUNT(*)::int n FROM transactions WHERE notes LIKE '%[regression]%' OR notes LIKE '%TESTREG%' OR shopify_order_id LIKE '#TESTREG%'`
  );
  record('§18 residue: no test transaction rows left in the ledger',
    leftoverTx.rows[0].n === 0, `${leftoverTx.rows[0].n} rows`);
  const leftoverMoves = await db.query(`SELECT COUNT(*)::int n FROM sector_movements WHERE reference LIKE 'TESTREG%'`); // by reference only: a real MUSE sale during a run writes one too
  record('§18 residue: no test sector movements left', leftoverMoves.rows[0].n === 0, `${leftoverMoves.rows[0].n} rows`);

  // The trigger-written log is residue too — it is what made ~160 orphan rows
  // pile up from earlier runs before this was caught (2026-07-16).
  if (startedAt) {
    const leftoverDsc = await db.query(
      `SELECT COUNT(*)::int n FROM direct_stock_changes WHERE changed_at >= $1`, [startedAt]
    );
    record('§18 residue: no trigger-written stock-change rows left behind',
      leftoverDsc.rows[0].n === 0, `${leftoverDsc.rows[0].n} rows`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!WEBHOOK_SECRET) throw new Error('SA_SHOPIFY_WEBHOOK_SECRET / SCENT_SHOPIFY_WEBHOOK_SECRET not set');
  console.log('══════════ SA REGRESSION SUITE (Phase 2d) ══════════\n');
  // setup() creates a ROOT user whose password is in this file. It runs inside
  // the try so a failed login still reaches cleanup — on 28 Sep 2026 one didn't,
  // and the account sat active in production until 22 Oct.
  let uid, stockBefore, startedAt;
  try {
    uid = await setup();
    // Taken BEFORE any test writes, compared AFTER cleanup (§18 discipline).
    stockBefore = await snapshotStock();
    startedAt = (await db.query(`SELECT NOW() AS t`)).rows[0].t;
    await testProductsCrud();
    await testStockOps();
    await testPurchaseOrder();
    await testFormulasReadyStock();
    await testScentedGroup();
    await testDemandPlanningConsistency();
    await testDemandCountsFragranceConsumption();
    await testWebhooks();
    await testExclusivity();
    await testOilUsageReportMath();
  } finally {
    await cleanup(uid, startedAt);
  }
  try {
    await testNoResidue(stockBefore, startedAt);
  } finally {
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
