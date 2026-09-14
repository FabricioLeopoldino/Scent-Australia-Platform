// Reverses the stock drift left by running regression-sa.js twice on 2026-09-14.
//
// WHAT HAPPENED. The suite was run twice against live data (09:46 and 09:51
// Sydney) to prove that a change to the replenishment status had not broken
// anything. It had not — the same failures appear on the unmodified baseline.
// But the suite does not clean up after itself when it is interrupted, and two
// of its tests are stale, so three real products moved:
//
//   FRAG_0001  Armani Woods                8900 → 8904 mL   (+4)
//   FRAG_0231  Hyde Signature                 0 → -400 mL   (-400)
//   FRAG_0323  Baccarat (Strong Version)  15800 → 16200 mL  (+400)
//
// The +4 is the tech-stock test: Tech Stock was retired, so its cycle fails and
// its compensating "+2 revert" fires with nothing to revert. Twice.
//
// The ±400 pair is the interesting one, and it is worth reading before this is
// dismissed as test noise. Run 1 was killed mid-suite, after its webhook
// fulfilment had debited FRAG_0231 by 400 mL and before its cancellation could
// give it back. Run 2 reused the same order id, #TESTREG1. The 3-layer
// duplicate guard correctly refused to debit a second time — but the
// CANCELLATION path has no equivalent guard, so it credited +400 anyway, onto
// whichever oil run 2 had resolved (FRAG_0323). A reversal paid out for a
// debit that never happened.
//
// That only fires when an order id is reused, which in production Shopify does
// not do — so it is not being reported as a live defect. It is written down
// here because it is the mechanism, and because a reversal that does not check
// whether its debit actually landed is worth a look in its own right.
//
// HOW THIS FIXES IT. Through /api/sa/stock/add and /stock/remove — the same
// audited endpoints the suite used — so each correction writes its own ledger
// row. Nothing is deleted and nothing is edited in place: the test movement and
// the correction both stay in the record, which is the point.
//
// The nine #TESTREG1 rows still in sa.transactions are deliberately NOT touched.
// They are `shopify_reversal`, which is not a demand type, so they change no
// forecast; removing rows from the production ledger is the owner's call.
//
// Dry run by default. Pass --apply to write.
//   node scripts/restore-regression-sa-drift-20260914.cjs
//   node scripts/restore-regression-sa-drift-20260914.cjs --apply
require('dotenv').config();
const { Pool } = require('pg');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { join } = require('node:path');

const APPLY = process.argv.includes('--apply');
const ROOT = join(__dirname, '..');
const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;

// Measured from direct_stock_changes.old_stock on the first row each product
// touched, cross-checked against transactions.balance_after. Both agree.
const DRIFT = [
  { id: 'OIL_1',   code: 'FRAG_0001', name: 'Armani Woods',              before: 8900,  after: 8904  },
  { id: 'OIL_231', code: 'FRAG_0231', name: 'Hyde Signature',            before: 0,     after: -400  },
  { id: 'OILS_49', code: 'FRAG_0323', name: 'Baccarat (Strong Version)', before: 15800, after: 16200 },
];
const NOTE = '[restore] reversing drift left by regression-sa.js runs of 2026-09-14';

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let server, failed = 0;

(async () => {
  console.log(APPLY ? '=== APPLY — this writes to production ===' : '=== DRY RUN — nothing will be written (pass --apply) ===');

  // Read first. If a balance is not what was measured, somebody or something
  // else moved it since, and this script must not guess on top of that.
  const plan = [];
  for (const d of DRIFT) {
    const r = await pool.query('SELECT "currentStock"::float s, unit FROM products WHERE id = $1', [d.id]);
    if (!r.rows.length) { console.log(`  ABORT  ${d.code} not found`); failed++; continue; }
    const now = r.rows[0].s;
    const delta = d.before - now;                 // what must be applied to get back
    const expected = d.after;
    console.log(`  ${d.code.padEnd(11)} ${d.name.padEnd(28)} was ${String(d.before).padStart(6)} | now ${String(now).padStart(6)} | correction ${delta > 0 ? '+' : ''}${delta} ${r.rows[0].unit}`);
    if (now !== expected) {
      console.log(`         ABORT — expected to find ${expected}, found ${now}. Something else moved it; not guessing.`);
      failed++;
      continue;
    }
    if (delta !== 0) plan.push({ ...d, delta });
  }
  if (failed) throw new Error('pre-flight disagreed with the measurement — nothing applied');
  if (!plan.length) { console.log('\nNothing to correct — all three already sit at their pre-test values.'); return; }

  if (!APPLY) {
    console.log(`\nWould apply ${plan.length} correction(s) through /api/sa/stock/{add,remove}. Re-run with --apply.`);
    return;
  }

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1200)}`);

  const token = jwt.sign({ id: 8, name: 'restore-script', role: 'root', modules: ['SA'] },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });

  console.log('');
  for (const p of plan) {
    const path = p.delta > 0 ? '/api/sa/stock/add' : '/api/sa/stock/remove';
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: p.id, quantity: Math.abs(p.delta), notes: NOTE }),
    });
    const ok = res.ok;
    console.log(ok ? `  ok    ${p.code} ${p.delta > 0 ? '+' : ''}${p.delta}` : `  FAIL  ${p.code} — HTTP ${res.status} ${(await res.text()).slice(0, 180)}`);
    if (!ok) failed++;
  }

  console.log('\nverifying against the database:');
  for (const d of DRIFT) {
    const r = await pool.query('SELECT "currentStock"::float s FROM products WHERE id = $1', [d.id]);
    const ok = r.rows[0].s === d.before;
    console.log(ok ? `  ok    ${d.code} back at ${d.before}` : `  FAIL  ${d.code} is ${r.rows[0].s}, wanted ${d.before}`);
    if (!ok) failed++;
  }
})()
  .catch((e) => { console.error('\nFATAL', e.message); failed++; })
  .finally(async () => {
    if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
    await pool.end();
    console.log(failed === 0 ? (APPLY ? '\n✅ restored' : '\n✅ dry run clean') : `\n❌ ${failed} problem(s)`);
    process.exit(failed === 0 ? 0 : 1);
  });
