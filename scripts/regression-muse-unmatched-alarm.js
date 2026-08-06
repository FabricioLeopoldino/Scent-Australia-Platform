// Proves a MUSE fulfillment line that moves no stock raises an alarm instead of
// vanishing.
//
// WHY THIS EXISTS (2026-08-06): `smFulfillmentHandler` joins Shopify to the
// platform on the SKU alone — `if (!sku) continue`. When marketing rebuilt the
// Muse catalogue by hand they created every variant WITHOUT a SKU, so a sale
// would have shipped, been invoiced, and moved no stock at all, with nothing
// written anywhere. The SKUs were backfilled on 2026-08-06, but the hole in the
// code remained: any future variant created without one repeats it silently.
//
// Two failure modes are covered:
//   · no_sku        — the line carries no SKU at all
//   · sku_not_found — a SKU that matches nothing in the catalogue
// Both must log an error AND leave an `muse_fulfillment_unmatched` row in the
// audit log, where the office can see it on the Activity page.
//
// It also asserts the alarm does NOT fire on a clean fulfillment — an alarm
// that cries wolf gets ignored, which would be worse than none.
//
// Read-only against real data: it uses a throwaway product it creates and
// removes, and asserts no other stock moved.
//
// Run: node scripts/regression-muse-unmatched-alarm.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'regression-only-secret-not-a-real-key';
const TAG = `ZZTEST_${Date.now()}`;

if (!process.env.PLATFORM_DATABASE_URL) { console.error('PLATFORM_DATABASE_URL required.'); process.exit(1); }
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

const audits = async (order) => (await pool.query(
  `SELECT action, details FROM audit_log WHERE action = 'muse_fulfillment_unmatched' AND entity_name = $1`,
  [order])).rows;

// The receiver answers 200 BEFORE it processes (webhooks.js:224 — a deliberate
// early ack so Shopify never retries a fulfillment that is already in flight).
// So every assertion has to wait for the work, not for the response.
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
const stockOf = async () => Number(
  (await pool.query(`SELECT current_stock FROM products WHERE id = $1`, [productId])).rows[0].current_stock);

try {
  // Disposable finished good so the clean-fulfillment case has something real
  // to deduct without touching any catalogue product.
  const ins = await pool.query(
    `INSERT INTO products (name, product_code, sku, category, unit, current_stock)
     VALUES ($1,$2,$3,'FINISHED_GOODS','units',50) RETURNING id`,
    [`${TAG} probe`, TAG, TAG]);
  productId = ins.rows[0].id;

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

  // ── 1. A line with NO SKU must alarm ─────────────────────────────────────
  {
    const order = `#ZZ-NOSKU-${Date.now()}`;
    const r = await post('fulfillments/create', {
      id: Date.now(), order_id: 90001, name: order, status: 'success',
      line_items: [{ title: 'Phantom Reed Diffuser', quantity: 3, sku: '' }],
    });
    check(r.status === 200, 'no-SKU line still answers 200 (Shopify must not retry)', `got ${r.status}`);
    const rows = await waitFor(() => audits(order), (x) => x.length > 0);
    check(rows.length === 1, 'no-SKU line writes an unmatched alarm to the audit log', `found ${rows.length}`);
    const u = rows[0]?.details?.unmatched?.[0];
    check(u?.reason === 'no_sku' && u?.qty === 3, 'alarm records reason and quantity', JSON.stringify(u));
    check(/STOCK NOT DEDUCTED/.test(log), 'alarm is logged loudly as an error');
  }

  // ── 2. An unknown SKU must alarm too ─────────────────────────────────────
  {
    const order = `#ZZ-BADSKU-${Date.now()}`;
    const r = await post('fulfillments/create', {
      id: Date.now() + 1, order_id: 90002, name: order, status: 'success',
      line_items: [{ title: 'Ghost', quantity: 1, sku: 'Muse_DOES_NOT_EXIST' }],
    });
    check(r.status === 200, 'unknown-SKU line answers 200', `got ${r.status}`);
    const rows = await waitFor(() => audits(order), (x) => x.length > 0);
    check(rows[0]?.details?.unmatched?.[0]?.reason === 'sku_not_found',
      'unknown SKU is recorded as sku_not_found', JSON.stringify(rows[0]?.details?.unmatched));
  }

  // ── 3. A clean fulfillment must NOT alarm ────────────────────────────────
  //     An alarm that fires on healthy traffic gets ignored, which is worse
  //     than having none at all.
  {
    const order = `#ZZ-CLEAN-${Date.now()}`;
    const r = await post('fulfillments/create', {
      id: Date.now() + 2, order_id: 90003, name: order, status: 'success',
      line_items: [{ title: `${TAG} probe`, quantity: 2, sku: TAG }],
    });
    check(r.status === 200, 'clean fulfillment answers 200', `got ${r.status}`);
    // Wait for the POSITIVE signal (stock moved) before asserting the NEGATIVE
    // one (no alarm) — otherwise "no alarm yet" would pass for the wrong reason.
    const after = await waitFor(stockOf, (s) => s !== 50);
    check(after === 48, 'clean fulfillment still deducts stock (50 → 48)', `got ${after}`);
    const rows = await audits(order);
    check(rows.length === 0, 'clean fulfillment raises NO alarm', `found ${rows.length}`);
  }

  console.log(failed === 0
    ? `\n✅ muse-unmatched-alarm: all checks passed`
    : `\n❌ muse-unmatched-alarm: ${failed} failed`);
} catch (e) {
  console.error(`\n❌ muse-unmatched-alarm: ${e.message}`);
  failed++;
} finally {
  if (server) { server.stdout?.destroy(); server.stderr?.destroy(); server.kill(); }
  // Restore: remove the probe and every row this run created.
  if (productId) {
    await pool.query(`DELETE FROM transactions WHERE product_id = $1`, [productId]).catch(() => {});
    await pool.query(`DELETE FROM products WHERE id = $1`, [productId]).catch(() => {});
  }
  await pool.query(`DELETE FROM audit_log WHERE entity_name LIKE '#ZZ-%'`).catch(() => {});
  await pool.query(`DELETE FROM webhook_processed WHERE shopify_order_id IN (90001,90002,90003)`).catch(() => {});
  await pool.end();
}
process.exitCode = failed === 0 ? 0 : 1;
