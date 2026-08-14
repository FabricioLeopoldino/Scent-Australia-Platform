// Puts back the stock that `preflight.cjs --full` consumed on 2026-08-14.
//
// WHAT HAPPENED. The new preflight gained a --full mode that runs every
// regression suite. Several of those suites exercise MUSE fulfilment against
// REAL data: one sells 99 units against a shelf of 2, so 97 go through the D16
// make-to-order path and consume the whole bill of materials. Run repeatedly,
// that debited:
//
//     COMP_00006..00011      582 each   (reed diffuser component sets)
//     LBL_00001, LBL_00002   582 each   (real counted label stock, 498 → −84)
//     RAW_00001           87,300 ml     (ethanol)
//     sa FRAG_0003        29,100 ml     (a real Fragrance Library oil)
//
// The suites have no teardown — the known root cause, deferred by the owner —
// and preflight --full turned "run by hand, rarely" into "run every morning".
// That is my mistake: I added a convenience that multiplied a known hazard.
//
// SCOPE. Only products with an actual transaction in the affected window are
// touched, and only for the amounts those transactions recorded. SA is a live
// system in daily use, so a stock difference there is NOT assumed to be mine:
// only sa FRAG_0003's muse_production debits are reversed, because MUSE
// fulfilment is the only thing that writes that type and the only MUSE
// fulfilments in the window were the test runs. Anything else on the SA side is
// reported, never guessed at.
//
// Every correction is written to the ledger. Restoring a number silently would
// be a second unrecorded change on top of the first.
//
// Run:  node scripts/restore-after-full-preflight.cjs            (dry run)
//       node scripts/restore-after-full-preflight.cjs --apply
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const WINDOW = process.env.RESTORE_WINDOW || '3 hours';

const mk = (schema) => new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: `-c search_path=${schema},public`,
});
const log = (s = '') => console.log(s);

// Types the test runs produced, and which direction each moved stock.
const TEST_DEBITS  = ['shopify_sale', 'production_debit', 'muse_production'];
const TEST_CREDITS = ['ready_formula_in', 'production_in'];

(async () => {
  const sm = mk('sm'), sa = mk('sa');
  const smC = await sm.connect(), saC = await sa.connect();
  try {
    await smC.query('BEGIN'); await saC.query('BEGIN');
    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — restore stock consumed by preflight --full\n`);

    // ── SM ──────────────────────────────────────────────────────────────────
    log('  SM');
    // `restored` matters: cleanup-regression-residue.cjs already credited three
    // fixtures back earlier in the same window and wrote 'Restore…' adjust rows
    // for them. Without subtracting those, this would pay them twice — the dry
    // run showed CMP-RB200, CMP-RLID and RM-ETHANOL overshooting by exactly the
    // amount already returned.
    const smRows = (await smC.query(
      `SELECT product_code,
              COALESCE(sum(quantity) FILTER (WHERE type = ANY($1::text[])), 0)::float AS debited,
              COALESCE(sum(quantity) FILTER (WHERE type = ANY($2::text[])), 0)::float AS credited,
              COALESCE(sum(quantity) FILTER (WHERE type = 'adjust' AND notes ILIKE 'Restore%'), 0)::float AS restored
         FROM transactions
        WHERE created_at > now() - $3::interval AND product_code IS NOT NULL
        GROUP BY 1 ORDER BY 1`, [TEST_DEBITS, TEST_CREDITS, WINDOW])).rows;

    for (const r of smRows) {
      const net = (r.debited || 0) - (r.credited || 0) - (r.restored || 0);
      if (!net) continue;
      const p = (await smC.query(
        `SELECT id, current_stock::float s, unit FROM products WHERE product_code = $1`,
        [r.product_code])).rows[0];
      if (!p) { log(`    ${String(r.product_code).padEnd(14)} not found — skipped`); continue; }
      const target = p.s + net;
      await smC.query(`UPDATE products SET current_stock = $1 WHERE id = $2`, [target, p.id]);
      await smC.query(
        `INSERT INTO transactions (product_id, product_name, product_code, type, quantity, unit, balance_after, notes, user_id)
         VALUES ($1,$2,$3,'adjust',$4,$5,$6,$7,NULL)`,
        [p.id, r.product_code, r.product_code, Math.abs(net), p.unit, target,
         `Restore after preflight --full consumed real stock — scripts/restore-after-full-preflight.cjs`]);
      log(`    ${String(r.product_code).padEnd(14)} ${String(p.s).padStart(10)} → ${String(target).padStart(10)}  (+${net})`);
    }

    // ── SA: only the unambiguous one ────────────────────────────────────────
    log('\n  SA (only muse_production, which nothing but MUSE fulfilment writes)');
    const saRows = (await saC.query(
      `SELECT product_code, sum(quantity)::float AS debited
         FROM transactions
        WHERE created_at > now() - $1::interval AND type = 'muse_production'
        GROUP BY 1 ORDER BY 1`, [WINDOW])).rows;
    for (const r of saRows) {
      const p = (await saC.query(
        `SELECT id, "currentStock"::float s, unit FROM products WHERE "productCode" = $1`,
        [r.product_code])).rows[0];
      if (!p) { log(`    ${String(r.product_code).padEnd(14)} not found — skipped`); continue; }
      const target = p.s + r.debited;
      await saC.query(`UPDATE products SET "currentStock" = $1 WHERE id = $2`, [target, p.id]);
      await saC.query(
        `INSERT INTO transactions (product_id, product_name, product_code, type, quantity, unit, balance_after, notes, user_id)
         VALUES ($1,$2,$3,'add',$4,$5,$6,$7,NULL)`,
        [p.id, r.product_code, r.product_code, r.debited, p.unit || 'mL', target,
         `Restore after preflight --full consumed real oil — scripts/restore-after-full-preflight.cjs`]);
      log(`    ${String(r.product_code).padEnd(14)} ${String(p.s).padStart(10)} → ${String(target).padStart(10)}  (+${r.debited})`);
    }

    // ── Anything else that moved on the SA side: reported, not touched ──────
    const other = (await saC.query(
      `SELECT product_code, type, sum(quantity)::float q, count(*) n
         FROM transactions
        WHERE created_at > now() - $1::interval AND type <> 'muse_production'
          -- exclude this run's own corrections, which are visible inside the
          -- open transaction and otherwise appear as mystery movement
          AND COALESCE(notes, '') NOT ILIKE 'Restore after%'
        GROUP BY 1,2 ORDER BY 1`, [WINDOW])).rows;
    if (other.length) {
      log('\n  SA — other movement in the window. NOT touched: SA is in daily use and');
      log('  this may be real warehouse work. Check before doing anything with it.');
      other.forEach((r) => log(`    ${String(r.product_code).padEnd(14)} ${String(r.type).padEnd(16)} ${String(r.q).padStart(8)}  (${r.n} rows)`));
    }

    if (APPLY) {
      await smC.query('COMMIT'); await saC.query('COMMIT');
      log('\n✅ committed\n');
    } else {
      await smC.query('ROLLBACK'); await saC.query('ROLLBACK');
      log('\n↩  rolled back — re-run with --apply to keep it\n');
    }
  } catch (e) {
    await smC.query('ROLLBACK').catch(() => {}); await saC.query('ROLLBACK').catch(() => {});
    console.error('\n❌ rolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    smC.release(); saC.release();
    await sm.end(); await sa.end();
  }
})();
