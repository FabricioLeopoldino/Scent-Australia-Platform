// Sets MUSE finished-good balances that were typed in during the July build
// back to zero.
//
// WHY (owner-confirmed 2026-08-18). Four MUSE variants carried stock that does
// not physically exist — 104 units in total, every one of them created by a
// manual `add` in mid-July while the platform was being built. Not one has a
// production movement behind it.
//
// It is not a cosmetic wrong number. Order ingestion asks "is it on the shelf?"
// to decide whether anything has to be made:
//
//     need = quantity ordered − finished stock
//       need <= 0  → nothing to make, pick it and post it
//       need >  0  → create a production order
//
// Phantom stock answers that question wrongly, so the order silently skips
// production. That is exactly what happened to order #1022 (Daniel Edwards,
// paid 17 August): it needed a Room Spray MADE, the platform believed one was
// on the shelf, and no production order, alarm or screen entry appeared
// anywhere. Muse_RS00124 carries 100 phantom Zen Garden sprays — an order for
// thirty of them would have produced nothing and told nobody.
//
// SAFETY. Targets are found from the ledger, not from a list: a variant only
// qualifies if every movement it has ever had is a manual `add` or a Shopify
// sale/reversal pair. Anything with a real production movement is reported and
// left alone. Each change writes an `adjust` row explaining itself, so the
// correction is a movement in the history and not a silent edit.
//
// Idempotent. Read-only until --apply.
//
// Run:  node scripts/zero-phantom-finished-stock.cjs            (dry run)
//       node scripts/zero-phantom-finished-stock.cjs --apply
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
// Movement types that mean "this unit was really manufactured or received".
// A balance explained only by the types NOT in here is a typed-in number.
const REAL_ORIGIN = ['production_in', 'production_credit', 'transfer_in', 'ready_formula_in'];

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
    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — zero phantom MUSE finished stock\n`);

    const candidates = (await q(
      `SELECT v.id, v.sku, v.name, v.current_stock::float AS stock
         FROM products v
         JOIN products m ON m.id = v.master_product_id AND m.segment = 'MUSE'
        WHERE v.current_stock > 0 AND COALESCE(v.archived, false) = false
        ORDER BY v.current_stock DESC`)).rows;

    if (!candidates.length) { log('  Nothing with positive stock — already done.\n'); await client.query('ROLLBACK'); return; }

    let zeroed = 0, kept = 0;
    for (const c of candidates) {
      const real = (await q(
        `SELECT count(*)::int n FROM transactions
          WHERE product_id = $1 AND type = ANY($2::text[])`, [c.id, REAL_ORIGIN])).rows[0].n;
      const moves = (await q(
        `SELECT type, count(*)::int n FROM transactions WHERE product_id = $1 GROUP BY 1 ORDER BY 1`,
        [c.id])).rows;
      const history = moves.map((m) => `${m.type}×${m.n}`).join(' ') || 'no movements at all';

      if (real > 0) {
        kept++;
        log(`  KEEP  ${c.sku.padEnd(14)} ${String(c.stock).padStart(5)}   has a real production movement — left alone`);
        log(`        ${history}`);
        continue;
      }

      log(`  zero  ${c.sku.padEnd(14)} ${String(c.stock).padStart(5)} → 0   ${String(c.name).slice(0, 38)}`);
      log(`        ${history}`);
      await q(`UPDATE products SET current_stock = 0 WHERE id = $1`, [c.id]);
      await q(
        `INSERT INTO transactions (product_id, product_name, product_code, type, quantity, unit, balance_after, notes, user_id)
         VALUES ($1, $2, $3, 'adjust', $4, 'units', 0, $5, NULL)`,
        [c.id, c.name, c.sku, c.stock,
         `Phantom stock from the July build corrected to 0 — no production movement behind it. `
         + `It made order ingestion skip production. Owner-confirmed 2026-08-18.`]);
      zeroed++;
    }

    log(`\n  ${zeroed} zeroed, ${kept} left alone`);
    const left = (await q(
      `SELECT count(*)::int n FROM products v JOIN products m ON m.id = v.master_product_id
        AND m.segment = 'MUSE' WHERE v.current_stock > 0 AND COALESCE(v.archived,false) = false`)).rows[0].n;
    log(`  MUSE variants still holding stock: ${left}`);

    if (APPLY) { await client.query('COMMIT'); log('\n✅ committed\n'); }
    else { await client.query('ROLLBACK'); log('\n↩  rolled back — re-run with --apply to keep it\n'); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\n❌ rolled back:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
