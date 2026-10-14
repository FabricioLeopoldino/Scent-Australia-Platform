// Swap the Shopify SKUs of two spare parts so each product carries its own number.
//
// WHY (2026-10-14). The SKU audit found the Wall Mount Bracket (SAMAC_00042)
// holding SA_MAC_00328 — a code Shopify does not carry — and the Franch Drum
// Nozzle (SAMAC_00043) holding SA_MAC_00042, the Bracket's number. With both
// Shopify listings on SA_MAC_00042, a Bracket sale debited the Nozzle. The
// Products screen has no SKU field, so this cannot be fixed from the UI.
// After this, Fabricio sets the Nozzle listing in Shopify to SA_MAC_00043.
//
// Dry run by default; --apply to write. Stock is not touched.
import 'dotenv/config';
import pkg from 'pg';

const APPLY = process.argv.includes('--apply');
const pool = new pkg.Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

const CHANGES = [
  { productCode: 'SAMAC_00042', from: 'SA_MAC_00328', to: 'SA_MAC_00042' },
  { productCode: 'SAMAC_00043', from: 'SA_MAC_00042', to: 'SA_MAC_00043' },
];

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const actor = (await client.query(
    `SELECT id, name FROM users WHERE role = 'root' ORDER BY id LIMIT 1`)).rows[0];
  if (!actor) throw new Error('no root user to attribute the change to');

  for (const c of CHANGES) {
    const p = (await client.query(
      `SELECT id, name, "shopifySkus", "currentStock" FROM products WHERE "productCode" = $1 FOR UPDATE`,
      [c.productCode])).rows[0];
    if (!p) throw new Error(`${c.productCode} not found`);
    if (p.shopifySkus?.SA_MAC !== c.from) {
      throw new Error(`${c.productCode} holds ${JSON.stringify(p.shopifySkus)}, expected SA_MAC=${c.from} — already changed?`);
    }
    const next = { ...p.shopifySkus, SA_MAC: c.to };
    await client.query(`UPDATE products SET "shopifySkus" = $1 WHERE id = $2`, [JSON.stringify(next), p.id]);
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'product_updated', 'product', $2, $3, $4)`,
      [actor.id, p.id, p.name, JSON.stringify({
        field: 'shopifySkus', before: p.shopifySkus, after: next,
        reason: 'SKU audit 2026-10-14: Bracket and Nozzle carried each other\'s Shopify SKU',
      })]);
    console.log(`${c.productCode} ${p.name}: ${c.from} -> ${c.to} (stock ${p.currentStock}, untouched)`);
  }

  // Each new SKU must resolve to exactly the product it was given to.
  for (const c of CHANGES) {
    const hits = (await client.query(
      `SELECT "productCode" FROM products
        WHERE EXISTS (SELECT 1 FROM jsonb_each_text("shopifySkus") WHERE value = $1)
           OR ("skuMultipliers" IS NOT NULL AND "skuMultipliers" ? $1)`, [c.to])).rows;
    if (hits.length !== 1 || hits[0].productCode !== c.productCode) {
      throw new Error(`${c.to} resolves to ${JSON.stringify(hits)}, expected only ${c.productCode}`);
    }
  }

  await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
  console.log(APPLY ? `APPLIED (audit as ${actor.name})` : 'DRY RUN — rolled back. Re-run with --apply to write.');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('ROLLED BACK:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
