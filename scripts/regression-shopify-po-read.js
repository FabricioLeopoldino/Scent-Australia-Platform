// Guards delivery 1 of the Shopify PO integration: it READS, and only reads.
//
// WHY THIS EXISTS (2026-09-21). Purchase orders move to Shopify. The first
// deployment is deliberately inert — it shows what the platform can see so the
// owner and the manager can check it against the store for a few days. The one
// promise it makes is that it changes nothing, and a promise like that is worth
// nothing unless something fails when it stops being true.
//
// It also pins the two findings that only appeared on the first real run:
//
//   1. Shopify NEVER closes a purchase order. #PO76 was raised in July 2025,
//      delivered long ago, and still reads ORDERED. Without a cut-off the page
//      showed 94 orders, almost all history.
//   2. A code that does not match must reach a person with a reason attached.
//      Real ones in this store: SA_1L_000 (bioethanol placeholder), 5013612
//      (batteries), SA_1L_068 (a zero short), and lines with no code at all.
//
// READ-ONLY. Writes nothing, to the database or to Shopify.
//
// Run: node scripts/regression-shopify-po-read.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
import { readIncomingPurchaseOrders, VARIANT_ML, SINCE } from '../server/sa/shopify-purchase-orders.js';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

try {
  console.log('\n1. It cannot write anything');
  const reader = src('server/sa/shopify-purchase-orders.js');
  for (const word of ['INSERT', 'UPDATE ', 'DELETE', 'pool.query', 'client.query']) {
    check(!reader.includes(word), `the reader contains no ${word.trim()}`);
  }
  // Every Shopify call in this file must be a GraphQL read. A mutation would be
  // a write to someone else's system, which this integration never does.
  check(!/mutation/i.test(reader), 'and sends no Shopify mutation');
  const server = src('server/sa/index.js');
  const route = server.slice(server.indexOf("'/shopify-purchase-orders'"));
  check(/^[^\n]*router\.get/.test(server.slice(server.lastIndexOf('router.', server.indexOf("'/shopify-purchase-orders'")))),
    'the endpoint is a GET');
  // To the end of the handler, not a fixed number of characters: a window broke
  // the moment the handler grew, failing a check whose subject had not changed.
  check(/ok: false/.test(route.slice(0, route.indexOf('\nrouter.'))),
    'and fails closed — it reports that it could not read, never a stale list');

  console.log('\n2. The guards are in the code, not in someone’s memory');
  check(/po\.status !== 'ORDERED'/.test(reader), 'drafts are skipped');
  check(/WATCHED_DESTINATIONS\.includes\(destination\)/.test(reader), 'only the watched destination is read');
  check(/sydneyDate\(po\.dateCreated\) < SINCE/.test(reader), `only orders since the cut-off (${SINCE})`);
  check(/archivedAt/.test(reader), 'archived orders are skipped');
  check(Object.keys(VARIANT_ML).length >= 5 && VARIANT_ML.SA_1L === 1000,
    'the bottle sizes are declared, so no quantity is ever guessed');

  console.log('\n3. What it sees in the live store right now');
  const products = (await pool.query(
    `SELECT "productCode", name, "currentStock", unit, "shopifySkus", status
       FROM products WHERE status = 'active'`)).rows;
  const { orders, liveLineIds } = await readIncomingPurchaseOrders(products);
  console.log(`     ${orders.length} purchase order(s) raised since ${SINCE}`);
  for (const o of orders) {
    console.log(`     ${o.number.padEnd(8)} ${String(o.supplier).slice(0, 22).padEnd(23)} ${String(o.dateCreated).slice(0, 10)}${o.arrivedInShopify ? '  (received in Shopify)' : ''}`);
    for (const l of o.lines) {
      console.log(`        ${(l.matched ? 'ok  ' : 'CHECK')} ${String(l.sku || '(no code)').padEnd(15)} ${l.matched ? `${l.productCode} +${l.incomingMl / 1000} L` : l.reason}`);
    }
  }

  console.log('\n4. Every line is either matched or explained');
  // The failure this prevents is silence. A line the platform cannot place must
  // never simply vanish from the page.
  const silent = orders.flatMap((o) => o.lines).filter((l) => !l.matched && !l.reason);
  check(silent.length === 0, 'no line is dropped without a reason', `${silent.length} silent`);

  const matched = orders.flatMap((o) => o.lines).filter((l) => l.matched);
  check(matched.every((l) => l.incomingMl > 0 && l.productCode),
    'every matched line carries a product and a quantity in mL');
  check(matched.every((l) => l.incomingMl === l.bottles * l.bottleMl),
    'and its litres are bottles × bottle size, with nothing rounded in between');

  console.log('\n4b. An accepted order that is deleted in Shopify is noticed');
  // Deleting a purchase order removes it from the API completely, so the only
  // signal is absence — and absence must not be confused with "filtered out".
  // The line ids are collected BEFORE the cut-off and destination filters for
  // exactly that reason: otherwise moving the cut-off would make every older
  // accepted order look cancelled.
  check(liveLineIds instanceof Set && liveLineIds.size > 0,
    `the reader reports every line the store still holds (${liveLineIds?.size})`);
  const shownIds = orders.flatMap((o) => o.lines.map((l) => l.lineId));
  check(shownIds.every((id) => liveLineIds.has(id)),
    'and every line it shows is in that set — filtering never looks like deletion');
  check(/!liveLineIds\.has\(r\.shopify_line_id\)/.test(server),
    'the endpoint flags accepted lines the store no longer has');
  check(/still counting them as stock on its way/.test(src('src/sa/pages/ShopifyPurchaseOrders.jsx')),
    'and the screen says what that means rather than just listing them');

  console.log('\n4c. It refuses rather than showing half the truth');
  // Every one of these was a way to quietly report a live order as deleted and
  // offer a button to remove it. Failing is the only safe behaviour.
  check(/More purchase orders than this can page through/.test(reader),
    'a truncated page of orders throws instead of returning a short list');
  check(/has more lines than can be read at once/.test(reader),
    'and so does an order with more lines than one read can hold');
  check(/status === 'ORDERED' && !po\.archivedAt/.test(reader),
    'archived or re-drafted orders count as no longer live, not merely unshown');
  check(/AbortSignal\.timeout/.test(reader), 'a hung Shopify call gives up rather than hangs on');
  check(/timeZone: 'Australia\/Sydney'/.test(reader),
    'the cut-off compares Sydney dates, not UTC ones');
  check(/!po\.transfers\.pageInfo\?\.hasNextPage/.test(reader),
    '"received in Shopify" is claimed only when the whole transfer list was read');
  check(/role === 'technician'/.test(server),
    'the read endpoint enforces the role itself, not the menu');
  check(/client = await pool\.connect\(\);[\s\S]{0,60}BEGIN/.test(server),
    'the database client is taken after Shopify answers, so a slow store cannot starve the pool');

  console.log('\n5. Accepting writes an ordinary purchase order, and only once');
  // Acceptance deliberately reuses purchase_orders rather than inventing a
  // parallel table: the screens that show a pending order beside its fragrance,
  // and the receive flow that validates the remaining balance, locks the product
  // row, adds the stock and writes the transaction, all already exist and are
  // already trusted. A second set would be a second way to be wrong.
  check(/INSERT INTO purchase_orders[\s\S]{0,400}shopify_line_id/.test(server),
    'acceptance inserts into purchase_orders, not a table of its own');
  check(/o\.shopifyId === shopifyId/.test(server),
    'it re-reads Shopify inside the request, never trusting the screen’s numbers');
  check(/no longer in Shopify/.test(server),
    'and refuses an order that has since been deleted');
  check(/shopify_po_accepted/.test(server), 'the acceptance is audited');

  const hasCols = (await pool.query(`
    SELECT count(*) n FROM information_schema.columns
     WHERE table_schema='sa' AND table_name='purchase_orders'
       AND column_name IN ('shopify_po_gid','shopify_line_id')`)).rows[0].n;

  if (Number(hasCols) < 2) {
    console.log('  note  the columns do not exist yet — the next deploy adds them at startup');
  } else {
    // The real guarantee that a line cannot be accepted twice is the index, not
    // the code: code can be bypassed, a constraint cannot. Proven by trying it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prod = (await client.query(
        `SELECT id FROM products WHERE category='OILS' AND status='active' LIMIT 1`)).rows[0];
      const lineId = `gid://regression/line/${Date.now()}`;
      const insert = () => client.query(
        `INSERT INTO purchase_orders (product_id, order_number, quantity, supplier, notes,
                                      added_by, shopify_po_gid, shopify_line_id)
         VALUES ($1,'#REGRESSION',1000,'regression','regression','regression','gid://regression/po',$2)
         ON CONFLICT (shopify_line_id) WHERE shopify_line_id IS NOT NULL DO NOTHING
         RETURNING id`, [prod.id, lineId]);
      check((await insert()).rows.length === 1, 'a line can be accepted');
      check((await insert()).rows.length === 0, 'and the same line cannot be accepted twice');
    } finally {
      // Everything above happened inside a transaction that is now thrown away.
      await client.query('ROLLBACK');
      client.release();
    }
    const left = (await pool.query(
      `SELECT count(*) n FROM purchase_orders WHERE order_number = '#REGRESSION'`)).rows[0].n;
    check(Number(left) === 0, 'and the test left nothing behind', `${left} rows remain`);
  }

  console.log(failed === 0
    ? '\n✅ shopify-po-read: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
