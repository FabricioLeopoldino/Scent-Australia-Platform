// ═══════════════════════════════════════════════════════════════════════════
// D14 PHASE 2 — Fragrance Library consumption service: mechanics + concurrency
// ═══════════════════════════════════════════════════════════════════════════
// This service is NOT wired into any route yet (Phase 3). This script exercises
// it directly against the running database, using a throwaway oil fixture that
// is created and destroyed by this script — no real product is ever touched.
//
// Usage: node scripts/regression-fragrance-library.cjs
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const { Pool } = require('pg');
const { withTransaction } = require('../server/sm/db.js');
const { consumeFragranceOil, restoreFragranceOil } = require('../server/sm/services/fragrance-library.js');

const direct = process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.');
const OIL_ID = '__FRAGLIB_TEST_OIL';

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };

// This script's OWN fixture setup/teardown uses a DEDICATED pool with
// search_path=sa,public — sa.products' trigger (log_direct_stock_change)
// references its sibling table unqualified, so bookkeeping writes need the
// real `sa` search_path, not `SET LOCAL` across separate pool.connect() calls
// (which doesn't persist — each query() below would get its own connection).
// The service-under-test (consumeFragranceOil/restoreFragranceOil) is exempt
// from this concern: it runs inside ONE withTransaction client and brackets
// its own write with search_path itself (see withSaSearchPath in the service).
const saFixturePool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sa,public' });
const query = (sql, params) => saFixturePool.query(sql, params);

async function setStock(v) {
  await query(`UPDATE products SET "currentStock" = $1, "stockBoxes" = 1, exclusivity = NULL WHERE id = $2`, [v, OIL_ID]);
}
async function getStock() {
  return parseFloat((await query(`SELECT "currentStock" FROM products WHERE id = $1`, [OIL_ID])).rows[0].currentStock);
}
async function txCount(type) {
  return parseInt((await query(`SELECT COUNT(*)::int c FROM transactions WHERE product_id = $1 AND type = $2`, [OIL_ID, type])).rows[0].c);
}

async function setup() {
  await query(`DELETE FROM transactions WHERE product_id = $1`, [OIL_ID]);
  await query(`DELETE FROM products WHERE id = $1`, [OIL_ID]);
  await query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", "unitPerBox", status)
     VALUES ($1, $1, $1, '__Fragrance Library concurrency probe__', 'OILS', 'mL', 1000, 1000, 'active')`,
    [OIL_ID]
  );
}
async function cleanup() {
  await query(`DELETE FROM transactions WHERE product_id = $1`, [OIL_ID]);
  await query(`DELETE FROM products WHERE id = $1`, [OIL_ID]);
  await saFixturePool.end();
}

(async () => {
  await setup();

  // ── 1. Basic consume / restore per segment ────────────────────────────────
  await withTransaction(async (client) => {
    const tq = (t, p) => client.query(t, p);
    const r = await consumeFragranceOil(tq, OIL_ID, 100, 'MUSE', 'test-muse');
    r.newStock === 900 ? ok('consume: MUSE debits correctly', '1000 → 900') : bad('MUSE debit wrong', r.newStock);
  });
  (await txCount('muse_production')) === 1 ? ok('consume: writes muse_production transaction') : bad('muse_production transaction missing');

  await withTransaction(async (client) => {
    const tq = (t, p) => client.query(t, p);
    const r = await restoreFragranceOil(tq, OIL_ID, 100, 'MUSE', 'test-muse-restore');
    r.newStock === 1000 ? ok('restore: MUSE credits correctly', '900 → 1000') : bad('MUSE restore wrong', r.newStock);
  });
  (await txCount('muse_reversal')) === 1 ? ok('restore: writes muse_reversal transaction') : bad('muse_reversal transaction missing');

  await withTransaction(async (client) => {
    const tq = (t, p) => client.query(t, p);
    await consumeFragranceOil(tq, OIL_ID, 50, 'STANDARD', 'test-std');
  });
  (await txCount('sm_std_production')) === 1 ? ok('consume: STANDARD writes sm_std_production') : bad('sm_std_production missing');

  await withTransaction(async (client) => {
    const tq = (t, p) => client.query(t, p);
    await consumeFragranceOil(tq, OIL_ID, 50, 'MAJOR', 'test-major');
  });
  (await txCount('sm_major_production')) === 1 ? ok('consume: MAJOR writes sm_major_production') : bad('sm_major_production missing');

  console.log(`      stock after 3 debits (100 restored, then -50 -50): ${await getStock()}`);
  (await getStock()) === 900 ? ok('running balance correct after mixed segment debits', '1000 -50 -50 = 900') : bad('balance wrong', await getStock());

  // ── 2. Non-negative guard ─────────────────────────────────────────────────
  await setStock(10);
  let guardTripped = false;
  try {
    await withTransaction(async (client) => {
      const tq = (t, p) => client.query(t, p);
      await consumeFragranceOil(tq, OIL_ID, 999, 'MUSE', 'test-oversell');
    });
  } catch (e) { guardTripped = /Insufficient/.test(e.message); }
  guardTripped && (await getStock()) === 10
    ? ok('non-negative guard rejects an oversell and leaves stock untouched')
    : bad('non-negative guard failed', `tripped=${guardTripped} stock=${await getStock()}`);

  // ── 3. Exclusivity guard ──────────────────────────────────────────────────
  await setStock(100);
  await query(`UPDATE sa.products SET exclusivity = 'MUSE' WHERE id = $1`, [OIL_ID]);
  let exclusivityBlocked = false;
  try {
    await withTransaction(async (client) => {
      const tq = (t, p) => client.query(t, p);
      await consumeFragranceOil(tq, OIL_ID, 10, 'STANDARD', 'test-exclusivity');
    });
  } catch (e) { exclusivityBlocked = /exclusive to MUSE/.test(e.message); }
  exclusivityBlocked ? ok('exclusivity: SM (Standard) blocked from a MUSE-exclusive oil') : bad('exclusivity guard did not block SM');

  let exclusivityAllowed = true;
  try {
    await withTransaction(async (client) => {
      const tq = (t, p) => client.query(t, p);
      await consumeFragranceOil(tq, OIL_ID, 10, 'MUSE', 'test-exclusivity-ok');
    });
  } catch (e) { exclusivityAllowed = false; }
  exclusivityAllowed ? ok('exclusivity: MUSE itself can still consume its own exclusive oil') : bad('exclusivity wrongly blocked the owning business');
  await query(`UPDATE sa.products SET exclusivity = NULL WHERE id = $1`, [OIL_ID]);

  // ── 4. THE CONCURRENCY TEST ────────────────────────────────────────────────
  // Task A = my new Fragrance Library debit (guards non-negative).
  // Task B = a FAITHFUL replica of SA's REAL Shopify-sale webhook debit code
  // (server/sa/index.js ~line 2340): SELECT...FOR UPDATE, then
  // `newStock = currentStock - totalDeduction` with NO guard — SA's own
  // comment says "Allow negative stock" (a completed sale is never refused).
  // This is a genuinely discovered asymmetry, not an assumption: SA's real
  // code never blocks; only the new Fragrance Library side can refuse.
  await setStock(100);
  // search_path=sa mirrors the real saPool config (server/db.js) — needed for
  // sa.products' own trigger (its unqualified direct_stock_changes reference)
  // to resolve, exactly like a genuine SA session would.
  const rawPool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false }, options: '-c search_path=sa,public' });

  async function saStyleDebit(qty) {
    const client = await rawPool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`SELECT * FROM sa.products WHERE id = $1 FOR UPDATE`, [OIL_ID]);
      const p = r.rows[0];
      const current = parseFloat(p.currentStock) || 0;
      const newStock = current - qty; // SA's real behaviour: allowed to go negative
      await client.query(`UPDATE sa.products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3`, [newStock, Math.floor(newStock / (p.unitPerBox || 1)), p.id]);
      await client.query(
        `INSERT INTO sa.transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, shopify_order_id)
         VALUES ($1,$2,$3,'OILS','shopify_sale',$4,$5,$6,$7,$8)`,
        [p.id, p.productCode, p.name, qty, p.unit || 'mL', newStock, 'concurrency-probe SA-style sale', '#CONC-PROBE']
      );
      await client.query('COMMIT');
      return { ok: true, newStock };
    } catch (e) {
      await client.query('ROLLBACK');
      return { ok: false, error: e.message };
    } finally {
      client.release();
    }
  }

  async function fragLibDebit(qty) {
    try {
      let result;
      await withTransaction(async (client) => {
        const tq = (t, p) => client.query(t, p);
        result = await consumeFragranceOil(tq, OIL_ID, qty, 'MUSE', 'concurrency-probe MUSE production');
      });
      return { ok: true, newStock: result.newStock };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 60 + 60 = 120 > 100 available — the two CANNOT both fully succeed if either
  // side enforced a guard. Fire truly concurrently.
  const [resA, resB] = await Promise.all([fragLibDebit(60), saStyleDebit(60)]);
  const finalStock = await getStock();
  console.log(`      Fragrance Library debit(60): ${JSON.stringify(resA)}`);
  console.log(`      SA-style webhook debit(60) : ${JSON.stringify(resB)}`);
  console.log(`      final stock: ${finalStock}`);

  const noCorruption = finalStock === 100 - (resA.ok ? 60 : 0) - 60; // SA's debit ALWAYS lands (never guarded)
  noCorruption
    ? ok('concurrency: final balance is exactly consistent (no lost update, no double-count)', `stock=${finalStock}`)
    : bad('concurrency: balance is NOT consistent — possible lost update', `stock=${finalStock}, expected ${100 - (resA.ok?60:0) - 60}`);

  resB.ok
    ? ok('concurrency: the SA-style debit ALWAYS succeeds (matches production — a completed sale is never refused)')
    : bad('concurrency: the SA-style debit was unexpectedly refused — this would be a behaviour change to SA', resB.error);

  if (!resA.ok) {
    ok('concurrency: the Fragrance Library debit was refused when the shared oil ran short', resA.error);
  } else {
    console.log('      (Fragrance Library debit won the race this run — both fit; rerun to observe the reverse ordering)');
  }

  finalStock >= 0
    ? console.log(`      NOTE: final stock ${finalStock} — `, finalStock < 0 ? '⚠️ WENT NEGATIVE (expected: SA-style debit never guards)' : 'stayed non-negative this run')
    : null;

  await rawPool.end();
  await cleanup();
  console.log(`\n══════ D14 FRAGRANCE LIBRARY: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('FATAL', e.message); await cleanup().catch(() => {}); process.exit(1); });
