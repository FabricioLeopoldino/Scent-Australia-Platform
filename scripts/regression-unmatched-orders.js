// Proves an order the platform could not read reaches a human.
//
// WHY THIS EXISTS (2026-08-24). Ingestion matches every Shopify line by SKU. A
// line with no SKU, or a SKU that is not in the catalogue, cannot be turned into
// work — so it is dropped from the plan and an alarm is written to the audit
// log. The alarm has been written since the store opened. Nothing ever read it.
//
// Between 18 and 20 August, orders #1024 to #1028 arrived carrying nine such
// lines — 2,186 units, including 500 Coco Republic candles and 100 Sherridon
// Homes gift boxes. Four of the five produced no production order at all. The
// fifth, #1024, produced a ONE-unit order against a 501-unit basket, which is
// the worse shape: it looks finished. They were marketing tests, and they were
// found only because the morning check noticed the production-order count had
// moved by one.
//
// This will keep happening: marketing is building the B2B range on the store,
// and those products are going up without SKUs.
//
// The chain proved here, end to end:
//   paid, line has no SKU        → no work raised, but an audit alarm
//                                → the order appears on /dashboard/unmatched-orders
//   part of the order DID match  → the list says so, and names the short order
//   somebody marks it handled    → it leaves the list, and WHY is recorded
//   the fulfilment path          → keyed on order_id, not shopify_order_id,
//                                  and is read too
//
// That last one is the trap. The two writers disagree on the key: the order
// webhook writes details->shopify_order_id, the fulfilment webhook writes
// details->order_id. Reading one and calling it done is the same mistake that
// would have left cancelled orders on the awaiting-shipment list forever.
//
// Creates nothing it does not remove. Cleans its own webhook_processed rows —
// those are what live-store-guard.cjs reads to decide the store is live.
//
// Run: node scripts/regression-unmatched-orders.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'regression-only-secret-not-a-real-key';
const STAMP = Date.now();
const SHORT = String(STAMP).slice(-8);         // product_code is varchar(20)
const TAG = `ZZUNRD_${SHORT}`;
const ORDER_ID = STAMP % 2147480000;           // unique, and never a real Shopify id
const ORDER_REF = `#ZZ-UNREAD-${SHORT}`;
const FULFIL_REF = `#ZZ-UNREAD-F-${SHORT}`;
const FULFIL_ID = (STAMP % 2147480000) + 7;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

let failed = 0, server, productId, token;
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

// Asserted through HTTP, not by repeating the query: a panel that renders
// nothing because the route 500s is exactly the failure this guards against.
const listUnread = async () => {
  const r = await fetch(`${BASE}/api/sm/dashboard/unmatched-orders`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`unmatched-orders returned HTTP ${r.status}`);
  return r.json();
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

try {
  // A real master, or ingestion refuses the matched line before it ever gets to
  // the unmatched one — and then the partial case below proves nothing.
  const master = (await pool.query(
    `SELECT id FROM products WHERE product_code = 'RS100' AND is_master = true`)).rows[0];
  if (!master) throw new Error('master RS100 not found — cannot build a realistic fixture');
  productId = (await pool.query(
    `INSERT INTO products (name, product_code, sku, category, unit, current_stock, segment, master_product_id)
     VALUES ($1, $2, $3, 'FINISHED_GOOD', 'units', 0, 'MUSE', $4) RETURNING id`,
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

  const jwt = (await import('jsonwebtoken')).default;
  token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SM', 'MUSE'] },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });

  // ── 1. The half-read order — the shape of #1024 ──────────────────────────
  // One line the platform understands, two it does not. This is the dangerous
  // one: a production order exists, so every screen says the order is handled.
  const r = await post('orders/paid', {
    id: ORDER_ID, name: ORDER_REF, financial_status: 'paid',
    line_items: [
      { sku: TAG, quantity: 1, title: `${TAG} probe`, variant_title: 'Adventure' },
      { quantity: 250, title: 'Room Spray', price: '22.00', variant_title: 'Adventure',
        properties: [{ name: 'Fragrance', value: 'Adventure' },
                     { name: '_CustomizerSource', value: 'fragrance-customizer' }] },
      { sku: `${TAG}_NOPE`, quantity: 40, title: 'Something not in the catalogue' },
    ],
  });
  check(r.status === 200, 'orders/paid answers 200', `got ${r.status}`);

  const seen = await waitFor(listUnread, (x) => x.some((o) => o.order_ref === ORDER_REF));
  const row = seen.find((o) => o.order_ref === ORDER_REF);
  check(!!row, 'an order with unreadable lines reaches the dashboard');
  check((row?.lines || []).length === 2, 'both unreadable lines are listed',
    `got ${(row?.lines || []).length}`);

  const noSku = (row?.lines || []).find((l) => l.reason === 'no_sku');
  check(noSku?.qty === 250, 'the quantity is the real one, not the matched line',
    `qty=${noSku?.qty}`);
  check(noSku?.title === 'Room Spray', 'and what was sold, so it can be raised by hand');
  // Personalisation rides in properties; without it a custom order cannot be made.
  check((noSku?.properties || []).some((p) => p.name === 'Fragrance' && p.value === 'Adventure'),
    'personalisation survives to the screen');
  check((row?.lines || []).some((l) => l.reason === 'sku_not_found' && l.sku === `${TAG}_NOPE`),
    'a SKU that is not in the catalogue is reported differently from no SKU at all');

  // The trap: part of it DID become work, so the screen must say so out loud.
  check(!!row?.production_order_number,
    'a partly-read order names the production order it created',
    JSON.stringify(row?.production_order_number));

  // ── 2. The fulfilment path, which keys the order differently ─────────────
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
     VALUES (NULL, 'muse_fulfillment_unmatched', 'product', NULL, $1, $2::jsonb)`,
    [FULFIL_REF, JSON.stringify({
      fulfillment_id: FULFIL_ID, order_id: String(FULFIL_ID), shopify_order: FULFIL_REF,
      unmatched: [{ reason: 'no_sku', title: 'Shipped something we cannot name', qty: 3 }],
    })]);
  const both = await listUnread();
  check(both.some((o) => o.order_ref === FULFIL_REF),
    'the fulfilment alarm is read too, despite keying the order as order_id');

  // ── 3. Marking it handled clears it, and records why ─────────────────────
  const res = await fetch(`${BASE}/api/sm/dashboard/unmatched-orders/${ORDER_ID}/resolve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'marketing test' }),
  });
  check(res.ok, 'it can be marked handled', `HTTP ${res.status}`);

  const after = await listUnread();
  check(!after.some((o) => o.order_ref === ORDER_REF), 'and it leaves the list');
  check(after.some((o) => o.order_ref === FULFIL_REF),
    'clearing one does not clear the others');

  const cleared = (await pool.query(
    `SELECT user_id, details FROM audit_log
      WHERE action = 'shopify_order_unmatched_resolved' AND entity_name = $1`, [ORDER_REF])).rows[0];
  check(!!cleared, 'the decision is itself recorded, not a silent delete');
  check(cleared?.details?.note === 'marketing test', 'including the reason given',
    JSON.stringify(cleared?.details?.note));
  check(cleared?.user_id === 8, 'and who gave it', `user_id=${cleared?.user_id}`);

  // The alarm survives the clearing. Deleting it would erase the evidence that
  // the order was ever mis-read.
  const alarmStillThere = Number((await pool.query(
    `SELECT count(*) c FROM audit_log WHERE action = 'shopify_order_unmatched' AND entity_name = $1`,
    [ORDER_REF])).rows[0].c);
  check(alarmStillThere === 1, 'the original alarm is kept, not deleted', `found ${alarmStillThere}`);

  // ── 4. Resolving something that was never reported is refused ────────────
  const bogus = await fetch(`${BASE}/api/sm/dashboard/unmatched-orders/99999999999/resolve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'x' }),
  });
  check(bogus.status === 404, 'clearing an order that was never flagged is refused',
    `HTTP ${bogus.status}`);

  // ── 5. It needs a login ──────────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/sm/dashboard/unmatched-orders`);
  check(anon.status === 401 || anon.status === 403,
    'the list is not readable without a login', `HTTP ${anon.status}`);

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /muse-order|muse-fulfil|webhook|rror/i.test(l)).slice(-14).join('\n'));
  }
  console.log(failed === 0 ? '\n✅ unmatched-orders: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  // Production orders first: the fixture product cannot go while lines point at it.
  let orders = [];
  try {
    orders = (await pool.query(
      `SELECT id FROM production_orders WHERE shopify_order_number = $1`, [ORDER_REF])
    ).rows.map((o) => o.id);
  } catch { /* nothing to clean */ }
  for (const id of orders) {
    await pool.query('DELETE FROM production_order_components WHERE production_order_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM production_order_lines WHERE production_order_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM production_orders WHERE id = $1', [id]).catch(() => {});
  }
  if (productId) {
    await pool.query('DELETE FROM transactions WHERE product_id = $1', [productId]).catch(() => {});
    await pool.query('DELETE FROM products WHERE id = $1', [productId]).catch(() => {});
  }
  await pool.query(`DELETE FROM audit_log WHERE entity_name LIKE '#ZZ-UNREAD-%'`).catch(() => {});
  await pool.query(`DELETE FROM webhook_processed WHERE shopify_order_id = ANY($1::bigint[])`,
    [[ORDER_ID, FULFIL_ID]]).catch(() => {});
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
