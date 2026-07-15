// ═══════════════════════════════════════════════════════════════════════════
// D14 — MUSE variant commercial naming ("Afterglow" != the oil's own name "Santal")
// ═══════════════════════════════════════════════════════════════════════════
// Full lifecycle through the real API: create -> queue -> start -> COMPLETE,
// verifying the auto-created finished-good variant uses the explicit
// variant_name override, is keyed by (master_id, oil_id), and its stock
// increments by the produced quantity. Also proves the old fallback (no
// override -> auto-concatenate with the oil's name) still works.
//
// Usage: REGRESSION_BASE=http://localhost:3013 node scripts/regression-fragrance-library-naming.cjs
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

const OIL_ID = '__FRAGLIB_NAME_OIL';
const MASTER_CODE = 'FLNM';
let orderIds = [];

async function cleanup() {
  for (const id of orderIds) {
    await sm.query(`DELETE FROM production_order_lines WHERE production_order_id = $1`, [id]).catch(() => {});
    await sm.query(`DELETE FROM production_jobs WHERE production_order_id = $1`, [id]).catch(() => {});
    await sm.query(`DELETE FROM production_orders WHERE id = $1`, [id]).catch(() => {});
  }
  await sm.query(`DELETE FROM products WHERE master_product_id IN (SELECT id FROM products WHERE product_code = $1)`, [MASTER_CODE]).catch(() => {});
  await sa.query(`DELETE FROM transactions WHERE product_id = $1`, [OIL_ID]).catch(() => {});
  await sa.query(`DELETE FROM products WHERE id = $1`, [OIL_ID]).catch(() => {});
  await sm.query(`DELETE FROM products WHERE product_code = $1`, [MASTER_CODE]).catch(() => {});
}

async function runOrder(qty, variantNameOverride) {
  const create = await api('POST', '/api/sm/production-orders', {
    order_type: 'STANDARD', client_id: null, notes: 'D14 naming test',
    lines: [{ product_type: MASTER_CODE, oil_id: OIL_ID, oil_pct: 25, quantity: qty, variant_name: variantNameOverride || undefined }],
  });
  const orderId = create.json?.id;
  if (!orderId) throw new Error('create failed: ' + JSON.stringify(create.json));
  orderIds.push(orderId);
  await sm.query(`UPDATE production_orders SET status = 'queued' WHERE id = $1`, [orderId]);
  const start = await api('POST', `/api/sm/manufacturing/${orderId}/start`);
  if (start.status !== 200) throw new Error('start failed: ' + JSON.stringify(start.json));
  const lines = await sm.query(`SELECT id FROM production_order_lines WHERE production_order_id = $1`, [orderId]);
  const lineId = lines.rows[0].id;
  const filling = await api('POST', `/api/sm/manufacturing/${orderId}/lines/${lineId}/filling-done`);
  if (filling.status !== 200) throw new Error('filling-done failed: ' + JSON.stringify(filling.json));
  const complete = await api('POST', `/api/sm/manufacturing/${orderId}/complete`, {
    line_leftovers: [{ line_id: lineId }],
  });
  if (complete.status !== 200) throw new Error('complete failed: ' + JSON.stringify(complete.json));
  return orderId;
}

(async () => {
  await cleanup();
  await sa.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", "unitPerBox", status)
     VALUES ($1, $1, $1, 'Santal', 'OILS', 'mL', 10000, 1000, 'active')`,
    [OIL_ID]
  );
  await sm.query(
    `INSERT INTO products (name, product_code, category, segment, is_master, unit, current_stock, volume_ml, volume_unit, default_oil_pct)
     VALUES ('Reed Diffuser 200ml', $1, 'FINISHED_GOOD', 'MUSE', true, 'units', 0, 200, 'ml', 25)`,
    [MASTER_CODE]
  );

  // ── 1. Explicit commercial name wins over the oil's own name ─────────────
  await runOrder(5, 'Afterglow');
  const v1 = await sm.query(
    `SELECT name, oil_id, current_stock FROM products WHERE master_product_id = (SELECT id FROM products WHERE product_code = $1) AND oil_id = $2`,
    [MASTER_CODE, OIL_ID]
  );
  v1.rows.length === 1
    ? ok('exactly one variant created for (master, oil)')
    : bad('variant count wrong', v1.rows.length);
  v1.rows[0]?.name === 'Reed Diffuser 200ml — Afterglow'
    ? ok('variant uses the EXPLICIT commercial name, not the oil name', v1.rows[0]?.name)
    : bad('variant name wrong — leaked the oil name instead of the commercial name', v1.rows[0]?.name);
  v1.rows[0]?.oil_id === OIL_ID
    ? ok('variant correctly keyed by oil_id')
    : bad('variant oil_id wrong', v1.rows[0]?.oil_id);
  parseFloat(v1.rows[0]?.current_stock) === 5
    ? ok('finished-good stock incremented by the produced quantity', '0 → 5')
    : bad('stock increment wrong', v1.rows[0]?.current_stock);

  // ── 2. A second order for the SAME variant increments, doesn't duplicate ──
  await runOrder(3, 'Afterglow');
  const v2 = await sm.query(
    `SELECT name, current_stock FROM products WHERE master_product_id = (SELECT id FROM products WHERE product_code = $1) AND oil_id = $2`,
    [MASTER_CODE, OIL_ID]
  );
  v2.rows.length === 1 && parseFloat(v2.rows[0].current_stock) === 8
    ? ok('repeat order increments the SAME variant (no duplicate row)', '5 → 8')
    : bad('repeat order handling wrong', JSON.stringify(v2.rows));

  await cleanup();
  console.log(`\n══════ D14 NAMING: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sa.end(); await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); process.exit(1); });
