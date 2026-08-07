// Proves a MUSE order born on the Shopify site becomes production work here.
//
// WHY THIS EXISTS (2026-08-07): with "The Atelier" the customer configures on
// the Muse site and the order lands in Shopify already assembled. Until now the
// orders/paid handler only LOOKED for a production order of ours and, finding
// none, logged NOT FOUND and did nothing — so nobody learned there was
// something to make. The stock half already worked (D16 consumes the BOM at
// fulfilment), the work queue did not.
//
// The contract this protects:
//   · need = ordered − finished stock decides what gets produced, with no
//     per-product make-to-order flag to keep in sync
//   · the order is born 'draft' with client_id NULL (→ MUSE segment), so the
//     coordinator reviews it before the warehouse sees it
//   · BOM components are built — an order that can start and debit nothing is
//     the dangling state validateProductTypes exists to prevent
//   · numbering stays on the ONE SM-### sequence (a second prefix would make
//     getNextOrderNumber emit SM-NaN forever)
//   · a line we cannot plan raises an alarm instead of silently shrinking
//   · Shopify redelivery does not create a second order
//
// Boots its own server on a spare port and uses only throwaway rows, including
// a disposable Fragrance Library oil — sa is production data.
//
// Run: node scripts/regression-shopify-order-ingest.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'regression-only-secret-not-a-real-key';
// products.sku is varchar(20) — keep the tag short enough that `${TAG}_V1` fits.
const TAG = `ZZI${String(Date.now()).slice(-7)}`;
const OIL_ID = `ZZOIL${String(Date.now()).slice(-8)}`;

if (!process.env.PLATFORM_DATABASE_URL) { console.error('PLATFORM_DATABASE_URL required.'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

let failed = 0, server, masterId, ethanolId, log = '';
const skuOf = (n) => `${TAG}_V${n}`;
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

// The receiver acks BEFORE processing, so assertions wait for the work.
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
const ordersFor = async (ref) => (await pool.query(
  `SELECT po.id, po.order_number, po.status, po.client_id, po.shopify_order_number
     FROM production_orders po WHERE po.notes LIKE $1`, [`%${ref}%`])).rows;
const linesOf = async (orderId) => (await pool.query(
  `SELECT product_type, quantity, oil_id, oil_pct FROM production_order_lines
    WHERE production_order_id = $1 ORDER BY line_number`, [orderId])).rows;

try {
  // ── Disposable catalogue: one oil, one component, one master, three variants
  await pool.query(
    `INSERT INTO sa.products (id, tag, name, category, "productCode", "currentStock", unit, status)
     VALUES ($1,$1,$2,'OILS',$1,50000,'mL','active')`, [OIL_ID, `[regression] Ingest Oil`]);

  ethanolId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, current_stock)
     VALUES ($1,$2,'RAW_MATERIAL','ml',100000) RETURNING id`,
    [`${TAG} ethanol`, `${TAG}_ETH`])).rows[0].id;

  masterId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, is_master, segment, current_stock, volume_ml, default_oil_pct)
     VALUES ($1,$2,'FINISHED_GOOD','units',true,'MUSE',0,200,25) RETURNING id`,
    [`${TAG} master`, `${TAG}_M`])).rows[0].id;

  await pool.query(
    `INSERT INTO product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
     VALUES ($1,$2,'ethanol_pct',0,0,'core',true)`, [`${TAG}_M`, ethanolId]);

  // v1 empty shelf · v2 fully covered · v3 partially covered
  for (const [n, stock] of [[1, 0], [2, 50], [3, 4]]) {
    await pool.query(
      `INSERT INTO products (name, product_code, sku, category, unit, master_product_id, segment, current_stock, oil_id)
       VALUES ($1,$2,$3,'FINISHED_GOOD','units',$4,'MUSE',$5,$6)`,
      [`${TAG} variant ${n}`, `${TAG}_V${n}`, skuOf(n), masterId, stock, OIL_ID]);
  }

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
  if (!up) throw new Error(`server did not boot\n${log.slice(-1500)}`);

  // ── 1. Empty shelf → produce the whole quantity ──────────────────────────
  {
    const ref = `#ZZ-MTO-${Date.now()}`;
    const r = await post('orders/paid', {
      id: 810001, name: ref,
      line_items: [{ title: 'Reed Diffuser', quantity: 6, sku: skuOf(1) }],
    });
    check(r.status === 200, 'orders/paid answers 200', `got ${r.status}`);
    const rows = await waitFor(() => ordersFor(ref), (x) => x.length > 0);
    check(rows.length === 1, 'a production order is created', `found ${rows.length}`);
    const o = rows[0];
    check(o?.status === 'draft', "it is born 'draft' for the office to review", `status=${o?.status}`);
    check(o?.client_id === null, 'client_id is NULL → resolveOrderSegment reads it as MUSE');
    check(/^SM-\d+$/.test(o?.order_number || ''), 'numbering stays on the SM- sequence (no SM-NaN)', o?.order_number);
    check(o?.shopify_order_number === ref, 'the Shopify identity is kept on the order', o?.shopify_order_number);

    const lines = await linesOf(o.id);
    check(lines.length === 1 && Number(lines[0].quantity) === 6, 'nothing on the shelf → produce all 6', JSON.stringify(lines));
    check(lines[0]?.oil_id === OIL_ID, "the line carries the variant's oil", lines[0]?.oil_id);
    const comps = await pool.query(
      `SELECT COUNT(*) n FROM production_order_components WHERE production_order_id = $1`, [o.id]);
    check(Number(comps.rows[0].n) > 0, 'BOM components were built (the order can actually debit)', `${comps.rows[0].n} components`);

    // Reservations belong to the queued transition, not to creation.
    const resv = await pool.query(
      `SELECT COUNT(*) n FROM stock_reservations WHERE production_order_id = $1`, [o.id]);
    check(Number(resv.rows[0].n) === 0, 'no reservations yet — those happen when it is queued', `${resv.rows[0].n}`);
  }

  // ── 2. Redelivery must not create a second order ─────────────────────────
  {
    const ref = `#ZZ-DUP-${Date.now()}`;
    const payload = { id: 810002, name: ref, line_items: [{ title: 'Reed Diffuser', quantity: 2, sku: skuOf(1) }] };
    await post('orders/paid', payload);
    await waitFor(() => ordersFor(ref), (x) => x.length > 0);
    await post('orders/paid', payload);
    await new Promise((r) => setTimeout(r, 2500));
    const rows = await ordersFor(ref);
    check(rows.length === 1, 'a redelivered order does not create a second production order', `found ${rows.length}`);
  }

  // ── 3. Enough on the shelf → nothing to produce ──────────────────────────
  {
    const ref = `#ZZ-SHELF-${Date.now()}`;
    await post('orders/paid', {
      id: 810003, name: ref,
      line_items: [{ title: 'From stock', quantity: 5, sku: skuOf(2) }],
    });
    await new Promise((r) => setTimeout(r, 3000));
    const rows = await ordersFor(ref);
    check(rows.length === 0, 'covered by finished stock → no production order at all', `found ${rows.length}`);
    check(/covered by finished stock/.test(log), 'and it says so in the log');
  }

  // ── 4. Partial stock → produce only the difference ───────────────────────
  {
    const ref = `#ZZ-PART-${Date.now()}`;
    await post('orders/paid', {
      id: 810004, name: ref,
      line_items: [{ title: 'Partial', quantity: 10, sku: skuOf(3) }], // 4 on the shelf
    });
    const rows = await waitFor(() => ordersFor(ref), (x) => x.length > 0);
    const lines = rows[0] ? await linesOf(rows[0].id) : [];
    check(lines.length === 1 && Number(lines[0].quantity) === 6, '10 ordered − 4 on the shelf → produce 6', JSON.stringify(lines));
  }

  // ── 5. A line we cannot plan alarms, and the rest still gets made ────────
  {
    const ref = `#ZZ-MIX-${Date.now()}`;
    await post('orders/paid', {
      id: 810005, name: ref,
      line_items: [
        { title: 'Real', quantity: 3, sku: skuOf(1) },
        { title: 'Graphic design service', quantity: 1, sku: '' },
        { title: 'Ghost', quantity: 2, sku: 'ZZ_NO_SUCH_SKU' },
      ],
    });
    const rows = await waitFor(() => ordersFor(ref), (x) => x.length > 0);
    const lines = rows[0] ? await linesOf(rows[0].id) : [];
    check(lines.length === 1 && Number(lines[0].quantity) === 3, 'the plannable line is still produced', JSON.stringify(lines));
    const alarm = await waitFor(
      async () => (await pool.query(
        `SELECT details FROM audit_log WHERE action = 'shopify_order_unmatched' AND entity_name = $1`, [ref])).rows,
      (x) => x.length > 0);
    check(alarm.length === 1, 'the unplannable lines raise an alarm', `${alarm.length} rows`);
    const reasons = (alarm[0]?.details?.unmatched || []).map((u) => u.reason).sort();
    check(JSON.stringify(reasons) === JSON.stringify(['no_sku', 'sku_not_found']),
      'the alarm names both reasons', JSON.stringify(reasons));
  }

  // ── 6. A cancellation for an order we never had is a no-op ───────────────
  {
    const ref = `#ZZ-CANCEL-${Date.now()}`;
    const r = await post('orders/cancelled', {
      id: 810006, name: ref, line_items: [{ title: 'Reed Diffuser', quantity: 1, sku: skuOf(1) }],
    });
    check(r.status === 200, 'an unmatched cancellation still answers 200', `got ${r.status}`);
    await new Promise((s) => setTimeout(s, 2500));
    check((await ordersFor(ref)).length === 0, 'an unmatched cancellation creates nothing');
  }

  console.log(failed === 0
    ? `\n✅ shopify-order-ingest: all checks passed`
    : `\n❌ shopify-order-ingest: ${failed} failed`);
} catch (e) {
  console.error(`\n❌ shopify-order-ingest: ${e.message}`);
  failed++;
} finally {
  // The receiver acks before it works, so a failure's cause only ever shows up
  // in the server log — print it rather than making the next person reproduce.
  if (failed > 0) {
    const lines = log.split('\n').filter((l) => /muse-order|webhook|rror/i.test(l)).slice(-25);
    console.log(`\n─── server log (tail) ───\n${lines.join('\n') || '(nothing matched)'}`);
  }
  if (server) server.kill();
  // Order matters: components and lines reference the orders.
  const ids = (await pool.query(`SELECT id FROM production_orders WHERE notes LIKE $1`, [`%#ZZ-%`])).rows.map((r) => r.id);
  if (ids.length) {
    await pool.query(`DELETE FROM production_order_components WHERE production_order_id = ANY($1::int[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM stock_reservations WHERE production_order_id = ANY($1::int[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM production_order_lines WHERE production_order_id = ANY($1::int[])`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM production_orders WHERE id = ANY($1::int[])`, [ids]).catch(() => {});
  }
  await pool.query(`DELETE FROM audit_log WHERE action IN ('shopify_order_ingested','shopify_order_unmatched') AND entity_name LIKE '#ZZ-%'`).catch(() => {});
  await pool.query(`DELETE FROM webhook_processed WHERE shopify_order_id BETWEEN 810001 AND 810006`).catch(() => {});
  await pool.query(`DELETE FROM product_bom WHERE product_type = $1`, [`${TAG}_M`]).catch(() => {});
  await pool.query(`DELETE FROM products WHERE product_code LIKE $1`, [`${TAG}%`]).catch(() => {});
  await pool.query(`DELETE FROM sa.transactions WHERE product_id = $1`, [OIL_ID]).catch(() => {});
  await pool.query(`DELETE FROM sa.products WHERE id = $1`, [OIL_ID]).catch(() => {});
  await pool.end();
}
process.exitCode = failed === 0 ? 0 : 1;
