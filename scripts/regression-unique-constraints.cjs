// Proves the database itself now refuses two things the code only assumed.
//
// WHY THIS EXISTS (2026-08-11).
//
// SKU. The Shopify order matcher does `WHERE p.sku = $1` and uses whatever row
// comes back. With two rows an arbitrary one wins: wrong product made, wrong oil
// debited, nothing raised. integrity-sm has always REPORTED duplicates, but
// reporting only helps if somebody runs it — nothing stopped one being created.
// That stopped being academic the day the owner said new SKUs would be typed by
// hand for each new fragrance.
//
// Partial on purpose: ACTIVE products only. An archived row may legitimately
// keep the SKU of whatever replaced it — the Saffron & Oakmoss retirement on the
// same day did exactly that, and a blanket unique index would have blocked it.
//
// JOBS. manufacturing.js checks jobExists before starting and only one statement
// in the codebase inserts a job, so one order has always meant one job — by
// convention. A second job means the whole BOM is debited twice.
//
// Runs inside a transaction and ROLLS BACK, so nothing survives, and each
// expected failure is isolated by a SAVEPOINT: without one, the first rejection
// aborts the transaction and every later statement fails with 25P02, which
// looks exactly like a second, stricter rejection. That misread happened while
// writing this.
//
// Run: node scripts/regression-unique-constraints.cjs
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.PLATFORM_DATABASE_URL) { console.error('PLATFORM_DATABASE_URL required.'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

const TAG = `ZZUQ${String(Date.now()).slice(-7)}`;
const SKU = `${TAG}_S`;              // products.sku is varchar(20)
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Run a statement expected to fail, without poisoning the transaction.
const expectFail = async (c, name, fn) => {
  await c.query(`SAVEPOINT ${name}`);
  try { await fn(); return null; }
  catch (e) { await c.query(`ROLLBACK TO ${name}`); return e; }
};

(async () => {
  const c = await pool.connect();
  const insProduct = (code, sku, archived) => c.query(
    `INSERT INTO products (name, product_code, sku, category, unit, current_stock, archived)
     VALUES ($1,$2,$3,'COMPONENT','units',0,$4)`, [`${TAG} ${code}`, `${TAG}${code}`, sku, archived]);

  try {
    await c.query('BEGIN');

    console.log('\nThe indexes exist');
    const idx = (await c.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='sm'
        AND indexname IN ('uq_products_sku_active','uq_production_jobs_order')`)).rows.map((r) => r.indexname);
    check(idx.includes('uq_products_sku_active'), 'uq_products_sku_active is present');
    check(idx.includes('uq_production_jobs_order'), 'uq_production_jobs_order is present');

    console.log('\nSKU — one active product per SKU');
    await insProduct('A', SKU, false);
    check(true, 'the first active product takes the SKU');
    const dup = await expectFail(c, 'sp_sku', () => insProduct('B', SKU, false));
    check(dup?.code === '23505', 'a second ACTIVE product with the same SKU is refused',
      dup ? `${dup.code} ${dup.constraint}` : 'it was ACCEPTED — the index is not protecting');
    check(dup?.constraint === 'uq_products_sku_active', 'and it is this index that refuses it', dup?.constraint);

    const arch = await expectFail(c, 'sp_arch', () => insProduct('C', SKU, true));
    check(arch === null, 'an ARCHIVED product may keep the same SKU — retirement must stay possible',
      arch ? `${arch.code} — the rule is stricter than intended` : '');

    console.log('\nJobs — one production job per order');
    const orderId = (await c.query(
      `INSERT INTO production_orders (order_number, order_type, status) VALUES ($1,'STANDARD','draft') RETURNING id`,
      [`${TAG}-O`])).rows[0].id;
    await c.query(`INSERT INTO production_jobs (production_order_id, status) VALUES ($1,'in_production')`, [orderId]);
    check(true, 'the first job starts');
    const dupJob = await expectFail(c, 'sp_job', () =>
      c.query(`INSERT INTO production_jobs (production_order_id, status) VALUES ($1,'in_production')`, [orderId]));
    check(dupJob?.code === '23505', 'a second job on the same order is refused — no double BOM debit',
      dupJob ? `${dupJob.code} ${dupJob.constraint}` : 'it was ACCEPTED');

    await c.query('ROLLBACK');
    console.log('\nrolled back — no rows kept');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    console.error(`\nFATAL ${e.message}`);
    failed++;
  } finally {
    c.release();
    await pool.end();
  }

  console.log(failed === 0 ? '\n✅ unique-constraints: all checks passed' : `\n❌ ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
