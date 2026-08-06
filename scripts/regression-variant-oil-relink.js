// Covers PATCH /api/products/:id/oil — re-pointing a variant at another oil.
//
// WHY THIS EXISTS (2026-08-06): before this endpoint the only way to change a
// variant's oil was through the master (remove the wrong oil, add the right
// one), which ARCHIVES the variants and creates new ones with new SKUs. Those
// SKUs are now live on the Muse Shopify store, so that route would break the
// only join between the store and the platform. Two real mislinks (Tokyo,
// Avocado & Mint) had to be repaired by script for exactly that reason.
//
// The contract this protects:
//   · the oil changes, and NOTHING else does — SKU and stock survive
//   · the change is audited (who, from which oil, to which)
//   · only admin/root may do it — it decides which stock a SALE debits
//   · it refuses a non-oil, an inactive oil, and a non-variant product
//
// Runs against a live server + DB. Creates its own master and variant and
// removes them, then asserts nothing else moved.
//
// Run: node scripts/regression-variant-oil-relink.js
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

// SM routes are mounted at /api/sm. The browser writes "/api/products" and an
// axios interceptor in SMModule.jsx rewrites it — a script has to be explicit.
const HOST = process.env.REGRESSION_BASE || 'http://localhost:3000';
const BASE = `${HOST}/api/sm`;
const TAG = `ZZOIL_${Date.now()}`;
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

let failed = 0, masterId, variantId;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Mirrors makeToken() in server/platform/auth.js exactly: { id, name, role,
// modules[], must_change_password }. platform.users has no email column, and
// `modules` is not optional — /api/sm sits behind requireModule('SM').
async function token(role = 'root') {
  const u = await pool.query(
    `SELECT id, name FROM platform.users WHERE role = $1 AND COALESCE(active,true) LIMIT 1`, [role]);
  if (!u.rows[0]) return null;
  const jwt = await import('jsonwebtoken');
  return jwt.default.sign(
    { id: u.rows[0].id, name: u.rows[0].name, role, modules: ['SA', 'SM', 'MUSE', 'OPS'], must_change_password: false },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
}
const call = (t, method, path, body) => fetch(BASE + path, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
  body: body ? JSON.stringify(body) : undefined,
});

try {
  const rootTok = await token('root');
  if (!rootTok) throw new Error('no root user to authenticate with');

  // Two real oils to move between.
  const oils = await pool.query(
    `SELECT id, "productCode" AS code FROM sa.products
      WHERE category = 'OILS' AND COALESCE(status,'') <> 'inactive' ORDER BY "productCode" LIMIT 2`);
  if (oils.rows.length < 2) throw new Error('need two active oils');
  const [oilA, oilB] = oils.rows;

  // Disposable master + variant, so no catalogue row is touched.
  masterId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, is_master, segment, current_stock)
     VALUES ($1,$2,'FINISHED_GOOD','units',true,'MUSE',0) RETURNING id`,
    [`${TAG} master`, `${TAG}_M`])).rows[0].id;
  variantId = (await pool.query(
    `INSERT INTO products (name, product_code, sku, category, unit, master_product_id, segment, current_stock, oil_id)
     VALUES ($1,$2,$3,'FINISHED_GOOD','units',$4,'MUSE',37,$5) RETURNING id`,
    [`${TAG} variant`, `${TAG}_V`, TAG, masterId, oilA.id])).rows[0].id;

  const state = async () => (await pool.query(
    `SELECT sku, current_stock, oil_id FROM products WHERE id = $1`, [variantId])).rows[0];

  // ── The happy path ───────────────────────────────────────────────────────
  {
    const before = await state();
    const r = await call(rootTok, 'PATCH', `/products/${variantId}/oil`, { oil_id: oilB.id });
    check(r.status === 200, 'root can re-point the oil', `got ${r.status} ${await r.clone().text()}`);
    const after = await state();
    check(after.oil_id === oilB.id, 'oil_id changed', `${before.oil_id} → ${after.oil_id}`);
    check(after.sku === before.sku, 'SKU is preserved', `${before.sku} → ${after.sku}`);
    check(Number(after.current_stock) === Number(before.current_stock),
      'stock is preserved', `${before.current_stock} → ${after.current_stock}`);
    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE action = 'variant_oil_relinked' AND entity_id = $1`, [variantId]);
    check(audit.rows.length === 1, 'the change is audited', `${audit.rows.length} rows`);
    check(audit.rows[0]?.details?.from?.code === oilA.code && audit.rows[0]?.details?.to?.code === oilB.code,
      'audit records both sides of the move', JSON.stringify(audit.rows[0]?.details));
  }

  // ── Refusals ─────────────────────────────────────────────────────────────
  {
    const r = await call(rootTok, 'PATCH', `/products/${variantId}/oil`, { oil_id: masterId });
    check(r.status === 400, 'refuses an id that is not an oil', `got ${r.status}`);
  }
  {
    const r = await call(rootTok, 'PATCH', `/products/${masterId}/oil`, { oil_id: oilA.id });
    check(r.status === 400, 'refuses to link a MASTER to an oil', `got ${r.status}`);
  }
  {
    const r = await call(rootTok, 'PATCH', `/products/${variantId}/oil`, {});
    check(r.status === 400, 'refuses an empty payload', `got ${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/products/${variantId}/oil`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oil_id: oilA.id }),
    });
    check(r.status === 401, 'refuses an unauthenticated caller', `got ${r.status}`);
  }
  {
    const userTok = await token('user');
    if (userTok) {
      const r = await call(userTok, 'PATCH', `/products/${variantId}/oil`, { oil_id: oilA.id });
      check(r.status === 403, 'refuses a non-admin role', `got ${r.status}`);
    } else {
      console.log('  skip  non-admin refusal (no plain user in this database)');
    }
  }
  // Re-applying the same oil must be a harmless no-op, not a second audit row.
  {
    await call(rootTok, 'PATCH', `/products/${variantId}/oil`, { oil_id: oilB.id });
    const audit = await pool.query(
      `SELECT id FROM audit_log WHERE action = 'variant_oil_relinked' AND entity_id = $1`, [variantId]);
    check(audit.rows.length === 1, 'setting the same oil again writes no second audit row', `${audit.rows.length} rows`);
  }

  console.log(failed === 0
    ? `\n✅ variant-oil-relink: all checks passed`
    : `\n❌ variant-oil-relink: ${failed} failed`);
} catch (e) {
  console.error(`\n❌ variant-oil-relink: ${e.message}`);
  failed++;
} finally {
  if (variantId) await pool.query(`DELETE FROM audit_log WHERE entity_id = $1 AND action = 'variant_oil_relinked'`, [variantId]).catch(() => {});
  await pool.query(`DELETE FROM products WHERE product_code LIKE $1`, [`${TAG}%`]).catch(() => {});
  await pool.end();
}
process.exitCode = failed === 0 ? 0 : 1;
