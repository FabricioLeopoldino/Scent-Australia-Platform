#!/usr/bin/env node
/*
 * D14.9 — SM/MUSE catalog re-key onto the D14 oil model.
 * Plan: ../../D14.9_CATALOG_RESET.md. Owner decisions (2026-07-28):
 *   · 5 codeless fragrances  → leave oil_id NULL (resolve oil on first production)
 *   · 3 test variants        → delete (only if zero footprint)
 *   · rehearse on a Neon BRANCH first, then the primary in a maintenance window
 *
 * What it does (DATA ONLY — never writes to `sa`):
 *   For every real MUSE variant, set products.oil_id from the CSV mapping,
 *   matched by the variant's existing store SKU. fragrance_id / muse_master_fragrances
 *   / the legacy FRAG_* catalog are LEFT UNTOUCHED (superseded by oil_id via the
 *   D14/D16 code path; cleanup is a later optional phase). SKU and current_stock are
 *   NEVER mutated. Idempotent: only fills oil_id where it is currently NULL.
 *
 * SAFETY:
 *   · Refuses to run unless D149_DATABASE_URL is set explicitly (no accidental prod).
 *   · Dry-run by default — wraps everything in a transaction and ROLLS BACK.
 *     Pass --commit to COMMIT. Even with --commit, all pre/post asserts must pass
 *     or it rolls back and exits 1.
 *
 * Usage:
 *   D149_DATABASE_URL="postgres://…<branch>…" node scripts/reset-d14-9.cjs           # dry-run
 *   D149_DATABASE_URL="postgres://…<branch>…" node scripts/reset-d14-9.cjs --commit  # apply
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const COMMIT = process.argv.includes('--commit');
const DB = process.env.D149_DATABASE_URL;
if (!DB) {
  console.error('REFUSING TO RUN: set D149_DATABASE_URL to the target (a Neon branch first).');
  process.exit(2);
}
const CSV = path.join(__dirname, '..', '..', 'SKU_mapping_MUSE.csv');
const TEST_SKUS = ['Muse_RDTEST00001', 'Muse_RDTEST00002', 'Muse_CANDLEG00001'];
const T = (s) => (s == null ? '' : String(s)).trim();

function parseCsv() {
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return { code: T(c[0]), name: T(c[1]), skus: [T(c[5]), T(c[6]), T(c[7])].filter(Boolean) };
  }).filter((r) => r.name);
}

function fail(msg) { console.error('  ✗ ' + msg); throw new Error(msg); }
function ok(msg) { console.log('  ✓ ' + msg); }

(async () => {
  const pool = new Pool({ connectionString: DB.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let applied = false;
  try {
    const rows = parseCsv();
    const withCode = rows.filter((r) => r.code);
    const codeless = rows.filter((r) => !r.code);
    const csvSkus = new Set(rows.flatMap((r) => r.skus));
    const skuToCode = {};
    for (const r of rows) for (const s of r.skus) skuToCode[s] = r.code; // '' for codeless
    const codes = [...new Set(withCode.map((r) => r.code))];

    console.log(`\nD14.9 reset — ${COMMIT ? 'COMMIT' : 'DRY-RUN'}  (target: ${DB.replace(/:[^:@/]+@/, ':***@')})`);
    console.log(`CSV: ${rows.length} rows, ${codeless.length} codeless, ${csvSkus.size} SKUs, ${codes.length} distinct codes\n`);

    // ── Step 0 — pre-flight (read-only asserts) ──────────────────────────
    console.log('Step 0 — pre-flight:');
    const oil = await client.query(`SELECT "productCode" pc, id FROM sa.products WHERE category='OILS' AND "productCode" = ANY($1)`, [codes]);
    const codeToOil = {};
    for (const r of oil.rows) codeToOil[r.pc] = r.id;
    const unresolved = codes.filter((c) => !codeToOil[c]);
    if (unresolved.length) fail(`codes not resolving to an sa OILS row: ${unresolved.join(', ')}`);
    ok(`all ${codes.length} codes resolve to sa OILS`);

    const variants = (await client.query(
      `SELECT id, sku, oil_id, current_stock, master_product_id, fragrance_id FROM sm.products
       WHERE segment='MUSE' AND master_product_id IS NOT NULL AND archived=false`
    )).rows;
    const realVariants = variants.filter((v) => !TEST_SKUS.includes(v.sku));
    const testVariants = variants.filter((v) => TEST_SKUS.includes(v.sku));
    ok(`${variants.length} MUSE variants (${realVariants.length} real, ${testVariants.length} test)`);

    // every real variant's SKU must be in the CSV (nothing lost/invented)
    const varSkus = new Set(realVariants.map((v) => v.sku));
    const missing = [...csvSkus].filter((s) => !varSkus.has(s));
    const extra = [...varSkus].filter((s) => !csvSkus.has(s));
    if (missing.length) fail(`${missing.length} CSV SKUs missing on variants: ${missing.slice(0, 5).join(', ')}…`);
    if (extra.length) fail(`${extra.length} non-CSV real variant SKUs: ${extra.slice(0, 5).join(', ')}…`);
    ok('real-variant SKU set == CSV SKU set exactly');

    const stockSnapshot = Object.fromEntries(variants.map((v) => [v.sku, Number(v.current_stock || 0)]));

    // ── mutations inside one transaction ─────────────────────────────────
    await client.query('BEGIN');

    // Step 1 — delete the 3 test variants (only if zero footprint)
    console.log('Step 1 — remove test variants:');
    for (const tv of testVariants) {
      const refs = (await client.query(
        `SELECT
           (SELECT count(*) FROM sm.transactions WHERE product_id = $1)::int AS tx,
           (SELECT count(*) FROM sm.production_order_lines WHERE fragrance_id = $1 OR packaging_component_id = $1)::int AS pol`,
        [tv.id]
      )).rows[0];
      if (refs.tx > 0 || refs.pol > 0) { console.log(`  · KEPT ${tv.sku} (footprint: ${refs.tx} tx, ${refs.pol} order-lines) — not deleting`); continue; }
      // Delete the variant's master↔fragrance link first, else it dangles (the
      // (master, fragrance) pair is 1:1 with the variant via idx_variant_uniq).
      if (tv.fragrance_id) await client.query(`DELETE FROM sm.muse_master_fragrances WHERE master_product_id = $1 AND fragrance_id = $2`, [tv.master_product_id, tv.fragrance_id]);
      await client.query(`DELETE FROM sm.products WHERE id = $1`, [tv.id]);
      ok(`deleted ${tv.sku} + its master link (zero footprint)`);
    }

    // Step 3 — set oil_id from the SKU→code→oil map (idempotent: only where NULL)
    console.log('Step 3 — set variant.oil_id:');
    let set = 0, leftNull = 0;
    for (const v of realVariants) {
      const code = skuToCode[v.sku];
      const oilId = code ? codeToOil[code] : null;
      if (oilId) {
        const r = await client.query(`UPDATE sm.products SET oil_id = $1 WHERE id = $2 AND oil_id IS NULL`, [oilId, v.id]);
        set += r.rowCount;
      } else {
        leftNull++; // codeless → stays NULL by design
      }
    }
    ok(`oil_id set on ${set} variants; ${leftNull} codeless left NULL`);

    // ── Step 5 — post-flight asserts (against live tx state) ─────────────
    console.log('Step 5 — post-flight:');
    const after = (await client.query(
      `SELECT id, sku, oil_id, current_stock FROM sm.products
       WHERE segment='MUSE' AND master_product_id IS NOT NULL AND archived=false`
    )).rows.filter((v) => !TEST_SKUS.includes(v.sku));

    // SKU set + stock unchanged
    for (const v of after) {
      if (stockSnapshot[v.sku] !== Number(v.current_stock || 0)) fail(`stock changed for ${v.sku}`);
    }
    ok('current_stock unchanged for every variant');
    const afterSkus = new Set(after.map((v) => v.sku));
    if ([...csvSkus].some((s) => !afterSkus.has(s))) fail('a CSV SKU went missing');
    ok('every CSV SKU still present');

    // coded variants linked; codeless NULL
    const codelessSkus = new Set(codeless.flatMap((r) => r.skus));
    let badLink = 0, badNull = 0;
    for (const v of after) {
      const shouldLink = !!skuToCode[v.sku] && !codelessSkus.has(v.sku);
      if (shouldLink && !v.oil_id) badLink++;
      if (codelessSkus.has(v.sku) && v.oil_id) badNull++;
    }
    if (badLink) fail(`${badLink} coded variants missing oil_id`);
    if (badNull) fail(`${badNull} codeless variants unexpectedly linked`);
    ok('coded variants linked; codeless variants NULL');

    // oil_id references a real sa OILS row
    const dangling = (await client.query(
      `SELECT count(*)::int n FROM sm.products v
       WHERE v.oil_id IS NOT NULL AND v.segment='MUSE'
       AND NOT EXISTS (SELECT 1 FROM sa.products o WHERE o.id = v.oil_id AND o.category='OILS')`
    )).rows[0].n;
    if (dangling) fail(`${dangling} variants have oil_id not pointing at an sa OILS row`);
    ok('every set oil_id references a real sa OILS row');

    // no orphaned master↔fragrance link (would fail integrity-sm) — guards the
    // test-variant deletion above from leaving a dangling muse_master_fragrances row
    const orphanLinks = (await client.query(
      `SELECT count(*)::int n FROM sm.muse_master_fragrances mmf
       WHERE NOT EXISTS (SELECT 1 FROM sm.products p WHERE p.master_product_id = mmf.master_product_id AND p.fragrance_id = mmf.fragrance_id)`
    )).rows[0].n;
    if (orphanLinks) fail(`${orphanLinks} muse_master_fragrances links have no variant`);
    ok('every muse_master_fragrances link still has its variant');

    if (COMMIT) { await client.query('COMMIT'); applied = true; console.log('\n✅ COMMITTED.'); }
    else { await client.query('ROLLBACK'); console.log('\n↩️  DRY-RUN rolled back (pass --commit to apply).'); }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\n❌ FAILED — rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
  if (process.exitCode === 1 && applied) process.exitCode = 1;
})();
