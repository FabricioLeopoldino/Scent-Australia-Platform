// ═══════════════════════════════════════════════════════════════════════════
// SM DATA RESET — wipes ALL business data in schema sm (D3: SM is resettable)
// ═══════════════════════════════════════════════════════════════════════════
// Keeps:  sm.users (platform-mirrored, id-aligned) · sm.system_settings
// Wipes:  every other sm table (TRUNCATE RESTART IDENTITY CASCADE)
//         + platform.product_links + platform.stock_transfers (reference sm)
//
// After running, rebuild the catalog:  node scripts/import-muse-catalog.cjs
// (creates masters/fragrances/variants with store SKUs + SA links from the
//  owner's CSV). Verify with: node scripts/integrity-sm.cjs
//
// Usage: node scripts/reset-sm-data.cjs --confirm
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');

if (!process.argv.includes('--confirm')) {
  console.error('This wipes ALL SM business data. Run with --confirm to proceed.');
  process.exit(1);
}

const KEEP = ['users', 'system_settings'];
const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const pool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false } });

(async () => {
  const tables = (
    await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'sm' AND table_type = 'BASE TABLE' ORDER BY table_name`
    )
  ).rows.map((r) => r.table_name).filter((t) => !KEEP.includes(t));

  console.log(`Wiping ${tables.length} sm tables (keeping: ${KEEP.join(', ')})`);
  await pool.query(`TRUNCATE ${tables.map((t) => `sm."${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

  const lk = await pool.query(`SELECT COUNT(*) n FROM platform.product_links`);
  const xf = await pool.query(`SELECT COUNT(*) n FROM platform.stock_transfers`);
  await pool.query(`TRUNCATE platform.stock_transfers, platform.product_links RESTART IDENTITY CASCADE`);
  console.log(`Wiped platform links (${lk.rows[0].n}) and transfers (${xf.rows[0].n})`);

  for (const t of ['products', 'transactions', 'production_orders', 'audit_log']) {
    const c = await pool.query(`SELECT COUNT(*) n FROM sm."${t}"`);
    console.log(`  sm.${t}: ${c.rows[0].n}`);
  }
  const u = await pool.query(`SELECT COUNT(*) n FROM sm.users`);
  console.log(`  sm.users kept: ${u.rows[0].n}`);
  console.log('\nDone. Now run: node scripts/import-muse-catalog.cjs  (server must be up)');
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
