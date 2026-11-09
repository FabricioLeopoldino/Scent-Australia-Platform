// Put every SA product's supplier onto the one registry (sa.suppliers).
//
// WHY (owner, 9 Nov 2026). The product form took free text, so the same
// supplier was typed many ways (Luxaroma / Luxorama, BELL / Bell, "SCENT METHOD "),
// and the supplier_id some products carried was stale: FIA products pointed at
// "Smart Fragrances > BELL" and were planned with its 90-day lead time instead
// of FIA's 21. From now on the form picks from the registry; this moves the
// existing rows onto it.
//
// Decisions it applies (owner, 9 Nov): one supplier per product; BELL is now
// Smart Fragrances; OV10 is a Crearoma model; "SA" / "Scent Australia" no
// longer exists, so those products are left with no supplier. Any text NOT in
// MAP below is listed as "needs a decision" and left exactly as it is.
//
// A supplier this script has to create starts at the 30-day lead time, which is
// the fallback those products are planned with today, so Demand Planning only
// changes where a product moves to a supplier whose lead time differs — every
// such product is listed.
//
//   PLATFORM_DATABASE_URL=<sectors-dev> node scripts/supplier-cleanup.mjs            # dry run
//   PLATFORM_DATABASE_URL=<sectors-dev> node scripts/supplier-cleanup.mjs --apply    # writes
//
// Refuses any database but the test copy (ep-old-water-) unless --production is
// passed too. One transaction: all of it or none of it.
import 'dotenv/config';
import { supplierKey } from '../shared/supplier-names.js';

const url = process.env.PLATFORM_DATABASE_URL || '';
const APPLY = process.argv.includes('--apply');
if (!url.includes('ep-old-water-') && !process.argv.includes('--production')) {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the test copy (ep-old-water-). Pass --production as well to run it on live.');
  process.exit(1);
}

// Text as typed today (compared by supplierKey: case, spaces and punctuation
// ignored) → the registry name it becomes. '' = no supplier.
const MAP = {
  'Luxaroma': 'Luxaroma', 'Luxorama': 'Luxaroma',
  'FIA': 'FIA',
  'Scent Method': 'Scent Method',
  'Smart Fragrances': 'Smart Fragrances', 'Smart Fragrances > BELL': 'Smart Fragrances', 'BELL': 'Smart Fragrances',
  'Natarom': 'Natarom',
  'Guangzhou': 'Guangzhou', 'CHINA': 'Guangzhou',
  // Every diffuser comes from Crearoma, which is Ouwave; OV10/OV5/ECO-5/OY-5 are its models.
  'Crearoma (Ouwave)': 'Crearoma (Ouwave)', 'Crearoma': 'Crearoma (Ouwave)',
  'ouwave': 'Crearoma (Ouwave)', 'Ouwave (Diffusers)': 'Crearoma (Ouwave)',
  'OV10': 'Crearoma (Ouwave)', 'OV5': 'Crearoma (Ouwave)', 'ECO-5': 'Crearoma (Ouwave)', 'OY-5 [OUWAVE]': 'Crearoma (Ouwave)',
  // Refurb = returned Crearoma machines, cleaned and tested, sold second hand.
  'Wifi Medium Diffuser Refurb': 'Crearoma (Ouwave)', 'ScentLite Refurb': 'Crearoma (Ouwave)', '700 Medium Diffuser Refurb': 'Crearoma (Ouwave)',
  'Vanerete?': 'Vanerete', 'Vanerete': 'Vanerete', // ScentPod ceiling/light rail diffuser
  'Anotec 0307': 'Anotec', // 0307 is the code; FRAG_0309 already carries ANOTEC0307 as its supplier code
  'SA': '', 'Scent Australia': '', 'Candle Supply': '', 'Natural Candle Supply': '', // no longer used
  // Company names that were only ever typed on products: they join the registry as they are.
  'ABP (Australian Botanical Products)': 'ABP (Australian Botanical Products)',
  'Air Esscentials': 'Air Esscentials',
  'Anotec': 'Anotec',
  'Aroma Scenting': 'Aroma Scenting',
  'Australia Aromatics': 'Australia Aromatics',
  'Big Tree Supplies': 'Big Tree Supplies',
  'Duracell': 'Duracell',
  'Frag World': 'Frag World',
  'New Directions Australia': 'New Directions Australia',
  'PGP - PLASDENE': 'PGP - PLASDENE',
  'Risdon International': 'Risdon International',
  'The Fragrance Room': 'The Fragrance Room',
  'The Ingredient Warehouse': 'The Ingredient Warehouse',
};
const RENAME = { 'Ouwave (Diffusers)': 'Crearoma (Ouwave)' };
const NEW_LEAD_TIME = 30;
const target = new Map(Object.entries(MAP).map(([from, to]) => [supplierKey(from), to]));

const { saPool } = await import('../server/db.js');
const client = await saPool.connect();
try {
  await client.query('BEGIN');
  const suppliers = (await client.query(`SELECT id, name, lead_time FROM suppliers ORDER BY id`)).rows;
  const products = (await client.query(
    `SELECT id, "productCode", name, supplier, supplier_id, lead_time FROM products ORDER BY "productCode"`)).rows;

  // Lead time as Demand Planning resolves it today: product override, then the
  // linked supplier, then a name match, then 30 days.
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const byName = new Map(suppliers.map((s) => [s.name.toLowerCase().trim(), s]));
  const leadNow = (p) => p.lead_time ?? (p.supplier_id ? byId.get(p.supplier_id)?.lead_time
    : byName.get(String(p.supplier || '').toLowerCase().trim())?.lead_time) ?? 30;

  // 0. Renames that keep the registry row (and its lead time): Ouwave (Diffusers)
  // becomes Crearoma (Ouwave) instead of being folded into a new 30-day entry.
  const renamed = [];
  for (const [from, to] of Object.entries(RENAME)) {
    const row = suppliers.find((s) => supplierKey(s.name) === supplierKey(from));
    if (!row || suppliers.some((s) => supplierKey(s.name) === supplierKey(to))) continue;
    await client.query(`UPDATE suppliers SET name = $1 WHERE id = $2`, [to, row.id]);
    renamed.push(`${row.name} → ${to} (${row.lead_time} days)`); row.name = to;
  }

  // 1. Every registry name the map points at must exist.
  const created = [];
  const reg = new Map(suppliers.map((s) => [supplierKey(s.name), s]));
  for (const to of new Set(Object.values(MAP).filter(Boolean))) {
    if (reg.has(supplierKey(to))) continue;
    const row = (await client.query(
      `INSERT INTO suppliers (name, lead_time, notes) VALUES ($1, $2, 'Added by the supplier clean-up, 9 Nov 2026') RETURNING id, name, lead_time`,
      [to, NEW_LEAD_TIME])).rows[0];
    reg.set(supplierKey(to), row); created.push(row.name);
  }

  // 2. Move each product.
  const moved = new Map(); const undecided = new Map(); const leadChanges = [];
  for (const p of products) {
    const text = String(p.supplier || '').trim();
    if (!text) {
      if (p.supplier_id) { await client.query(`UPDATE products SET supplier_id = NULL WHERE id = $1`, [p.id]); moved.set('(blank text, stale link) → no supplier', (moved.get('(blank text, stale link) → no supplier') || 0) + 1); }
      continue;
    }
    const k = supplierKey(text);
    // Not in MAP but already a registry name (Crearoma after a first run, a
    // supplier registered since): it stays that supplier.
    const to = target.has(k) ? target.get(k) : reg.get(k)?.name;
    if (to === undefined) { undecided.set(text, (undecided.get(text) || 0) + 1); continue; }
    const sup = to ? reg.get(supplierKey(to)) : null;
    if (p.supplier === (sup?.name ?? '') && p.supplier_id === (sup?.id ?? null)) continue;
    await client.query(`UPDATE products SET supplier = $1, supplier_id = $2 WHERE id = $3`, [sup?.name ?? '', sup?.id ?? null, p.id]);
    const label = `"${p.supplier}"${p.supplier_id ? ` (linked to ${byId.get(p.supplier_id)?.name ?? p.supplier_id})` : ''} → ${sup ? `"${sup.name}"` : 'no supplier'}`;
    moved.set(label, (moved.get(label) || 0) + 1);
    const before = leadNow(p), after = p.lead_time ?? sup?.lead_time ?? 30;
    if (before !== after) leadChanges.push(`${p.productCode} ${p.name}: ${before} → ${after} days`);
  }

  // 3. Registry names that are now spellings of another one (BELL, "Smart Fragrances > BELL").
  const merged = [];
  for (const s of suppliers) {
    const to = target.get(supplierKey(s.name));
    if (to === undefined || supplierKey(to) === supplierKey(s.name)) continue;
    const left = (await client.query(`SELECT COUNT(*)::int n FROM products WHERE supplier_id = $1`, [s.id])).rows[0].n;
    if (left) { undecided.set(`registry "${s.name}" still linked`, left); continue; }
    await client.query(`DELETE FROM suppliers WHERE id = $1`, [s.id]);
    merged.push(`${s.name} → ${to || 'removed'}`);
  }

  console.log(`\nSupplier clean-up — ${APPLY ? 'APPLIED' : 'DRY RUN (nothing written)'}\n`);
  console.log(`Registry renames: ${renamed.join('; ') || 'none'}`);
  console.log(`New registry suppliers (${created.length}, at ${NEW_LEAD_TIME} days): ${created.join(', ') || 'none'}`);
  console.log(`Registry entries folded into another: ${merged.join('; ') || 'none'}`);
  console.log(`\nProducts moved:`);
  for (const [l, n] of moved) console.log(`  ${String(n).padStart(4)}  ${l}`);
  console.log(`\nDemand Planning lead time changes (${leadChanges.length}):`);
  for (const l of leadChanges) console.log(`  ${l}`);
  console.log(`\nNEEDS A DECISION — left exactly as they are (${undecided.size}):`);
  for (const [t, n] of undecided) console.log(`  ${String(n).padStart(4)}  "${t}"`);

  await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
  console.log(APPLY ? '\nCommitted.' : '\nRolled back. Run with --apply to write it.');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Failed, nothing written:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await saPool.end();
}
