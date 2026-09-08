// Retires the SA Scented Products range, now that it is no longer sold.
//
// WHY (2026-09-08). The owner deleted the SA_RD / SA_RS / SA_TS products from
// Scent Australia's own Shopify store — Reed Diffuser, Room Spray and Travel
// Spray are sold through Muse now, not through SA. The platform still lists all
// 354 of them on the SA products screen, where they are noise: nobody can sell
// them and nobody should count them.
//
// DEACTIVATES. It does not delete, for the reason the whole SA module is built
// around: never delete to fix, reverse and let the record show both. Four real
// transactions reference these products (2 remove, 2 return, last 12 Aug), and
// deleting the rows would leave that history pointing at nothing. Deactivating
// takes them off the screen — ProductManagement shows active only, with a
// "Show Inactive" toggle beside it — while the history stays readable and any
// one of them can be switched back on in a click if a product returns.
//
// It writes exactly what the screen's own Active/Inactive toggle writes:
// products.status = 'inactive' plus a `product_deactivated` audit row, so these
// 354 read in the audit trail identically to one done by hand.
//
// SCOPE, asserted rather than assumed: the three prefixes are the whole of
// category SA_SCENTED_PRODUCTS (118 + 118 + 118 = 354) and nothing else. The
// script refuses if that stops being true, and refuses if anything in range
// carries stock. RAW_MATERIALS is explicitly out — SA_RM is the operation's
// ethanol, batteries and empty bottles, not a Room Spray, and an earlier
// reading of this request nearly took it in.
//
// Run:  node scripts/retire-sa-scented-products.cjs           (dry run)
//       node scripts/retire-sa-scented-products.cjs --apply   (writes)
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
// The owner's account. The screen stamps req.user.id on the audit row; a script
// has no session, so it names him explicitly rather than leaving it null —
// he is the person who made this decision.
const ACTOR_ID = 8;
const PREFIXES = ['SA_RD', 'SA_RS', 'SA_TS'];
const EXPECTED_CATEGORY = 'SA_SCENTED_PRODUCTS';

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true },
  options: '-c search_path=sa,public',
});

const WHERE = `("productCode" LIKE 'SA\\_RD%' OR "productCode" LIKE 'SA\\_RS%' OR "productCode" LIKE 'SA\\_TS%')`;
const log = (s = '') => console.log(s);

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rows = (await client.query(
      `SELECT id, "productCode" AS code, name, category, status,
              "currentStock"::float AS stock
         FROM products WHERE ${WHERE} ORDER BY "productCode" FOR UPDATE`)).rows;

    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — retiring the SA Scented Products range\n`);

    // ── Refusals. Each one is a thing that was true when this was written and
    // must still be true, or the script is operating on something else.
    const offCategory = rows.filter((r) => r.category !== EXPECTED_CATEGORY);
    if (offCategory.length) {
      throw new Error(`${offCategory.length} product(s) in range are not ${EXPECTED_CATEGORY} `
        + `(e.g. ${offCategory[0].code} is ${offCategory[0].category}) — refusing`);
    }
    const withStock = rows.filter((r) => r.stock !== 0);
    if (withStock.length) {
      throw new Error(`${withStock.length} product(s) still carry stock `
        + `(e.g. ${withStock[0].code} = ${withStock[0].stock}) — refusing. `
        + `Retiring something with stock on the shelf hides it.`);
    }
    // The whole category, and nothing outside it: proves no scented product is
    // being left stranded and no other category is being swept up.
    const catTotal = Number((await client.query(
      `SELECT count(*)::int n FROM products
        WHERE category = $1 AND COALESCE(status,'active') = 'active'`, [EXPECTED_CATEGORY])).rows[0].n);
    const activeInRange = rows.filter((r) => (r.status || 'active') === 'active').length;
    if (catTotal !== activeInRange) {
      throw new Error(`${EXPECTED_CATEGORY} has ${catTotal} active products but only `
        + `${activeInRange} carry the three prefixes — the range is no longer the whole `
        + `category, so somebody must say what to do with the difference`);
    }

    const byPrefix = PREFIXES.map((p) => [p, rows.filter((r) => r.code.startsWith(p)).length]);
    byPrefix.forEach(([p, n]) => log(`  ${p.padEnd(8)} ${String(n).padStart(4)} products`));
    log(`  ${'TOTAL'.padEnd(8)} ${String(rows.length).padStart(4)}`);
    log(`\n  all at zero stock      yes (asserted)`);
    log(`  the whole category     yes (${catTotal} active in ${EXPECTED_CATEGORY})`);

    const already = rows.filter((r) => (r.status || 'active') === 'inactive').length;
    const todo = rows.filter((r) => (r.status || 'active') === 'active');
    log(`  already inactive       ${already}`);
    log(`  to deactivate          ${todo.length}\n`);

    // History is the reason this deactivates instead of deleting — show it.
    const ids = rows.map((r) => r.id);
    const tx = Number((await client.query(
      `SELECT count(*)::int n FROM transactions WHERE product_id = ANY($1::text[])`, [ids])).rows[0].n);
    log(`  transactions that would be orphaned by a DELETE: ${tx}`);
    log(`  (kept readable — this only flips status)\n`);

    // Two statements, not 708. Row-at-a-time meant ~700 round trips to Neon,
    // which took over two minutes with 354 production rows held under FOR
    // UPDATE the whole time — a lock that long on a live warehouse table is its
    // own hazard, quite apart from the wait.
    const todoIds = todo.map((r) => r.id);
    await client.query(
      `UPDATE products SET status = 'inactive' WHERE id = ANY($1::text[])`, [todoIds]);
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       SELECT $1, 'product_deactivated', 'product', p.id, p.name,
              jsonb_build_object(
                'productCode', p."productCode",
                'category',    p.category,
                'status',      'inactive',
                'reason',      $2::text,
                'via',         'script retire-sa-scented-products.cjs')
         FROM products p WHERE p.id = ANY($3::text[])`,
      [ACTOR_ID,
       'Removed from the Scent Australia Shopify store — sold through Muse now',
       todoIds]);

    // ── Prove it before keeping it.
    const after = (await client.query(
      `SELECT count(*) FILTER (WHERE COALESCE(status,'active') = 'active')::int still_active,
              count(*) FILTER (WHERE status = 'inactive')::int now_inactive
         FROM products WHERE ${WHERE}`)).rows[0];
    if (Number(after.still_active) !== 0) {
      throw new Error(`${after.still_active} product(s) in range are still active — refusing to commit`);
    }
    const audits = Number((await client.query(
      `SELECT count(*)::int n FROM audit_log
        WHERE action = 'product_deactivated' AND entity_id = ANY($1::text[])`, [ids])).rows[0].n);
    if (audits < todo.length) {
      throw new Error(`only ${audits} audit rows for ${todo.length} deactivations — refusing to commit`);
    }
    // Nothing outside the range may have moved.
    const collateral = Number((await client.query(
      `SELECT count(*)::int n FROM products
        WHERE NOT ${WHERE} AND status = 'inactive' AND category = $1`, [EXPECTED_CATEGORY])).rows[0].n);
    if (collateral !== 0) {
      throw new Error(`${collateral} product(s) OUTSIDE the range were deactivated — refusing to commit`);
    }

    log(`  deactivated            ${todo.length}`);
    log(`  audit rows written     ${audits}`);
    log(`  still active in range  ${after.still_active}  (must be 0)`);
    log(`  touched outside range  ${collateral}  (must be 0)`);

    if (APPLY) { await client.query('COMMIT'); log('\n✅ committed — they are off the SA products screen, under "Show Inactive" if needed\n'); }
    else { await client.query('ROLLBACK'); log('\n↩  rolled back — re-run with --apply to keep it\n'); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`\n❌ rolled back: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
