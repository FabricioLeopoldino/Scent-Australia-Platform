// ═══════════════════════════════════════════════════════════════════════
// Phase 3c — SM module regression suite (PRD §12 Phase 3c Verify)
//
// Exercises the FULL production flow against a local platform server:
//   catalog seed (suppliers/products/masters — doubles as the SM base data,
//   left in place on purpose) → MUSE order → reserve → start (debit) →
//   line done → complete (leftovers, extra fragrance, MUSE variant + MUS
//   SKU, strength log) → Major Client priority displacement → candle
//   external-processing line ops → hardening checks (uploads 403,
//   sanitized errors).
//
// Usage:  node scripts/regression-sm.js       (server must be running)
// Exit 0 = ALL PASS.
// ═══════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
const { Pool } = pkg;

const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';

const db = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false },
  options: '-c search_path=sm,public',
});

const results = [];
let TOKEN = null;

function record(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const near = (a, b, eps = 0.011) => Math.abs(parseFloat(a) - parseFloat(b)) < eps;

async function stockOf(id) {
  const r = await db.query(`SELECT current_stock FROM products WHERE id = $1`, [id]);
  return parseFloat(r.rows[0].current_stock);
}

// find-or-create product by code (idempotent seed)
async function ensureProduct(fields) {
  const existing = await db.query(`SELECT id FROM products WHERE product_code = $1`, [fields.product_code]);
  if (existing.rows[0]) return existing.rows[0].id;
  const r = await api('POST', '/api/sm/products', fields);
  return r.json?.id || r.json?.product?.id;
}

async function setup() {
  const hash = bcrypt.hashSync('RegressionSm1!', 10);
  const u = await db.query(
    `INSERT INTO platform.users (name, password_hash, role, must_change_password)
     VALUES ('__regression_sm', $1, 'root', false)
     ON CONFLICT (name) DO UPDATE SET password_hash = $1, must_change_password = false RETURNING id`,
    [hash]
  );
  const uid = u.rows[0].id;
  await db.query(`INSERT INTO platform.user_modules (user_id, module) VALUES ($1,'SM') ON CONFLICT DO NOTHING`, [uid]);
  await db.query(
    `INSERT INTO users (id, name, password_hash, role) VALUES ($1,'__regression_sm',$2,'root') ON CONFLICT (id) DO NOTHING`,
    [uid, hash]
  );
  const login = await api('POST', '/api/platform/auth/login', { name: '__regression_sm', password: 'RegressionSm1!' });
  if (login.status !== 200) throw new Error('login failed');
  TOKEN = login.json.token;
  return uid;
}

async function main() {
  console.log('══════════ SM REGRESSION SUITE (Phase 3c) ══════════\n');
  const uid = await setup();

  try {
    // ── Seed catalog (idempotent; intentionally left in place as base data) ──
    const supplier = await api('POST', '/api/sm/suppliers', { name: 'Seed Supplier Co', lead_time: 30 });
    record('seed: supplier', supplier.status === 200 || supplier.status === 201);

    const ethanolId = await ensureProduct({ name: 'Ethanol 96%', product_code: 'RM-ETHANOL', category: 'RAW_MATERIAL', unit: 'ml', current_stock: 100000, min_stock_level: 10000 });
    const bottleId = await ensureProduct({ name: 'Reed Bottle 200ml', product_code: 'CMP-RB200', category: 'COMPONENT', unit: 'units', current_stock: 5000, min_stock_level: 100 });
    const lidId = await ensureProduct({ name: 'Reed Lid', product_code: 'CMP-RLID', category: 'COMPONENT', unit: 'units', current_stock: 5000, min_stock_level: 100 });
    const frag1 = await ensureProduct({ name: 'Santal Bloom', product_code: 'FRAG-SANTAL', category: 'FRAGRANCE', unit: 'ml', current_stock: 50000, min_stock_level: 5000 });
    const frag2 = await ensureProduct({ name: 'Oud Noir', product_code: 'FRAG-OUD', category: 'FRAGRANCE', unit: 'ml', current_stock: 50000, min_stock_level: 5000 });
    record('seed: products (ethanol/bottle/lid/2 fragrances)', [ethanolId, bottleId, lidId, frag1, frag2].every(Boolean));

    // ── MUSE master with BOM + 2 fragrances → auto variants + MUS skus ──
    let masterId;
    const existingMaster = await db.query(`SELECT id FROM products WHERE product_code = 'RD200_TEST' AND is_master = true`);
    if (existingMaster.rows[0]) {
      masterId = existingMaster.rows[0].id;
      record('master: MUSE master exists (idempotent)', true);
    } else {
      const master = await api('POST', '/api/sm/masters', {
        name: 'Reed Diffuser 200ml TEST',
        product_code: 'RD200_TEST',
        segment: 'MUSE',
        volume_ml: 200,
        default_oil_pct: 25,
        container_name: 'Reed Diffuser',
        bom_components: [
          { component_product_id: bottleId, quantity_formula: 'fixed', quantity_per_unit: 1 },
          { component_product_id: lidId, quantity_formula: 'fixed', quantity_per_unit: 1 },
          { component_product_id: ethanolId, quantity_formula: 'ethanol_pct', quantity_per_unit: 0 },
        ],
        fragrance_ids: [frag1, frag2],
        generate_variants: true,
      });
      masterId = master.json?.master?.id;
      record('master: MUSE create + 2 variants + MUS skus', master.status === 201 && master.json?.variants_created === 2, JSON.stringify({ variants: master.json?.variants_created }));
    }
    const skus = await db.query(`SELECT sku FROM products WHERE master_product_id = $1 ORDER BY sku`, [masterId]);
    record('master: variants carry MUS#### skus', skus.rows.length >= 2 && skus.rows.every((r) => /^MUS\d{4}$/.test(r.sku)));

    // ── MUSE production order: reserve → start (debit) → complete ──
    const eth0 = await stockOf(ethanolId), fr0 = await stockOf(frag1), bot0 = await stockOf(bottleId);
    const variant0 = parseFloat(
      (await db.query(`SELECT COALESCE(MAX(current_stock),0) AS s FROM products WHERE master_product_id = $1 AND fragrance_id = $2`, [masterId, frag1])).rows[0].s
    );

    const order = await api('POST', '/api/sm/production-orders', {
      order_type: 'STANDARD',
      lines: [{ product_type: 'RD200_TEST', fragrance_id: frag1, oil_pct: 25, quantity: 10 }],
    });
    const orderId = order.json?.id;
    record('order: MUSE order created', order.status === 201 && !!orderId, order.json?.order_number);

    const resv = await db.query(`SELECT COUNT(*) FROM stock_reservations WHERE production_order_id = $1 AND status = 'reserved'`, [orderId]);
    record('order: stock reserved (not debited)', parseInt(resv.rows[0].count) >= 3 && near(await stockOf(ethanolId), eth0));

    // Lifecycle: draft → queued → start (start requires queued|waiting_external)
    await api('PUT', `/api/sm/production-orders/${orderId}/status`, { status: 'queued' });
    const start = await api('POST', `/api/sm/manufacturing/${orderId}/start`);
    const ethAfter = await stockOf(ethanolId), frAfter = await stockOf(frag1), botAfter = await stockOf(bottleId);
    // qty10 × 200ml: ethanol 75% = 1500, fragrance 25% = 500, bottle 10
    record('start: debits BOM exactly', start.status === 200 && near(ethAfter, eth0 - 1500) && near(frAfter, fr0 - 500) && near(botAfter, bot0 - 10),
      `eth −${eth0 - ethAfter}, frag −${fr0 - frAfter}, bottle −${bot0 - botAfter}`);

    const lineId = (await db.query(`SELECT id FROM production_order_lines WHERE production_order_id = $1`, [orderId])).rows[0].id;
    await api('POST', `/api/sm/manufacturing/${orderId}/lines/${lineId}/filling-done`);
    const complete = await api('POST', `/api/sm/manufacturing/${orderId}/complete`, {
      notes_on_completion: '[regression] done',
      line_leftovers: [{ line_id: lineId, leftover_formula_ml: 100, extra_fragrance_ml: 50, extra_fragrance_reason: 'weak batch test' }],
    });
    const orderRow = await db.query(`SELECT status FROM production_orders WHERE id = $1`, [orderId]);
    record('complete: MUSE order auto-fulfilled', complete.status === 200 && orderRow.rows[0].status === 'fulfilled');

    const variant = await db.query(
      `SELECT current_stock, sku FROM products WHERE master_product_id = $1 AND fragrance_id = $2`, [masterId, frag1]
    );
    record('complete: variant stock +10', near(variant.rows[0]?.current_stock, variant0 + 10), `sku=${variant.rows[0]?.sku}, ${variant0}→${variant.rows[0]?.current_stock}`);

    const rf = await db.query(`SELECT current_stock FROM products WHERE category = 'READY_FORMULA' AND name ILIKE '%Santal Bloom%'`);
    record('complete: leftover → READY_FORMULA +100 ml', rf.rows[0] && parseFloat(rf.rows[0].current_stock) >= 100);

    const frFinal = await stockOf(frag1);
    record('complete: extra fragrance −50 ml debited', near(frFinal, frAfter - 50));

    const strength = await db.query(`SELECT actual_pct_used FROM fragrance_strength_log WHERE production_order_id = $1`, [orderId]);
    record('complete: strength log written (actual % > standard)', strength.rows[0] && parseFloat(strength.rows[0].actual_pct_used) > 25);

    // ── Major Client priority displacement ──
    // idempotent client (rerun-safe)
    let clientId = (await db.query(`SELECT id FROM clients WHERE name = '[regression] Coco Republic Test' LIMIT 1`)).rows[0]?.id;
    if (!clientId) {
      const cli = await api('POST', '/api/sm/clients', { name: '[regression] Coco Republic Test', is_large_client: true });
      clientId = cli.json?.id;
    }
    // blocker sized against CURRENT availability: reserve all-but-5,000 ml of frag2
    const fr2Stock = await stockOf(frag2);
    const blockerQty = Math.max(1, Math.floor((fr2Stock - 5000) / 50)); // 50 ml frag per unit (200ml × 25%)
    const blocker = await api('POST', '/api/sm/production-orders', {
      order_type: 'STANDARD',
      lines: [{ product_type: 'RD200_TEST', fragrance_id: frag2, oil_pct: 25, quantity: blockerQty }],
    });
    const check = await api('POST', '/api/sm/reservations/check-displacement', {
      client_id: clientId,
      components: [{ product_id: frag2, quantity_required: 15000 }],
    });
    record('major: pre-flight detects displacement need',
      check.status === 200 && check.json?.priority === 'high' && check.json?.any_displacement === true,
      `client=${clientId} blockerQty=${blockerQty} → ${JSON.stringify(check.json)?.slice(0, 120)}`);

    const majorMasterExists = await db.query(`SELECT id FROM products WHERE product_code = 'MAJ_RD200_TEST' AND is_master = true`);
    if (!majorMasterExists.rows[0]) {
      await api('POST', '/api/sm/masters', {
        name: 'Major Reed 200ml TEST', product_code: 'MAJ_RD200_TEST', segment: 'MAJOR', client_id: clientId,
        volume_ml: 200, default_oil_pct: 25,
        bom_components: [{ component_product_id: ethanolId, quantity_formula: 'ethanol_pct', quantity_per_unit: 0 }],
        fragrance_ids: [frag2],
      });
    }
    const majorOrder = await api('POST', '/api/sm/production-orders', {
      client_id: clientId, order_type: 'LARGE_CLIENT', displace_low_priority: true,
      lines: [{ product_type: 'MAJ_RD200_TEST', fragrance_id: frag2, oil_pct: 25, quantity: 300 }], // needs 15,000 ml frag2
    });
    const displaced = await db.query(
      `SELECT COUNT(*) FROM dashboard_alerts WHERE alert_type = 'reservation_displaced' AND related_order_id = $1`,
      [blocker.json?.id]
    );
    record('major: high-priority order displaces + alert raised', majorOrder.status === 201 && parseInt(displaced.rows[0].count) >= 1);

    // cancel both to release reservations (keep DB tidy for reruns)
    await api('DELETE', `/api/sm/production-orders/${blocker.json?.id}?mode=cancel`);
    await api('DELETE', `/api/sm/production-orders/${majorOrder.json?.id}?mode=cancel`);
    const leftover = await db.query(
      `SELECT COUNT(*) FROM stock_reservations WHERE production_order_id IN ($1,$2) AND status = 'reserved'`,
      [blocker.json?.id, majorOrder.json?.id]
    );
    record('major: cancel releases reservations', leftover.rows[0].count === '0');

    // ── Candle line: send-for-filling → waiting_external → receive ──
    const candleMasterExists = await db.query(`SELECT id FROM products WHERE product_code = 'CANDLE_240G' AND is_master = true`);
    if (!candleMasterExists.rows[0]) {
      await api('POST', '/api/sm/masters', {
        name: 'Candle 240g TEST', product_code: 'CANDLE_240G', segment: 'MUSE', volume_ml: 240,
        default_oil_pct: 12, is_candle: true,
        bom_components: [{ component_product_id: ethanolId, quantity_formula: 'ethanol_pct', quantity_per_unit: 0 }],
        fragrance_ids: [frag1],
      });
    }
    const candleOrder = await api('POST', '/api/sm/production-orders', {
      order_type: 'STANDARD',
      lines: [{ product_type: 'CANDLE_240G', fragrance_id: frag1, oil_pct: 12, quantity: 5 }],
    });
    const cOrderId = candleOrder.json?.id;
    const cLineId = candleOrder.json?.lines?.[0]?.id;
    await api('POST', `/api/sm/manufacturing/${cOrderId}/lines/${cLineId}/send-for-filling`, { supplier: 'Filling Co' });
    const waiting = await db.query(`SELECT status FROM production_orders WHERE id = $1`, [cOrderId]);
    record('candle: send-for-filling → waiting_external', waiting.rows[0].status === 'waiting_external');
    const recv = await api('POST', `/api/sm/manufacturing/${cOrderId}/lines/${cLineId}/receive-from-filling`);
    const lineRow = await db.query(`SELECT line_status, candle_status FROM production_order_lines WHERE id = $1`, [cLineId]);
    record('candle: receive-from-filling → line done', recv.status === 200 && lineRow.rows[0].candle_status === 'received_from_filling' && lineRow.rows[0].line_status === 'done');
    await api('DELETE', `/api/sm/production-orders/${cOrderId}?mode=cancel`).catch(() => {});

    // ── Hardening (Phase 3b) ──
    const upload = await api('PATCH', `/api/sm/products/${frag1}/image`, { image_data: 'data:image/png;base64,AAAA' });
    record('hardening: upload endpoint 403 behind FEATURE_UPLOADS', upload.status === 403);

    const dbErr = await api('POST', '/api/sm/stock/add', { product_id: 'not-a-number', quantity: 5 });
    record('hardening: DB error sanitized (no pg message leaked)', dbErr.status === 500 && dbErr.json?.error === 'Internal server error');

    const bizErr = await api('POST', '/api/sm/stock/remove', { product_id: ethanolId, quantity: 99999999 });
    record('hardening: business error passes allowlist', bizErr.status === 500 && /^Insufficient stock/.test(bizErr.json?.error || ''));
  } finally {
    await db.query(`DELETE FROM users WHERE name = '__regression_sm'`);
    await db.query(`DELETE FROM platform.users WHERE name = '__regression_sm'`);
    await db.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n══════════ RESULT: ${failed.length === 0 ? '✅ ALL PASS' : `❌ ${failed.length} FAILED`} (${results.length} checks) ══════════`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Regression error:', e);
  process.exit(1);
});
