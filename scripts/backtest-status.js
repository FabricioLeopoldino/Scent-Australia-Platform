// Answers the manager's question directly: when this screen says an oil will
// run out before an order can land, does it run out?
//
// WHY THIS EXISTS (2026-09-14). backtest-demand.js measures the RATE — how many
// litres a day the model expects. That is a useful number and a humbling one
// (56% error at best). But it is not what she reads. She reads a badge, filters
// by Critical, and works down the list. The honest question about the badge is
// not "how close is the rate" but "how often is the badge right", and those two
// can differ enormously: a rate can be 40% off and still put every product in
// the correct bucket, because the bucket boundary is the lead time, not a litre.
//
// METHOD. For each as-of date, using only what was knowable then:
//   · stock is reconstructed from transactions.balance_after — the last
//     movement before the date. This is the same figure the screen showed at
//     the time, miscounts and all, so it is a fair test of what she saw.
//   · inbound is reconstructed from purchase orders raised before the date and
//     not yet received by it.
//   · the rate comes from the real calcSmartDemand, fed only prior sales and
//     the forecast that was current then.
//   · the verdict: did cumulative consumption over the next lead-time days
//     actually exceed what was on hand? That is "it ran out", and it is built
//     from outflow, which is the reliable half of the ledger.
//
// Both rules are scored side by side — the one that shipped until today and the
// one that ships now — so the answer is a change, not just a number.
//
// The four figures that matter, in the words they mean:
//   precision  of the oils it called Critical, how many really ran out
//   recall     of the oils that really ran out, how many it called Critical
//   noise      Critical calls that did not need to be made
//   misses     run-outs it never warned about  ← the expensive one
//
// READ-ONLY. Writes nothing.
//
// Run:  node scripts/backtest-status.js
import 'dotenv/config';
import pkg from 'pg';
import { calcSmartDemand } from '../shared/demand-calculator.js';
const { Pool } = pkg;

const DEMAND_TX_TYPES = ['remove', 'shopify_sale', 'sale', 'muse_production',
  'sm_std_production', 'sm_major_production'];
const FALLBACK_LEAD = 30;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

// Stop three weeks back, which is the commonest lead time. Products whose own
// lead time runs past the data are skipped individually below — cutting every
// date to suit the 90-day suppliers would leave three samples and call it
// evidence, which is how a thin measurement gets quoted as a fact.
const LAST_DATA_DAY = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
const asOfDates = (() => {
  const out = [];
  const last = new Date(Date.now() - 21 * 86400000);
  for (let d = new Date('2026-05-01'); d <= last; d = new Date(d.getTime() + 14 * 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
})();

const pct = (n, d) => d === 0 ? '  n/a' : `${(n / d * 100).toFixed(0)}%`.padStart(5);

(async () => {
  console.log(`Status backtest — ${asOfDates.length} as-of dates `
    + `(${asOfDates[0]} → ${asOfDates[asOfDates.length - 1]})\n`);

  const products = (await pool.query(
    `SELECT pr.id, pr."productCode" code, pr.name,
            COALESCE(pr.lead_time, s.lead_time, ${FALLBACK_LEAD}) lead
     FROM products pr
     LEFT JOIN suppliers s ON (pr.supplier_id IS NOT NULL AND s.id = pr.supplier_id)
                           OR (pr.supplier_id IS NULL AND LOWER(TRIM(pr.supplier)) = LOWER(TRIM(s.name)))
     WHERE pr.category = 'OILS' AND (pr.status IS NULL OR pr.status = 'active')`)).rows;
  const byCode = new Map(products.map((p) => [p.code, p]));

  // Every movement, with the balance it left behind. Sydney dates: created_at
  // is UTC stored naive, so the driver would shift it ten hours.
  const moves = (await pool.query(
    `SELECT t.product_code code,
            (t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date::text d,
            t.type, t.quantity::float q, t.balance_after::float bal, t.id
     FROM transactions t
     JOIN products pr ON pr."productCode" = t.product_code
     WHERE pr.category = 'OILS' AND t.created_at >= '2026-03-01'
     ORDER BY t.product_code, t.created_at, t.id`)).rows;

  const hist = new Map();   // code → all movements, chronological
  for (const m of moves) {
    if (!hist.has(m.code)) hist.set(m.code, []);
    hist.get(m.code).push(m);
  }

  const pos = (await pool.query(
    `SELECT pr."productCode" code, po.quantity::float q,
            (po.added_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date::text raised,
            CASE WHEN po.received_at IS NULL THEN NULL
                 ELSE (po.received_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date::text
            END recv
     FROM purchase_orders po JOIN products pr ON pr.id = po.product_id
     WHERE pr.category = 'OILS'`)).rows;

  const fcRows = (await pool.query(
    `SELECT product_code code, forecast_120_days f, import_date::date::text d
     FROM forecasts ORDER BY import_date, id`)).rows;
  const forecastAsOf = (code, asOf) => {
    let latest = null;
    for (const r of fcRows) {
      if (r.code !== code) continue;
      if (r.d > asOf) break;
      latest = r.f;
    }
    // Stored in litres; the endpoint multiplies by 1000 before dividing by 120.
    return latest != null && latest > 0 ? (latest * 1000) / 120 : null;
  };

  const RULES = {
    old: (ctx) => {
      // What shipped until today: Conservative scenario against lead time + 10.
      if (ctx.stock <= 0) return true;
      const days = ctx.d.scenarios.conservative > 0
        ? ctx.stock / ctx.d.scenarios.conservative : Infinity;
      return days < ctx.lead + 10;
    },
    new: (ctx) => {
      // What ships now: the corrected rate, counting inbound, against lead time.
      const trended = ctx.d.retailDailyAvg * (ctx.d.trendMultiplier || 1);
      const rate = Math.min(Math.max(trended, ctx.d.b2bDaily), ctx.d.scenarios.conservative);
      if (rate <= 0) return false;                       // "No data", not Critical
      return (ctx.stock + ctx.inbound) / rate < ctx.lead;
    },
    // Most of what the new rule misses, it misses NARROWLY — the product ran
    // short late in the window rather than being wildly mispredicted. These two
    // ask what a small margin buys back, and what it costs in noise. Neither
    // ships; they exist so the trade-off is a measurement and not a preference.
    'new+7d': (ctx) => {
      const trended = ctx.d.retailDailyAvg * (ctx.d.trendMultiplier || 1);
      const rate = Math.min(Math.max(trended, ctx.d.b2bDaily), ctx.d.scenarios.conservative);
      if (rate <= 0) return false;
      return (ctx.stock + ctx.inbound) / rate < ctx.lead + 7;
    },
    'new×1.25': (ctx) => {
      const trended = ctx.d.retailDailyAvg * (ctx.d.trendMultiplier || 1);
      const rate = Math.min(Math.max(trended, ctx.d.b2bDaily), ctx.d.scenarios.conservative);
      if (rate <= 0) return false;
      return (ctx.stock + ctx.inbound) / rate < ctx.lead * 1.25;
    },
  };

  const RULE_NAMES = Object.keys(RULES);
  const blank = () => Object.fromEntries(RULE_NAMES.map(r => [r, { tp: 0, fp: 0, fn: 0, tn: 0 }]));
  const score = blank();
  const perDate = [];
  const misses = [];   // what the new rule failed to warn about, for inspection

  for (const asOf of asOfDates) {
    const dayScore = blank();
    for (const [code, all] of hist) {
      const prod = byCode.get(code);
      if (!prod) continue;
      const lead = Number(prod.lead);
      const endStr = new Date(new Date(asOf).getTime() + lead * 86400000).toISOString().slice(0, 10);
      // The answer has to have happened already. A 90-day product judged on 60
      // days of hindsight would look like it never ran out.
      if (endStr > LAST_DATA_DAY) continue;

      // Stock as at the as-of date: the balance the last movement left behind.
      const before = all.filter((m) => m.d < asOf);
      if (before.length === 0) continue;                 // never moved — nothing to judge
      const stock = before[before.length - 1].bal;

      const inbound = pos
        .filter((p) => p.code === code && p.raised <= asOf && (!p.recv || p.recv > asOf))
        .reduce((a, p) => a + p.q, 0);

      const history = all
        .filter((m) => DEMAND_TX_TYPES.includes(m.type)
          && m.d >= new Date(new Date(asOf).getTime() - 30 * 86400000).toISOString().slice(0, 10)
          && m.d < asOf)
        .map((m) => ({ date: m.d, volume: Math.abs(m.q) }));

      const consumed = all
        .filter((m) => DEMAND_TX_TYPES.includes(m.type) && m.d >= asOf && m.d < endStr)
        .reduce((a, m) => a + Math.abs(m.q), 0);

      // Judge only where something was knowable AND something happened. An oil
      // with no history and no consumption teaches nothing, and counting it as
      // a correct "not Critical" would inflate every figure below.
      if (history.length === 0 && consumed === 0) continue;

      const d = calcSmartDemand(history, forecastAsOf(code, asOf), asOf);
      // The truth: did what it had (plus what arrived) fail to cover what it
      // actually used, over the time an order would have taken to land?
      const ranOut = consumed > (stock + inbound);
      const ctx = { stock, inbound, lead, d };

      for (const rule of RULE_NAMES) {
        const flagged = RULES[rule](ctx);
        const k = flagged ? (ranOut ? 'tp' : 'fp') : (ranOut ? 'fn' : 'tn');
        score[rule][k]++;
        dayScore[rule][k]++;
        if (rule === 'new' && k === 'fn') {
          misses.push({ asOf, code, name: prod.name, stock: (stock + inbound) / 1000,
            consumed: consumed / 1000, lead,
            // How badly. Running 30% over what you held is a near miss somebody
            // absorbs; running 13x over is not a forecasting failure, it is an
            // event no thirty-day history could have seen coming. Averaging the
            // two into one "misses" number hides which kind you actually have.
            ratio: (stock + inbound) > 0 ? consumed / (stock + inbound) : Infinity });
        }
      }
    }
    perDate.push({ asOf, dayScore });
  }

  const judged = score.new.tp + score.new.fp + score.new.fn + score.new.tn;
  const realRunOuts = score.new.tp + score.new.fn;
  console.log(`${judged} product-dates judged. ${realRunOuts} of them genuinely ran short `
    + `(consumed more than they had, plus anything inbound, before an order could land).\n`);

  console.log('                    precision   recall    noise      misses');
  console.log('                    (of those   (of real  (Critical  (run-outs');
  console.log('                    it flagged) run-outs) for nothing) not warned)');
  console.log('  ' + '─'.repeat(62));
  const LABEL = { old: 'until today ', new: 'shipping now', 'new+7d': 'new, +7 days', 'new×1.25': 'new, x1.25  ' };
  for (const rule of RULE_NAMES) {
    const s = score[rule];
    console.log(`  ${(LABEL[rule] || rule).padEnd(13)}     ${pct(s.tp, s.tp + s.fp)}      ${pct(s.tp, s.tp + s.fn)}     `
      + `${String(s.fp).padStart(5)}       ${String(s.fn).padStart(5)}`);
  }

  console.log('\n  Read it this way. PRECISION is how much of the Critical list is worth');
  console.log('  her time. RECALL is how much of the real trouble the list caught.');
  console.log('  MISSES is the number that costs money — a run-out nobody warned about.');

  console.log('\n  by as-of date — precision / recall of the rule shipping now:');
  for (const p of perDate) {
    const s = p.dayScore.new;
    console.log(`    ${p.asOf}   flagged ${String(s.tp + s.fp).padStart(3)}, right ${String(s.tp).padStart(3)}`
      + `   (${pct(s.tp, s.tp + s.fp)} precision, ${pct(s.tp, s.tp + s.fn)} recall, ${s.fn} missed)`);
  }

  if (misses.length) {
    const band = (lo, hi) => misses.filter((m) => m.ratio > lo && m.ratio <= hi).length;
    console.log(`\n  the ${misses.length} misses, by how far past its stock the product went:`);
    console.log(`    up to 1.5x  ${String(band(0, 1.5)).padStart(3)}   a near miss — ran short late in the window`);
    console.log(`    1.5x to 3x  ${String(band(1.5, 3)).padStart(3)}   a real miss`);
    console.log(`    over 3x     ${String(band(3, Infinity)).padStart(3)}   no 30-day history predicts these`);
    console.log('\n  worst first:');
    misses.sort((a, b) => (b.consumed - b.stock) - (a.consumed - a.stock)).slice(0, 12)
      .forEach((m) => console.log(`    ${m.asOf}  ${m.code.padEnd(11)} ${String(m.name).slice(0, 24).padEnd(25)}`
        + ` had ${m.stock.toFixed(1).padStart(7)} L, used ${m.consumed.toFixed(1).padStart(7)} L in ${m.lead}d`));
  }

  console.log('\n  CAVEAT: stock is reconstructed from the ledger balance, which the owner');
  console.log('  says is unreliable — miscounts, unrecorded receipts, returns. That is a');
  console.log('  real limit. But it is the same figure the screen showed at the time, so');
  console.log('  this measures what she actually saw, not an idealised version of it.');
})()
  .catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
