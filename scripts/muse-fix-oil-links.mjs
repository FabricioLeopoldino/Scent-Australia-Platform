// D18 / MUSE launch — repair variant→oil links before the store goes live.
//
// WHY: the MUSE catalogue was built while the business was still deciding which
// oil each commercial name maps to, so some variants point at the wrong oil and
// some at none. Found by cross-checking four independent sources: name matching,
// `product_aliases`, the warehouse audit list, and finally the authoritative
// name→FRAG_ map the owner and the warehouse manager produced together
// (_work/muse-authoritative-map.tsv). All four agreed on the same defects.
//
// Two of these are not cosmetic:
//   · Tokyo consumed FRAG_0275 "AMAN HARU (Exclusive to ADINA SYDNEY)" — an oil
//     reserved for one SA client. Public MUSE sales would have drained it.
//   · Avocado & Mint consumed Aqua Positano — an entirely different fragrance.
// Neither would have raised an error: stock would simply have gone down in the
// wrong place.
//
// SAFETY
//   · Dry run by default; writes only with --commit AND MUSE_ALLOW_WRITE=yes.
//   · Only the `oil_id` column, only the SKUs listed below.
//   · Verifies the target oil exists, is active and is an OIL before writing.
//   · Prints and stores the before/after for every row (rollback = re-apply the
//     `from` values printed in the plan).
//   · One transaction: all rows land or none do.
//
// Usage:
//   node scripts/muse-fix-oil-links.mjs
//   MUSE_ALLOW_WRITE=yes node scripts/muse-fix-oil-links.mjs --commit
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const COMMIT = process.argv.includes('--commit');
if (COMMIT && process.env.MUSE_ALLOW_WRITE !== 'yes') {
  console.error('Refusing to write: set MUSE_ALLOW_WRITE=yes as well as --commit.');
  process.exit(1);
}

// Every entry is owner-confirmed against _work/muse-authoritative-map.tsv.
// `from` is asserted before writing: if the current link is not what we expect,
// the data moved under us and the run aborts rather than guessing.
const FIXES = [
  { group: '00114', label: 'Tokyo',                            from: 'FRAG_0275', to: 'FRAG_0053' },
  { group: '00012', label: 'Avocado & Mint',                   from: 'FRAG_0011', to: 'FRAG_0010' },
  { group: '00117', label: 'Vetiver Waterlily',                from: null,        to: 'FRAG_0158' },
  { group: '00080', label: 'Ode Oeuvre',                       from: null,        to: 'FRAG_0330' },
  { group: '00003', label: 'Allergen Free Saffron & Oakmoss',  from: null,        to: 'FRAG_0283' },
];
const PREFIXES = ['Muse_TS', 'Muse_RS', 'Muse_RD'];

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

// ── Resolve target oils ────────────────────────────────────────────────────
const codes = [...new Set(FIXES.map((f) => f.to))];
const oils = await pool.query(
  `SELECT id, "productCode" AS code, name, "currentStock" AS stock, status
     FROM sa.products WHERE "productCode" = ANY($1) AND category = 'OILS'`, [codes]);
const oilByCode = new Map(oils.rows.map((r) => [r.code, r]));
let fatal = 0;
for (const c of codes) {
  const o = oilByCode.get(c);
  if (!o) { console.error(`❌ target oil ${c} not found (or not category OILS)`); fatal++; }
  else if (o.status === 'inactive') { console.error(`❌ target oil ${c} is inactive`); fatal++; }
}
if (fatal) { await pool.end(); process.exit(1); }

// ── Build the row-level plan ───────────────────────────────────────────────
const skus = FIXES.flatMap((f) => PREFIXES.map((p) => p + f.group));
const cur = await pool.query(
  `SELECT p.sku, p.name, p.oil_id, o."productCode" AS code, o.name AS oil_name
     FROM products p LEFT JOIN sa.products o ON o.id = p.oil_id
    WHERE p.sku = ANY($1) AND COALESCE(p.archived,false) = false`, [skus]);
const bySku = new Map(cur.rows.map((r) => [r.sku, r]));

const todo = [], skip = [], mismatch = [];
for (const f of FIXES) {
  const target = oilByCode.get(f.to);
  for (const p of PREFIXES) {
    const sku = p + f.group;
    const row = bySku.get(sku);
    if (!row) { skip.push(`${sku} — variant not found or archived`); continue; }
    if (row.code === f.to) { skip.push(`${sku} — already ${f.to}`); continue; }
    // Guard: the current state must be exactly what the audit found.
    if ((row.code || null) !== f.from) {
      mismatch.push(`${sku} — expected ${f.from || 'no oil'}, found ${row.code || 'no oil'}`);
      continue;
    }
    todo.push({ sku, label: f.label, fromCode: row.code, fromName: row.oil_name, toCode: f.to, toId: target.id, toName: target.name });
  }
}

console.log('════ MUSE oil-link repair ════\n');
for (const t of todo) {
  console.log(`  ${t.sku}  ${t.label}`);
  console.log(`      from : ${t.fromCode || '(none)'} ${t.fromName ? `"${t.fromName}"` : ''}`);
  console.log(`      to   : ${t.toCode} "${t.toName}"`);
}
console.log(`\nTo change ............. ${todo.length}`);
console.log(`Already correct ....... ${skip.length}`);
console.log(`Unexpected state ...... ${mismatch.length}`);
skip.forEach((s) => console.log(`   · ${s}`));
mismatch.forEach((s) => console.log(`   ⚠️  ${s}`));

if (mismatch.length) {
  console.error('\n❌ Aborting: the live data no longer matches the audit. Re-run the audit before writing.');
  await pool.end(); process.exit(1);
}
if (!COMMIT) {
  console.log('\n── DRY RUN — nothing written. ──');
  console.log('Re-run with:  MUSE_ALLOW_WRITE=yes node scripts/muse-fix-oil-links.mjs --commit');
  await pool.end(); process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const t of todo) {
    await client.query(`UPDATE products SET oil_id = $1 WHERE sku = $2`, [t.toId, t.sku]);
  }
  await client.query('COMMIT');
  console.log(`\n✅ ${todo.length} variants relinked.`);
  console.log('Rollback: re-apply the "from" values printed above.');
} catch (e) {
  await client.query('ROLLBACK');
  console.error(`\n❌ rolled back: ${e.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
