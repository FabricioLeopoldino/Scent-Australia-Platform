// Guards the rule that keeps business_unit and segment from disagreeing.
//
// WHY THIS EXISTS (owner decision, 2026-08-14). "What did the Library sell this
// month, and what did the Archive sell?" could not be answered: both are
// segment = 'MUSE', 454 finished goods in one bucket. segment could not be
// stretched to answer it because it already means four things — MUSE (the
// Library), STANDARD (the legacy Scented Merchandise catalogue), MAJOR (client
// work), null (legacy rows) — and it decides OIL RULES AND PRODUCTION.
//
// So reporting got its own field. Two fields that describe overlapping things
// can disagree, and the fix for that is the same one that worked for canUseOil:
// a written rule, in one place, with something that fails when it is broken.
//
//     segment        decides oil and production
//     business_unit  decides reporting
//     library|archive  =>  segment must be MUSE
//     atelier          =>  segment must NOT be MUSE
//     anything with a SKU must carry one
//     materials carry none
//
// This proves each of those actually fails when violated. A rule nobody can
// break is usually a rule that is not being checked.
//
// Uses a transaction and rolls back. Production is never modified.
//
// Run: node scripts/regression-business-unit.cjs
require('dotenv').config();
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');

const ROOT = join(__dirname, '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// The rules as integrity-sm states them. Kept here as the QUERIES it runs, so a
// rule quietly deleted from the battery shows up as a failure here.
const RULES = {
  'unknown value': `SELECT count(*) n FROM products WHERE business_unit IS NOT NULL
                      AND business_unit NOT IN ('library','archive','atelier')`,
  'library/archive outside MUSE': `SELECT count(*) n FROM products
                      WHERE business_unit IN ('library','archive') AND segment <> 'MUSE'`,
  'atelier inside MUSE': `SELECT count(*) n FROM products
                      WHERE business_unit = 'atelier' AND segment = 'MUSE'`,
  'sellable without a unit': `SELECT count(*) n FROM products WHERE sku IS NOT NULL
                      AND COALESCE(archived,false)=false AND business_unit IS NULL`,
  'material with a unit': `SELECT count(*) n FROM products WHERE business_unit IS NOT NULL
                      AND category IN ('COMPONENT','RAW_MATERIAL','LABEL')`,
};

(async () => {
  console.log('\n1. The battery still carries every rule');
  const battery = src('scripts/integrity-sm.cjs');
  for (const [label, needle] of [
    ['unknown values', "business_unit NOT IN ('library','archive','atelier')"],
    ['library/archive under MUSE', "business_unit IN ('library','archive') AND segment <> 'MUSE'"],
    ['atelier not under MUSE', "business_unit = 'atelier' AND segment = 'MUSE'"],
    ['sellable carries one', 'sku IS NOT NULL'],
    ['materials carry none', "category IN ('COMPONENT','RAW_MATERIAL','LABEL')"],
  ]) check(battery.includes(needle), `integrity-sm still checks ${label}`);

  console.log('\n2. Registration cannot create a row that breaks the rule');
  const route = src('server/sm/routes/muse-fragrance.js');
  check(/business_unit/.test(route), 'the registration route sets business_unit');
  check(/\['library', 'archive'\]\.includes\(unit\)/.test(route),
    "it refuses anything but 'library' or 'archive'");
  // This route always writes segment 'MUSE', so accepting 'atelier' here would
  // create precisely the row integrity-sm fails on.
  check(/segment[\s\S]{0,200}'MUSE'/.test(route), "and it always writes segment 'MUSE'");
  check(/=== '' \? 'library'/.test(route) || /\? 'library'/.test(route),
    'an omitted value defaults to library, never to null');

  const pool = new Pool({
    connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('\n3. Real data satisfies every rule right now');
    for (const [label, sql] of Object.entries(RULES)) {
      check(Number((await client.query(sql)).rows[0].n) === 0, `no ${label}`);
    }

    console.log('\n4. Each rule actually fails when broken');
    // A real MUSE variant to corrupt, then roll back.
    const victim = (await client.query(
      `SELECT id FROM products WHERE segment='MUSE' AND category='FINISHED_GOOD'
        AND business_unit='library' LIMIT 1`)).rows[0];
    check(!!victim, 'a MUSE product exists to test with');

    const breaks = async (label, set, rule) => {
      await client.query(`SAVEPOINT s`);
      await client.query(`UPDATE products SET ${set} WHERE id = $1`, [victim.id]);
      const n = Number((await client.query(RULES[rule])).rows[0].n);
      await client.query(`ROLLBACK TO SAVEPOINT s`);
      check(n > 0, label, `rule "${rule}" did not fire`);
    };
    await breaks("a typo'd unit is caught", `business_unit = 'libary'`, 'unknown value');
    await breaks('library under the wrong segment is caught', `segment = 'STANDARD'`, 'library/archive outside MUSE');
    await breaks('atelier under MUSE is caught', `business_unit = 'atelier'`, 'atelier inside MUSE');
    await breaks('a sellable row with no unit is caught', `business_unit = NULL`, 'sellable without a unit');
    await breaks('a material given a unit is caught', `category = 'COMPONENT'`, 'material with a unit');

    await client.query('ROLLBACK');

    console.log('\n5. Where the range actually sits');
    const dist = (await pool.query(
      `SELECT COALESCE(business_unit,'(none)') b, count(*) n FROM products
        WHERE COALESCE(archived,false)=false GROUP BY 1 ORDER BY 2 DESC`)).rows;
    for (const r of dist) console.log(`     ${String(r.b).padEnd(9)} ${String(r.n).padStart(4)}`);
    check(dist.some((r) => r.b === 'library' && Number(r.n) > 0), 'the Library is populated');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(failed === 0 ? '\n✅ business-unit: all checks passed' : `\n❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
