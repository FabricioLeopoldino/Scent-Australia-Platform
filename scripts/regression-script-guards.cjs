// Proves that no script can quietly destroy live data, and that the guards
// which stop them are still there.
//
// WHY THIS EXISTS (2026-08-14). Four scripts carried a scope that was correct
// when written and silently stopped being correct:
//
//   cleanup-sm-test-data.cjs   `DELETE FROM production_orders` with no WHERE.
//                              Its pre-flight reported "no order belongs to a
//                              non-test client" — but that check JOINs clients,
//                              and MUSE orders are defined by client_id IS NULL,
//                              so every real MUSE order was invisible to it. It
//                              would have deleted SM-001 (#1020) and SM-002
//                              (#1021, a real customer order) while reporting
//                              that nothing real was touched.
//   e2e-muse-retail.cjs        creates and COMPLETES a real order on the Muse
//   e2e-muse-webhooks.cjs      store. Both headers still said the store was a
//                              playground with no live sales. It went retail on
//                              2026-08-10.
//   import-muse-catalog.cjs    rebuilds the catalogue from a CSV, written for an
//                              empty database. The catalogue now exists and has
//                              been hand-corrected — eleven wrong SKUs fixed on
//                              11 August would be overwritten.
//
// None of that was carelessness. A scope written down once goes stale in
// silence, and "I read it before running" is luck, not a mechanism. So the
// guards test a property that does not go stale: a real order carries a Shopify
// order number.
//
// Read-only, except that it RUNS two guarded scripts to prove they refuse.
// Those exit before touching anything.
//
// Run: node scripts/regression-script-guards.cjs
require('dotenv').config();
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const SCRIPTS = join(ROOT, 'scripts');
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Comments are stripped before any of this is applied. The first version of
// this test matched raw source, so three scripts passed on their own header
// prose ("--commit" appearing in a usage comment), and a new file containing
// `// no ROLLBACK needed here` would have passed identically.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

// Each pattern must match a STATEMENT, not a keyword. `TRUNCATE` on its own
// matched regression-oil-position.cjs, whose line 45 asserts the ABSENCE of
// writes with `/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/` — a test that checks for
// no writes is not a script that writes.
const WRITES_DB = /\b(DELETE\s+FROM\s+\w|TRUNCATE\s+(TABLE\s+)?\w|UPDATE\s+\w+\s+SET|INSERT\s+INTO\s+\w)/i;
// Damage is not only SQL. muse-fix-wrong-skus.mjs and muse-assign-skus.mjs
// rewrite SKUs on the LIVE Shopify store; eleven wrong ones were fixed by hand
// on 11 August, so those are precisely the scripts that must not re-run blind.
//
// Only real mutations count. `graphql.json` and `method: 'POST'` are how you
// READ from Shopify's GraphQL API too, and matching them flagged
// check-muse-launch-readiness.mjs, which is read-only (verified: no mutation,
// no SQL write anywhere in it).
const WRITES_SHOPIFY = /\bmutation\s|productVariantsBulk|productUpdate|productSet\b|productCreate|inventorySetQuantities|\b(draft_)?orders\.json|\/variants\/\d+\.json/i;
const GUARDED = /--apply|--commit|CLEANUP_DATABASE_URL|assertStoreNotLive|ROLLBACK|REFUSING TO RUN|process\.exit\(2\)/;

(async () => {
  console.log('\n1. Every script that writes to production data has some guard');
  // The audit that found these five, kept as a test so a sixth cannot appear
  // unnoticed — migrate-sa.js was found by this check, not by reading.
  //
  // Exemption is by CONTENT, not by filename. The first version skipped
  // anything called regression-*/integrity-*/check-*, which meant a file named
  // check-and-purge.cjs would be invisible to this test forever, and
  // cleanup-regression-residue.cjs was one rename away from exempting itself.
  // A regression is recognised by what it does: assert, and not offer to apply.
  const looksLikeATest = (src) =>
    /\bcheck\(|\bok\(|process\.exit\(fail/.test(src) && !/--apply|--commit/.test(src);

  // Suites that write test fixtures into the live database. This is a real
  // problem, not an exemption: running two of them on 2026-08-14 left 456 live
  // MUSE finished goods where there were 454, plus two production orders, a
  // test client and stock drift on three fixtures. The root cause is that they
  // have no teardown, and fixing that was explicitly deferred by the owner.
  //
  // So the list is a BASELINE, not a pardon. It must not grow: a new suite that
  // writes to production has to either clean up after itself or be argued for
  // here. cleanup-regression-residue.cjs is the cure until then.
  const WRITES_FIXTURES = [
    'regression-sm.js', 'regression-d16-makeorder.cjs', 'regression-fragrance-library-e2e.cjs',
    'regression-fragrance-library-naming.cjs', 'regression-fragrance-library-rf.cjs',
    'regression-muse-fulfillment.cjs', 'regression-muse-fragrance-register.js',
    'regression-muse-unmatched-alarm.js', 'verify-webhooks-d12.cjs',
    'regression-sa.js', 'regression-shopify-order-ingest.js',
    'regression-variant-oil-relink.js', 'regression-muse-fulfilment-model.js',
    // Added 2026-08-18 and, unlike the rest of this list, it DOES tear down —
    // its own product, audit rows and webhook_processed rows all go in a
    // finally block, verified by re-running and seeing the counts unchanged.
    // It is listed because this check classifies by what a file writes, not by
    // whether it cleans up, and inventing a "has teardown" detector to keep one
    // name off a list would be the wrong kind of clever.
    'regression-awaiting-shipment.js',
    // Also tears down, and asserts it: it writes to SA, which is a production
    // system in daily use, so it deletes its product and every transaction it
    // caused and then FAILS if a single row is left behind.
    'regression-warehouse-operators.js',
    // Added 2026-08-24. Tears down its product, its production order and lines,
    // its audit rows and its webhook_processed rows, and preflight's residue
    // check is the backstop that proves it.
    'regression-unmatched-orders.js',
  ];

  const unguarded = [];
  const newFixtureWriters = [];
  for (const f of readdirSync(SCRIPTS)) {
    if (!/\.(cjs|js|mjs)$/.test(f)) continue;
    const src = stripComments(readFileSync(join(SCRIPTS, f), 'utf8'));
    if (!(WRITES_DB.test(src) || WRITES_SHOPIFY.test(src))) continue;
    if (GUARDED.test(src)) continue;
    if (looksLikeATest(src)) {
      if (!WRITES_FIXTURES.includes(f)) newFixtureWriters.push(f);
      continue;
    }
    unguarded.push(f);
  }
  check(unguarded.length === 0,
    'no script that reshapes production data is unguarded', unguarded.join(', '));
  check(newFixtureWriters.length === 0,
    'no NEW suite writes test fixtures into the live database', newFixtureWriters.join(', '));
  console.log(`     (${WRITES_FIXTURES.length} known suites write fixtures to the live DB — `
    + `no teardown, cleaned by cleanup-regression-residue.cjs)`);

  console.log('\n2. Every delete of an order is scoped, not just the ones I noticed');
  // The first version asserted that one particular string was absent. That
  // passes on `DELETE FROM production_orders WHERE true`. So instead: find EVERY
  // delete against the orders table and require each one to carry the scope.
  const cleanupRaw = stripComments(readFileSync(join(SCRIPTS, 'cleanup-sm-test-data.cjs'), 'utf8'));
  // The scope is held in a `SAFE` constant and interpolated, so the literal does
  // not appear at the delete sites. Resolve it before matching — otherwise this
  // check fails on correct code, which is how it first behaved.
  const safeDef = cleanupRaw.match(/const SAFE = `([^`]+)`/);
  check(!!safeDef && /shopify_order_id IS NULL/.test(safeDef[1])
        && /shopify_order_number IS NULL/.test(safeDef[1]),
    'SAFE excludes orders carrying either Shopify identifier', safeDef?.[1]);
  const cleanup = safeDef ? cleanupRaw.split('${SAFE}').join(safeDef[1]) : cleanupRaw;
  const orderDeletes = [...cleanup.matchAll(/DELETE FROM production_orders([^`'"]*)/gi)]
    .map((m) => m[1].trim());
  check(orderDeletes.length > 0, 'the file still deletes orders (otherwise this check is vacuous)');
  const unscoped = orderDeletes.filter((tail) => !/shopify_order_id IS NULL/i.test(tail));
  check(unscoped.length === 0, 'every DELETE FROM production_orders is scoped',
    unscoped.map((t) => `"…${t.slice(0, 40)}"`).join(', '));
  check(/shopify_order_id IS NOT NULL OR shopify_order_number IS NOT NULL/.test(cleanup),
    'and its pre-flight refuses outright if any order came from the store');
  // The disjunct that deleted every orphan regardless of the order guard.
  check(!/DELETE FROM external_processing[\s\S]{0,120}production_order_id IS NULL/i.test(cleanup),
    'external_processing is no longer deleted unconditionally via an OR');

  console.log('\n3. The live-store guard is shared, and actually reached');
  check(existsSync(join(SCRIPTS, 'lib/live-store-guard.cjs')), 'the shared guard exists');
  for (const f of ['e2e-muse-retail.cjs', 'e2e-muse-webhooks.cjs', 'import-muse-catalog.cjs']) {
    const src = stripComments(readFileSync(join(SCRIPTS, f), 'utf8'));
    check(/assertStoreNotLive\(/.test(src), `${f} calls the shared guard`);
  }
  // Reaching it matters as much as calling it: the call must come before the
  // script's first write. Searched only inside the main block — helper
  // functions are DEFINED earlier in the file but run later, and scanning the
  // whole file made this fail on correct code.
  for (const f of ['e2e-muse-retail.cjs', 'e2e-muse-webhooks.cjs']) {
    const whole = stripComments(readFileSync(join(SCRIPTS, f), 'utf8'));
    const mainAt = whole.indexOf('(async () => {');
    const main = mainAt === -1 ? whole : whole.slice(mainAt);
    const at = main.indexOf('assertStoreNotLive');
    const firstWrite = Math.min(
      ...[/method:\s*['"]POST['"]/i, /UPDATE\s+products/i, /draft_orders\.json/i]
        .map((re) => { const m = re.exec(main); return m ? m.index : Infinity; }));
    check(at !== -1 && at < firstWrite,
      `${f} calls it before its first write`, `guard@${at} write@${firstWrite}`);
  }
  // NOT asserted: that these files contain no rule of their own. The earlier
  // version failed the build if anyone added a second inline check, which
  // punishes defence in depth. What must not happen is a DIVERGENT rule, and
  // section 4b pins the shared one instead.

  console.log('\n4. The guard itself refuses — not just present, but firing');
  //
  // The first version of this section ran e2e-muse-retail.cjs and
  // e2e-muse-webhooks.cjs for real, and trusted the guard to stop them. That was
  // the most dangerous thing in this whole change set:
  //
  //   · those scripts talk to Shopify with MUSE_SHOPIFY_*, while the guard reads
  //     PLATFORM_DATABASE_URL. Different systems, no linkage — point the DB at a
  //     Neon branch (the documented rehearsal workflow) and the "safety test"
  //     creates, pays and fulfils a REAL order on the live store;
  //   · the 60s test timeout was shorter than the script's own 90s timeout, so a
  //     run that got past the guard would be killed AFTER the paid order and the
  //     forced stock change, but BEFORE its cleanup.
  //
  // A guard test must never invoke the guarded thing against production. The
  // guard is now exercised directly in a child process — process.exit(2) has to
  // be observable — and the scripts are only checked structurally, above.
  {
    const harness = `
      process.env.PLATFORM_DATABASE_URL = ${JSON.stringify(process.env.PLATFORM_DATABASE_URL || '')};
      require(${JSON.stringify(join(SCRIPTS, 'lib/live-store-guard.cjs'))})
        .assertStoreNotLive('regression harness — writes nothing')
        .then(() => { console.log('GUARD_ALLOWED'); process.exit(0); });
    `;
    let code = 0, out = '';
    try {
      out = execFileSync(process.execPath, ['-e', harness],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    } catch (e) { code = e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }
    check(code === 2 && /REFUSING TO RUN/.test(out),
      'assertStoreNotLive exits 2 and refuses against the live database', `exit ${code}`);
    check(!/GUARD_ALLOWED/.test(out), 'it did not fall through');
  }

  console.log('\n4b. It reads evidence the guarded scripts cannot erase');
  const guardSrc = readFileSync(join(SCRIPTS, 'lib/live-store-guard.cjs'), 'utf8');
  // production_orders alone was the original signal and it was wrong twice over:
  // a retail sale covered by finished stock creates no production order at all
  // (webhooks.js returns order: null), and those rows live in the table the
  // guarded scripts delete from.
  check(/webhook_processed/.test(guardSrc), 'webhook history is one of the signals');
  check(/shopify_sale/.test(guardSrc), 'the sale ledger is another');
  check(/shopify_order_id IS NOT NULL/.test(guardSrc),
    'and orders are matched by Shopify id, not only by display number');
  check(/treated as live/.test(guardSrc),
    'a signal that cannot be READ counts as live — the guard fails closed');

  console.log('\n5. The acknowledgement cannot be muscle memory');
  const guard = readFileSync(join(SCRIPTS, 'lib/live-store-guard.cjs'), 'utf8');
  check(/I_KNOW_THE_MUSE_STORE_IS_LIVE/.test(guard),
    'the override names the store, so it cannot be typed by habit');
  check(/process\.exit\(2\)/.test(guard), 'refusing exits non-zero, so CI or a wrapper notices');

  console.log('\n6. The one-time SA migration cannot run a second time');
  // Found by check 1 above, not by eye — the manual sweep had classified it as
  // guarded because it protects its SOURCE thoroughly. Nothing protected the
  // TARGET: `node scripts/migrate-sa.js` with no arguments drops schema sa and
  // public and deletes platform users, and asked nothing before doing it.
  const mig = readFileSync(join(SCRIPTS, 'migrate-sa.js'), 'utf8');
  check(/REFUSING TO RUN — the platform is already in service/.test(mig),
    'it refuses once the platform is in service');
  check(/exclusivity/.test(mig) && /platform\.users/.test(mig) && /sm\.products WHERE sku IS NOT NULL/.test(mig),
    'it decides that from three independent signals, not one');
  check(/MIGRATE_SA_I_HAVE_A_BACKUP/.test(mig),
    'the override demands a backup was taken, in its own name');
  // --reconcile-only reads and must stay usable, or the guard would cost a
  // legitimate tool. Measured by position rather than a regex window: the guard
  // must open inside `if (!RECONCILE_ONLY)` and close before the next `\n  }`
  // at that indentation.
  const guardAt = mig.indexOf('REFUSING TO RUN — the platform is already in service');
  const openAt = mig.lastIndexOf('if (!RECONCILE_ONLY) {', guardAt);
  const closeAt = mig.indexOf('\n  }', openAt);
  check(openAt !== -1 && guardAt > openAt && closeAt > guardAt,
    'and --reconcile-only is still allowed through',
    `open=${openAt} guard=${guardAt} close=${closeAt}`);

  console.log('\n7. The importer will not overwrite a catalogue that exists');
  const imp = readFileSync(join(SCRIPTS, 'import-muse-catalog.cjs'), 'utf8');
  check(/IMPORT_OVER_LIVE_CATALOGUE/.test(imp), 'it refuses when MUSE products with SKUs exist');
  check(/sku IS NOT NULL/.test(imp), 'and it measures that from the SKUs actually present');

  console.log(failed === 0 ? '\n✅ script-guards: all checks passed' : `\n❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
