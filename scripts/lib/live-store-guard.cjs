// One guard, several callers. Refuses to let a script that was written against
// a playground store run against the live one.
//
// WHY THIS EXISTS (2026-08-14). Several scripts carried an assumption in their
// own header — "the Muse store is the owner's build/playground store, no live
// sales" — that was true when they were written in July and stopped being true
// on 10 August, when MUSE went retail. Nothing told them. e2e-muse-retail.cjs
// and e2e-muse-webhooks.cjs create REAL orders on that store, which can now
// reach a real customer; import-muse-catalog.cjs --reset-test deletes
// production orders, which now include real ones.
//
// WHICH SIGNAL, AND WHY NOT THE OBVIOUS ONE. The first version of this guard
// asked whether any row in sm.production_orders carried a shopify_order_number.
// An adversarial review the same day showed that sees almost nothing:
//
//     production_orders with a Shopify number    2
//     webhook_processed rows                    53
//     transactions of type shopify_sale         18
//     audit rows muse_fulfillment_sale          51
//
// Two reasons it was the wrong question. First, a retail order covered by
// finished stock creates NO production order at all — webhooks.js returns
// `order: null` when nothing has to be made, and that is the ordinary MUSE
// case. The store can sell every day and that signal stays at zero. Second,
// those two rows live in the very table these scripts delete from, so tidying
// them would disarm the guard, its callers' WHERE clauses, and this check all
// at once. A guard whose evidence its callers can erase is not a guard.
//
// So it now asks three independent questions and treats ANY of them as proof.
// Two of the three (webhook history, sale ledger) are not touched by the
// scripts being guarded.
//
// Deliberately not overridable by a bare flag: the acknowledgement names the
// store, so it cannot become muscle memory.
const { Pool } = require('pg');

const ACK = 'I_KNOW_THE_MUSE_STORE_IS_LIVE';

// Each entry: a question whose answer being > 0 means the store has served real
// traffic. Kept as separate queries on purpose — one combined statement with
// three subselects throws away all three signals if a single table is missing
// on some branch.
const SIGNALS = [
  ['webhooks received from Shopify', `SELECT count(*)::int n FROM webhook_processed`],
  ['sales deducted from stock', `SELECT count(*)::int n FROM transactions
                                   WHERE type IN ('shopify_sale', 'shopify_reversal')`],
  ['orders that came from the store', `SELECT count(*)::int n FROM production_orders
                                        WHERE shopify_order_id IS NOT NULL
                                           OR shopify_order_number IS NOT NULL`],
];

async function assertStoreNotLive(what) {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) throw new Error('PLATFORM_DATABASE_URL is not set — refusing to guess');
  const pool = new Pool({
    connectionString: url.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
  });

  const found = [];
  try {
    for (const [label, sql] of SIGNALS) {
      try {
        const n = (await pool.query(sql)).rows[0].n;
        if (n > 0) found.push(`${label}: ${n}`);
      } catch (e) {
        // FAIL CLOSED. "I could not tell" must never mean "carry on" — that is
        // the failure mode that made migrate-sa.js proceed to DROP SCHEMA when
        // its probe threw. An unreadable signal counts as evidence of life.
        found.push(`${label}: could not be read (${e.message}) — treated as live`);
      }
    }
  } finally {
    await pool.end();
  }
  if (!found.length) return;

  if (process.env.LIVE_STORE_ACK === ACK) {
    console.warn(`\n⚠️  The Muse store shows real traffic, and you acknowledged it:`);
    found.forEach((f) => console.warn(`     ${f}`));
    console.warn(`   Continuing because LIVE_STORE_ACK is set.\n`);
    return;
  }

  console.error(`\n❌ REFUSING TO RUN — the Muse store is live.\n`);
  console.error(`   ${what}\n`);
  console.error(`   Evidence:`);
  found.forEach((f) => console.error(`     ${f}`));
  console.error(`\n   This script was written when the store was a playground and no`);
  console.error(`   sale was real. That stopped being true on 2026-08-10.`);
  console.error(`\n   If you are certain, re-run with:`);
  console.error(`     LIVE_STORE_ACK=${ACK} node <script>\n`);
  process.exit(2);
}

module.exports = { assertStoreNotLive, ACK, SIGNALS };
