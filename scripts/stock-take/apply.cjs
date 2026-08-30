// Applies the fragrance stock take, and retires the technicians' separate stock.
//
// WHY (2026-08-31). The warehouse counted 168 fragrances on Friday 28 August.
// The biggest gaps are the oils the technicians move most — the count found
// 878.9 L the system did not have and 828.1 L it had not recorded — and the
// owner's reading is that these are additions: an order not entered, a
// withdrawal not taken off, a return not put back. The separate technician
// stock is being retired for that reason. It is not a fault in the system; the
// operation could not keep two ledgers straight, so it goes back to one.
//
// TWO THINGS ARE TRUE AT ONCE AND BOTH ARE RECORDED SEPARATELY:
//
//   the main balance becomes the counted figure, carried forward by everything
//     that moved between the count and now — 69 products moved, 834 L of it, and
//     writing the counted figure straight in would erase those real sales
//   the technicians' balance goes to zero, because the count already includes
//     what they were holding (owner confirmed 31/08). It is NOT added on top;
//     adding it would count 255 L twice.
//
// Every product gets a ledger row. Where a technician balance is cleared it gets
// its own row as well, so the 255 L does not simply vanish from the history. No
// balance is ever set by a silent UPDATE — a stock number with no movement
// behind it cannot be explained three months later and looks exactly like a
// real one.
//
// SA IS A PRODUCTION SYSTEM. Dry run by default. Everything happens inside one
// transaction, every figure is re-read and asserted before COMMIT, and any
// disagreement rolls the whole thing back.
//
// Run:  node scripts/stock-take/apply.cjs                 (dry run)
//       node scripts/stock-take/apply.cjs --apply         (writes)
require('dotenv').config();
const { Pool } = require('pg');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { LITRE, COUNT_CUTOFF_SYDNEY, parseSheet, buildMatcher, proposedFor } = require('./lib.cjs');

const APPLY = process.argv.includes('--apply');
const SHEET = process.argv.find((a) => a.endsWith('.txt')) || join(__dirname, '2026-08-28-fragrances.txt');
const OUT = join(__dirname, 'apply-plan.csv');
const COUNT_DATE = '28/08/2026';
const NOTE = `Stock take ${COUNT_DATE}`;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true },
  // search_path is REQUIRED, not tidiness. sa.products carries a trigger that
  // writes the second ledger, sa.direct_stock_changes, and it names that table
  // unqualified — without this every UPDATE fails with "relation does not
  // exist" and the whole stock take rolls back.
  options: '-c search_path=sa,public',
});

const L = (ml) => `${(ml / LITRE).toFixed(1)} L`;
const log = (s = '') => console.log(s);

(async () => {
  const rows = parseSheet(readFileSync(SHEET, 'utf8'));
  const unreadable = rows.filter((r) => r.bad);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const oils = (await client.query(
      `SELECT id, "productCode" AS code, name, supplier_code, unit,
              "currentStock"::float AS stock
         FROM sa.products WHERE category = 'OILS' FOR UPDATE`)).rows;
    const matcher = buildMatcher(oils);

    // The balance the ledger recorded at the cutoff, per product. READ, never
    // replayed. balance_after IS NOT NULL because it genuinely can be null on
    // old rows, and null minus a number is how the statement screen once
    // reported a product 500 units short.
    const atCutoff = new Map((await client.query(
      `SELECT DISTINCT ON (product_code) product_code, balance_after::float AS bal
         FROM sa.transactions
        WHERE category = 'OILS' AND balance_after IS NOT NULL
          AND created_at <= ($1::timestamp AT TIME ZONE 'Australia/Sydney' AT TIME ZONE 'UTC')
        ORDER BY product_code, id DESC`, [COUNT_CUTOFF_SYDNEY]))
      .rows.map((r) => [r.product_code, r.bal]));

    // Which products moved after the cutoff at all, and which moved on the
    // Friday itself - the day the count was spread across, so the only ones
    // where the cutoff choice could be wrong.
    const movedAfter = new Set((await client.query(
      `SELECT DISTINCT product_code FROM sa.transactions
        WHERE category = 'OILS'
          AND created_at > ($1::timestamp AT TIME ZONE 'Australia/Sydney' AT TIME ZONE 'UTC')`,
      [COUNT_CUTOFF_SYDNEY])).rows.map((r) => r.product_code));
    const movedOnCountDay = new Set((await client.query(
      `SELECT DISTINCT product_code FROM sa.transactions
        WHERE category = 'OILS'
          AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date = $1::date`,
      [COUNT_CUTOFF_SYDNEY])).rows.map((r) => r.product_code));

    const plan = [];
    const problems = [];
    for (const r of rows.filter((x) => !x.bad)) {
      const { hit, how } = matcher(r);
      if (hit.length !== 1) { problems.push({ r, n: hit.length, why: hit.length ? 'ambiguous' : 'not found' }); continue; }
      const p = hit[0];
      // No balance at the cutoff and yet movement after it means the ledger
      // cannot say what the system held when they counted. Guessing there would
      // silently invent a figure, so it is refused instead.
      if (!atCutoff.has(p.code) && movedAfter.has(p.code)) {
        problems.push({ r, n: 1, why: 'no ledger balance at the cutoff, but it moved after' });
        continue;
      }
      const bal = atCutoff.has(p.code) ? atCutoff.get(p.code) : p.stock;
      const proposed = proposedFor(r, bal, p.stock);
      plan.push({ r, p, how, balAtCutoff: bal, movedSince: p.stock - bal,
        onCountDay: movedOnCountDay.has(p.code), proposed, delta: proposed - p.stock });
    }

    // Refuse rather than apply a partial list. A stock take applied to 160 of
    // 168 leaves eight products wrong and nobody knowing which.
    if (unreadable.length || problems.length) {
      problems.forEach((x) => log(`    line ${x.r.no}  ${x.r.name} — ${x.why}`));
      throw new Error(`${unreadable.length} unreadable line(s) and ${problems.length} problem line(s) — refusing to apply a partial stock take`);
    }

    const tech = (await client.query(
      `SELECT t.product_id, t.quantity::float AS ml, p."productCode" AS code, p.name, p.unit
         FROM sa.tech_stock t JOIN sa.products p ON p.id = t.product_id
        WHERE t.quantity <> 0`)).rows;

    // Every technician balance must belong to a counted product, or clearing it
    // would delete stock nobody has laid eyes on.
    const counted = new Set(plan.map((x) => x.p.code));
    const orphan = tech.filter((t) => !counted.has(t.code));
    if (orphan.length) {
      throw new Error(`${orphan.length} technician balance(s) belong to oils that were NOT counted (${orphan.map((o) => o.code).join(', ')}) — refusing`);
    }

    log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — fragrance stock take of ${COUNT_DATE}\n`);
    log(`  sheet lines            ${rows.length}`);
    log(`  matched to a product   ${plan.length}`);
    log(`  technician balances    ${tech.length} oil(s), ${L(tech.reduce((s, t) => s + t.ml, 0))}`);
    log('');
    log('  The counted figure INCLUDES what the technicians held (owner, 31/08),');
    log('  so their balance is cleared, NOT added to the main stock.');
    log(`  Cutoff ${COUNT_CUTOFF_SYDNEY} Sydney — ${plan.filter((x) => x.movedSince !== 0).length} product(s)`
      + ` moved after it, ${plan.filter((x) => x.onCountDay).length} of them on the count day itself.`);

    const changed = plan.filter((x) => x.delta !== 0);
    const up = changed.filter((x) => x.delta > 0);
    const down = changed.filter((x) => x.delta < 0);
    log('');
    log(`  stock going UP     ${String(up.length).padStart(3)}   +${L(up.reduce((s, x) => s + x.delta, 0))}`);
    log(`  stock going DOWN   ${String(down.length).padStart(3)}   ${L(down.reduce((s, x) => s + x.delta, 0))}`);
    log(`  already correct    ${String(plan.length - changed.length).padStart(3)}`);
    log(`  net change         ${L(changed.reduce((s, x) => s + x.delta, 0))}`);


    // The technicians' 255 L leaves the system as well, and it is NOT in the
    // figure above - that one is only the main balance moving. Reporting the
    // main change alone understates what the count found by a quarter of a
    // tonne of oil.
    const techTotal = tech.reduce((s2, t) => s2 + t.ml, 0);
    const mainDelta = changed.reduce((s2, x) => s2 + x.delta, 0);
    log('');
    log(`  main balances          ${L(mainDelta)}`);
    log(`  technician balances    -${L(techTotal)}  (cleared; already inside the counted figure)`);
    log(`  TOTAL the system was carrying and does not have:  ${L(mainDelta - techTotal)}`);

    // A count that lands below zero is not a correction, it is a question:
    // more was consumed after the cutoff than was counted. Listed rather than
    // written quietly, because a negative balance is exactly the state the
    // integrity check exists to shout about.
    const goesNegative = changed.filter((x) => x.proposed < 0);
    if (goesNegative.length) {
      log('');
      log(`  ${goesNegative.length} product(s) land BELOW ZERO - more went out after the count than was counted:`);
      goesNegative.forEach((x) => log(
        `    ${x.p.code.padEnd(11)} ${x.p.name.padEnd(30).slice(0, 30)} counted ${String(x.r.counted).padStart(6)} L,`
        + ` ${L(Math.abs(x.movedSince))} out since -> ${L(x.proposed)}`));
      log('    These need a person: either the count is wrong or the consumption is.');
    }
    log('\n  the twelve biggest:');
    [...changed].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12).forEach((x) => log(
      `    ${x.p.code.padEnd(11)} ${x.p.name.padEnd(32).slice(0, 32)} ${L(x.p.stock).padStart(9)} → ${L(x.proposed).padStart(9)}   ${x.delta > 0 ? '+' : ''}${L(x.delta)}`));

    // ── Write ────────────────────────────────────────────────────────────────
    let techRows = 0, adjRows = 0;
    for (const t of tech) {
      await client.query(
        `INSERT INTO sa.transactions
           (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id)
         VALUES ($1,$2,$3,'OILS','tech_remove',$4,$5,0,$6,NULL)`,
        [t.product_id, t.code, t.name, Math.abs(t.ml), t.unit,
         `${NOTE} — technician stock retired; the counted figure includes it`]);
      await client.query(`UPDATE sa.tech_stock SET quantity = 0, updated_at = NOW() WHERE product_id = $1`,
        [t.product_id]);
      techRows++;
    }

    for (const x of changed) {
      await client.query(`UPDATE sa.products SET "currentStock" = $1, updated_at = NOW() WHERE id = $2`,
        [x.proposed, x.p.id]);
      await client.query(
        `INSERT INTO sa.transactions
           (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id)
         VALUES ($1,$2,$3,'OILS','adjust',$4,$5,$6,$7,NULL)`,
        [x.p.id, x.p.code, x.p.name, Math.abs(x.delta), x.p.unit, x.proposed,
         `${NOTE} — counted ${x.r.counted} L; ledger held ${L(x.balAtCutoff)} at the cutoff`
         + (x.movedSince ? `, ${x.movedSince > 0 ? '+' : ''}${L(x.movedSince)} moved since` : '')
         + (x.onCountDay ? ', moved on the count day itself so the cutoff is approximate' : '')
         + `; ${x.p.stock} → ${x.proposed} ${x.p.unit}`]);
      adjRows++;
    }

    // ── Prove it, before deciding whether to keep it ────────────────────────
    const after = new Map((await client.query(
      `SELECT id, "currentStock"::float AS stock FROM sa.products WHERE category='OILS'`))
      .rows.map((r) => [r.id, r.stock]));
    const wrong = changed.filter((x) => after.get(x.p.id) !== x.proposed);
    if (wrong.length) throw new Error(`${wrong.length} product(s) did not land on the proposed figure`);

    const techLeft = Number((await client.query(
      `SELECT count(*) c FROM sa.tech_stock WHERE quantity <> 0`)).rows[0].c);
    if (techLeft) throw new Error(`${techLeft} technician balance(s) are still not zero`);

    const untouched = plan.filter((x) => x.delta === 0);
    const drifted = untouched.filter((x) => after.get(x.p.id) !== x.p.stock);
    if (drifted.length) throw new Error(`${drifted.length} product(s) that needed no change were changed anyway`);

    log(`\n  ledger rows written    ${adjRows} adjustment(s) + ${techRows} technician clearance(s)`);
    log(`  verified               every figure matches the plan, no technician balance left`);

    const csv = [['product_code', 'name', 'counted_litres', 'ledger_at_cutoff', 'system_now',
      'moved_since_cutoff', 'moved_on_count_day', 'new_balance', 'change', 'tech_cleared',
      'sheet_said_system_had'].join(',')];
    const q = (v) => `"${String(v ?? '').split('"').join('""')}"`;
    const techBy = new Map(tech.map((t) => [t.code, t.ml]));
    for (const x of plan) {
      csv.push([q(x.p.code), q(x.p.name), x.r.counted, x.balAtCutoff, x.p.stock,
        x.movedSince, x.onCountDay ? 'yes' : '', x.proposed, x.delta,
        techBy.get(x.p.code) || 0, x.r.sheetSystem].join(','));
    }
    writeFileSync(OUT, csv.join('\n'), 'utf8');
    log(`  full line-by-line      ${OUT}`);

    if (APPLY) { await client.query('COMMIT'); log('\n✅ committed\n'); }
    else { await client.query('ROLLBACK'); log('\n↩  rolled back — re-run with --apply to keep it\n'); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`\n❌ rolled back: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
