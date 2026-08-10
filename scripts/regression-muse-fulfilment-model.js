// Covers what a MUSE shipment is allowed to consume.
//
// WHY THIS EXISTS (2026-08-10, from a full end-to-end audit): three defects in
// smFulfillmentHandler, all of which lose oil or lose it twice, all silent.
//
//   1. ALL-OR-NOTHING SPLIT. The choice between "off the shelf" and "make to
//      order" was `finishedStock <= 0`, so ANY stock sent the WHOLE quantity
//      down the shelf branch. Two on the shelf and five sold drove stock to −3
//      while the three units actually made consumed nothing at all.
//
//   2. DOUBLE CONSUMPTION. Nothing connected a shipment to the production order
//      for the same Shopify order. Start production (oil debited), ship in
//      Shopify before clicking Complete, and the shelf still reads 0 — so the
//      shipment made-to-ordered a second full batch. Measured: 1000 mL taken
//      for a 500 mL order.
//
//   3. ONE BAD LINE VOIDED THE SHIPMENT. Every line ran in one transaction with
//      no isolation, so a throw on line 2 — lockOil rejecting a missing or
//      exclusivity-locked oil, the exact mislink class found at launch — rolled
//      back lines 1 and 3 as well. The 200 was already sent, so Shopify never
//      retried, and the alarm was skipped too. Goods gone, nothing recorded,
//      nothing said.
//
// Everything here runs on disposable rows, including a disposable Fragrance
// Library oil, and the teardown removes them — sa is production data.
//
// Run: node scripts/regression-muse-fulfilment-model.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'regression-only-secret-not-a-real-key';
const TAG = `ZZF${String(Date.now()).slice(-7)}`;
const OIL_ID = `ZZFO${String(Date.now()).slice(-8)}`;
const OIL_START = 100000;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

let failed = 0, server, masterId, ethanolId, log = '';
const V = {}; // name → { id, sku }
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const post = (topic, payload) => {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');
  return fetch(`${BASE}/api/webhook/shopify/muse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-hmac-sha256': hmac },
    body, signal: AbortSignal.timeout(30000),
  });
};
async function waitFor(fn, ok, ms = 20000) {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() > until) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
}
const oil = async () => Number((await pool.query(`SELECT "currentStock" c FROM sa.products WHERE id=$1`, [OIL_ID])).rows[0].c);
const stock = async (id) => Number((await pool.query(`SELECT current_stock c FROM products WHERE id=$1`, [id])).rows[0].c);
const alarms = async (ref) => (await pool.query(
  `SELECT details FROM audit_log WHERE action='muse_fulfillment_unmatched' AND entity_name=$1`, [ref])).rows;
const processed = (fid, type) => waitFor(
  async () => (await pool.query(
    `SELECT 1 FROM webhook_processed WHERE shopify_order_id=$1 AND webhook_type=$2`, [fid, type])).rows,
  (x) => x.length > 0);

async function mkVariant(key, stockQty, oilId = OIL_ID) {
  const sku = `${TAG}_${key}`;
  const r = await pool.query(
    `INSERT INTO products (name, product_code, sku, category, unit, master_product_id, segment, current_stock, oil_id)
     VALUES ($1,$2,$3,'FINISHED_GOOD','units',$4,'MUSE',$5,$6) RETURNING id`,
    [`${TAG} ${key}`, `${TAG}_${key}`, sku, masterId, stockQty, oilId]);
  V[key] = { id: r.rows[0].id, sku };
}

try {
  await pool.query(
    `INSERT INTO sa.products (id, tag, name, category, "productCode", "currentStock", unit, status)
     VALUES ($1,$1,$2,'OILS',$1,$3,'mL','active')`, [OIL_ID, '[regression] fulfilment oil', OIL_START]);
  ethanolId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, current_stock)
     VALUES ($1,$2,'RAW_MATERIAL','ml',1000000) RETURNING id`, [`${TAG} eth`, `${TAG}_E`])).rows[0].id;
  masterId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, is_master, segment, current_stock, volume_ml, default_oil_pct)
     VALUES ($1,$2,'FINISHED_GOOD','units',true,'MUSE',0,200,25) RETURNING id`,
    [`${TAG} master`, `${TAG}_M`])).rows[0].id;
  await pool.query(
    `INSERT INTO product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
     VALUES ($1,$2,'ethanol_pct',0,0,'core',true)`, [`${TAG}_M`, ethanolId]);

  await mkVariant('EMPTY', 0);          // nothing on the shelf
  await mkVariant('PART', 2);           // partially covered
  await mkVariant('FULL', 10);          // fully covered
  await mkVariant('GOOD', 0);           // pairs with BAD below
  // A variant whose oil is reserved for another business. lockOil throws on it
  // (fragrance-library.js:67) — the live trigger for the "one bad line" case.
  // products.oil_id has a foreign key, so a dangling id is not reachable; an
  // exclusivity-locked oil is, and it is the same mislink class found at launch.
  await pool.query(
    `INSERT INTO sa.products (id, tag, name, category, "productCode", "currentStock", unit, status, exclusivity)
     VALUES ($1,$1,$2,'OILS',$1,50000,'mL','active','SA')`, [`${OIL_ID}X`, '[regression] exclusive oil']);
  await mkVariant('BAD', 0, `${OIL_ID}X`);

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test',
      SM_SHOPIFY_WEBHOOK_SECRET: SECRET, MUSE_SHOPIFY_WEBHOOK_SECRET: SECRET,
      SM_SHOPIFY_API_SECRET: '', MUSE_SHOPIFY_API_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1200)}`);

  const ship = (fid, oid, items, name) => post('fulfillments/create',
    { id: fid, order_id: oid, status: 'success', name, line_items: items });

  // ── 1. Nothing on the shelf → make the lot ────────────────────────────────
  {
    const before = await oil();
    await ship(930001, 940001, [{ title: 'x', quantity: 5, sku: V.EMPTY.sku }], '#ZZ-F-EMPTY');
    await processed(930001, 'muse_sale');
    const used = before - await oil();
    check(used === 250, 'empty shelf → oil for all 5 (5×200×25% = 250 mL)', `${used} mL`);
    check(await stock(V.EMPTY.id) === 0, 'made-to-order leaves finished stock at 0');
  }

  // ── 2. Enough on the shelf → consume nothing ──────────────────────────────
  {
    const before = await oil();
    await ship(930002, 940002, [{ title: 'x', quantity: 5, sku: V.FULL.sku }], '#ZZ-F-FULL');
    await processed(930002, 'muse_sale');
    check(before - await oil() === 0, 'covered by stock → no oil consumed');
    check(await stock(V.FULL.id) === 5, 'and 5 come off the shelf (10 → 5)', `${await stock(V.FULL.id)}`);
  }

  // ── 3. Partly on the shelf → make only the shortfall ──────────────────────
  {
    const before = await oil();
    await ship(930003, 940003, [{ title: 'x', quantity: 5, sku: V.PART.sku }], '#ZZ-F-PART');
    await processed(930003, 'muse_sale');
    const used = before - await oil();
    check(used === 150, '2 on the shelf, 5 sold → oil for 3 only (150 mL)', `${used} mL`);
    check(await stock(V.PART.id) === 0, 'and the shelf lands on 0, never negative', `${await stock(V.PART.id)}`);
  }

  // ── 4. A failing line must not void the rest of the shipment ──────────────
  {
    const ref = '#ZZ-F-MIX';
    const before = await oil();
    await ship(930004, 940004, [
      { title: 'good', quantity: 2, sku: V.GOOD.sku },
      { title: 'bad', quantity: 2, sku: V.BAD.sku },   // its oil does not exist → throws
    ], ref);
    await processed(930004, 'muse_sale');
    const used = before - await oil();
    check(used === 100, 'the healthy line still consumed its oil (2×200×25% = 100 mL)', `${used} mL`);
    const a = await waitFor(() => alarms(ref), (x) => x.length > 0);
    const reasons = (a[0]?.details?.unmatched || []).map((u) => u.reason);
    check(reasons.includes('line_failed'), 'the failing line is raised as an alarm', JSON.stringify(reasons));
    check(await stock(V.BAD.id) === 0, 'and the failing line moved nothing');
  }

  // ── 5. Shipping before Complete must not consume a second time ────────────
  {
    const SHOP = 940005;
    await post('orders/paid', { id: SHOP, name: '#ZZ-F-DBL',
      line_items: [{ title: 'x', quantity: 4, sku: V.EMPTY.sku }] });
    const po = await waitFor(
      async () => (await pool.query(
        `SELECT id, order_number FROM production_orders WHERE shopify_order_id=$1`, [SHOP])).rows,
      (x) => x.length > 0);
    check(po.length === 1, 'a production order was created for the paid order', po[0]?.order_number);

    const u = await pool.query(`SELECT id, name FROM platform.users WHERE role IN ('root','admin') AND COALESCE(active,true) LIMIT 1`);
    const jwt = await import('jsonwebtoken');
    const token = jwt.default.sign({ id: u.rows[0].id, name: u.rows[0].name, role: 'root',
      modules: ['SA', 'SM', 'MUSE', 'OPS'], must_change_password: false },
      process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
    const api = (m, p, b) => fetch(`${BASE}/api/sm${p}`, { method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: b ? JSON.stringify(b) : undefined });

    await api('PUT', `/production-orders/${po[0].id}/status`, { status: 'queued' });
    await api('POST', `/manufacturing/${po[0].id}/start`);
    const afterStart = await oil();

    await ship(930005, SHOP, [{ title: 'x', quantity: 4, sku: V.EMPTY.sku }], '#ZZ-F-DBL');
    await processed(930005, 'muse_sale');
    check(await oil() === afterStart, 'production already debited → the shipment consumes NO more oil', `${afterStart} → ${await oil()}`);
    const a = await waitFor(() => alarms('#ZZ-F-DBL'), (x) => x.length > 0);
    const reasons = (a[0]?.details?.unmatched || []).map((r2) => r2.reason);
    check(reasons.includes('production_not_completed'), 'and it says the production order still needs completing', JSON.stringify(reasons));
  }

  // ── 6. Shipping with an untouched production order closes it ──────────────
  {
    const SHOP = 940006;
    await post('orders/paid', { id: SHOP, name: '#ZZ-F-STALE',
      line_items: [{ title: 'x', quantity: 3, sku: V.EMPTY.sku }] });
    const po = await waitFor(
      async () => (await pool.query(
        `SELECT id, order_number, status FROM production_orders WHERE shopify_order_id=$1`, [SHOP])).rows,
      (x) => x.length > 0);
    const before = await oil();
    await ship(930006, SHOP, [{ title: 'x', quantity: 3, sku: V.EMPTY.sku }], '#ZZ-F-STALE');
    await processed(930006, 'muse_sale');
    check(before - await oil() === 150, 'never produced → the shipment makes it (3×200×25% = 150 mL)', `${before - await oil()} mL`);
    const after = await waitFor(
      async () => (await pool.query(`SELECT status FROM production_orders WHERE id=$1`, [po[0].id])).rows,
      (x) => x[0]?.status === 'cancelled');
    check(after[0]?.status === 'cancelled', 'and the now-pointless production order is closed', `status=${after[0]?.status}`);
  }

  console.log(failed === 0
    ? `\n✅ muse-fulfilment-model: all checks passed`
    : `\n❌ muse-fulfilment-model: ${failed} failed`);
} catch (e) {
  console.error(`\n❌ muse-fulfilment-model: ${e.message}`);
  failed++;
} finally {
  if (failed > 0) {
    const l = log.split('\n').filter((x) => /muse-fulfil|muse-order|rror/i.test(x)).slice(-30);
    console.log(`\n─── server log ───\n${l.join('\n') || '(nothing)'}`);
  }
  if (server) server.kill();
  const ids = (await pool.query(`SELECT id FROM production_orders WHERE notes LIKE '%#ZZ-F-%'`)).rows.map((r) => r.id);
  if (ids.length) {
    await pool.query(`DELETE FROM audit_log WHERE entity_type='production_order' AND entity_id = ANY($1::int[])`, [ids]).catch(() => {});
    for (const t of ['production_order_components', 'stock_reservations', 'production_order_lines', 'production_jobs'])
      await pool.query(`DELETE FROM ${t} WHERE production_order_id = ANY($1::int[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM production_orders WHERE id = ANY($1::int[])`, [ids]).catch(() => {});
  }
  const pids = (await pool.query(`SELECT id FROM products WHERE product_code LIKE $1`, [`${TAG}%`])).rows.map((r) => r.id);
  if (pids.length) {
    await pool.query(`DELETE FROM audit_log WHERE entity_type='product' AND entity_id = ANY($1::int[])`, [pids]).catch(() => {});
    await pool.query(`DELETE FROM transactions WHERE product_id = ANY($1::int[])`, [pids]).catch(() => {});
  }
  await pool.query(`DELETE FROM audit_log WHERE entity_name LIKE '#ZZ-F-%'`).catch(() => {});
  await pool.query(`DELETE FROM webhook_processed WHERE shopify_order_id BETWEEN 930001 AND 940006`).catch(() => {});
  await pool.query(`DELETE FROM product_bom WHERE product_type = $1`, [`${TAG}_M`]).catch(() => {});
  await pool.query(`DELETE FROM products WHERE product_code LIKE $1`, [`${TAG}%`]).catch(() => {});
  await pool.query(`DELETE FROM sa.transactions WHERE product_id LIKE $1`, [`${OIL_ID}%`]).catch(() => {});
  await pool.query(`DELETE FROM sa.products WHERE id LIKE $1`, [`${OIL_ID}%`]).catch(() => {});
  await pool.end();
}
process.exitCode = failed === 0 ? 0 : 1;
