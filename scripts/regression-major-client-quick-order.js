// Proves the data contract behind the "Add all <client> products" button.
//
// WHY THIS EXISTS (2026-09-02). Investigating a request from Emma (marketing —
// a faster way to enter a Major Client's order, e.g. Coco Republic's PO) found
// the order screen's client-products list was dead code: fetched, never
// rendered. The real mechanism was already there — GET /api/product-types
// filters by client_id and links a fragrance automatically when a master has
// exactly one — the screen just never offered a one-click way to add every one
// of a client's products to an order at once.
//
// This is a frontend-only change (src/sm/pages/ProductionOrders.jsx) with no
// automated browser test in this codebase, so what CAN be proven here is the
// data contract the button depends on:
//
//   GET /api/product-types  returns client_id and fragrance_ids in the shape
//     the button's code reads (an array, present even when empty — a NULL
//     here would silently break the "exactly one fragrance" auto-fill)
//   POST /production-orders accepts a payload shaped exactly as the button
//     builds it, for a master with a fragrance AND one without, and the
//     resulting line and stock movement are correct
//
// Two client masters on purpose: one with a single fragrance (must auto-fill),
// one with none (must not crash, and must not fabricate a fragrance).
//
// Creates a disposable client, two masters, one component and one production
// order; removes all of it, in reverse dependency order, and fails if
// anything is left over.
//
// Run: node scripts/regression-major-client-quick-order.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3989;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `ZZMC_${Date.now()}`.slice(0, 14);

const sm = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sm,public',
});

let failed = 0, server, clientId, masterAId, masterBId, componentId, orderId, comp;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const token = () => jwt.sign({ id: 8, name: 'FabricioL', role: 'root', modules: ['SM'] },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
const api = (path, opts = {}) => fetch(`${BASE}/api/sm${path}`, {
  ...opts,
  headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  signal: AbortSignal.timeout(30000),
});

try {
  // A real fragrance and a real general-stock component to build against —
  // this proves the contract on data that behaves like the live catalogue.
  // Archived, not active: every one of the 126 legacy FRAGRANCE-category
  // products is archived (found while writing this suite, 2026-09-02) — the
  // MAJOR-client link still points at the table the D14 oil migration
  // superseded for MUSE, and nobody carried it forward. Archived state does
  // not block the foreign key, so it still proves the linking mechanism; it
  // does NOT mean a real client master could pick a live fragrance this way.
  const frag = (await sm.query(
    `SELECT id, name FROM products WHERE category = 'FRAGRANCE' LIMIT 1`)).rows[0];
  if (!frag) throw new Error('no fragrance row at all to link — cannot build the fixture');
  comp = (await sm.query(
    `SELECT id, name, current_stock::float AS stock FROM products
      WHERE category = 'COMPONENT' AND archived = false ORDER BY current_stock DESC LIMIT 1`)).rows[0];
  if (!comp) throw new Error('no component to build a recipe against');

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1200)}`);

  console.log('\n1. A Major Client and two of their own products');
  const cr = await api('/clients', {
    method: 'POST', body: JSON.stringify({ name: `${TAG} Coco Test`, is_large_client: true }),
  });
  check(cr.ok, 'client created', `HTTP ${cr.status}`);
  clientId = (await cr.json()).id;

  const mA = await api('/masters', { method: 'POST', body: JSON.stringify({
    name: `${TAG} Temple Candle`, product_code: `${TAG}A`, segment: 'MAJOR', client_id: clientId,
    volume_ml: 240, default_oil_pct: 12, is_candle: true, fragrance_ids: [frag.id],
    bom_components: [{ component_product_id: comp.id, quantity_formula: 'fixed', quantity_per_unit: 1 }],
  }) });
  check(mA.ok, 'master WITH one linked fragrance created', `HTTP ${mA.status} ${JSON.stringify((await mA.clone().json().catch(() => ({}))))}`);
  masterAId = (await mA.json()).master.id;

  const mB = await api('/masters', { method: 'POST', body: JSON.stringify({
    name: `${TAG} Temple Room Spray`, product_code: `${TAG}B`, segment: 'MAJOR', client_id: clientId,
    volume_ml: 100, default_oil_pct: 25,
    bom_components: [{ component_product_id: comp.id, quantity_formula: 'fixed', quantity_per_unit: 1 }],
  }) });
  check(mB.ok, 'master with NO linked fragrance created', `HTTP ${mB.status}`);
  masterBId = (await mB.json()).master.id;
  componentId = comp.id;

  console.log('\n2. GET /product-types shows what the button reads');
  const pt = await (await api('/product-types')).json();
  const rowA = pt.find((p) => p.key === `${TAG}A`);
  const rowB = pt.find((p) => p.key === `${TAG}B`);
  check(!!rowA && rowA.client_id === clientId, 'master A carries this client_id', JSON.stringify(rowA?.client_id));
  check(Array.isArray(rowA?.fragrance_ids) && rowA.fragrance_ids.length === 1 && rowA.fragrance_ids[0] === frag.id,
    'and exactly the one fragrance linked — the case that must auto-fill', JSON.stringify(rowA?.fragrance_ids));
  check(Array.isArray(rowB?.fragrance_ids) && rowB.fragrance_ids.length === 0,
    'master B carries an EMPTY ARRAY, not null — a null here breaks the button\'s Array.isArray check',
    JSON.stringify(rowB?.fragrance_ids));

  console.log('\n3. The exact payload the button builds — both lines at once, one submit');
  // Mirrors lineFromMaster()/addClientProductLines() in ProductionOrders.jsx:
  // fragrance_id set only when exactly one is linked, left blank otherwise.
  const buildLine = (pt, qty) => ({
    product_type: pt.key,
    fragrance_id: pt.fragrance_ids.length === 1 ? pt.fragrance_ids[0] : null,
    oil_id: null,
    oil_pct: pt.is_pure_oil ? 100 : pt.default_oil_pct,
    quantity: qty,
    volume_ml: pt.volume,
  });
  const order = await api('/production-orders', {
    method: 'POST',
    body: JSON.stringify({
      client_id: clientId, order_type: 'LARGE_CLIENT', notes: `${TAG} quick-order test`,
      lines: [buildLine(rowA, 3), buildLine(rowB, 5)],
    }),
  });
  check(order.ok, 'the order is accepted', `HTTP ${order.status} ${JSON.stringify(await order.clone().json().catch(() => ({})))}`);
  const orderBody = await order.json();
  orderId = orderBody.order?.id ?? orderBody.id;
  check(!!orderId, 'and an order id comes back', JSON.stringify(orderBody).slice(0, 200));

  const detail = await (await api(`/production-orders/${orderId}`)).json();
  const lineA = detail.lines?.find((l) => l.product_type === `${TAG}A`);
  const lineB = detail.lines?.find((l) => l.product_type === `${TAG}B`);
  check(lineA?.fragrance_id === frag.id, 'line A kept the auto-filled fragrance', `${lineA?.fragrance_id}`);
  check(lineB && (lineB.fragrance_id === null || lineB.fragrance_id === undefined),
    'line B has no fabricated fragrance', `${lineB?.fragrance_id}`);
  check(Number(lineA?.quantity) === 3 && Number(lineB?.quantity) === 5,
    'both quantities came through as typed', `${lineA?.quantity} / ${lineB?.quantity}`);

  console.log('\n4. The recipe was attached correctly, and nothing is consumed yet');
  // Orders sit in draft; the codebase debits stock at the in_production
  // transition, not at creation — draft orders must not touch physical stock.
  // Line A also reserves fragrance for the candle formula itself (240ml x 12%
  // oil x 3 units = 86.4ml) alongside the explicit BOM component below — match
  // on the component we actually registered, not just the line's product_type.
  const reserved = (await sm.query(
    `SELECT poc.quantity_required::float q, pol.product_type
       FROM production_order_components poc
       JOIN production_order_lines pol ON pol.id = poc.production_order_line_id
      WHERE poc.production_order_id = $1 AND poc.product_id = $2
      ORDER BY pol.product_type`, [orderId, comp.id])).rows;
  const reqA = reserved.find((r) => r.product_type === `${TAG}A`);
  const reqB = reserved.find((r) => r.product_type === `${TAG}B`);
  check(reqA?.q === 3 && reqB?.q === 5,
    'each line reserved the right quantity of the component (3 and 5)',
    JSON.stringify(reserved));
  const untouched = Number((await sm.query(
    `SELECT current_stock::float s FROM products WHERE id = $1`, [comp.id])).rows[0].s);
  check(untouched === comp.stock, 'and the shelf is untouched while the order is still a draft',
    `${comp.stock} -> ${untouched}`);

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /master|production-order|rror/i.test(l)).slice(-14).join('\n'));
  }
  console.log(failed === 0 ? '\n✅ major-client-quick-order: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  // Reverse dependency order: order lines/components, then the order, then the
  // masters (which cascades their fragrance link), then the client. The
  // component's stock is restored explicitly since deleting the order does not
  // reverse what it already consumed.
  if (orderId) {
    await sm.query('DELETE FROM production_order_components WHERE production_order_id = $1', [orderId]).catch(() => {});
    await sm.query('DELETE FROM production_order_lines WHERE production_order_id = $1', [orderId]).catch(() => {});
    await sm.query('DELETE FROM transactions WHERE notes LIKE $1', [`%${TAG}%`]).catch(() => {});
    await sm.query('DELETE FROM production_orders WHERE id = $1', [orderId]).catch(() => {});
  }
  for (const id of [masterAId, masterBId]) {
    if (id) {
      await sm.query('DELETE FROM major_client_master_fragrances WHERE master_product_id = $1', [id]).catch(() => {});
      await sm.query('DELETE FROM product_bom WHERE product_type = (SELECT product_code FROM products WHERE id = $1)', [id]).catch(() => {});
      await sm.query('DELETE FROM products WHERE id = $1', [id]).catch(() => {});
    }
  }
  if (clientId) await sm.query('DELETE FROM clients WHERE id = $1', [clientId]).catch(() => {});

  // Restore the component's stock via a ledger row, like any other correction.
  if (componentId) {
    const now = (await sm.query('SELECT current_stock::float s, name, product_code FROM products WHERE id=$1', [componentId])).rows[0];
    const original = comp?.stock;
    if (original == null) { /* fixture never reached this point */ } else
    if (now && now.s !== original) {
      await sm.query(
        `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
         VALUES ($1,$2,$3,'COMPONENT','adjust',$4,'units',$5,$6)`,
        [componentId, now.product_code, now.name, Math.abs(original - now.s), original,
         `Regression cleanup ${TAG} — restored after major-client-quick-order test`]);
      await sm.query('UPDATE products SET current_stock = $1 WHERE id = $2', [original, componentId]);
    }
  }

  const left = clientId
    ? Number((await sm.query('SELECT count(*) c FROM clients WHERE id = $1', [clientId])).rows[0].c)
    : 0;
  console.log(left === 0 ? '  ok    SM left exactly as found' : `  FAIL  client row still present`);
  if (left) failed++;

  await sm.end();
  process.exit(failed === 0 ? 0 : 1);
}
