// ═══════════════════════════════════════════════════════════════════════════
// CUTOVER VERIFICATION — run right after a migration, against the LIVE app
// ═══════════════════════════════════════════════════════════════════════════
// The reconciliation gate proves the DATA landed. This proves the APPLICATION
// serves it: the SA module, MUSE/SM (which is NOT migrated and must survive
// untouched), the cross-system links, and the user id-alignment invariant.
//
// Run AFTER scripts/import-muse-catalog.cjs --reset-test (so regression
// fixtures don't skew the counts).
//
// Usage: REGRESSION_BASE=http://localhost:3010 node scripts/verify-cutover.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const B = process.env.REGRESSION_BASE || 'http://localhost:3000';
const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const pl = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false } });
const sa = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sa' });

const token = jwt.sign(
  { id: 1, name: 'Root', role: 'root', modules: ['SA', 'SM', 'MUSE'], must_change_password: false },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '15m' }
);
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const get = async (p) => (await fetch(B + p, { headers: H })).json();

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };

(async () => {
  // ── SA module serves the freshly migrated production data ────────────────
  const srcCount = (await sa.query(`SELECT COUNT(*)::int n FROM products`)).rows[0].n;
  const prods = await get('/api/sa/products');
  prods.length === srcCount
    ? ok('SA module serves every migrated product', `${prods.length} products`)
    : bad('SA product count', `API ${prods.length} vs DB ${srcCount}`);

  const stockSum = (await sa.query(`SELECT SUM("currentStock")::numeric s FROM products`)).rows[0].s;
  const apiSum = prods.reduce((a, p) => a + (parseFloat(p.currentStock) || 0), 0);
  Math.abs(apiSum - parseFloat(stockSum)) < 1
    ? ok('SA stock served matches the DB exactly', `${Number(stockSum).toLocaleString()} units`)
    : bad('stock sum mismatch', `API ${apiSum} vs DB ${stockSum}`);

  // Demand Planning — the heaviest SA query, must compute on real data
  const dp = await get('/api/sa/dashboard/replenishment');
  Array.isArray(dp.products) && dp.products.length > 0
    ? ok('Demand Planning computes on real data', `${dp.products.length} items`)
    : bad('Demand Planning returned nothing', JSON.stringify(dp).slice(0, 80));

  // ── MUSE/SM is NOT migrated — it must survive the SA re-migration intact ──
  const frags = await get('/api/sm/products?category=FRAGRANCE');
  frags.length === 124
    ? ok('MUSE catalog untouched by the SA migration', '124 fragrances')
    : bad('MUSE fragrance count', `${frags.length} (expected 124)`);

  const masters = await get('/api/sm/masters?segment=MUSE');
  masters.length === 3
    ? ok('MUSE masters intact', '3 masters (RD200/RS100/TS10)')
    : bad('MUSE masters', `${masters.length} (expected 3)`);

  const variants = (await pl.query(
    `SELECT COUNT(*)::int n FROM sm.products WHERE sku LIKE 'Muse\\_%' AND COALESCE(archived,false)=false`
  )).rows[0].n;
  variants === 372
    ? ok('MUSE store SKUs intact', '372 variants')
    : bad('MUSE variants', `${variants} (expected 372)`);

  // ── Cross-system links must still resolve against the FRESH sa ids ────────
  const links = await get('/api/platform/product-links');
  const broken = (await pl.query(
    `SELECT COUNT(*)::int n FROM platform.product_links l
     WHERE NOT EXISTS (SELECT 1 FROM sa.products p WHERE p.id = l.sa_product_id)`
  )).rows[0].n;
  broken === 0
    ? ok('SA↔SM links survive the re-migration', `${links.length} links, 0 broken`)
    : bad('broken links after migration', `${broken} of ${links.length}`);

  // ── Users: id-alignment invariant (the FK integrity of the whole platform) ─
  const users = (await pl.query(`SELECT COUNT(*)::int n FROM platform.users`)).rows[0].n;
  const orphans = (await pl.query(
    `SELECT COUNT(*)::int n FROM platform.users pu WHERE NOT EXISTS (SELECT 1 FROM sa.users su WHERE su.id = pu.id)`
  )).rows[0].n;
  orphans === 0
    ? ok('user id-alignment invariant holds', `${users} users, 0 orphans`)
    : bad('user id misalignment', `${orphans} orphans`);

  const smMirror = (await pl.query(
    `SELECT COUNT(*)::int n FROM platform.users pu WHERE NOT EXISTS (SELECT 1 FROM sm.users su WHERE su.id = pu.id)`
  )).rows[0].n;
  smMirror === 0
    ? ok('users mirrored into sm (FK integrity)', `${users} mirrored`)
    : bad('users missing from sm', `${smMirror}`);

  console.log(`\n══════ LIVE APP: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  await pl.end(); await sa.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); process.exit(1); });
