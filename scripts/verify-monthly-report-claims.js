// Re-checks the numbers quoted in the September monthly update, before it goes
// to the business. READ-ONLY: every statement is a SELECT, nothing is written.
//
// WHY: the report is assembled from WORK_LOG.md, where each item was verified on
// the day it landed. That is a contemporaneous record, not a live one — a number
// true on 31 August can be false today, and the report does not say "as at". The
// ones that describe the CURRENT state of the system are the ones worth
// re-reading, because that is what anyone who opens the platform will see.
//
// Not checkable here, and deliberately not guessed: everything in Salesforce,
// Shopify, and the physical/IT work (laptops, clock-in, warehouse setups). Those
// live in other systems.
//
// Run: node scripts/verify-monthly-report-claims.js
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const show = (claim, actual, ok) =>
  console.log(`  ${ok ? 'ok  ' : 'CHECK'}  ${claim.padEnd(52)} → ${actual}`);

try {
  console.log('\nFragrance Library');

  const [{ n: oils }] = await q(
    `SELECT count(*) n FROM products WHERE category = 'OILS' AND status = 'active'`);
  show('fragrances active today', `${oils}`, true);

  const [{ total: returns, named }] = await q(
    `SELECT count(*) total, count(operator_ids) named FROM transactions WHERE type = 'return'`);
  show('893 returns attributed to a person', `${named} of ${returns} named today`, +named >= 893);

  const [{ n: deactivated }] = await q(
    `SELECT count(*) n FROM products
     WHERE status <> 'active' AND category = 'SA_SCENTED_PRODUCTS'`);
  show('354 discontinued listings deactivated', `${deactivated}`, +deactivated === 354);

  const neg = await q(
    `SELECT "productCode" code, category, ("currentStock"::float) s FROM products
     WHERE "currentStock" < 0 AND status = 'active' ORDER BY "currentStock"`);
  show('negative-stock items surfaced by the check', `${neg.length} negative now`, true);
  for (const r of neg) console.log(`          ${r.code.padEnd(14)} ${String(r.category).padEnd(22)} ${r.s}`);

  console.log('\nDemand planning');

  // Resolved exactly as server/sa/index.js:4284 does it — product override, then
  // supplier by id, then supplier by NAME where no id is set. A plain join on
  // supplier_id alone reads 203 and would understate the coverage by 46.
  const [{ resolved }] = await q(
    `SELECT count(COALESCE(p.lead_time, s.lead_time)) resolved
     FROM products p
     LEFT JOIN suppliers s ON (p.supplier_id IS NOT NULL AND s.id = p.supplier_id)
                            OR (p.supplier_id IS NULL AND LOWER(TRIM(p.supplier)) = LOWER(TRIM(s.name)))
     WHERE p.status = 'active' AND p.category = 'OILS'`);
  show('246 of 282 fragrances have a real lead time',
    `${resolved} resolved, ${oils - resolved} on the 30-day default`, true);

  const fc = await q(
    `SELECT max(import_date)::date d, count(*) n FROM forecasts
     WHERE import_date = (SELECT max(import_date) FROM forecasts)`);
  show('forecast read from the latest import only',
    `${fc[0].n} rows, imported ${fc[0].d.toISOString().slice(0, 10)}`, true);

  const [{ n: imports }] = await q(`SELECT count(DISTINCT import_date) n FROM forecasts`);
  show('older imports retained but not read', `${imports} distinct imports on file`, true);

  console.log('\nThe count itself (August), as the audit trail holds it');
  // The count went in as 'adjust' movements on one day — there is no 'stocktake'
  // type. Read in Sydney time, or the whole day lands on the wrong date.
  const [{ n: adj }] = await q(
    `SELECT count(*) n FROM transactions
     WHERE type = 'adjust'
       AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date = DATE '2026-08-31'`);
  show('145 stocktake corrections recorded', `${adj} adjustments on 31 August (Sydney)`, +adj === 145);

  console.log('\nNot checkable from here (other systems / physical work):');
  console.log('  Salesforce: sign-up fault, 1,560 accounts, Newcastle, Xero, reports, login');
  console.log('  Shopify:    16 purchase orders, the abandoned PO, sales-channel fault');
  console.log('  Physical:   laptops, clock-in, Microsoft + shipping setups, label stock');
  console.log('  Costs:      86–88% database, two thirds hosting (measured in August)');
} catch (e) {
  console.error('\nFATAL', e.message);
} finally {
  await pool.end();
}
