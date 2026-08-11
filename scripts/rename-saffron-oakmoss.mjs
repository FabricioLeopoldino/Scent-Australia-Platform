// Owner decision, 2026-08-11: the commercial name is "Saffron & Oakmoss", and
// only the 00003 set stays.
//
// OILS_9 is ONE oil (105 L) sold under two commercial names, three formats each
// — six active MUSE variants. That is the intentional pattern, not a duplicate
// registration. What the owner's boss asked for is the name, and what the owner
// decided is that the second set retires:
//
//   00003  "Allergen Free Saffron & Oakmoss Fragrance"  → renamed, KEPT
//   00048  "Fresher Allergen Free Saffron & Oakmoss"    → archived
//
// The oil itself is NOT touched. "ISPT - NEW Fresher Allergen Free Saffron &
// Oakmoss " is a supplier's internal name, and sa is sacred: renaming an oil
// happens through the Fragrance Library screen (D15, one door), never a script.
//
// Renaming is safe because a name is display only — the links that decide what
// gets made and which oil is debited are the SKU and oil_id, and neither moves.
//
// Archiving does NOT hide the variant from the Shopify order matcher (it does
// not filter archived), so a sale of an 00048 SKU would still resolve. Take the
// 00048 product off the store first; this script is the platform half.
//
// Dry run by default. Pass --commit to apply.
//   node scripts/rename-saffron-oakmoss.mjs
//   node scripts/rename-saffron-oakmoss.mjs --commit
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const COMMIT = process.argv.includes('--commit');
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

const OIL = 'OILS_9';
const NEW_NAME = 'Saffron & Oakmoss';
const KEEP = ['Muse_RD00003', 'Muse_RS00003', 'Muse_TS00003'];
const RETIRE = ['Muse_RD00048', 'Muse_RS00048', 'Muse_TS00048'];
// The format prefix is already in the stored name; only the part after the
// em dash changes. Rebuilding it from the master would risk inventing a
// different wording than the other 360 variants use.
const renamed = (name) => `${name.split('—')[0].trim()} — ${NEW_NAME}`;

try {
  const rows = (await pool.query(
    `SELECT id, sku, name, oil_id, current_stock, archived FROM products
      WHERE sku = ANY($1::text[]) ORDER BY sku`, [[...KEEP, ...RETIRE]])).rows;

  // ── Guards: refuse on anything unexpected rather than guess ──────────────
  const missing = [...KEEP, ...RETIRE].filter((s) => !rows.some((r) => r.sku === s));
  const wrongOil = rows.filter((r) => r.oil_id !== OIL);
  if (missing.length) { console.error(`❌ REFUSING: SKUs not found: ${missing.join(', ')}`); process.exit(1); }
  if (wrongOil.length) {
    console.error(`❌ REFUSING: these do not point at ${OIL}: ${wrongOil.map((r) => `${r.sku}→${r.oil_id}`).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n── RENAME (kept)  →  "${NEW_NAME}"`);
  for (const r of rows.filter((x) => KEEP.includes(x.sku)))
    console.log(`   ${r.sku}  ${JSON.stringify(r.name)}\n              → ${JSON.stringify(renamed(r.name))}`);

  console.log(`\n── ARCHIVE (retired)`);
  for (const r of rows.filter((x) => RETIRE.includes(x.sku)))
    console.log(`   ${r.sku}  ${JSON.stringify(r.name)}  stock=${r.current_stock}  archived=${r.archived}`);

  // Stock or open work on a retiring variant is the owner's call, not this
  // script's — report it and stop.
  const held = rows.filter((r) => RETIRE.includes(r.sku) && Number(r.current_stock) !== 0);
  const lines = (await pool.query(
    `SELECT DISTINCT po.order_number, po.status FROM production_order_lines pol
       JOIN production_orders po ON po.id = pol.production_order_id
       JOIN products p ON p.product_code = pol.product_type
      WHERE pol.variant_name ILIKE '%Fresher Allergen%'`)).rows;
  console.log(`\n   finished stock on the retiring set: ${held.length ? held.map((r) => `${r.sku}=${r.current_stock}`).join(', ') : 'none'}`);
  console.log(`   production orders naming it: ${lines.length ? lines.map((r) => `${r.order_number}(${r.status})`).join(', ') : 'none'}`);
  if (held.length) { console.error('\n❌ REFUSING: a retiring variant holds stock. Decide what happens to it first.'); process.exit(1); }

  if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit.'); process.exit(0); }

  console.log('\nApplying…');
  for (const r of rows.filter((x) => KEEP.includes(x.sku))) {
    await pool.query(`UPDATE products SET name = $1 WHERE id = $2`, [renamed(r.name), r.id]);
  }
  const arch = await pool.query(
    `UPDATE products SET archived = true WHERE sku = ANY($1::text[])`, [RETIRE]);
  console.log(`  renamed: ${KEEP.length}   archived: ${arch.rowCount}`);

  // The legacy junction mirrors the ACTIVE catalogue — integrity-sm enforces it
  // from both sides ("every MUSE master link has its variant" and "every active
  // MUSE variant has its master link"). Archiving a variant therefore has to
  // take its link with it, or integrity goes red on the next run. The first
  // version of this script missed that and did exactly that, on 2026-08-11.
  // Scoped to the retired fragrance ids: a global sweep would silently remove
  // unrelated dangling rows this script knows nothing about.
  const retiredFragIds = [...new Set(rows.filter((r) => RETIRE.includes(r.sku))
    .map((r) => r.fragrance_id).filter((x) => x != null))];
  if (retiredFragIds.length) {
    const link = await pool.query(
      `DELETE FROM muse_master_fragrances mmf
        WHERE mmf.fragrance_id = ANY($1::int[])
          AND NOT EXISTS (SELECT 1 FROM products v
                           WHERE v.master_product_id = mmf.master_product_id
                             AND v.fragrance_id = mmf.fragrance_id
                             AND COALESCE(v.archived, false) = false)`, [retiredFragIds]);
    console.log(`  legacy master↔fragrance links removed: ${link.rowCount}`);
  }

  // Re-read: the only proof that what was intended is what landed.
  console.log('\nVerifying…');
  for (const r of (await pool.query(
    `SELECT sku, name, archived, oil_id FROM products WHERE sku = ANY($1::text[]) ORDER BY sku`,
    [[...KEEP, ...RETIRE]])).rows) {
    console.log(`   ${r.sku}  ${JSON.stringify(r.name)}  archived=${r.archived}  oil=${r.oil_id}`);
  }
  console.log('\n✅ done — SKUs and oil links untouched, only names and the archived flag changed.');
} catch (e) {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
