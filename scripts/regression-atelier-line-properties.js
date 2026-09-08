// Proves a matched Atelier line keeps what the customer actually asked for.
//
// WHY THIS EXISTS (2026-09-09). "Metallic Foil" and "Finishing touch" ride on
// a Shopify line as PROPERTIES, never as their own SKU — order #1024 showed
// "Standard" and "Metallic foil" sharing one variant_id, and the owner
// confirmed the business fact behind that: foil is applied to the label and
// packaging by whoever prints them, never a different vessel. There was never
// going to be a "metallic component" to mis-consume.
//
// The real bug was narrower and worse: a MATCHED line (has a SKU, so it never
// touches the unmatched-orders alarm) dropped every property on the way into
// production_order_lines. Only an unmatched line kept them, and only because
// they ride in the alarm row nobody reads for this. Once the Atelier's
// customiser variants get real SKUs, this is the path every one of them takes.
//
// Proves: a matched line's properties reach production_order_lines.
// customer_properties; an internal key (leading _, e.g. _CustomizerSource) is
// still stored (so nothing is silently dropped at write time) but the UI
// helper filters it, since that key was never the customer's own choice; a
// line with no properties at all still creates cleanly with a null column.
//
// Creates one disposable master-linked product with a SKU (so the line is
// MATCHED, the case that was broken) and tears everything down after.
//
// Run: node scripts/regression-atelier-line-properties.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'regression-only-secret-not-a-real-key';
const STAMP = Date.now();
const SHORT = String(STAMP).slice(-8);
const TAG = `ZZATLR_${SHORT}`;
const ORDER_ID = STAMP % 2147480000;
const ORDER_REF = `#ZZ-ATELIER-${SHORT}`;
const NO_PROPS_REF = `#ZZ-ATELIER-NP-${SHORT}`;
const NO_PROPS_ID = ORDER_ID + 1;

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
  // A real master, or the line is refused before it ever proves anything — the
  // same fixture shape regression-unmatched-orders.js uses for the matched half
  // of #1024.
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
  // 3 minutes: a cold Neon connection has taken longer than 90×500ms before.
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1500)}`);

  token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SM', 'MUSE'] },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });

  console.log('\n1. A matched line carrying the customer\'s choices');
  const r = await post('orders/paid', {
    id: ORDER_ID, name: ORDER_REF, financial_status: 'paid',
    line_items: [{
      sku: TAG, quantity: 1, title: `${TAG} probe`, variant_title: 'Adventure',
      properties: [
        { name: 'Fragrance', value: 'Adventure' },
        { name: 'Finishing touch', value: 'Metallic foil — label + packaging' },
        { name: 'Metallic Foil', value: 'Yes' },
        { name: '_CustomizerSource', value: 'fragrance-customizer' },
      ],
    }],
  });
  check(r.status === 200, 'orders/paid answers 200', `got ${r.status}`);

  const lineWithProps = await waitFor(
    () => pool.query(
      `SELECT pol.customer_properties FROM production_order_lines pol
         JOIN production_orders po ON po.id = pol.production_order_id
        WHERE po.shopify_order_number = $1`, [ORDER_REF]).then((r) => r.rows[0]),
    (row) => !!row);
  check(!!lineWithProps, 'the matched line produced a production order at all');

  const props = Array.isArray(lineWithProps?.customer_properties) ? lineWithProps.customer_properties : [];
  check(props.length === 4, 'every property survived to production_order_lines', `got ${props.length}`);
  check(props.some((p) => p.name === 'Metallic Foil' && p.value === 'Yes'),
    'Metallic Foil is one of them');
  check(props.some((p) => p.name === 'Finishing touch' && p.value.includes('—')),
    'Finishing touch keeps its em dash, not a hyphen substituted in');
  check(props.some((p) => p.name === '_CustomizerSource'),
    'the internal key is stored too — filtering it is the display\'s job, not ingestion\'s');

  console.log('\n2. A line with no properties still creates cleanly');
  const r2 = await post('orders/paid', {
    id: NO_PROPS_ID, name: NO_PROPS_REF, financial_status: 'paid',
    line_items: [{ sku: TAG, quantity: 1, title: `${TAG} probe`, variant_title: 'Adventure' }],
  });
  check(r2.status === 200, 'orders/paid answers 200 for the plain line', `got ${r2.status}`);
  const plainLine = await waitFor(
    () => pool.query(
      `SELECT pol.customer_properties FROM production_order_lines pol
         JOIN production_orders po ON po.id = pol.production_order_id
        WHERE po.shopify_order_number = $1`, [NO_PROPS_REF]).then((r) => r.rows[0]),
    (row) => !!row);
  check(!!plainLine, 'the plain line produced a production order too');
  check(plainLine?.customer_properties === null, 'and its column is null, not an empty artifact',
    JSON.stringify(plainLine?.customer_properties));

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /muse-order|webhook|rror/i.test(l)).slice(-14).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ atelier-line-properties: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  let orders = [];
  try {
    orders = (await pool.query(
      `SELECT id FROM production_orders WHERE shopify_order_number = ANY($1::text[])`,
      [[ORDER_REF, NO_PROPS_REF]])).rows.map((o) => o.id);
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
  // NOT entity_name: the matched path's own audit row (shopify_order_ingested)
  // names the SM order number it minted (e.g. "SM-009"), never the #ZZ-ATELIER
  // ref — code review caught this leaving rows behind on every run. The ref
  // does survive, in details->>'shopify_order', which is what the row is
  // actually keyed by everywhere else in this file.
  await pool.query(
    `DELETE FROM audit_log WHERE details->>'shopify_order' = ANY($1::text[])`,
    [[ORDER_REF, NO_PROPS_REF]]).catch(() => {});
  await pool.query(`DELETE FROM webhook_processed WHERE shopify_order_id = ANY($1::bigint[])`,
    [[ORDER_ID, NO_PROPS_ID]]).catch(() => {});
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
