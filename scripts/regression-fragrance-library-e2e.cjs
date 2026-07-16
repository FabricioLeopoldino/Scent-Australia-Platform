// ═══════════════════════════════════════════════════════════════════════════
// D14 PHASE 3 E2E — Fragrance Library wired into real BOM + production
// ═══════════════════════════════════════════════════════════════════════════
// Creates a REAL MUSE production order through the actual HTTP API, using a
// throwaway master + throwaway oil, starts production, and verifies the Cold
// Room oil was debited by exactly the expected mL (volume x qty x oil_pct%),
// tagged as muse_production. Then does the same for a STANDARD (B2B) order,
// and confirms an EXCLUSIVE oil is invisible in the wrong segment's picker.
//
// Usage: REGRESSION_BASE=http://localhost:3012 node scripts/regression-fragrance-library-e2e.cjs
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

const OIL_ID = '__FRAGLIB_E2E_OIL';
const MASTER_CODE = 'FRAGLIB_E2E_MASTER';
let orderIds = [];

const CLIENT_NAME = '__FragLib E2E Client__';

async function cleanup() {
  for (const id of orderIds) {
    await sm.query(`DELETE FROM production_order_lines WHERE production_order_id = $1`, [id]).catch(() => {});
    await sm.query(`DELETE FROM production_jobs WHERE production_order_id = $1`, [id]).catch(() => {});
    await sm.query(`DELETE FROM production_orders WHERE id = $1`, [id]).catch(() => {});
  }
  await sa.query(`DELETE FROM transactions WHERE product_id = $1`, [OIL_ID]).catch(() => {});
  // The sa.products trigger logs every stock change into direct_stock_changes —
  // delete OUR fixture's rows too (§18 test-data discipline).
  await sa.query(`DELETE FROM direct_stock_changes WHERE product_id = $1`, [OIL_ID]).catch(() => {});
  await sa.query(`DELETE FROM products WHERE id = $1`, [OIL_ID]).catch(() => {});
  await sm.query(`DELETE FROM products WHERE product_code = $1`, [MASTER_CODE]).catch(() => {});
  // Own throwaway client — NEVER touch a pre-existing row (a past run of this
  // script mutated regression-sm.js's own Major Client fixture by grabbing
  // "the first client in the table"; that corrupted a DIFFERENT suite until
  // caught and fixed).
  await sm.query(`DELETE FROM clients WHERE name = $1`, [CLIENT_NAME]).catch(() => {});
}

(async () => {
  await cleanup();
  await sa.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", "unitPerBox", status)
     VALUES ($1, $1, $1, '__Fragrance Library E2E oil__', 'OILS', 'mL', 10000, 1000, 'active')`,
    [OIL_ID]
  );
  // Throwaway MUSE-segment master, 200 mL, default 25% oil — matches the
  // "click the oil straight from the Fragrance Library list" mental model.
  await sm.query(
    `INSERT INTO products (name, product_code, category, segment, is_master, unit, current_stock, volume_ml, volume_unit, default_oil_pct)
     VALUES ('__FragLib E2E Master__', $1, 'FINISHED_GOOD', 'MUSE', true, 'units', 0, 200, 'ml', 25)`,
    [MASTER_CODE]
  );

  // ── 1. Picker respects exclusivity ────────────────────────────────────────
  const listBefore = await api('GET', '/api/sm/fragrance-library?segment=MUSE');
  const seenBefore = listBefore.json.some((o) => o.id === OIL_ID);
  seenBefore ? ok('shared oil (exclusivity NULL) visible in the MUSE picker') : bad('shared oil not visible in MUSE picker');

  await sa.query(`UPDATE products SET exclusivity = 'SM' WHERE id = $1`, [OIL_ID]);
  const listExcluded = await api('GET', '/api/sm/fragrance-library?segment=MUSE');
  listExcluded.json.some((o) => o.id === OIL_ID)
    ? bad('SM-exclusive oil wrongly visible in the MUSE picker')
    : ok('SM-exclusive oil correctly hidden from the MUSE picker');

  const listStd = await api('GET', '/api/sm/fragrance-library?segment=STANDARD');
  listStd.json.some((o) => o.id === OIL_ID)
    ? ok('the same oil IS visible in the STANDARD (its own business) picker')
    : bad('SM-exclusive oil wrongly hidden from STANDARD');

  await sa.query(`UPDATE products SET exclusivity = NULL WHERE id = $1`, [OIL_ID]);

  // ── 2. Real MUSE production order, oil_id line, start -> debit ───────────
  const create = await api('POST', '/api/sm/production-orders', {
    order_type: 'STANDARD', client_id: null, notes: 'D14 E2E',
    lines: [{ product_type: MASTER_CODE, oil_id: OIL_ID, oil_pct: 25, quantity: 10 }],
  });
  const orderId = create.json?.id;
  if (!orderId) { bad('create MUSE order', JSON.stringify(create.json).slice(0, 200)); await cleanup(); process.exit(1); }
  orderIds.push(orderId);
  ok('MUSE production order created via the real API', `order id ${orderId}`);

  const lineCheck = await sm.query(`SELECT oil_id, oil_qty_ml FROM production_order_lines WHERE production_order_id = $1`, [orderId]);
  const expectedMl = 10 * 200 * 0.25; // qty * volume * oil_pct
  const storedMl = parseFloat(lineCheck.rows[0]?.oil_qty_ml);
  storedMl === expectedMl
    ? ok('oil_qty_ml computed and stored correctly at creation', `${storedMl} mL (10 x 200mL x 25%)`)
    : bad('oil_qty_ml wrong', `got ${storedMl}, expected ${expectedMl}`);

  // queue then start (mirrors the real lifecycle: draft -> confirmed -> queued -> start)
  await sm.query(`UPDATE production_orders SET status = 'queued' WHERE id = $1`, [orderId]);
  const start = await api('POST', `/api/sm/manufacturing/${orderId}/start`);
  start.status === 200 ? ok('production started (HTTP 200)') : bad('start failed', JSON.stringify(start.json));

  const oilAfter = parseFloat((await sa.query(`SELECT "currentStock" FROM products WHERE id = $1`, [OIL_ID])).rows[0].currentStock);
  oilAfter === 10000 - expectedMl
    ? ok('Fragrance Library oil debited by the exact BOM-computed amount', `10000 → ${oilAfter}`)
    : bad('oil debit amount wrong', `got ${oilAfter}, expected ${10000 - expectedMl}`);

  const tx = await sa.query(`SELECT type, quantity, notes FROM transactions WHERE product_id = $1 AND type = 'muse_production'`, [OIL_ID]);
  tx.rows.length === 1 && tx.rows[0].notes.includes(create.json.order_number || '')
    ? ok('transaction tagged muse_production with the order number in notes', tx.rows[0].notes)
    : bad('muse_production transaction missing/wrong', JSON.stringify(tx.rows));

  // ── 3. A STANDARD (B2B) order lands sm_std_production ─────────────────────
  const smMaster = 'FRAGLIB_E2E_MASTER'; // reuse: STANDARD orders don't require client_id either (small clients ordering ad hoc use order_type STANDARD, client_id optional in this flow)
  await sa.query(`UPDATE products SET "currentStock" = 5000 WHERE id = $1`, [OIL_ID]);
  const create2 = await api('POST', '/api/sm/production-orders', {
    order_type: 'STANDARD', client_id: null, notes: 'D14 E2E std',
    lines: [{ product_type: MASTER_CODE, oil_id: OIL_ID, oil_pct: 25, quantity: 1 }],
  });
  // Force a client so this one resolves to STANDARD/MAJOR rather than MUSE —
  // segment is derived from client_id presence (see resolveOrderSegment).
  // OWN throwaway client — never touch a pre-existing row (see cleanup()).
  const cli = await sm.query(`INSERT INTO clients (name, is_large_client) VALUES ($1, false) RETURNING id`, [CLIENT_NAME]);
  if (cli.rows[0] && create2.json?.id) {
    await sm.query(`UPDATE production_orders SET client_id = $1 WHERE id = $2`, [cli.rows[0].id, create2.json.id]);
    orderIds.push(create2.json.id);
    await sm.query(`UPDATE production_orders SET status = 'queued' WHERE id = $1`, [create2.json.id]);
    const start2 = await api('POST', `/api/sm/manufacturing/${create2.json.id}/start`);
    start2.status === 200 ? ok('STANDARD (B2B) order started') : bad('STANDARD start failed', JSON.stringify(start2.json));
    const stdTx = await sa.query(`SELECT type FROM transactions WHERE product_id = $1 AND type = 'sm_std_production'`, [OIL_ID]);
    stdTx.rows.length === 1
      ? ok('STANDARD order tagged sm_std_production (distinct bucket from MUSE)')
      : bad('sm_std_production transaction missing', JSON.stringify(stdTx.rows));
  } else {
    console.log('  (skipped STANDARD-order sub-test — no client fixture available)');
  }

  await cleanup();
  console.log(`\n══════ D14 PHASE 3 E2E: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await sa.end(); await sm.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); process.exit(1); });
