// ═══════════════════════════════════════════════════════════════════════════
// Phase 2a — SA production migration (PRD §11)
//
//   pg_dump (LIVE SA database, READ-ONLY) ──▶ restore into platform DB public
//   ──▶ ALTER SCHEMA public RENAME TO sa ──▶ user import ──▶ reconciliation
//
// SAFETY GUARANTEES (the source is a PRODUCTION system in active use):
//   1. The source session runs with default_transaction_read_only=on —
//      any write attempted through it FAILS at the Postgres level.
//   2. pg_dump only ever reads (ACCESS SHARE locks — normal operations
//      are never blocked).
//   3. All destructive statements (DROP SCHEMA sa, schema rename) run
//      exclusively on the PLATFORM database, asserted to be a different host.
//   4. Snapshot consistency on a live DB: we open a REPEATABLE READ read-only
//      transaction, pg_export_snapshot(), and pass it to pg_dump --snapshot.
//      The reconciliation then reads through the SAME open transaction —
//      dump and reconciliation see the identical frozen instant, so sales
//      happening mid-migration cause neither corruption nor false FAILs.
//
// Usage:
//   node scripts/migrate-sa.js                  full migration + reconciliation
//   node scripts/migrate-sa.js --reconcile-only reconciliation only (meaningful
//                                               right after a run; live drift
//                                               since the run will FAIL it)
//
// Repeatable by design: each run drops schema sa and reloads from a fresh
// snapshot. Exit code 0 = ALL PASS; non-zero blocks downstream phases (PRD).
// ═══════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Client } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────
// Production SA database (READ-ONLY source of the dump). The owner renamed the
// SCENT_* env family to SA_* (2026-07-14), so accept every historical name.
const SOURCE_URL =
  process.env.SA_SOURCE_DATABASE_URL ||
  process.env.SA_DATABASE_URL ||
  process.env.SCENT_DATABASE_URL;
const TARGET_URL = process.env.PLATFORM_DATABASE_URL;
const RECONCILE_ONLY = process.argv.includes('--reconcile-only');

const PG_BIN =
  process.env.PG_BIN ||
  path.join(process.env.LOCALAPPDATA || '', 'pg-tools', 'pg17', 'bin');
const PG_DUMP = path.join(PG_BIN, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
const PSQL = path.join(PG_BIN, process.platform === 'win32' ? 'psql.exe' : 'psql');

const SNAP_DIR = path.join(__dirname, '..', 'snapshots');

function directUrl(url) {
  return url ? url.replace('-pooler.', '.') : url;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`\n❌ ABORT: ${msg}`);
  process.exit(1);
}

function fmt(n) {
  return n === null || n === undefined ? 'NULL' : String(n);
}

// ── Reconciliation ────────────────────────────────────────────────────────
// srcQ reads the SOURCE through the frozen snapshot transaction.
// tgtQ reads schema sa on the platform DB.
async function reconcile(srcQ, tgtQ) {
  const results = []; // { check, source, target, pass }
  const add = (check, source, target, pass = String(source) === String(target)) =>
    results.push({ check, source: fmt(source), target: fmt(target), pass });

  // 1. Table sets
  const srcTables = (
    await srcQ(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    )
  ).rows.map((r) => r.table_name);
  const tgtTables = (
    await tgtQ(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'sa' AND table_type = 'BASE TABLE' ORDER BY table_name`
    )
  ).rows.map((r) => r.table_name);
  add('table set', srcTables.join(','), tgtTables.join(','), srcTables.join(',') === tgtTables.join(','));

  // 2. Row count per table
  // `users` is the one sanctioned divergence: platform-only users (seeded
  // Root, users created in the platform) are MIRRORED into sa.users for FK
  // integrity. Check: every source user exists intact in target; extras must
  // all be registered platform users.
  for (const t of srcTables) {
    if (t === 'users') {
      const srcUsers = (await srcQ(`SELECT COUNT(*) FROM public.users`)).rows[0].count;
      const matched = (
        await tgtQ(`SELECT COUNT(*) FROM sa.users s
                    WHERE EXISTS (SELECT 1 FROM platform.users p
                                  WHERE p.sa_user_id = s.id::text AND p.name = s.name)`)
      ).rows[0].count;
      add('rows: users (source preserved)', srcUsers, matched);
      const extras = (
        await tgtQ(`SELECT COUNT(*) FROM sa.users s
                    WHERE NOT EXISTS (SELECT 1 FROM platform.users p WHERE p.sa_user_id = s.id::text)
                      AND NOT EXISTS (SELECT 1 FROM platform.users p WHERE p.id = s.id)`)
      ).rows[0].count;
      add('users: unexplained extras', 0, extras, String(extras) === '0');
      continue;
    }
    const s = (await srcQ(`SELECT COUNT(*) FROM public."${t}"`)).rows[0].count;
    const g = tgtTables.includes(t)
      ? (await tgtQ(`SELECT COUNT(*) FROM sa."${t}"`)).rows[0].count
      : 'MISSING';
    add(`rows: ${t}`, s, g);
  }

  // 3. Total stock (SA column is camelCase, quoted)
  const sStock = (await srcQ(`SELECT COALESCE(SUM("currentStock"),0)::numeric(20,3) AS s FROM public.products`)).rows[0].s;
  const gStock = (await tgtQ(`SELECT COALESCE(SUM("currentStock"),0)::numeric(20,3) AS s FROM sa.products`)).rows[0].s;
  add('SUM(products.currentStock)', sStock, gStock);

  // 4. Per-product stock mismatches
  const perProdSql = (schema) =>
    `SELECT id, "currentStock"::numeric(20,3) AS st FROM ${schema}.products ORDER BY id`;
  const sProd = (await srcQ(perProdSql('public'))).rows;
  const gProd = (await tgtQ(perProdSql('sa'))).rows;
  const gMap = new Map(gProd.map((r) => [r.id, r.st]));
  let mismatches = 0;
  for (const r of sProd) if (String(gMap.get(r.id)) !== String(r.st)) mismatches++;
  add('per-product stock mismatches', 0, mismatches, mismatches === 0);

  // 5. Last transaction balance per product
  const lastBalSql = (schema) =>
    `SELECT DISTINCT ON (product_id) product_id, balance_after::numeric(20,3) AS b
     FROM ${schema}.transactions ORDER BY product_id, created_at DESC, id DESC`;
  const sBal = (await srcQ(lastBalSql('public'))).rows;
  const gBal = (await tgtQ(lastBalSql('sa'))).rows;
  const gBalMap = new Map(gBal.map((r) => [String(r.product_id), String(r.b)]));
  let balMism = 0;
  for (const r of sBal) if (gBalMap.get(String(r.product_id)) !== String(r.b)) balMism++;
  add('last balance_after mismatches', 0, balMism, balMism === 0 && sBal.length === gBal.length);

  // ── Report ──
  const w1 = Math.max(...results.map((r) => r.check.length), 5) + 2;
  let out = '\n══════════ RECONCILIATION REPORT ══════════\n';
  let allPass = true;
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) allPass = false;
    const detail = r.check === 'table set' && r.pass ? `${r.source.split(',').length} tables` : `src=${r.source} tgt=${r.target}`;
    out += `${status}  ${r.check.padEnd(w1)} ${r.pass ? detail : '⟵ MISMATCH: ' + detail}\n`;
  }
  out += `════════════════════════════════════════════\nRESULT: ${allPass ? '✅ ALL PASS' : '❌ FAILED'}\n`;
  console.log(out);

  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
  const reportPath = path.join(SNAP_DIR, `reconciliation-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  writeFileSync(reportPath, out);
  console.log(`Report archived: ${reportPath}\n`);

  return allPass;
}

// ── User import (§11.4) ───────────────────────────────────────────────────
// ID ALIGNMENT (audit finding 2026-07-08): sa.audit_log, sa.transactions,
// sa.purchase_orders and sa.scented_product_groups all carry FK constraints
// to sa.users(id), and SA routes write req.user.id (the PLATFORM id) into
// them. Therefore:
//   1. Users are imported PRESERVING their sa.users id, so platform id ==
//      sa id for every migrated user.
//   2. Every platform-only user (seeded Root, users created later) is
//      MIRRORED into sa.users under the same id, so the FKs always resolve
//      and Activity Log name joins stay correct.
// The platform router repeats the mirror on user create/delete (see
// router.js) — this function re-establishes the invariant on each run.
async function importUsers(tgt) {
  console.log('[users] Importing sa.users → platform.users (ids preserved)...');

  // Re-align: drop previously imported users (platform-only users survive).
  await tgt.query(`DELETE FROM platform.users WHERE sa_user_id IS NOT NULL`);

  const res = await tgt.query(`
    INSERT INTO platform.users (id, name, password_hash, role, must_change_password, sa_user_id)
    SELECT id, name, password, role, COALESCE(must_change_password, false), id::text
    FROM sa.users
    ON CONFLICT (name) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      role = EXCLUDED.role,
      must_change_password = EXCLUDED.must_change_password,
      sa_user_id = EXCLUDED.sa_user_id
    RETURNING id, name, role
  `);
  await tgt.query(`
    SELECT setval(pg_get_serial_sequence('platform.users','id'),
                  GREATEST((SELECT COALESCE(MAX(id),1) FROM platform.users), 1))
  `);

  // Mirror platform-only users into sa.users (same id; hash reused only to
  // satisfy NOT NULL — SA no longer has a login path).
  const mirrored = await tgt.query(`
    INSERT INTO sa.users (id, name, password, role, must_change_password)
    SELECT p.id, p.name, p.password_hash, p.role, false
    FROM platform.users p
    WHERE NOT EXISTS (SELECT 1 FROM sa.users s WHERE s.id = p.id)
    ON CONFLICT DO NOTHING
    RETURNING id, name
  `);
  await tgt.query(`
    SELECT setval(pg_get_serial_sequence('sa.users','id'),
                  GREATEST((SELECT COALESCE(MAX(id),1) FROM sa.users),
                           (SELECT COALESCE(MAX(id),1) FROM platform.users)))
  `);

  // Default module access (additive — never strips manual grants):
  // everyone → SA; root → also SM. Technicians get SA only.
  await tgt.query(`
    INSERT INTO platform.user_modules (user_id, module)
    SELECT id, 'SA' FROM platform.users WHERE sa_user_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await tgt.query(`
    INSERT INTO platform.user_modules (user_id, module)
    SELECT id, 'SM' FROM platform.users WHERE role = 'root' AND sa_user_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);

  console.log(`[users] Imported ${res.rowCount} users with sa ids preserved; mirrored ${mirrored.rowCount} platform-only users into sa.users.`);

  // Invariant check: every platform user must now exist in sa.users with the same id
  const broken = await tgt.query(`
    SELECT p.id, p.name FROM platform.users p
    LEFT JOIN sa.users s ON s.id = p.id
    WHERE s.id IS NULL
  `);
  if (broken.rows.length > 0) {
    console.error('[users] ❌ ID-alignment invariant broken for:', JSON.stringify(broken.rows));
    throw new Error('User id alignment failed');
  }
  console.log('[users] ✅ ID-alignment invariant verified (platform.users ⊆ sa.users by id).');
}

// ── IDENTITY GUARD ────────────────────────────────────────────────────────
// The host check below proves source ≠ target, but NOT that the target is the
// right database. If PLATFORM_DATABASE_URL ever pointed at production (an easy
// mistake — the .env has carried duplicate PLATFORM_DATABASE_URL entries), the
// `DROP SCHEMA public CASCADE` further down would destroy the live SA system —
// including a physical stock count that cost real people real days to produce.
// So: before ANY destructive statement, PROVE the target is the platform DB and
// PROVE the source is production. Refuse loudly otherwise.
async function assertDatabaseIdentities(tgt, src) {
  // 1. TARGET must own the platform schema (production has no such schema).
  const hasPlatform = await tgt.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'platform' AND table_name = 'users'`
  );
  if (hasPlatform.rows[0].n === 0) {
    fail(
      'TARGET does not contain platform.users — it is NOT the platform database. ' +
      'Refusing to run (this is the guard that stops a DROP on production).'
    );
  }

  // 2. TARGET must NOT look like the production SA system: production keeps its
  //    tables in `public`. A populated public.products on the target means the
  //    URL points at production.
  const tgtPublic = await tgt.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('products','transactions')`
  );
  if (tgtPublic.rows[0].n > 0) {
    const rows = await tgt.query(`SELECT COUNT(*)::int AS n FROM public.products`).catch(() => ({ rows: [{ n: 0 }] }));
    if (rows.rows[0].n > 0) {
      fail(
        `TARGET has ${rows.rows[0].n} rows in public.products — this looks like the PRODUCTION SA database. ` +
        'Refusing to run. Check PLATFORM_DATABASE_URL.'
      );
    }
  }

  // 3. SOURCE must actually be production (tables in public with data), else the
  //    dump would silently produce an empty/incomplete restore.
  const srcProducts = await src.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'products'`
  );
  if (srcProducts.rows[0].n === 0) {
    fail('SOURCE has no public.products — it does not look like the production SA database. Refusing to run.');
  }
  const srcCount = (await src.query(`SELECT COUNT(*)::int AS n FROM public.products`)).rows[0].n;
  if (srcCount === 0) {
    fail('SOURCE public.products is EMPTY — refusing to migrate an empty production snapshot.');
  }

  console.log(`[guard] TARGET confirmed = platform DB (platform.users present, public empty).`);
  console.log(`[guard] SOURCE confirmed = production SA (${srcCount} products, read-only session).\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();

  // Preconditions
  if (!SOURCE_URL) fail('SA_DATABASE_URL (production SA source) not set — add it to .env.');
  if (!TARGET_URL) fail('PLATFORM_DATABASE_URL not set.');
  const srcHost = hostOf(SOURCE_URL);
  const tgtHost = hostOf(TARGET_URL);
  if (!srcHost || !tgtHost) fail('Could not parse database hosts.');
  if (srcHost.replace('-pooler.', '.') === tgtHost.replace('-pooler.', '.')) {
    fail(`Source and target are the SAME database (${srcHost}) — refusing to run.`);
  }
  if (!RECONCILE_ONLY && !existsSync(PG_DUMP)) fail(`pg_dump not found at ${PG_DUMP} (set PG_BIN).`);
  if (!RECONCILE_ONLY && !existsSync(PSQL)) fail(`psql not found at ${PSQL} (set PG_BIN).`);

  console.log('════════════════════════════════════════════');
  console.log(' SA PRODUCTION MIGRATION — Phase 2a (PRD §11)');
  console.log('════════════════════════════════════════════');
  console.log(`SOURCE (read-only): ${srcHost}`);
  console.log(`TARGET (platform) : ${tgtHost}`);
  console.log(`Mode              : ${RECONCILE_ONLY ? 'reconcile-only' : 'full migration'}\n`);

  // ── SOURCE session: read-only, snapshot-frozen ──
  // Direct endpoint required: Neon's pooler rejects `options` startup params,
  // and the exported snapshot must be shared by pg_dump on the same backend.
  const src = new Client({
    connectionString: directUrl(SOURCE_URL),
    ssl: { rejectUnauthorized: false },
    options: '-c default_transaction_read_only=on',
  });
  await src.connect();
  await src.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snap = (await src.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
  const srcInfo = (await src.query('SELECT current_database() AS db, version() AS v')).rows[0];
  console.log(`[source] Connected READ-ONLY to "${srcInfo.db}" — snapshot ${snap} exported.`);
  console.log(`[source] ${srcInfo.v.split(',')[0]}\n`);
  const srcQ = (text) => src.query(text);

  // ── TARGET connection (direct endpoint for DDL) ──
  const tgt = new Client({
    connectionString: directUrl(TARGET_URL),
    ssl: { rejectUnauthorized: false },
  });
  await tgt.connect();
  const tgtQ = (text) => tgt.query(text);

  // HARD GUARD — runs BEFORE anything destructive. Proves the target is the
  // platform DB and the source is production. Aborts otherwise.
  await assertDatabaseIdentities(tgt, src);

  try {
    if (!RECONCILE_ONLY) {
      // Precondition: public schema on the platform DB must be empty
      const pubTables = await tgt.query(
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      if (parseInt(pubTables.rows[0].count) > 0) {
        fail('Platform public schema is not empty — it must hold no tables before restore.');
      }

      // 1. Dump through the exported snapshot
      if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
      const dumpPath = path.join(SNAP_DIR, 'sa_dump_latest.sql');
      console.log('[dump] Running pg_dump (read-only, snapshot-consistent)...');
      const dump = spawnSync(
        PG_DUMP,
        [
          '--no-owner',
          '--no-privileges',
          '--schema=public',
          `--snapshot=${snap}`,
          '--format=plain',
          `--file=${dumpPath}`,
          directUrl(SOURCE_URL),
        ],
        { encoding: 'utf8', timeout: 600000 }
      );
      if (dump.status !== 0) fail(`pg_dump failed: ${dump.stderr || dump.error}`);
      console.log(`[dump] Done → ${dumpPath}`);

      // 2. Drop previous sa schema + the (verified-empty) public schema —
      //    the dump itself recreates public (PG15+ dumps emit CREATE SCHEMA public).
      console.log('[target] DROP SCHEMA IF EXISTS sa CASCADE (platform DB)...');
      await tgt.query('DROP SCHEMA IF EXISTS sa CASCADE');
      await tgt.query('DROP SCHEMA IF EXISTS public CASCADE');

      // 3. Restore into public (single transaction — all or nothing)
      console.log('[restore] psql --single-transaction into platform public...');
      const restore = spawnSync(
        PSQL,
        ['-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-f', dumpPath, directUrl(TARGET_URL)],
        { encoding: 'utf8', timeout: 600000 }
      );
      if (restore.status !== 0) fail(`psql restore failed: ${restore.stderr || restore.error}`);
      console.log('[restore] Done.');

      // 4. Rename public → sa, recreate public
      console.log('[target] ALTER SCHEMA public RENAME TO sa; CREATE SCHEMA public;');
      await tgt.query('ALTER SCHEMA public RENAME TO sa');
      await tgt.query('CREATE SCHEMA public');

      // 5. User import
      await importUsers(tgt);
    }

    if (!RECONCILE_ONLY) {
      // FR-XFER-9: the restored production constraint lacks the transfer
      // types — re-extend immediately so transfers never hit a stale CHECK.
      await tgt.query(`
        DO $$
        BEGIN
          ALTER TABLE sa.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
          ALTER TABLE sa.transactions ADD CONSTRAINT transactions_type_check
            CHECK (type IN (
              'add', 'remove', 'adjust', 'incoming', 'return',
              'shopify_sale', 'shopify_reversal',
              'formula_ready_used', 'formula_ready_restored',
              'tech_transfer_out', 'tech_transfer_in',
              'tech_remove',
              'tech_return_from_tech', 'tech_return_to_main',
              'tech_return_input',
              'transfer_out', 'transfer_cancel_return'
            ));
        END$$;
      `);
      console.log('[target] transactions CHECK extended with transfer types (FR-XFER-9).');
    }

    // 6. Reconciliation (source reads stay inside the frozen snapshot txn)
    const allPass = await reconcile(srcQ, tgtQ);

    console.log(`Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await src.query('COMMIT').catch(() => {});
    await src.end().catch(() => {});
    await tgt.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('\n❌ Migration error:', e.message);
  process.exit(1);
});
