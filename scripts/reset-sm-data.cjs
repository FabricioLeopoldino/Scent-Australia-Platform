// ═══════════════════════════════════════════════════════════════════════════
// SM DATA RESET — wipes ALL business data in schema sm
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️  SM IS NO LONGER RESETTABLE. The header of this file used to say it was,
// on the authority of D3, and that stopped being true on 2026-08-10 when MUSE
// went retail. Nobody came back to tell the file. A reader in six months would
// have believed it — which is the actual danger here, not the SQL.
//
// It was armed at production: the only barrier was `--confirm`, and the target
// came from PLATFORM_DATABASE_URL in .env. One command destroyed the live MUSE
// catalogue, every order, every transaction, the audit history and the SA↔SM
// oil links — measured on 2026-08-11 at 3,937 rows across 31 tables. sm.users
// survives, so the system still lets you log in; it is just empty.
//
// Recovery would depend on Neon point-in-time restore, whose window nobody has
// verified. Assume there is no undo.
//
// The legitimate use that remains is rehearsing a migration on a Neon BRANCH
// (Block B needs one). A branch is a copy of production, so no data-shaped test
// can tell them apart — only the connection string can. Hence the guards:
//
//   · RESET_DATABASE_URL must be set explicitly. .env alone can no longer arm
//     it, which is the single most important line in this file.
//   · If that URL points at the same database as PLATFORM_DATABASE_URL, it
//     refuses. That is the accident this exists to prevent.
//   · Dry run by default. It prints the target and every row it would destroy.
//     --commit to apply, and --confirm on top of it.
//
// Keeps:  sm.users (platform-mirrored, id-aligned) · sm.system_settings
// Wipes:  every other sm table (TRUNCATE RESTART IDENTITY CASCADE)
//         + platform.product_links + platform.stock_transfers (reference sm)
//
// After running, rebuild the catalog:  node scripts/import-muse-catalog.cjs
// Verify with: node scripts/integrity-sm.cjs
//
// Usage:
//   RESET_DATABASE_URL=... node scripts/reset-sm-data.cjs
//   RESET_DATABASE_URL=... node scripts/reset-sm-data.cjs --commit --confirm
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');

const COMMIT = process.argv.includes('--commit');
const CONFIRM = process.argv.includes('--confirm');

const target = process.env.RESET_DATABASE_URL;
if (!target) {
  console.error('REFUSING TO RUN: set RESET_DATABASE_URL to the target database.');
  console.error('It is deliberately NOT read from PLATFORM_DATABASE_URL — this script wipes everything.');
  process.exit(2);
}

// Compare the actual database, not the raw string: the pooled and direct hosts
// differ by one substring and are the same database.
const same = (a, b) => {
  const norm = (u) => String(u || '').replace('-pooler.', '.').trim().replace(/\/$/, '');
  return norm(a) !== '' && norm(a) === norm(b);
};
if (same(target, process.env.PLATFORM_DATABASE_URL)) {
  console.error('REFUSING TO RUN: RESET_DATABASE_URL is the PRODUCTION database (it matches PLATFORM_DATABASE_URL).');
  console.error('This script is for rehearsing on a Neon branch. Point it at the branch.');
  process.exit(2);
}

const direct = target.replace('-pooler.', '.');
const host = (direct.match(/@([^/:]+)/) || [])[1] || '?';
const dbname = (direct.match(/\/([^/?]+)(\?|$)/) || [])[1] || '?';
const pool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false } });

const KEEP = ['users', 'system_settings'];

(async () => {
  console.log(`TARGET  host=${host}  db=${dbname}\n`);

  const tables = (
    await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'sm' AND table_type = 'BASE TABLE' ORDER BY table_name`
    )
  ).rows.map((r) => r.table_name).filter((t) => !KEEP.includes(t));

  // Show the damage BEFORE doing it. A number on screen is the last chance
  // anyone has to notice they are pointed at the wrong database.
  let total = 0;
  const rows = [];
  for (const t of tables) {
    const n = Number((await pool.query(`SELECT COUNT(*) n FROM sm."${t}"`)).rows[0].n);
    total += n;
    if (n > 0) rows.push([`sm.${t}`, n]);
  }
  for (const t of ['product_links', 'stock_transfers']) {
    const n = Number((await pool.query(`SELECT COUNT(*) n FROM platform."${t}"`)).rows[0].n);
    total += n;
    if (n > 0) rows.push([`platform.${t}`, n]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  console.log(`Would TRUNCATE ${tables.length} sm tables (keeping: ${KEEP.join(', ')})`);
  for (const [t, n] of rows) console.log(`  ${String(n).padStart(7)}  ${t}`);
  const kept = Number((await pool.query(`SELECT COUNT(*) n FROM sm.users`)).rows[0].n);
  console.log(`\n  TOTAL ROWS TO DESTROY: ${total}     (sm.users kept: ${kept})`);

  if (!COMMIT || !CONFIRM) {
    console.log('\nDRY RUN — nothing deleted. Re-run with BOTH --commit and --confirm to apply.');
    await pool.end();
    return;
  }

  console.log('\nApplying…');
  await pool.query(`TRUNCATE ${tables.map((t) => `sm."${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE platform.stock_transfers, platform.product_links RESTART IDENTITY CASCADE`);

  for (const t of ['products', 'transactions', 'production_orders', 'audit_log']) {
    const c = await pool.query(`SELECT COUNT(*) n FROM sm."${t}"`);
    console.log(`  sm.${t}: ${c.rows[0].n}`);
  }
  console.log(`  sm.users kept: ${(await pool.query(`SELECT COUNT(*) n FROM sm.users`)).rows[0].n}`);
  console.log('\nDone. Now run: node scripts/import-muse-catalog.cjs  (server must be up)');
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
