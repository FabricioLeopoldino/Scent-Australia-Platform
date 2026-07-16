// ═══════════════════════════════════════════════════════════════════════════
// D14 — leftover oil-formula → Ready Formula → reuse (the full circle)
// ═══════════════════════════════════════════════════════════════════════════
// Once oil is mixed into ethanol it can never return to sa.products as pure
// oil (owner, 2026-07-16) — the leftover MIXTURE becomes a Ready Formula and
// gets consumed by a later order, reducing that order's oil debit.
//
// This gate guards the whole loop through the real API:
//   order 1 (oil_id line) → start → complete with leftover_formula_ml
//     → RF product credited, Fragrance Library oil untouched by the credit
//   /ready-formula/available?oil_id finds the RF
//   order 2 (use_ready_formula) → oil_qty_ml scaled DOWN → start debits less
//
// It also guards the bom-builder.js `quantity_reserved` fix (2026-07-16): a
// pre-existing bug queried a nonexistent column when an order consumed an
// EXISTING Ready Formula, 500-ing every such order. No other gate exercises
// that path.
//
// Usage: REGRESSION_BASE=http://localhost:3000 node scripts/regression-fragrance-library-rf.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';
const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const sa = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sa,public' });
const sm = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public' });

const token = jwt.sign(
  { id: 1, name: 'Root', role: 'root', modules: ['SA', 'SM', 'MUSE'], must_change_password: false },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '15m' }
);
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };

const OIL_ID = '__FRAGLIB_RF_OIL';
const MASTER_CODE = 'FLRF';
let orderIds = [];

async function cleanup() {
  for (const id of orderIds) {
    await sm.query(`DELETE FROM production_order_lines WHERE production_order_id = $1`, [id]).catch(() => {});
    await sm.query(`DELETE FROM production_jobs WHERE production_order_id = $1`, [id]).catch(() => {});
    await sm.query(`DELETE FROM production_orders WHERE id = $1`, [id]).catch(() => {});
  }
  await sm.query(`DELETE FROM products WHERE master_product_id IN (SELECT id FROM products WHERE product_code = $1)`, [MASTER_CODE]).catch(() => {});
  await sm.query(`DELETE FROM products WHERE product_code = $1`, [MASTER_CODE]).catch(() => {});
  // The RF product this run creates (named after the oil's name)
  await sm.query(`DELETE FROM transactions WHERE product_id IN (SELECT id FROM products WHERE category='READY_FORMULA' AND name ILIKE '%FragLib RF Probe%')`).catch(() => {});
  await sm.query(`DELETE FROM products WHERE category = 'READY_FORMULA' AND name ILIKE '%FragLib RF Probe%'`).catch(() => {});
  await sa.query(`DELETE FROM transactions WHERE product_id = $1`, [OIL_ID]).catch(() => {});
  // §18: the sa.products trigger logs every stock change — remove our fixture's rows
  await sa.query(`DELETE FROM direct_stock_changes WHERE product_id = $1`, [OIL_ID]).catch(() => {});
  await sa.query(`DELETE FROM products WHERE id = $1`, [OIL_ID]).catch(() => {});
}

async function runToFillingDone(orderId) {
  await sm.query(`UPDATE production_orders SET status = 'queued' WHERE id = $1`, [orderId]);
  const start = await api('POST', `/api/sm/manufacturing/${orderId}/start`);
  if (start.status !== 200) throw new Error('start failed: ' + JSON.stringify(start.json));
  const lines = await sm.query(`SELECT id FROM production_order_lines WHERE production_order_id = $1`, [orderId]);
  const lineId = lines.rows[0].id;
  const fd = await api('POST', `/api/sm/manufacturing/${orderId}/lines/${lineId}/filling-done`);
  if (fd.status !== 200) throw new Error('filling-done failed: ' + JSON.stringify(fd.json));
  return lineId;
}

(async () => {
  await cleanup();
  await sa.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", "unitPerBox", status)
     VALUES ($1, $1, $1, 'FragLib RF Probe', 'OILS', 'mL', 10000, 1000, 'active')`,
    [OIL_ID]
  );
  await sm.query(
    `INSERT INTO products (name, product_code, category, segment, is_master, unit, current_stock, volume_ml, volume_unit, default_oil_pct)
     VALUES ('FLRF Master 200ml', $1, 'FINISHED_GOOD', 'MUSE', true, 'units', 0, 200, 'ml', 25)`,
    [MASTER_CODE]
  );

  // ── 1. Produce with an oil_id line, report a 100 mL leftover on completion ─
  const create1 = await api('POST', '/api/sm/production-orders', {
    order_type: 'STANDARD', client_id: null, notes: 'FragLib RF gate — round 1',
    lines: [{ product_type: MASTER_CODE, oil_id: OIL_ID, oil_pct: 25, quantity: 10 }],
  });
  const order1 = create1.json?.id;
  if (!order1) { bad('create order 1', JSON.stringify(create1.json).slice(0, 150)); await cleanup(); process.exit(1); }
  orderIds.push(order1);
  const line1 = await runToFillingDone(order1);
  const oilAfterStart = parseFloat((await sa.query(`SELECT "currentStock" FROM products WHERE id = $1`, [OIL_ID])).rows[0].currentStock);
  oilAfterStart === 9500
    ? ok('order 1 start debited the oil (10 × 200 mL × 25%)', '10000 → 9500')
    : bad('order 1 debit wrong', `${oilAfterStart}`);

  const complete1 = await api('POST', `/api/sm/manufacturing/${order1}/complete`, {
    line_leftovers: [{ line_id: line1, leftover_formula_ml: 100 }],
  });
  complete1.status === 200 ? ok('order 1 completed with 100 mL leftover reported') : bad('complete failed', JSON.stringify(complete1.json).slice(0, 150));

  const rf = await sm.query(`SELECT id, name, current_stock FROM products WHERE category = 'READY_FORMULA' AND name ILIKE '%FragLib RF Probe%'`);
  rf.rows.length === 1 && parseFloat(rf.rows[0].current_stock) === 100
    ? ok('leftover credited as a Ready Formula named after the oil', `${rf.rows[0].name} = 100 mL`)
    : bad('Ready Formula not credited', JSON.stringify(rf.rows));

  const oilAfterComplete = parseFloat((await sa.query(`SELECT "currentStock" FROM products WHERE id = $1`, [OIL_ID])).rows[0].currentStock);
  oilAfterComplete === oilAfterStart
    ? ok('the mixture NEVER returns to sa.products as pure oil', `oil still ${oilAfterComplete}`)
    : bad('oil stock changed by the leftover credit', `${oilAfterStart} → ${oilAfterComplete}`);

  // ── 2. The picker finds it by oil_id ──────────────────────────────────────
  const avail = await api('GET', `/api/sm/ready-formula/available?oil_id=${OIL_ID}`);
  Array.isArray(avail.json) && avail.json.length === 1 && avail.json[0].id === rf.rows[0].id
    ? ok('/ready-formula/available surfaces it by oil_id')
    : bad('RF not found by oil_id', JSON.stringify(avail.json).slice(0, 120));

  // ── 3. A later order consumes it — the quantity_reserved path ─────────────
  const create2 = await api('POST', '/api/sm/production-orders', {
    order_type: 'STANDARD', client_id: null, notes: 'FragLib RF gate — round 2',
    lines: [{ product_type: MASTER_CODE, oil_id: OIL_ID, oil_pct: 25, quantity: 2, use_ready_formula: true, ready_formula_id: rf.rows[0].id }],
  });
  const order2 = create2.json?.id;
  create2.status === 201 && order2
    ? ok('order consuming an EXISTING Ready Formula creates cleanly (quantity_reserved fix)')
    : bad('order 2 create failed — the bom-builder RF path is broken again', JSON.stringify(create2.json).slice(0, 150));
  if (order2) {
    orderIds.push(order2);
    // totalFormula = 2 × 200 = 400 mL; RF covers 100; remaining 300 at 25% oil = 75 mL
    const line2 = await sm.query(`SELECT oil_qty_ml FROM production_order_lines WHERE production_order_id = $1`, [order2]);
    Math.abs(parseFloat(line2.rows[0].oil_qty_ml) - 75) < 0.01
      ? ok('RF coverage scales the oil debit down', `oil_qty_ml = ${line2.rows[0].oil_qty_ml} (400 − 100 RF → 75 oil)`)
      : bad('RF scaling wrong', `${line2.rows[0].oil_qty_ml}, expected 75`);

    await sm.query(`UPDATE production_orders SET status = 'queued' WHERE id = $1`, [order2]);
    const start2 = await api('POST', `/api/sm/manufacturing/${order2}/start`);
    start2.status === 200 ? ok('order 2 started') : bad('order 2 start failed', JSON.stringify(start2.json).slice(0, 120));
    const oilFinal = parseFloat((await sa.query(`SELECT "currentStock" FROM products WHERE id = $1`, [OIL_ID])).rows[0].currentStock);
    Math.abs(oilFinal - (oilAfterComplete - 75)) < 0.01
      ? ok('start debited only the RF-reduced amount', `${oilAfterComplete} → ${oilFinal}`)
      : bad('order 2 debit wrong', `${oilFinal}, expected ${oilAfterComplete - 75}`);
  }

  await cleanup();
  // §18 residue proof — nothing of ours left anywhere
  const res1 = (await sa.query(`SELECT COUNT(*)::int n FROM products WHERE id = $1`, [OIL_ID])).rows[0].n
    + (await sa.query(`SELECT COUNT(*)::int n FROM transactions WHERE product_id = $1`, [OIL_ID])).rows[0].n
    + (await sa.query(`SELECT COUNT(*)::int n FROM direct_stock_changes WHERE product_id = $1`, [OIL_ID])).rows[0].n
    + (await sm.query(`SELECT COUNT(*)::int n FROM products WHERE product_code = $1 OR name ILIKE '%FragLib RF Probe%'`, [MASTER_CODE])).rows[0].n;
  res1 === 0 ? ok('§18 residue: zero rows left behind') : bad('§18 residue LEFT', `${res1} rows`);

  console.log(`\n══════ D14 RF LOOP: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sa.end(); await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); await sa.end(); await sm.end(); process.exit(1); });
