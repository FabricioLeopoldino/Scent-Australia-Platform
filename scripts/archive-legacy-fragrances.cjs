#!/usr/bin/env node
/*
 * Phase B (Fragrance Library) — final slice: archive the 126 legacy MUSE
 * fragrance records (sm.products, category FRAGRANCE, code FRAG_00001..FRAG_00126
 * and a few hand-named ones). They are dead: every screen now reads the shared
 * SA oil (oil_id), not these. Owner (2026-07-29): archive, don't delete — some
 * carry residual stock (7 records, ~144 L) and transaction/order-line history
 * that must be preserved.
 *
 * CRITICAL SAFETY NOTE: the single-item "archive a product" endpoint
 * (server/sm/routes/products.js) cascades — archiving a FRAGRANCE also archives
 * any variant whose fragrance_id points at it. D14.9 deliberately left
 * fragrance_id set on all 374 real MUSE variants as a rollback cushion, so that
 * cascade would archive the ENTIRE live MUSE catalog if used here. This script
 * does NOT use that path — it updates ONLY the legacy fragrance rows themselves
 * (category='FRAGRANCE' AND product_code LIKE 'FRAG_%'), never touching any row
 * via fragrance_id. Asserts below prove no variant was touched.
 *
 * SAFETY:
 *   · Refuses to run unless ARCHIVE_DATABASE_URL is set explicitly.
 *   · Dry-run by default (BEGIN...ROLLBACK). --commit to apply.
 *   · All pre/post asserts must pass or it rolls back and exits 1.
 *
 * Usage:
 *   ARCHIVE_DATABASE_URL="postgres://…" node scripts/archive-legacy-fragrances.cjs           # dry-run
 *   ARCHIVE_DATABASE_URL="postgres://…" node scripts/archive-legacy-fragrances.cjs --commit  # apply
 */
const { Pool } = require('pg');

const COMMIT = process.argv.includes('--commit');
const DB = process.env.ARCHIVE_DATABASE_URL;
if (!DB) {
  console.error('REFUSING TO RUN: set ARCHIVE_DATABASE_URL to the target (a Neon branch first).');
  process.exit(2);
}

function fail(msg) { console.error('  ✗ ' + msg); throw new Error(msg); }
function ok(msg) { console.log('  ✓ ' + msg); }

// Match by category alone — NOT by product_code pattern. Two of the 126 legacy
// records (FRAG-OUD, FRAG-SANTAL) use a hyphen instead of the FRAG_00### pattern
// (hand-created, not auto-numbered), so a LIKE 'FRAG\_%' filter silently missed
// them (caught by a live dry-run: 124 matched instead of 126). category='FRAGRANCE'
// is the real, complete definition of "legacy pre-D14 fragrance record" — confirmed
// nothing else in the current schema uses this category.
const LEGACY_WHERE = `category = 'FRAGRANCE'`;

(async () => {
  const pool = new Pool({ connectionString: DB.replace('-pooler', ''), ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public' });
  const client = await pool.connect();
  try {
    console.log(`\nArchive legacy fragrances — ${COMMIT ? 'COMMIT' : 'DRY-RUN'}  (target: ${DB.replace(/:[^:@/]+@/, ':***@')})\n`);

    // ── Pre-flight (read-only) ────────────────────────────────────────────
    console.log('Pre-flight:');
    const before = (await client.query(
      `SELECT id, sku, product_code, current_stock, archived FROM products WHERE ${LEGACY_WHERE}`
    )).rows;
    ok(`${before.length} legacy fragrance records found`);
    const alreadyArchived = before.filter(r => r.archived).length;
    if (alreadyArchived) console.log(`  · ${alreadyArchived} already archived (idempotent — will be skipped)`);
    const stockSnapshot = Object.fromEntries(before.map(r => [r.id, Number(r.current_stock || 0)]));

    // Baseline: variant archived-state before, so we can prove zero drift after.
    const variantsBefore = (await client.query(
      `SELECT id, archived FROM products WHERE fragrance_id IS NOT NULL`
    )).rows;
    const variantArchivedBefore = new Map(variantsBefore.map(v => [v.id, v.archived]));
    ok(`${variantsBefore.length} fragrance_id-linked rows (variants) snapshotted — must stay untouched`);

    await client.query('BEGIN');

    // ── The only mutation: archive the legacy rows themselves ────────────
    // NOTE: sm.products has no updated_at column (created_at + shopify_synced_at only) —
    // confirmed live, so this deliberately omits it (unlike products.js's single-item
    // archive route, which references a nonexistent updated_at and would itself error
    // if ever exercised — a separate pre-existing bug, out of scope here).
    const upd = await client.query(
      `UPDATE products SET archived = true WHERE ${LEGACY_WHERE} AND archived = false`
    );
    console.log(`\nMutation: archived ${upd.rowCount} legacy fragrance record(s).`);

    // ── Post-flight asserts ────────────────────────────────────────────────
    console.log('Post-flight:');
    const after = (await client.query(
      `SELECT id, current_stock, archived FROM products WHERE ${LEGACY_WHERE}`
    )).rows;
    if (after.some(r => !r.archived)) fail('not every legacy fragrance record is archived');
    ok('every legacy fragrance record is now archived');

    if (after.some(r => stockSnapshot[r.id] !== Number(r.current_stock || 0))) fail('a legacy record\'s stock changed');
    ok('stock values on legacy records unchanged (archiving never touches stock)');

    const variantsAfter = (await client.query(
      `SELECT id, archived FROM products WHERE fragrance_id IS NOT NULL`
    )).rows;
    if (variantsAfter.length !== variantsBefore.length) fail('the set of fragrance_id-linked rows changed size — unexpected');
    const drifted = variantsAfter.filter(v => variantArchivedBefore.get(v.id) !== v.archived);
    if (drifted.length) fail(`${drifted.length} variant(s) had their archived flag changed — the cascade bug this script exists to avoid`);
    ok(`all ${variantsAfter.length} fragrance_id-linked rows (variants) untouched — zero drift`);

    if (COMMIT) { await client.query('COMMIT'); console.log('\n✅ COMMITTED.'); }
    else { await client.query('ROLLBACK'); console.log('\n↩️  DRY-RUN rolled back (pass --commit to apply).'); }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\n❌ FAILED — rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
