// Proves a paid order that needs nothing MADE still reaches a human.
//
// WHY THIS EXISTS (2026-08-18). Order ingestion asks "is it on the shelf?" to
// decide whether to create production work. When the answer is yes there is
// genuinely nothing to manufacture — but somebody still has to pick the goods
// and post them, and that branch was a console.log and nothing else.
//
// Order #1022 (Daniel Edwards, paid Sunday 17 August, one Adventure Room Spray)
// left exactly ONE row in the entire platform — in webhook_processed — and
// appeared on no screen. It was found two days later because a Monday check
// noticed a webhook that had moved no stock. The owner's question was the right
// one: "why doesn't the Muse order show in Production and Operations?" It did
// not show anywhere.
//
// This gets worse as the range holds more finished stock, which is the plan for
// the Library: the more they hold, the more orders take this silent path.
//
// The chain proved here, end to end:
//   paid + covered by stock  → no production order, but an audit row
//                            → the order appears on /dashboard/awaiting-shipment
//   fulfilled                → it leaves that list
//
// Uses a disposable product it creates and removes. Cleans up its own
// webhook_processed rows — leaving those behind is not tidy-up pedantry, they
// are what live-store-guard.cjs reads to decide the store is live.
//
// Run: node scripts/regression-awaiting-shipment.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'regression-only-secret-not-a-real-key';
const TAG = `ZZSHIP_${Date.now()}`;
const ORDER_ID = Date.now() % 2147480000;      // unique, and never a real Shopify id
const ORDER_REF = `#ZZ-SHIP-${Date.now()}`;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

let failed = 0, server, productId;
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

// The receiver acks before it finishes, so every assertion waits for the work.
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
const awaiting = async () => (await pool.query(
  `SELECT r.entity_name, r.details FROM audit_log r
    WHERE r.action = 'shopify_order_ready_to_ship'
      AND r.details->>'shopify_order_id' = $1
      AND NOT EXISTS (
        SELECT 1 FROM audit_log f
         WHERE f.action IN ('muse_fulfillment_sale', 'shopify_order_cancelled')
           AND COALESCE(f.details->>'order_id', f.details->>'shopify_order_id') = r.details->>'shopify_order_id')`,
  [String(ORDER_ID)])).rows;

try {
  // A disposable finished good WITH stock, so the order is covered by the shelf.
  //
  // It MUST hang off a real master. The first version of this created a bare
  // product and the suite failed with `no_master` — correctly: a variant with no
  // master has no bill of materials, so ingestion refuses it before it ever asks
  // about stock. Every real MUSE variant has one, so a fixture without one was
  // testing a state that cannot occur.
  const master = (await pool.query(
    `SELECT id FROM products WHERE product_code = 'RS100' AND is_master = true`)).rows[0];
  if (!master) throw new Error('master RS100 not found — cannot build a realistic fixture');
  productId = (await pool.query(
    `INSERT INTO products (name, product_code, sku, category, unit, current_stock, segment, master_product_id)
     VALUES ($1, $2, $3, 'FINISHED_GOOD', 'units', 5, 'MUSE', $4) RETURNING id`,
    [`${TAG} probe`, TAG, TAG, master.id])).rows[0].id;

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test',
      SM_SHOPIFY_WEBHOOK_SECRET: SECRET, MUSE_SHOPIFY_WEBHOOK_SECRET: SECRET,
      SM_SHOPIFY_API_SECRET: '', MUSE_SHOPIFY_API_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1500)}`);

  const ordersBefore = Number((await pool.query('SELECT count(*) c FROM production_orders')).rows[0].c);

  // ── 1. Paid, and the shelf covers it ─────────────────────────────────────
  const r = await post('orders/paid', {
    id: ORDER_ID, name: ORDER_REF, financial_status: 'paid',
    line_items: [{ sku: TAG, quantity: 2, title: `${TAG} probe` }],
  });
  check(r.status === 200, 'orders/paid answers 200', `got ${r.status}`);

  const rows = await waitFor(awaiting, (x) => x.length > 0);
  check(rows.length === 1, 'a shelf-covered order writes an audit row', `found ${rows.length}`);
  check(rows[0]?.entity_name === ORDER_REF, 'the row carries the order reference');
  const line = rows[0]?.details?.lines?.[0];
  check(line?.sku === TAG && line?.qty === 2,
    'and what has to be picked, so the warehouse knows', JSON.stringify(line));

  // The whole point: no production work was invented for goods already made.
  const ordersAfter = Number((await pool.query('SELECT count(*) c FROM production_orders')).rows[0].c);
  check(ordersAfter === ordersBefore, 'no production order is created', `${ordersBefore} → ${ordersAfter}`);

  // ── 2. It is visible through the endpoint the dashboard reads ────────────
  // Asserted through HTTP, not by repeating the query: a card that renders
  // nothing because the route 500s is the failure this is guarding against.
  const jwt = (await import('jsonwebtoken')).default;
  const token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SM', 'MUSE'] },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '5m' });
  const api = await fetch(`${BASE}/api/sm/dashboard/awaiting-shipment`,
    { headers: { Authorization: `Bearer ${token}` } });
  check(api.ok, 'the dashboard endpoint answers', `HTTP ${api.status}`);
  const list = api.ok ? await api.json() : [];
  check(list.some((o) => o.order_ref === ORDER_REF), 'and lists the order');

  // ── 3. Shipping it clears the list ───────────────────────────────────────
  await post('fulfillments/create', {
    id: ORDER_ID + 1, order_id: ORDER_ID, status: 'success', name: `${ORDER_REF}.1`,
    line_items: [{ sku: TAG, quantity: 2 }],
  });
  const after = await waitFor(awaiting, (x) => x.length === 0);
  check(after.length === 0, 'once shipped it leaves the waiting list', `still ${after.length}`);
  const stock = Number((await pool.query(
    'SELECT current_stock FROM products WHERE id = $1', [productId])).rows[0].current_stock);
  check(stock === 3, 'and the shelf actually moved (5 → 3)', `stock=${stock}`);

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /muse-order|muse-fulfil|webhook|rror/i.test(l)).slice(-14).join('\n'));
  }
  console.log(failed === 0 ? '\n✅ awaiting-shipment: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  if (productId) {
    await pool.query('DELETE FROM transactions WHERE product_id = $1', [productId]).catch(() => {});
    await pool.query('DELETE FROM products WHERE id = $1', [productId]).catch(() => {});
  }
  await pool.query(`DELETE FROM audit_log WHERE entity_name LIKE '#ZZ-SHIP-%'`).catch(() => {});
  await pool.query(`DELETE FROM webhook_processed WHERE shopify_order_id = ANY($1::bigint[])`,
    [[ORDER_ID, ORDER_ID + 1]]).catch(() => {});
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
