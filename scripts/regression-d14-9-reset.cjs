#!/usr/bin/env node
/*
 * D14.9 verification gate — READ-ONLY. Run after the reset (on the branch, then
 * on the primary) to prove the invariants hold. Exit 1 on any failure.
 * Scope matches the executed reset (data-only oil_id fill; legacy fragrance_id /
 * FRAG_* / muse_master_fragrances deliberately kept — NOT asserted cleared).
 *
 * DB: D149_DATABASE_URL if set, else PLATFORM_DATABASE_URL from platform/.env.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const TEST_SKUS = ['Muse_RDTEST00001', 'Muse_RDTEST00002', 'Muse_CANDLEG00001'];
const T = (s) => (s == null ? '' : String(s)).trim();

function dbUrl() {
  if (process.env.D149_DATABASE_URL) return process.env.D149_DATABASE_URL;
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const m = env.match(/^PLATFORM_DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
  if (!m) throw new Error('no DB url (set D149_DATABASE_URL or PLATFORM_DATABASE_URL)');
  return m[1];
}
function parseCsv() {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'SKU_mapping_MUSE.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(1).map((l) => { const c = l.split(','); return { code: T(c[0]), name: T(c[1]), skus: [T(c[5]), T(c[6]), T(c[7])].filter(Boolean) }; }).filter((r) => r.name);
}

let failed = 0;
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed++; };

(async () => {
  const pool = new Pool({ connectionString: dbUrl().replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  try {
    const rows = parseCsv();
    const csvSkus = new Set(rows.flatMap((r) => r.skus));
    const codelessSkus = new Set(rows.filter((r) => !r.code).flatMap((r) => r.skus));
    const codedSkus = new Set(rows.filter((r) => r.code).flatMap((r) => r.skus));

    const variants = (await pool.query(
      `SELECT id, sku, oil_id FROM sm.products
       WHERE segment='MUSE' AND master_product_id IS NOT NULL AND archived=false`
    )).rows;
    const bySku = new Map();
    for (const v of variants) bySku.set(v.sku, (bySku.get(v.sku) || 0) + 1);

    console.log('D14.9 reset gate:');

    // 1. test variants removed, or (if kept for having test history) inert: no oil_id
    const keptTest = TEST_SKUS.filter((s) => bySku.has(s));
    const activeTest = keptTest.filter((s) => (variants.find((v) => v.sku === s) || {}).oil_id);
    check(activeTest.length === 0, `test variants gone or inert [${keptTest.length} kept, ${activeTest.length} with oil_id]`);

    // 2. every CSV SKU present, exactly once (D13 fulfillment matches by SKU)
    const absent = [...csvSkus].filter((s) => !bySku.has(s));
    const dup = [...csvSkus].filter((s) => (bySku.get(s) || 0) > 1);
    check(absent.length === 0, `every CSV SKU present (${absent.length} missing)`);
    check(dup.length === 0, `every CSV SKU resolves to exactly one variant (${dup.length} duplicated)`);

    // 3. coded variants linked; 4. codeless NULL
    const coded = variants.filter((v) => codedSkus.has(v.sku));
    const codelessV = variants.filter((v) => codelessSkus.has(v.sku));
    const codedUnlinked = coded.filter((v) => !v.oil_id).length;
    const codelessLinked = codelessV.filter((v) => v.oil_id).length;
    check(codedUnlinked === 0, `all ${coded.length} coded variants have oil_id (${codedUnlinked} missing)`);
    check(codelessLinked === 0, `all ${codelessV.length} codeless variants are NULL (${codelessLinked} unexpectedly linked)`);

    // 5. no dangling oil_id (must reference a real sa OILS row)
    const dangling = (await pool.query(
      `SELECT count(*)::int n FROM sm.products v
       WHERE v.oil_id IS NOT NULL AND v.segment='MUSE'
       AND NOT EXISTS (SELECT 1 FROM sa.products o WHERE o.id = v.oil_id AND o.category='OILS')`
    )).rows[0].n;
    check(dangling === 0, `every set oil_id references a real sa OILS row (${dangling} dangling)`);

    console.log(failed === 0 ? '\nPASS' : `\nFAIL — ${failed} check(s)`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('ERROR', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
