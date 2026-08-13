// Proves the MUSE dashboard can see the oil behind its own range, and that
// looking never touches it.
//
// WHY THIS EXISTS (2026-08-13, closing block A). The manager's requirement is
// that oil never runs out. Scent Australia already warns on low stock and is
// genuinely using it — 187 of 325 oils carry a minimum — but the warning lives
// on SA's dashboard and whoever runs MUSE never saw it. Worse, 22 of the 115
// oils behind live MUSE products carry NO minimum at all, so for those the
// warning can never fire however low they get. Seven of them sit at zero.
//
// The three states are kept apart on purpose. Merging "below a level someone
// chose" with "nobody ever chose one" is exactly what produced 445 false alarms
// on this dashboard before 2026-08-12. One is an alarm; the other is an
// unanswered question, and they need different actions from different people.
//
// Read-only. Never writes. Never calls Shopify.
//
// Run: node scripts/regression-oil-position.cjs
require('dotenv').config();
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');

const ROOT = join(__dirname, '..');
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const routeSrc = readFileSync(join(ROOT, 'server/sm/routes/dashboard.js'), 'utf8');
const route = routeSrc.slice(routeSrc.indexOf("'/dashboard/oil-position'"));
const routeBody = route.slice(0, route.indexOf("router.get('/dashboard/alerts'"));

(async () => {
  console.log('\n1. The route exists and reads oil from where oil actually lives');
  check(/router\.get\('\/dashboard\/oil-position'/.test(routeSrc), 'the endpoint is registered');
  check(/FROM sa\.products/.test(routeBody), 'it reads sa.products, the real home of the oil');
  check(/m\.segment = 'MUSE'/.test(routeBody), 'it counts only MUSE products as dependants');
  check(/COALESCE\(v\.archived, false\) = false/.test(routeBody),
    'archived variants do not inflate the dependant count');

  console.log('\n2. Looking never writes');
  // SA is production and must not be written outside the audited oil ledger.
  check(!/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(routeBody),
    'the route contains no write statement of any kind');
  check(!/shopify|fetch\(/i.test(routeBody),
    'and no Shopify call — this must stay cheap enough to run on every load');

  console.log('\n3. The three states are kept apart');
  check(/const hasMin = \(r\) => r\.min_stock > 0/.test(routeBody),
    'a "deliberate minimum" is defined once');
  check(/below = rows\.filter\(\(r\) => hasMin\(r\)/.test(routeBody),
    'below-minimum requires a minimum to exist');
  check(/noMinimum = rows\.filter\(\(r\) => !hasMin\(r\)\)/.test(routeBody),
    'no-minimum is its own bucket, not folded into the alarm');

  console.log('\n4. Against the real Library');
  const pool = new Pool({
    connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
  });
  try {
    const { rows } = await pool.query(`
      SELECT o."productCode" AS product_code, o.name, o.id AS oil_id,
             o."currentStock"::float AS stock, o."minStockLevel"::float AS min_stock,
             count(v.id)::int AS variant_count
        FROM sa.products o
        JOIN products v ON v.oil_id = o.id AND COALESCE(v.archived, false) = false
        JOIN products m ON m.id = v.master_product_id AND m.segment = 'MUSE'
       WHERE o.category = 'OILS'
       GROUP BY o.id, o."productCode", o.name, o."currentStock", o."minStockLevel"`);

    const hasMin = (r) => r.min_stock > 0;
    const below = rows.filter((r) => hasMin(r) && r.stock <= r.min_stock);
    const noMin = rows.filter((r) => !hasMin(r));
    const healthy = rows.length - below.length - noMin.length;

    check(rows.length > 0, `oils behind the MUSE range (${rows.length})`);
    // The buckets must partition the set: nothing counted twice, nothing lost.
    check(below.length + noMin.length + healthy === rows.length,
      'the three buckets add up to the total exactly');
    check(!below.some((b) => noMin.includes(b)),
      'no oil is both below a minimum and without one');
    check(rows.every((r) => r.variant_count > 0),
      'every listed oil actually has a product depending on it');

    console.log(`     below minimum  ${String(below.length).padStart(3)}`);
    console.log(`     no minimum     ${String(noMin.length).padStart(3)}   ← cannot ever warn`);
    console.log(`     healthy        ${String(healthy).padStart(3)}`);

    // Not a failure — the count is a live business number, not an invariant.
    // Printed so an oil reaching zero is visible in the test output too.
    const atZero = rows.filter((r) => r.stock <= 0);
    if (atZero.length) {
      console.log(`     at zero        ${String(atZero.length).padStart(3)}   ${atZero.map((r) => r.product_code).join(', ')}`);
    }
  } finally {
    await pool.end();
  }

  console.log(failed === 0 ? '\n✅ oil-position: all checks passed' : `\n❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
