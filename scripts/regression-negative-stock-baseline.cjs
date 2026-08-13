// Guards the negative-stock exemption list in integrity-sm.cjs.
//
// WHY THIS EXISTS (2026-08-13, Block G). Ten components have never been
// physically counted. They opened at zero, so the first real MUSE order (#1021,
// 2 reed diffusers + 1 travel spray) drove them negative. The integrity battery
// failed on them every single run — and a check that is always red is a check
// nobody reads, which means a NEW negative, the one worth acting on, would not
// have stood out at all.
//
// So the ten are exempt until they are counted. That fix carries its own risk:
// an exemption list is the easiest thing in a codebase to quietly extend until
// it covers everything. This file is what stops that.
//
// Two things are asserted:
//   1. A negative on a product NOT in the list still fails. The alarm works.
//   2. Every code in the list is actually negative right now. A code that has
//      returned to zero or above has been counted, so it must be REMOVED —
//      otherwise the list rots into a permanent blind spot.
//
// Uses a transaction and rolls back. Production is never modified.
//
// Run: node scripts/regression-negative-stock-baseline.cjs
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

// Read the list from the battery itself — a copy here would drift, which is the
// bug class that produced the webhook-topic and format-list defects this week.
const src = readFileSync(join(ROOT, 'scripts/integrity-sm.cjs'), 'utf8');
const block = src.match(/const UNCOUNTED = \[([\s\S]*?)\];/);
const UNCOUNTED = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

const NEG_SQL = (codes) => `
  SELECT COUNT(*) n FROM products v
   WHERE v.current_stock < 0
     AND v.product_code <> ALL ('{${codes.join(',')}}'::text[])
     AND NOT (v.master_product_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM products m WHERE m.id = v.master_product_id AND m.segment = 'MUSE'))`;

(async () => {
  console.log('\n1. The exemption list is readable and bounded');
  check(UNCOUNTED.length > 0, 'UNCOUNTED parsed from integrity-sm.cjs', `got ${UNCOUNTED.length}`);
  // A hard ceiling. Not arbitrary: it is the count on the day the list was
  // created. Growing it is a deliberate act that has to come here and say so.
  check(UNCOUNTED.length <= 10,
    'the list has not grown past its original ten', `now ${UNCOUNTED.length}`);

  const pool = new Pool({
    connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('\n2. Nothing outside the list is negative today');
    check(Number((await client.query(NEG_SQL(UNCOUNTED))).rows[0].n) === 0,
      'the battery passes on real data');

    console.log('\n3. A NEW negative still fails — the alarm is not silenced');
    // COMP_00019 (the refill vessel) is deliberately not exempt.
    const victim = (await client.query(
      `SELECT product_code FROM products
        WHERE category IN ('COMPONENT','RAW_MATERIAL') AND current_stock >= 0
          AND product_code <> ALL ($1::text[]) LIMIT 1`, [UNCOUNTED])).rows[0];
    check(!!victim, 'a non-exempt component exists to test with');
    if (victim) {
      await client.query(`UPDATE products SET current_stock = -5 WHERE product_code = $1`,
        [victim.product_code]);
      check(Number((await client.query(NEG_SQL(UNCOUNTED))).rows[0].n) === 1,
        `${victim.product_code} at -5 is caught`);
    }

    console.log('\n4. An exempt one drifting further stays quiet, by design');
    await client.query(`UPDATE products SET current_stock = 0 WHERE product_code = $1`,
      [victim.product_code]);
    await client.query(`UPDATE products SET current_stock = -999 WHERE product_code = $1`,
      [UNCOUNTED[0]]);
    check(Number((await client.query(NEG_SQL(UNCOUNTED))).rows[0].n) === 0,
      `${UNCOUNTED[0]} at -999 does not fail the battery`);

    await client.query('ROLLBACK');

    console.log('\n5. No exempted code has been counted yet');
    // The moment one goes non-negative it has a real number behind it, and
    // leaving it exempt would hide a genuine fault from then on.
    const counted = (await client.query(
      `SELECT product_code, current_stock FROM products
        WHERE product_code = ANY($1::text[]) AND current_stock >= 0`, [UNCOUNTED])).rows;
    check(counted.length === 0,
      'every exempted code is still negative, so the exemption is still earned',
      counted.map((r) => `${r.product_code} is now ${r.current_stock} — REMOVE it from UNCOUNTED`).join('; '));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(failed === 0 ? '\n✅ negative-stock-baseline: all checks passed' : `\n❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
