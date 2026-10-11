// Records who placed each Shopify order, so demand planning can tell a customer
// from a technician.
//
// WHY (2026-10-09). The Salesforce forecast predicts what SERVICE clients will
// consume — accounts where we installed the machine and a technician refills it.
// Those refills are placed as Shopify orders, so the same litres were counted a
// second time as "sales". Measured over 90 days: 3,603 of the 5,519 litres of
// oil leaving by Shopify are technicians. On Feu de Camp it was every drop, and
// the screen asked to buy 75 L off demand that was entirely internal.
//
// WHY A SIDE TABLE. A stock movement carries only the order number, and the
// demand calculation cannot ask Shopify once per row on every page load. This
// caches the answer. It writes ONLY to `shopify_order_actor` — the ledger is
// never edited to make a report easier to write, and the cache can be thrown
// away and rebuilt from the store at any time.
//
// WHY THE PERSON AND NOT THE TAG. The tags are unreliable: the same technician
// is tagged on one order and not the next. Ethan Hall has 483 L tagged and 209 L
// untagged. Keyed on the customer, all 692 L classify correctly.
//
// DRY RUN BY DEFAULT. Pass --apply to write.
//
// Run: node scripts/classify-shopify-orders.js [--days 120] [--apply]
import 'dotenv/config';
import pkg from 'pg';
import { readOrderCustomers, recordOrderActors } from '../server/sa/shopify-order-actors.js';
const { Pool } = pkg;

const APPLY = process.argv.includes('--apply');
const daysArg = process.argv.indexOf('--days');
// Validated: an absent or non-numeric value becomes NaN and dies later at
// toISOString() with a bare "Invalid time value", which tells nobody anything.
const DAYS = (() => {
  if (daysArg === -1) return 120;
  const n = Number(process.argv[daysArg + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--days needs a whole number of days, got "${process.argv[daysArg + 1]}"`);
    process.exit(1);
  }
  return n;
})();

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

try {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  console.log(`\nReading Shopify orders created after ${since} …`);
  const orders = await readOrderCustomers(since);
  console.log(`  ${orders.length} orders`);

  const actors = (await pool.query(
    `SELECT customer_name FROM demand_internal_actors`)).rows.map((r) => r.customer_name);
  if (actors.length === 0) {
    console.log('\nNo internal actors recorded yet — deploy the migration first.');
    process.exit(1);
  }
  const norm = (n) => (n || '').trim().toLowerCase();
  const internal = new Set(actors.map(norm));
  console.log(`  ${internal.size} internal actors on file`);

  let yes = 0;
  const rows = orders.map((o) => {
    const name = o.customer?.displayName || null;
    // `active` is deliberately ignored: a technician who has since left was a
    // technician when the order was placed, and the history must stay classified
    // as it happened.
    const isInternal = !!name && internal.has(norm(name));
    if (isInternal) yes++;
    return [o.name, name, isInternal];
  });

  console.log(`\n  ${yes} internal · ${rows.length - yes} customer`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Pass --apply to record this.');
    const sample = rows.filter((r) => r[2]).slice(0, 5);
    for (const r of sample) console.log(`     ${r[0].padEnd(9)} ${r[1]}`);
    process.exit(0);
  }

  // Writes only to the cache, in one statement. Re-runnable. The server's
  // hourly refresh keeps it current; this is for reaching further back.
  const written = await recordOrderActors(pool, orders);
  console.log(`\n✅ ${written} orders recorded.`);
} catch (e) {
  console.error('\nFATAL', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
