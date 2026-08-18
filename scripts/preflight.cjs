#!/usr/bin/env node
// Start-of-day check. Run this BEFORE touching anything.
//
// WHY THIS EXISTS (2026-08-14). The owner now holds several roles at once and
// cannot supervise closely, so work has to arrive verified rather than arrive
// for review. This is the "is everything still where we left it" pass, written
// down instead of remembered — a session carries no memory of the last one, so
// a ritual that lives in someone's head does not survive the night.
//
// It answers five questions, in the order they can hurt:
//   1. Is what is deployed the same as what is written here?
//   2. Is the database still internally consistent?
//   3. Has the shape of production changed while nobody was looking?
//   4. Do the safety guards still refuse?
//   5. What is waiting on a person, not on code?
//
// Read-only. Never writes. Never calls Shopify.
//
// Run:  node scripts/preflight.cjs            fast (about 30s)
//       node scripts/preflight.cjs --full     also runs every regression
require('dotenv').config();
const { Pool } = require('pg');
const { execSync, execFileSync, spawn } = require('node:child_process');
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const FULL = process.argv.includes('--full');
const ROOT = join(__dirname, '..');
const LIVE = 'https://scent-australia-platform-1.onrender.com/api/health';

// The shape production had when this was last known-good. Not invariants — a
// number moving is not automatically wrong, it is automatically worth a look.
// Update these deliberately, with a note, when a change is intended.
const BASELINE = {
  muse_finished_goods: 454,   // the Library. +3 per new fragrance registered.
  business_unit_library: 454, // must track the line above exactly
  // SM-002 (#1021, the Kim Moss order). SM-001 (#1020, marketing's test order)
  // was deleted by the owner through the UI on 2026-08-14 — audited as
  // production_order_deleted by user 8, which is how it took ten seconds to
  // prove no script had done it. Scripts write user_id NULL.
  production_orders: 1,
  sa_oils: 325,               // the Fragrance Library
  // 14 since 2026-08-18: order #1022 was the first real MUSE sale to be MADE
  // rather than picked, and it drove the four Room Spray components negative —
  // they had never been counted either. See integrity-sm UNCOUNTED.
  negatives: 14,
  oils_no_minimum: 22,        // MUSE oils that can never raise a warning
};

let warn = 0, bad = 0;
const ok   = (l, d = '') => console.log(`  \x1b[32mok\x1b[0m    ${l}${d ? `  ${d}` : ''}`);
const note = (l, d = '') => { warn++; console.log(`  \x1b[33m··\x1b[0m    ${l}${d ? `  ${d}` : ''}`); };
const fail = (l, d = '') => { bad++;  console.log(`  \x1b[31mXX\x1b[0m    ${l}${d ? `  ${d}` : ''}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// stdio pipe on stderr too: `2>/dev/null` is not portable to the Windows shell
// and printed "The system cannot find the path specified." over the report.
const sh = (c) => {
  try { return execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return ''; }
};

(async () => {
  console.log('\n═══ PREFLIGHT ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })
    + ' (Sydney) ═══');

  // ── 1. Deployed vs written ────────────────────────────────────────────────
  head('1. What is live');
  const localHead = sh('git rev-parse --short HEAD');
  const dirty = sh('git status --porcelain');
  const unpushed = sh('git log --oneline @{u}..HEAD');
  let live = null;
  try {
    const r = await fetch(LIVE, { signal: AbortSignal.timeout(25000) });
    live = await r.json();
  } catch (e) { fail('the live service did not answer', e.message); }

  if (live) {
    const up = Math.round((live.uptime || 0) / 60);
    ok('service is up', `commit ${live.commit} · db ${live.dbConfigured ? 'configured' : 'NOT configured'} · up ${up}m`);
    if (live.commit && localHead && !localHead.startsWith(live.commit) && !live.commit.startsWith(localHead)) {
      note(`live is ${live.commit}, local HEAD is ${localHead}`, '— a deploy is pending');
    } else ok('live matches local HEAD');
  }
  if (dirty) note(`${dirty.split('\n').length} uncommitted file(s)`, dirty.split('\n')[0].trim());
  else ok('working tree clean');
  if (unpushed) note(`${unpushed.split('\n').length} commit(s) not pushed`, unpushed.split('\n')[0]);
  else ok('nothing waiting to push');

  // ── 2 & 3. Database ───────────────────────────────────────────────────────
  const pool = new Pool({
    connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
  });
  const one = async (sql) => Number((await pool.query(sql)).rows[0].c);

  head('2. Integrity');
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts/integrity-sm.cjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const m = out.match(/\((\d+) pass \/ (\d+) fail\)/);
    if (m && m[2] === '0') ok(`integrity battery`, `${m[1]} pass / 0 fail`);
    else fail(`integrity battery`, m ? `${m[1]} pass / ${m[2]} FAIL` : 'could not parse');
    const drift = out.match(/↳ (\d+) uncounted item\(s\) negative[^\n]*/);
    if (drift) note(drift[0].replace('↳ ', ''), '');
  } catch (e) {
    const out = `${e.stdout || ''}`;
    const m = out.match(/\((\d+) pass \/ (\d+) fail\)/);
    fail('integrity battery', m ? `${m[1]} pass / ${m[2]} FAIL` : e.message);
    out.split('\n').filter((l) => l.startsWith('FAIL')).forEach((l) => console.log(`        ${l}`));
  }

  head('3. Shape of production');
  const shape = {
    muse_finished_goods: await one(`SELECT count(*) c FROM products WHERE segment='MUSE'
                                     AND category='FINISHED_GOOD' AND COALESCE(archived,false)=false`),
    business_unit_library: await one(`SELECT count(*) c FROM products WHERE business_unit='library'
                                       AND COALESCE(archived,false)=false`),
    production_orders: await one(`SELECT count(*) c FROM production_orders`),
    sa_oils: await one(`SELECT count(*) c FROM sa.products WHERE category='OILS'`),
    negatives: await one(`SELECT count(*) c FROM products WHERE current_stock<0`),
    oils_no_minimum: await one(`SELECT count(*) c FROM (
        SELECT o.id FROM sa.products o
          JOIN products v ON v.oil_id=o.id AND COALESCE(v.archived,false)=false
          JOIN products m ON m.id=v.master_product_id AND m.segment='MUSE'
         WHERE o.category='OILS' AND COALESCE(o."minStockLevel",0)=0 GROUP BY o.id) x`),
  };
  for (const [k, want] of Object.entries(BASELINE)) {
    const got = shape[k];
    if (got === want) ok(k.replace(/_/g, ' ').padEnd(22), String(got));
    else note(`${k.replace(/_/g, ' ').padEnd(22)} ${got}`, `— baseline says ${want}`);
  }
  if (shape.muse_finished_goods !== shape.business_unit_library) {
    fail('a MUSE product has no business_unit', 'reporting would silently miss it');
  }

  // Test residue: the pattern that reached production three times this month.
  head('4. Test residue in live data');
  const residue = [
    ['products named TEST', `SELECT count(*) c FROM products WHERE COALESCE(archived,false)=false
                              AND (name ILIKE '%TEST%' OR product_code LIKE '%_TEST' OR sku LIKE 'ZZ%')`],
    ['#ZZ- audit rows', `SELECT count(*) c FROM audit_log WHERE entity_name LIKE '#ZZ-%'`],
    ['test clients', `SELECT count(*) c FROM clients WHERE name ILIKE '%test%'`],
    ['orders with no store ref and no author', `SELECT count(*) c FROM production_orders
       WHERE shopify_order_id IS NULL AND shopify_order_number IS NULL AND created_by IS NULL`],
  ];
  for (const [label, sql] of residue) {
    const n = await one(sql);
    if (n === 0) ok(label, '0');
    else note(`${label}: ${n}`, '— run scripts/cleanup-regression-residue.cjs');
  }

  // ── 5. The guards ─────────────────────────────────────────────────────────
  head('5. Safety guards');
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/regression-script-guards.cjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    ok('every destructive script still refuses');
  } catch (e) {
    fail('a safety guard is not holding', 'run scripts/regression-script-guards.cjs');
    `${e.stdout || ''}`.split('\n').filter((l) => /FAIL/.test(l)).forEach((l) => console.log(`        ${l.trim()}`));
  }

  // ── 6. Optional full suite ────────────────────────────────────────────────
  if (FULL) {
    head('6. Every regression');
    // Several suites talk to a running server over HTTP and do NOT boot one.
    // The first version of this ran them without providing one, and the results
    // depended entirely on whether some earlier session had left a server on
    // :3000 — the first --full run here looked greener than it was for exactly
    // that reason, on code five hours old. Preflight now owns the server, on a
    // port of its own so it cannot collide with anything the owner is running.
    // 3980, not 399x. The suites that spawn their own server bind 3991, 3995,
    // 3996, 3997 and 3998, and the first version of this took 3996 — the exact
    // port regression-shopify-order-ingest.js uses. It then could not bind, fell
    // through to THIS server, which carries no test webhook secret, and failed
    // with 401 while passing perfectly when run on its own. A preflight that
    // makes a healthy suite look broken is worse than no preflight.
    const PORT = 3980;
    let server = null;
    try {
      server = spawn(process.execPath, ['server/index.js'], {
        cwd: ROOT, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SM_SHOPIFY_SYNC_ENABLED: 'false' },
      });
      let up = false;
      for (let i = 0; i < 120 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`,
          { signal: AbortSignal.timeout(2000) })).ok; } catch { /* booting */ }
        if (!up) await new Promise((r) => setTimeout(r, 500));
      }
      if (!up) { fail('could not boot a server for the HTTP suites'); }
      else {
        ok(`test server on :${PORT}`);
        // Suites that CONSUME REAL STOCK. They exercise MUSE fulfilment against
        // live data: one sells 99 units against a shelf of 2, so 97 go through
        // the D16 make-to-order path and take the whole bill of materials with
        // them. Running the set once on 2026-08-14 debited 582 reed-diffuser
        // component sets, 582 real labels, 87 litres of ethanol and 29 litres of
        // a Fragrance Library oil, all of which had to be put back by hand.
        //
        // They are excluded because they have no teardown — the known root
        // cause, deferred by the owner — and a daily check must never be the
        // thing that empties the warehouse. Run them deliberately, then run
        // scripts/restore-after-full-preflight.cjs.
        const CONSUMES_REAL_STOCK = [
          'regression-sm.js', 'regression-d16-makeorder.cjs',
          'regression-muse-fulfillment.cjs', 'regression-muse-fulfilment-model.js',
          'regression-fragrance-library.cjs', 'regression-fragrance-library-e2e.cjs',
          'regression-fragrance-library-rf.cjs', 'regression-fragrance-library-naming.cjs',
          'regression-variant-oil-relink.js', 'regression-sa.js',
        ];
        const suites = readdirSync(join(ROOT, 'scripts'))
          .filter((f) => /^regression-.*\.(cjs|js)$/.test(f))
          .filter((f) => !CONSUMES_REAL_STOCK.includes(f));
        console.log(`     (${CONSUMES_REAL_STOCK.length} suites skipped — they consume real stock; `
          + `run them deliberately, then restore-after-full-preflight.cjs)`);
        for (const s of suites) {
          // Some suites spawn their OWN server, with their own webhook secrets.
          // Forcing REGRESSION_BASE on those points them at this one instead,
          // which has no test secret — regression-shopify-order-ingest.js then
          // fails with 401 and looks broken when it is fine.
          const ownsServer = /spawn\s*\(/.test(readFileSync(join(ROOT, 'scripts', s), 'utf8'));
          const env = ownsServer ? { ...process.env }
                                 : { ...process.env, REGRESSION_BASE: `http://127.0.0.1:${PORT}` };
          try {
            execFileSync(process.execPath, [join(ROOT, 'scripts', s)],
              { stdio: 'ignore', timeout: 300000, env });
            ok(s);
          } catch { fail(s, 'run it directly to see why'); }
        }
      }
    } finally {
      if (server) { try { server.kill('SIGKILL'); } catch { /* already gone */ } }
    }
  } else {
    console.log('\n  (--full also runs every regression suite)');
  }

  // ── 7. Waiting on a person ────────────────────────────────────────────────
  head('7. Needs a person, not code');
  const people = [
    [shape.oils_no_minimum > 0, `${shape.oils_no_minimum} MUSE oils have no minimum — they can never warn`],
    [shape.negatives > 0, `${shape.negatives} components never counted — a physical count is overdue`],
    [true, 'Atelier products + tag: waiting on marketing'],
    [true, 'refill cost/RRP and go-live date: waiting'],
  ];
  people.filter(([when]) => when).forEach(([, t]) => console.log(`  ··    ${t}`));

  await pool.end();

  console.log(`\n${'═'.repeat(58)}`);
  if (bad) console.log(`\x1b[31m  NOT READY — ${bad} problem(s), ${warn} thing(s) to know\x1b[0m`);
  else if (warn) console.log(`\x1b[33m  READY — with ${warn} thing(s) to know\x1b[0m`);
  else console.log(`\x1b[32m  READY — everything as expected\x1b[0m`);
  console.log(`${'═'.repeat(58)}\n`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('\nPREFLIGHT ITSELF FAILED:', e.message, '\n'); process.exit(1); });
