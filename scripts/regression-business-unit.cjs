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
  // Added 2026-09-16. The collection is a fact about the FRAGRANCE — the Archive
  // is ten fragrances, each sold across every format. A fragrance whose Reed
  // Diffuser is Archive and whose Room Spray is Library reports wrong, and does
  // so silently: no total looks odd until someone adds two of them together.
  // Not in integrity-sm yet, so it is checked here.
  'fragrance split across collections': `SELECT count(*) n FROM (
                      SELECT oil_id FROM products
                       WHERE segment='MUSE' AND category='FINISHED_GOOD' AND oil_id IS NOT NULL
                       GROUP BY oil_id HAVING count(DISTINCT business_unit) > 1) x`,
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

    console.log('\n5. A fragrance can be moved between the collections, and moves whole');
    // WHY (2026-09-16). Registration was already right; there was no way back.
    // The screen's toggle defaults to Library, the ten Archive fragrances
    // register in one sitting, and a missed toggle was permanent — correctable
    // only by editing the database by hand. PATCH /muse-fragrance/:oilId/collection
    // is the way back, and the property that matters is that it moves ALL
    // formats of a fragrance at once: an Archive Reed Diffuser whose Room Spray
    // stayed in the Library is a reporting fault nobody would see until a total
    // came out wrong.
    //
    // This exercises the STATEMENT the endpoint runs, inside the same
    // transaction, and rolls it back. The HTTP layer above it — the role check,
    // the refusal of 'atelier', the audit row — is asserted from the source,
    // not run.
    const patch = src('server/sm/routes/muse-fragrance.js');
    check(/router\.patch\('\/muse-fragrance\/:oilId\/collection'/.test(patch),
      'the correction endpoint exists');
    check(/muse_collection_changed/.test(patch), 'it writes its own audit entry');
    // Scoped to the new route's own body. Grepping the whole file matched the
    // registration route's identical message, so this passed even with the
    // correction endpoint's guard deleted — false confidence on the one line
    // that keeps 'atelier' out of a segment-MUSE row.
    const collectionBody = (patch.split("router.patch('/muse-fragrance/:oilId/collection'")[1] || '')
      .split('\nrouter.')[0];
    check(/business_unit must be 'library' or 'archive'/.test(collectionBody),
      "it refuses anything but 'library' or 'archive', atelier included");
    // From the route line forward only. Starting 200 characters EARLIER put the
    // comment block above the route inside the window — the same false
    // confidence fixed one check above, reintroduced by the fix.
    check(/^[^\n]*requireRole\('admin', 'root'\)/.test(
      patch.slice(patch.indexOf("router.patch('/muse-fragrance/:oilId/collection'"))),
      'and it is admin-only');
    check(/oil_id = \$2 AND segment = 'MUSE' AND category = 'FINISHED_GOOD'/.test(patch),
      'it is keyed on the oil, so every format moves together');

    // Counted over exactly the rows the endpoint's UPDATE touches — archived
    // included. Excluding them here made `moved > n` on any fragrance with an
    // archived format, which reads as a failure of a working endpoint.
    // The fragrance's own collection is read rather than assumed: hardcoding
    // 'library' would fail this test the day an Archive fragrance becomes the
    // one with the most formats, on perfectly healthy data.
    // The same split, reachable from the other side: re-pointing a variant at a
    // different fragrance used to leave it in its old collection. Fixed in the
    // relink endpoint rather than in this screen, so every caller is covered.
    const relink = src('server/sm/routes/products.js');
    check(/business_unit = COALESCE\(\$3, business_unit\)/.test(relink),
      'relinking a variant to another fragrance adopts that fragrance’s collection');

    const frag = (await client.query(
      `SELECT oil_id, count(*) n, min(business_unit) unit, count(DISTINCT business_unit) units
         FROM products
        WHERE segment='MUSE' AND category='FINISHED_GOOD' AND oil_id IS NOT NULL
        GROUP BY 1 HAVING count(*) > 1 AND count(DISTINCT business_unit) = 1
                      AND count(*) = count(business_unit)
        ORDER BY 2 DESC LIMIT 1`)).rows[0];
    // count(*) = count(business_unit) excludes a fragrance carrying a NULL row.
    // count(DISTINCT) ignores NULLs, so such a fragrance passed the selection and
    // then failed the restore check, which sees library AND null — a red test on
    // healthy data.
    check(!!frag, 'a fragrance exists that is sold in more than one format');

    if (frag) {
      // Move it to whichever collection it is NOT in, so the test works the same
      // once the Archive is populated.
      const target = frag.unit === 'archive' ? 'library' : 'archive';
      await client.query(`SAVEPOINT move`);
      const moved = (await client.query(
        `UPDATE products SET business_unit = $2
          WHERE oil_id = $1 AND segment = 'MUSE' AND category = 'FINISHED_GOOD'
          RETURNING id`, [frag.oil_id, target])).rows.length;
      check(moved === Number(frag.n),
        `all ${frag.n} formats of one fragrance move together`, `${moved} moved`);

      const split = Number((await client.query(
        `SELECT count(DISTINCT business_unit) n FROM products
          WHERE oil_id = $1 AND segment='MUSE' AND category='FINISHED_GOOD'`,
        [frag.oil_id])).rows[0].n);
      check(split === 1, 'the fragrance is not left split across two collections');

      for (const [label, sql] of Object.entries(RULES)) {
        check(Number((await client.query(sql)).rows[0].n) === 0,
          `still no ${label} after the move`);
      }
      await client.query(`ROLLBACK TO SAVEPOINT move`);
      const back = (await client.query(
        `SELECT DISTINCT business_unit b FROM products WHERE oil_id = $1
          AND segment='MUSE' AND category='FINISHED_GOOD'`, [frag.oil_id])).rows;
      check(back.length === 1 && back[0].b === frag.unit,
        'and the test leaves the fragrance exactly as it found it',
        `expected ${frag.unit}, found ${back.map((r) => r.b).join('/')}`);
    }

    await client.query('ROLLBACK');

    console.log('\n6. Where the range actually sits');
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
