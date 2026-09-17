// Proves the Dashboard's machine reorder watch shows what the data actually says.
//
// WHY THIS EXISTS (2026-09-17). The business asked for a reorder trigger on
// machines — "super important we don't run out of stock here… knowing it takes
// 3 months approx. to arrive". The trigger already existed: eleven of the
// eighteen machines carry a minimum and six were under it that morning, one at
// zero. Nothing was broken. The machines were simply spread through a list of
// 772 products, so nobody read it.
//
// A section that makes that visible is only worth having if it cannot drift from
// the data. Two ways it could:
//
//   1. By grading machines with a different rule from every other screen. The
//      Dashboard carries its own percentage rule (low below 60% of minimum)
//      alongside the shared one in utils/stockStatus (low below the minimum).
//      The section must use the shared one, or a machine reads as healthy here
//      and low in Product Management.
//   2. By quietly omitting the machines that carry NO minimum. Those can never
//      cross a threshold, so they would never appear however low they fell —
//      the silence would look like good news.
//
// READ-ONLY. Writes nothing.
//
// Run: node scripts/regression-machine-reorder-watch.js
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, f), 'utf8');

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

// The shared rule, restated as SQL. If utils/stockStatus changes, section 1
// fails and this is rewritten deliberately rather than drifting in silence.
const REORDER_SOON_FACTOR = 1.5;
const statusOf = (stock, min) =>
  stock < 0 ? 'NEGATIVE'
  : stock === 0 ? 'OUT'
  : stock < min ? 'LOW'
  : min > 0 && stock <= min * REORDER_SOON_FACTOR ? 'REORDER_SOON'
  : 'HEALTHY';

try {
  console.log('\n1. The section grades machines with the shared rule');
  const dash = src('src/sa/pages/Dashboard.jsx');
  check(/sharedStockStatus/.test(dash) && /isReorderSoon/.test(dash),
    'it imports the shared status and the reorder-soon band');
  const machinesLine = (dash.match(/allMachines = products\.filter\([^\n]*\)/) || [''])[0];
  check(/'SCENT_MACHINES'/.test(machinesLine),
    'it reads SCENT_MACHINES, not MACHINES_SPARES', machinesLine || 'allMachines not found');
  // The list this page reads carries inactive products too — that is how 354
  // discontinued scented lines still arrive — and a retired machine at zero
  // would be presented as something to reorder for ever.
  check(/status !== 'inactive'/.test(machinesLine),
    'and skips retired machines', machinesLine);
  const shared = src('src/sa/utils/stockStatus.js');
  check(/REORDER_SOON_FACTOR = 1\.5/.test(shared),
    `the shared reorder band is still ${REORDER_SOON_FACTOR}×`,
    'this script restates it and must be updated with it');

  console.log('\n2. It sits where the owner put it, above the negative-stock list');
  // Asked for on 2026-09-17: "diminuir o Negative Stock Alertas e colocar a área
  // para máquinas lá". Order on a dashboard is the whole message — a section
  // below a 26-row block is a section nobody scrolls to.
  check(dash.indexOf('{/* Machines — Reorder Watch */}') < dash.indexOf('{/* Negative Stock Alerts */}'),
    'the machine watch is rendered before negative stock');
  check(/\.slice\(0, 8\)/.test(dash.slice(dash.indexOf('{/* Negative Stock Alerts */}'))),
    'and the negative list is capped rather than printing all of them');
  check(/more, smaller/.test(dash),
    'with the remainder counted, not silently dropped');

  console.log('\n2b. Machines with no minimum are named, not hidden');
  check(/machinesWithoutMinimum/.test(dash),
    'the section lists the machines that can never raise the alert');

  console.log('\n3. What the screen should be showing right now');
  const rows = (await pool.query(`
    SELECT "productCode" code, name, sub_category, ("currentStock"::float) stock,
           ("minStockLevel"::float) min, supplier
      FROM products
     WHERE category = 'SCENT_MACHINES' AND status = 'active'
     ORDER BY "productCode"`)).rows;

  const graded = rows.map((r) => ({ ...r, st: statusOf(r.stock, r.min) }));
  const acting = graded.filter((g) => g.st !== 'HEALTHY');
  const noMin = graded.filter((g) => !(g.min > 0));

  for (const g of acting.sort((a, b) => a.stock / (a.min || 1) - b.stock / (b.min || 1))) {
    console.log(`     ${g.st.padEnd(13)} ${String(g.name).trim().slice(0, 36).padEnd(37)} ${String(g.stock).padStart(5)} / min ${g.min}`);
  }
  check(acting.length > 0 || rows.length === 0,
    `${acting.length} of ${rows.length} machines need action`, 'nothing to show is itself worth knowing');
  console.log(`     (${noMin.length} carry no minimum: ${noMin.map((g) => String(g.name).trim().slice(0, 24)).join(', ')})`);

  console.log('\n4. The three-month lead time the request was based on');
  // The business asked for this KNOWING it takes about three months. The alert
  // is a quantity threshold and knows nothing about time — so if the minimums
  // were set for a shorter wait, they fire too late. Recorded here because the
  // number that would let the system reason about it is simply absent.
  const lead = (await pool.query(`
    SELECT count(*) total,
           count(*) FILTER (WHERE COALESCE(p.lead_time, s.lead_time) IS NULL) none,
           count(*) FILTER (WHERE COALESCE(p.lead_time, s.lead_time) >= 80) realistic
      FROM products p
      LEFT JOIN suppliers s ON (p.supplier_id IS NOT NULL AND s.id = p.supplier_id)
                             OR (p.supplier_id IS NULL AND LOWER(TRIM(p.supplier)) = LOWER(TRIM(s.name)))
     WHERE p.category = 'SCENT_MACHINES' AND p.status = 'active'`)).rows[0];
  console.log(`     ${lead.total} machines · ${lead.none} with no lead time at all · ${lead.realistic} with one near three months`);
  check(true, 'reported, not asserted — the figure is the owner’s to set');

  console.log(failed === 0
    ? '\n✅ machine-reorder-watch: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
