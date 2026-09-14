// Measures how well the demand model predicts the oil that actually gets used.
//
// WHY THIS EXISTS (2026-09-14). Every argument about the model so far — sum vs
// max, a 30 or 60 or 90 day window, a buffer keyed on lumpiness or on volume —
// has been settled by reasoning. This settles them by measurement.
//
// WHAT IT CAN AND CANNOT DECIDE. The ledger BALANCE is not usable as ground
// truth: zeros come from miscounts, unrecorded receipts, returns and Tech Stock,
// as the owner explained. Outflow is a different matter — Shopify sales are
// automatic — so this measures CONSUMPTION PREDICTION, not stockouts.
//
// Two hard limits, both measured before writing a line of this:
//
//   · Usable sales history starts in APRIL 2026. March is partial (59 oils,
//     453 L against a normal ~2,000 L month) and February holds one movement.
//     So the window is roughly five months, not the six originally planned.
//   · The Salesforce forecast exists on FOUR useful dates — 14–16 Mar (three
//     attempts at the same file), 7 Apr, 1 Jul, 9–10 Sep. The three-month gap
//     is the pipeline that died when the previous person left, visible in the
//     data. Any as-of date between April and July therefore carries a forecast
//     that was already months stale, which is exactly what the screen was
//     showing at the time — so it is honest input, but it means the
//     forecast-combination rules are tested on far thinner evidence than the
//     sales-only ones. The report below says which is which.
//
// METHOD. For each as-of date, feed each candidate rule ONLY the sales that had
// happened by that date, ask it for a daily rate, and compare that rate against
// what the product actually consumed over the following horizon. The candidates
// all call the real calcSmartDemand from shared/demand-calculator.js — a
// re-implementation was tried once and was wrong by 59 products, so the
// production function is the only one allowed to answer.
//
// The headline metric is WAPE (weighted absolute percentage error): total error
// litres ÷ total actual litres. It is weighted on purpose. A 300% error on an
// oil consuming 200 mL a month is noise; a 30% error on one consuming 200 L is
// the whole problem. Mean-of-percentages would rank them the other way round.
// Bias is reported beside it, because a model that is right on average by
// over-ordering half the time and starving the other half is not right.
//
// READ-ONLY. Reads transactions, forecasts and products. Writes nothing.
//
// Run:  node scripts/backtest-demand.js
//       node scripts/backtest-demand.js --horizon 60
//       node scripts/backtest-demand.js --csv out.csv
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import pkg from 'pg';
import { calcSmartDemand } from '../shared/demand-calculator.js';
const { Pool } = pkg;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const HORIZON = Number(arg('horizon', 30));
const CSV = arg('csv', null);

// The demand types, copied from the endpoint. If these ever diverge the
// backtest is measuring a different question from the screen.
const DEMAND_TX_TYPES = ['remove', 'shopify_sale', 'sale', 'muse_production',
  'sm_std_production', 'sm_major_production'];

// As-of dates: fortnightly, starting a month after the history becomes usable
// (the model reads 30 days back, so an earlier date would read into the sparse
// part) and stopping one horizon short of today so the answer exists.
const asOfDates = (() => {
  const out = [];
  const first = new Date('2026-05-01');
  const last = new Date(Date.now() - (HORIZON + 1) * 86400000);
  for (let d = first; d <= last; d = new Date(d.getTime() + 14 * 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
})();

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

// ── The candidates ───────────────────────────────────────────────────────────
// Each takes the model's own output and returns one daily rate in mL.
// `current` is what the Recommendation column ships today.
const CANDIDATES = {
  current: (d) => {
    const trended = d.retailDailyAvg * (d.trendMultiplier || 1);
    return Math.min(Math.max(trended, d.b2bDaily), d.scenarios.conservative);
  },
  // The two older columns, kept so the backtest can say what they cost.
  expected_sum: (d) => d.scenarios.expected,
  conservative: (d) => d.scenarios.conservative,
  // Does the trend multiplier earn its place?
  no_trend:     (d) => Math.min(Math.max(d.retailDailyAvg, d.b2bDaily), d.scenarios.conservative),
  // Ignore the contract entirely — the sharpest test of whether the forecast
  // adds anything over what Shopify already records.
  sales_only:   (d) => d.retailDailyAvg * (d.trendMultiplier || 1),
  // And the reverse.
  forecast_only: (d) => d.b2bDaily,
  // A flat mean over the window, no weighting, no peak, no trend. The dumbest
  // thing that could possibly work — and the bar everything else must clear.
  flat_mean:    (d) => d.totalSold30d / 30,
  // Added after the first run, which showed `current` over-asking three litres
  // for every one it under-asked. Taking the HIGHER of the two streams cannot
  // do anything else: whichever stream is noisy-high that fortnight is the one
  // that wins. These are the alternatives to max().
  fc_else_sales:   (d) => d.b2bDaily > 0 ? d.b2bDaily : d.retailDailyAvg * (d.trendMultiplier || 1),
  fc_else_flat:    (d) => d.b2bDaily > 0 ? d.b2bDaily : d.totalSold30d / 30,
  min_of_two:      (d) => {
    const r = d.retailDailyAvg * (d.trendMultiplier || 1);
    return d.b2bDaily > 0 && r > 0 ? Math.min(r, d.b2bDaily) : Math.max(r, d.b2bDaily);
  },
  mean_of_two:     (d) => {
    const r = d.retailDailyAvg * (d.trendMultiplier || 1);
    return d.b2bDaily > 0 && r > 0 ? (r + d.b2bDaily) / 2 : Math.max(r, d.b2bDaily);
  },
};

const fmt = (n, w = 7, dp = 1) => String(Number(n).toFixed(dp)).padStart(w);

(async () => {
  console.log(`Backtest — horizon ${HORIZON} days, ${asOfDates.length} as-of dates `
    + `(${asOfDates[0]} → ${asOfDates[asOfDates.length - 1]})\n`);

  // Every oil, once.
  const products = (await pool.query(
    `SELECT id, "productCode" code, name, unit FROM products
     WHERE category = 'OILS' AND (status IS NULL OR status = 'active')`)).rows;
  const byCode = new Map(products.map((p) => [p.code, p]));

  // All demand movements in one read, bucketed per product per day. Dates come
  // out of Postgres as text in Sydney time — created_at is UTC stored naive, so
  // reading it through the driver on a Sydney machine shifts it ten hours.
  const moves = (await pool.query(
    `SELECT t.product_code code,
            (t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date::text d,
            SUM(t.quantity)::float v
     FROM transactions t
     JOIN products pr ON pr."productCode" = t.product_code
     WHERE t.type = ANY($1) AND pr.category = 'OILS'
       AND t.created_at >= '2026-03-01'
     GROUP BY 1, 2`, [DEMAND_TX_TYPES])).rows;

  const salesBy = new Map();  // code → [{date, volume}]
  for (const m of moves) {
    if (!salesBy.has(m.code)) salesBy.set(m.code, []);
    salesBy.get(m.code).push({ date: m.d, volume: Math.abs(m.v) });
  }
  for (const arr of salesBy.values()) arr.sort((a, b) => a.date < b.date ? -1 : 1);

  // The forecast that was CURRENT on each as-of date — not today's. Using
  // today's would hand the model information it could not have had, which is
  // the classic way a backtest flatters itself.
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
    // forecasts.forecast_120_days is stored in LITRES; the endpoint multiplies
    // by 1000 before dividing (server/sa/index.js). Missing that made the
    // forecast candidate predict a thousandth of the real figure.
    return latest != null && latest > 0 ? (latest * 1000) / 120 : null;
  };

  // ── Run ────────────────────────────────────────────────────────────────────
  const totals = {};          // candidate → {err, actual, over, under, n}
  for (const k of Object.keys(CANDIDATES)) totals[k] = { err: 0, actual: 0, over: 0, under: 0, n: 0 };
  const perDate = [];
  const rows = [];            // for the CSV
  // Guards against the obvious way forecast_only could win a rigged race:
  // by staying silent on products that consume nothing. If most of the actual
  // litres sit on products it never speaks about, its score means nothing.
  const cover = { withFc: 0, noFc: 0, litresWithFc: 0, litresNoFc: 0 };

  for (const asOf of asOfDates) {
    const end = new Date(new Date(asOf).getTime() + HORIZON * 86400000).toISOString().slice(0, 10);
    const windowStart = new Date(new Date(asOf).getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTotals = {};
    for (const k of Object.keys(CANDIDATES)) dateTotals[k] = { err: 0, actual: 0 };
    let productsScored = 0;

    for (const [code, all] of salesBy) {
      if (!byCode.has(code)) continue;

      const history = all.filter((e) => e.date >= windowStart && e.date < asOf);
      const actual = all.filter((e) => e.date >= asOf && e.date < end)
        .reduce((a, e) => a + e.volume, 0);

      // Nothing known and nothing happened teaches nothing — including these
      // would let a model score perfectly by predicting zero everywhere.
      if (history.length === 0 && actual === 0) continue;
      productsScored++;

      const fcDaily = forecastAsOf(code, asOf);
      if (fcDaily > 0) { cover.withFc++; cover.litresWithFc += actual; }
      else             { cover.noFc++;   cover.litresNoFc   += actual; }
      const d = calcSmartDemand(history, fcDaily, asOf);

      for (const [name, f] of Object.entries(CANDIDATES)) {
        const predicted = Math.max(0, f(d) * HORIZON);
        const err = predicted - actual;
        totals[name].err += Math.abs(err);
        totals[name].actual += actual;
        if (err > 0) totals[name].over += err; else totals[name].under += -err;
        totals[name].n++;
        dateTotals[name].err += Math.abs(err);
        dateTotals[name].actual += actual;
        if (CSV) {
          rows.push([asOf, code, name, (predicted / 1000).toFixed(2),
            (actual / 1000).toFixed(2), (err / 1000).toFixed(2), d.cleanDays, d.dataConfidence].join(','));
        }
      }
    }
    perDate.push({ asOf, productsScored, dateTotals });
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const scored = perDate.reduce((a, p) => a + p.productsScored, 0) / asOfDates.length;
  console.log(`Average ${scored.toFixed(0)} oils scored per as-of date. `
    + `Actual consumption measured: ${(totals.current.actual / 1000).toFixed(0)} L across all dates.\n`);

  const totLitres = cover.litresWithFc + cover.litresNoFc;
  console.log(`Forecast coverage: ${cover.withFc} product-dates carried a forecast, ${cover.noFc} did not.`);
  console.log(`  ${(cover.litresWithFc / 1000).toFixed(0)} L of the actual consumption sat on products WITH a forecast `
    + `(${(cover.litresWithFc / totLitres * 100).toFixed(0)}%), ${(cover.litresNoFc / 1000).toFixed(0)} L without.
`);

  console.log('  candidate        WAPE     over-ask    under-ask   verdict');
  console.log('  ' + '─'.repeat(66));
  const ranked = Object.entries(totals)
    .map(([k, t]) => ({ k, wape: t.actual > 0 ? t.err / t.actual : Infinity, ...t }))
    .sort((a, b) => a.wape - b.wape);
  const best = ranked[0].wape;
  for (const r of ranked) {
    const tag = r.k === 'current' ? '  ← shipping today'
      : r.wape <= best * 1.02 ? '  ← best'
      : '';
    console.log(`  ${r.k.padEnd(15)} ${fmt(r.wape * 100, 6)}%  ${fmt(r.over / 1000, 9)} L  ${fmt(r.under / 1000, 9)} L${tag}`);
  }

  console.log('\n  Read WAPE as: total litres of error per litre actually consumed.');
  console.log('  100% means the average prediction is wrong by as much as the whole demand.');
  console.log('  over-ask is oil that would have been bought and not used in the window;');
  console.log('  under-ask is demand the plan did not see coming.');

  console.log('\n  by as-of date (WAPE %, so lower is better):');
  const names = ranked.map((r) => r.k);
  console.log('    date        ' + names.map((n) => n.slice(0, 9).padStart(10)).join(''));
  for (const p of perDate) {
    console.log('    ' + p.asOf + '  ' + names.map((n) => {
      const t = p.dateTotals[n];
      return (t.actual > 0 ? (t.err / t.actual * 100).toFixed(0) + '%' : '—').padStart(10);
    }).join(''));
  }

  if (CSV) {
    writeFileSync(CSV, 'as_of,code,candidate,predicted_l,actual_l,error_l,clean_days,confidence\n' + rows.join('\n'));
    console.log(`\n  ${rows.length} rows written to ${CSV}`);
  }

  console.log('\n  CAVEAT, and it matters: the forecast existed on four dates only, with a');
  console.log('  three-month gap from April to July. Candidates that lean on it are being');
  console.log('  judged largely on a stale figure — which is what the screen showed at the');
  console.log('  time, so the comparison is fair, but it is not a test of a healthy feed.');
})()
  .catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
