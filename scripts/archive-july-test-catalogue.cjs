// Archives the July test catalogue the owner created while the platform was
// being built, and confirmed on 2026-08-14 was never real.
//
// WHAT IT IS. CS00001 "Reed Diffuser 200ml" (13 Jul) and CS00002 "Room Spray
// 100ml" (15 Jul) duplicate the MUSE masters RD200 and RS100, which already
// existed on 10 Jul with the same names, volumes and oil percentages. Their
// five components (COMP_00001-00005) all sit at exactly 1000 — a round test
// number — and carry typos the real records do not ("Lid e Second Lid",
// "Packag 100ml").
//
// The evidence that they were never used: zero variants, zero production order
// lines, zero stock transactions, no price. Verified before archiving.
//
// WHY ARCHIVE AND NOT DELETE. Archiving keeps the history and is reversible.
// Deleting a product that ever touched a junction table leaves orphans, which
// is what happened archiving the Saffron variants on 2026-08-12 — 26 rows left
// pointing at 1. So the recipe rows are deactivated in the SAME transaction,
// not left behind.
//
// They also carried segment 'STANDARD', which made them the only rows that
// could not be classified when business_unit arrived. Archiving closes that
// question rather than answering it with a guess.
//
// Idempotent. Writes an audit row per product, since a script that changes
// production data and leaves no trace is the gap found on 2026-08-13.
//
// Run:  node scripts/archive-july-test-catalogue.cjs           (dry run)
//       node scripts/archive-july-test-catalogue.cjs --apply
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const MASTERS = ['CS00001', 'CS00002'];
const COMPONENTS = ['COMP_00001', 'COMP_00002', 'COMP_00003', 'COMP_00004', 'COMP_00005'];
const ALL = [...MASTERS, ...COMPONENTS];

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});
const log = (s = '') => console.log(s);

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (t, p) => client.query(t, p);

    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — archive the July test catalogue\n`);

    // ── Refuse if any of them turns out to be in use ──────────────────────
    // The owner said these were his own tests. Trusting that without checking
    // is how a live product gets archived by a script.
    const rows = (await q(
      `SELECT p.id, p.product_code, p.name, p.current_stock, p.archived,
              (SELECT count(*) FROM products v WHERE v.master_product_id = p.id)::int AS variants,
              (SELECT count(*) FROM transactions t WHERE t.product_id = p.id)::int AS movements,
              (SELECT count(*) FROM production_order_lines l WHERE l.product_type = p.product_code)::int AS order_lines,
              -- Only counts a recipe that SURVIVES this run. The five components
              -- appear in CS00001 and CS00002, which are being archived in the
              -- same transaction, so counting those would block the script on
              -- its own work. The first version did exactly that.
              (SELECT count(*) FROM product_bom b
                WHERE b.component_product_id = p.id AND b.is_active
                  AND b.product_type <> ALL($2::text[]))::int AS used_in_recipes
         FROM products p WHERE p.product_code = ANY($1::text[]) ORDER BY p.product_code`,
      [ALL, MASTERS])).rows;

    if (rows.length !== ALL.length) {
      const found = rows.map((r) => r.product_code);
      log(`  note: ${ALL.filter((c) => !found.includes(c)).join(', ')} not present — nothing to do for those`);
    }

    let blocked = 0;
    log('  code         variants  movements  order lines  used in recipes  stock');
    for (const r of rows) {
      const inUse = r.variants || r.movements || r.order_lines || r.used_in_recipes;
      if (inUse) blocked++;
      log(`  ${r.product_code.padEnd(12)}${String(r.variants).padStart(8)}${String(r.movements).padStart(11)}${String(r.order_lines).padStart(13)}${String(r.used_in_recipes).padStart(17)}${String(r.current_stock).padStart(7)}${inUse ? '   ← IN USE' : ''}`);
    }
    if (blocked) {
      throw new Error(`${blocked} of them are in use — refusing to archive. Investigate before re-running.`);
    }
    log('\n  none of them is referenced by anything. Safe to archive.\n');

    // ── Deactivate their recipes first ────────────────────────────────────
    const bom = await q(
      `UPDATE product_bom SET is_active = false
        WHERE product_type = ANY($1::text[]) AND is_active = true`, [MASTERS]);
    log(`  recipes      ${bom.rowCount} line(s) deactivated${bom.rowCount === 0 ? ' (already done)' : ''}`);

    // ── Archive ───────────────────────────────────────────────────────────
    const arch = await q(
      `UPDATE products SET archived = true
        WHERE product_code = ANY($1::text[]) AND COALESCE(archived, false) = false
        RETURNING id, product_code, name`, [ALL]);
    log(`  products     ${arch.rowCount} archived${arch.rowCount === 0 ? ' (already done)' : ''}`);

    // ── Leave a trace ─────────────────────────────────────────────────────
    for (const r of arch.rows) {
      await q(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES (NULL, 'product_archived', 'product', $1, $2, $3)`,
        [r.id, r.name, JSON.stringify({
          product_code: r.product_code,
          reason: 'July 2026 test catalogue, confirmed by the owner as never real',
          via: 'script archive-july-test-catalogue.cjs',
        })]);
    }
    if (arch.rowCount) log(`  audit        ${arch.rowCount} product_archived row(s) recorded`);

    // ── Show the result ───────────────────────────────────────────────────
    log('\n  After:');
    for (const r of (await q(
      `SELECT COALESCE(segment,'(none)') s, COALESCE(business_unit,'(none)') b, count(*) n
         FROM products WHERE COALESCE(archived,false) = false GROUP BY 1,2 ORDER BY 1,2`)).rows) {
      log(`     segment ${String(r.s).padEnd(10)} business_unit ${String(r.b).padEnd(9)} ${String(r.n).padStart(4)}`);
    }

    if (APPLY) {
      await client.query('COMMIT');
      log('\n✅ committed\n');
    } else {
      await client.query('ROLLBACK');
      log('\n↩  rolled back — re-run with --apply to keep it\n');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ rolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
