// Proves the Recommendation says what to order, and does not disturb what
// the two older columns say.
//
// WHY THIS EXISTS (2026-09-11). The owner asked the practical question: the
// manager needs to raise a PO for oil, can she trust this screen? The audit
// that day answered direction yes, quantity no, for two measured reasons:
//
//   · Order Exp. and Order Safe ADD the two demand streams. Every order —
//     including the B2B service ones — now goes through Shopify, so the
//     Salesforce forecast and the recorded sales are largely the SAME demand
//     counted twice. Portfolio-wide: ~16,300 L suggested against ~12,000 real.
//   · Order Safe assumes the single busiest day of the month repeats every day
//     for the whole lead time. FRAG_0030 consumes 91 L a month; it asked 582.
//
// The fix is additive on purpose. Both existing columns keep their exact
// values, so nothing a planner has been reading changes underneath them, and
// the new column carries the corrected arithmetic beside them. That
// "changes nothing else" property is the main thing asserted here — it is what
// makes the feature safe to ship without retraining anybody.
//
// READ-ONLY. No fixture: it asserts against the live catalogue, because the
// property being proved is arithmetic the endpoint performs on whatever real
// products exist. Nothing is written, so there is nothing to tear down.
//
// Run: node scripts/regression-replenishment-recommendation.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { getStockStatus, isReorderSoon, isLowStock } from '../src/sa/utils/stockStatus.js';
import { shelfOutlook, orderToCover } from '../shared/shelf-outlook.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3986;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0, server;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  // 3 minutes: a cold Neon connection has taken longer than 120×500ms before.
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1200)}`);

  const token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SA', 'SM'] },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
  const r = await (await fetch(`${BASE}/api/sa/dashboard/replenishment`,
    { headers: { Authorization: `Bearer ${token}` } })).json();
  const oils = r.products.filter((p) => p.category === 'OILS');

  console.log('\n1. Every product carries a recommendation');
  check(oils.length > 0, 'the endpoint returned oils at all', `${oils.length}`);
  check(oils.every((p) => p.recommendation), 'none is missing the field',
    `${oils.filter((p) => !p.recommendation).length} missing`);
  const actions = new Set(oils.map((p) => p.recommendation.action));
  check([...actions].every((a) => ['order', 'hold', 'count_first'].includes(a)),
    'and only the three defined actions appear', [...actions].join(', '));

  // CHANGED 2026-10-12. Until then this section asserted "the LARGER stream,
  // never the sum" — the September workaround for a double count nobody had
  // yet located. Technician refills are now taken out of sales at the source,
  // so the owner's rule applies as stated: B2B + customer sales, added. The
  // "never added" property moved to where it now lives: between the contract
  // and the technician refills, which ARE one demand (section 7).
  console.log('\n2. It is B2B + customer sales, capped at the conservative rate');
  const both = oils.filter((p) => p.retailDailyAvg > 0 && p.b2bDaily > 0);
  check(both.length > 0, 'there are products where both streams are known', `${both.length}`);
  // Clamped at the conservative rate — leaving the clamp out made the old
  // check fail exactly when the cap engages (code review, 11 Sep). Tolerance
  // is proportional because trendMultiplier reaches here rounded to 2dp.
  const tol = (p) => Math.max(0.02, p.retailDailyAvg * 0.01);
  const off = oils.filter((p) => p.recommendation.dailyRate > 0 && Math.abs(
    p.recommendation.dailyRate - Math.min(p.scenarioExpectedRate, p.scenarioConservativeRate)) > tol(p));
  check(off.length === 0, 'its rate is the Expected scenario, capped',
    off.slice(0, 3).map((p) => `${p.productCode}: rate ${p.recommendation.dailyRate} vs expected ${p.scenarioExpectedRate}`).join(' | '));

  console.log('\n3. The older columns are untouched — nothing shifts under a planner');
  // Recomputed here from the same fields the endpoint returns, so a change to
  // either formula shows up as a mismatch rather than passing silently.
  const drifted = oils.filter((p) =>
    Math.abs(p.scenarioExpectedRate - ((p.retailDailyAvg * (p.trendMultiplier || 1)) + p.b2bDaily)) > tol(p));
  check(drifted.length === 0, 'Expected is still retail + B2B, exactly as before',
    drifted.slice(0, 3).map((p) => p.productCode).join(', '));
  const consDrift = oils.filter((p) =>
    Math.abs(p.scenarioConservativeRate - (p.retailDailyPeak + p.b2bDaily)) > tol(p));
  check(consDrift.length === 0, 'Conservative is still peak + B2B',
    consDrift.slice(0, 3).map((p) => p.productCode).join(', '));

  console.log('\n4. It is smaller than Order Safe, and says by how much');
  const ordering = oils.filter((p) => p.recommendation.action === 'order');
  check(ordering.length > 0, 'some products are recommended for order', `${ordering.length}`);
  // Guaranteed by construction since 11 Sep, not a hopeful observation: the
  // corrected rate is capped at the conservative one. Before that cap a rising
  // low-variance product could genuinely exceed the ceiling, because the
  // trend multiplier applies to retail while `conservative` uses the untrended
  // peak — code review caught this assertion claiming an invariant the code
  // did not actually hold.
  // A bridge order (keep the shelf stocked until a late order lands) is sized
  // to the empty days, not to a scenario, so it is exempt — and checked in 12.
  const bigger = ordering.filter((p) => !p.recommendation.bridge && p.recommendation.litres > p.safeOrder + 1);
  check(bigger.length === 0, 'none recommends MORE than the buy-safe ceiling',
    bigger.slice(0, 3).map((p) => `${p.productCode}: ${p.recommendation.litres} > ${p.safeOrder}`).join(' | '));
  const overRate = oils.filter((p) => p.recommendation.dailyRate > p.scenarioConservativeRate + 0.002);
  check(overRate.length === 0, 'and its daily rate never exceeds the conservative rate either',
    overRate.slice(0, 3).map((p) => `${p.productCode}: ${p.recommendation.dailyRate} > ${p.scenarioConservativeRate}`).join(' | '));
  const gapWrong = ordering.filter((p) =>
    Math.abs(p.recommendation.vsSafeOrder - (p.safeOrder - p.recommendation.litres)) > 1);
  check(gapWrong.length === 0, 'and the stated gap matches the two numbers',
    gapWrong.slice(0, 3).map((p) => p.productCode).join(', '));

  console.log('\n5. "Count first" is reserved for products with genuinely nothing to go on');
  const countFirst = oils.filter((p) => p.recommendation.action === 'count_first');
  // Asserted against the STREAMS, not against dataConfidence — keying it to the
  // same field the action is derived from would be tautological and prove
  // nothing (code review). This says the streams really are both silent.
  check(countFirst.every((p) => p.retailDailyAvg === 0 && p.b2bDaily === 0),
    'every one has no sales rate and no forecast rate',
    countFirst.filter((p) => p.retailDailyAvg > 0 || p.b2bDaily > 0)
      .slice(0, 3).map((p) => `${p.productCode}: retail ${p.retailDailyAvg} b2b ${p.b2bDaily}`).join(' | '));
  check(countFirst.every((p) => p.recommendation.litres === 0),
    'and none of them names a quantity');
  check(countFirst.every((p) => p.recommendation.basis === 'nothing_known'),
    'and each says so, rather than claiming it rests on sales it does not have',
    countFirst.filter((p) => p.recommendation.basis !== 'nothing_known')
      .slice(0, 3).map((p) => `${p.productCode}: ${p.recommendation.basis}`).join(' | '));

  console.log('\n6. The modal cannot contradict itself');
  // Found by looking at the real screen, not by reading code: FRAG_0137 showed
  // "Order 243 L, covering 81 days" with "⚠ Stock will run out before order
  // arrives — reorder immediately!" directly beneath it. The alarm read the
  // Expected scenario (20.5 days) while the recommendation read the corrected
  // one (40.2). Seven of twenty-five alarms were false the same way.
  //
  // The alarm now reads the recommendation's rate, so this asserts the two can
  // never disagree again: wherever the recommendation says stock outlasts the
  // lead time, the days-of-stock figure the alarm fires on must agree.
  // The screen now takes BOTH the alarm and the "already on its way" banner
  // from recommendation.action, so what has to be true is that `action` itself
  // is coherent — in both directions. The first version of this check only
  // asserted the 'hold' side and was a tautology: 'hold' already means stock
  // covers lead + buffer, so "covers lead time" followed for free and the check
  // would have passed with the entire UI change deleted (code review).
  //
  // Coverage is EFFECTIVE stock: shelf plus what is already ordered. Written
  // against physical stock alone at first, and it caught FRAG_0072 — 0.7 L on
  // the shelf, 20 L inbound, recommendation correctly holding while the alarm
  // shouted. The recommendation was right, the check was wrong, and the screen
  // was wrong too, so all three were fixed.
  const effectiveOf = (p) => p.realStock + (p.incomingStock || 0);
  const needOf = (p) => p.recommendation.dailyRate * p.recommendation.coversDays;
  const rated = oils.filter((p) => p.recommendation.dailyRate > 0);

  // The slack belongs on ONE side only. `litres` is rounded to whole units, so
  // a shortfall under half a unit displays as 0 and becomes 'hold' — that is
  // the rounding, and it is fine. Allowing the same slack the other way marked
  // every small need as already covered: FRAG_0314 needs 0.8 L, holds none, and
  // asking for 1 L is exactly right.
  const holdButShort = rated.filter((p) => p.recommendation.action === 'hold'
    && effectiveOf(p) < needOf(p) - 1);
  check(holdButShort.length === 0,
    '"no order needed" is only said when stock plus inbound really covers the period',
    holdButShort.slice(0, 3).map((p) => `${p.productCode}: ${effectiveOf(p).toFixed(1)} vs ${needOf(p).toFixed(1)} needed`).join(' | '));
  // The direction that actually breaks a screen: ordering while already covered
  // would put "Order N L" beside "No new order needed".
  const orderButCovered = rated.filter((p) => p.recommendation.action === 'order' && !p.recommendation.bridge
    && effectiveOf(p) >= needOf(p));
  check(orderButCovered.length === 0,
    'and an order is never recommended for something already covered',
    orderButCovered.slice(0, 3).map((p) => `${p.productCode}: has ${effectiveOf(p).toFixed(1)}, needs ${needOf(p).toFixed(1)}, still asks ${p.recommendation.litres}`).join(' | '));

  console.log('\n7. Each recommendation explains itself');
  check(ordering.every((p) => p.recommendation.note && p.recommendation.note.length > 20),
    'every order carries a plain-English reason');
  check(oils.every((p) => ['contract_and_sales', 'forecast_only', 'sales_only', 'nothing_known']
    .includes(p.recommendation.basis)), 'and every basis is one the screen knows how to say',
    [...new Set(oils.map((p) => p.recommendation.basis))].join(', '));

  console.log('\n8. Contract and technician refills are ONE demand — the larger, never added');
  // Rounded to 3dp on both sides by the API, hence the small tolerance.
  const b2bWrong = oils.filter((p) => p.forecastDaily > 0 && Math.abs(
    p.b2bDaily - Math.max(p.forecastDaily, p.technicianDaily || 0)) > 0.002);
  check(b2bWrong.length === 0, 'B2B is the larger of the contract and the refills',
    b2bWrong.slice(0, 3).map((p) => `${p.productCode}: b2b ${p.b2bDaily} vs contract ${p.forecastDaily} / tech ${p.technicianDaily}`).join(' | '));
  check(oils.every((p) => (p.b2bSource === 'technicians') === ((p.technicianDaily || 0) > (p.forecastDaily || 0) + 0.0005)
    || Math.abs((p.technicianDaily || 0) - (p.forecastDaily || 0)) <= 0.0005),
    'and the screen names whichever one was used');
  // A refill is only taken out of sales where a contract exists to hold it.
  check(oils.every((p) => !(p.technicianDaily > 0) || p.forecastDaily > 0),
    'technician refills are only moved to B2B on oils that carry a contract');

  // 2026-10-14, owner's proposal: safety stock = rate × lead × 1.25 and it
  // becomes the oil's minimum; the modal answers "how much for N days".
  console.log('\n9. Safety stock and "order to cover" use the recommendation\'s own rate');
  // Tolerances: dailyRate is served at 3dp, stock and safety at 1dp.
  const safetyWrong = oils.filter((p) => Math.abs(
    p.safetyStockLevel - p.recommendation.dailyRate * p.leadTime * 1.25) > 0.15);
  check(safetyWrong.length === 0, 'safety stock = rate × lead time × 1.25',
    safetyWrong.slice(0, 3).map((p) => `${p.productCode}: ${p.safetyStockLevel} vs ${(p.recommendation.dailyRate * p.leadTime * 1.25).toFixed(2)}`).join(' | '));
  check(oils.every((p) => JSON.stringify((p.coverage || []).map((c) => c.days)) === '[30,60,90,120]'),
    'every oil carries the four horizons');
  // Checked against the plain arithmetic, written here and not copied from the
  // server: on every oil whose dated orders all land within the shortest
  // period (30 days) — every oil on 15 Oct — the table is rate × days − shelf −
  // everything on order, undated included, exactly as the recommendation
  // counts it. Late orders are covered by the orderToCover unit checks in 12.
  const plain = (rate, d, p) => Math.max(0, rate * d - effectiveOf(p));
  const onTimeOnly = (p) => (p.openOrders || []).every((o) => o.days == null || o.days <= 30);
  const tableOils = oils.filter(onTimeOnly);
  const allWrong = tableOils.filter((p) => p.coverage.some((c) => p.recommendation.dailyRate > 0
    ? Math.abs(c.all - plain(p.recommendation.dailyRate, c.days, p)) > 0.25 : c.all !== null));
  check(allWrong.length === 0, `"all demand" column = rate × days − stock − on order, on ${tableOils.length} oils (blank with no rate)`,
    allWrong.slice(0, 3).map((p) => `${p.productCode}: ${JSON.stringify(p.coverage)}`).join(' | '));
  const sfWrong = tableOils.filter((p) => p.coverage.some((c) => p.forecastDaily != null
    ? Math.abs(c.salesforce - plain(p.forecastDaily, c.days, p)) > 0.25 : c.salesforce !== null));
  check(sfWrong.length === 0, '"Salesforce only" column = contract × days − stock − on order (blank with no contract)',
    sfWrong.slice(0, 3).map((p) => `${p.productCode}: ${JSON.stringify(p.coverage)}`).join(' | '));
  check(oils.every((p) => p.coverage.every((c, i, a) => i === 0
    || ((c.all ?? 0) >= (a[i - 1].all ?? 0) && (c.salesforce ?? 0) >= (a[i - 1].salesforce ?? 0)))),
    'a longer horizon never asks for less');

  console.log('\n10. The automatic minimum reaches the product list, and only for oils with a rate');
  const list = await (await fetch(`${BASE}/api/sa/products`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const byId = new Map(list.map((p) => [p.id, p]));
  const rep = new Map(r.products.map((p) => [p.id, p]));
  const autoWrong = list.filter((p) => {
    const d = rep.get(p.id);
    const expected = d && p.category === 'OILS' && d.unit === 'L' && d.recommendation?.dailyRate > 0
      ? d.safetyStockLevel * 1000 : null;
    // Served unrounded in whole mL; the screen's safety stock is rounded to
    // 0.1 L, so they agree to within 50 mL.
    return expected === null ? p.minStockAuto !== null
      : !Number.isInteger(p.minStockAuto) || p.minStockAuto <= 0 || Math.abs(p.minStockAuto - expected) > 50;
  });
  check(autoWrong.length === 0, 'minStockAuto = safety stock (whole mL, never 0) on rated oils, null everywhere else',
    autoWrong.slice(0, 3).map((p) => `${p.productCode} ${p.category}: ${p.minStockAuto}`).join(' | '));
  check(list.some((p) => p.minStockAuto !== null), 'and some oil actually gets one');
  const rateWrong = list.filter((p) => {
    const d = rep.get(p.id);
    return p.minStockAuto === null ? p.autoDailyRate !== null
      : Math.abs(p.autoDailyRate - d.recommendation.dailyRate * 1000) > 1;
  });
  check(rateWrong.length === 0, 'and carries the daily rate it was built from (mL/day), nothing without one',
    rateWrong.slice(0, 3).map((p) => `${p.productCode}: ${p.autoDailyRate}`).join(' | '));
  check(list.every((p) => (p.incomingOrders || []).every((o) => o.estimatedDeliveryDate == null ? o.etaDays === null : Number.isInteger(o.etaDays))),
    'every open order carries its days-away exactly when it has a date');

  // The two screens on one rule: Critical in the product list (shared rule,
  // fresh stock, cached rate) is Critical in Demand Planning, and back.
  const crit = list.filter((p) => p.category === 'OILS' && rep.has(p.id) && p.minStockAuto !== null)
    // Empty or overdrawn is the list's own, stronger word for the same alarm.
    .filter((p) => ['CRITICAL', 'OUT', 'NEGATIVE'].includes(getStockStatus(p).key) !== (rep.get(p.id).safetyStatus === 'Critical'));
  check(crit.length === 0, 'Critical (or empty) in the Fragrance Library ⇔ Critical in Demand Planning, on every rated oil',
    crit.slice(0, 5).map((p) => `${p.productCode} list=${getStockStatus(p).key} dp=${rep.get(p.id).safetyStatus}`).join(' | '));
  const pg = new pkg.Pool({ connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
    ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public' });
  const typed = (await pg.query(`SELECT id, "minStockLevel"::float m FROM products`)).rows;
  await pg.end();
  const typedChanged = typed.filter((t) => byId.has(t.id) && Math.abs(byId.get(t.id).minStockLevel - t.m) > 0.001);
  check(typedChanged.length === 0, 'the typed minimum is served untouched (the form never sees the automatic one)',
    typedChanged.slice(0, 3).map((t) => t.id).join(', '));

  console.log('\n11. "Low" counts what is on order, and the automatic minimum wins');
  const S = (p) => getStockStatus(p).key;
  const po = (q, got = 0) => [{ quantity: q, quantityReceived: got }];
  check(S({ currentStock: 10, minStockLevel: 5 }) === 'HEALTHY', 'unchanged: no automatic minimum, no order');
  check(S({ currentStock: 3, minStockLevel: 5 }) === 'LOW', 'unchanged: under the typed minimum is low');
  check(S({ currentStock: 18, minStockLevel: 5, minStockAuto: 20 }) === 'LOW', 'the automatic minimum overrides the typed one');
  check(S({ currentStock: 10, minStockAuto: 20, incomingOrders: po(15) }) === 'HEALTHY', 'an order that covers the gap clears "low"');
  check(S({ currentStock: 10, minStockAuto: 20, incomingOrders: po(15, 10) }) === 'CRITICAL'
    && S({ currentStock: 17, minStockAuto: 20, incomingOrders: po(15, 14) }) === 'LOW', 'only the part still to arrive counts');
  check(S({ currentStock: 0, minStockAuto: 20, incomingOrders: po(50) }) === 'OUT', 'empty stays empty whatever is on the way');
  check(S({ currentStock: -2, minStockAuto: 20, incomingOrders: po(50) }) === 'NEGATIVE', 'negative stays negative');
  check(isReorderSoon({ currentStock: 25, minStockAuto: 20 }) === true, 'reorder-soon reads the automatic minimum');
  check(isReorderSoon({ currentStock: 25, minStockAuto: 20, incomingOrders: po(10) }) === false, 'and counts what is on order too');

  // 2026-10-15: bands on an automatic minimum, and orders only when on time.
  // mL, the stored unit. Rate × lead 21 × 1.25 = minimum.
  const oil = (stock, rate, orders = []) => ({ currentStock: stock, minStockAuto: Math.round(rate * 21 * 1.25), autoDailyRate: rate, incomingOrders: orders });
  const dated = (q, etaDays) => ({ quantity: q, quantityReceived: 0, etaDays });
  check(S(oil(22600, 5371, [dated(200000, 13)])) === 'CRITICAL', 'Dream: 22.6 L with 200 L landing after it empties is Critical, not Healthy');
  check(S(oil(100000, 5157, [dated(200000, 13)])) === 'HEALTHY', 'Milagrito: 100 L with 200 L landing in time is Healthy');
  check(S(oil(22600, 5371, [dated(200000, null)])) === 'CRITICAL', 'an order with no date does not hold the alarm');
  check(S(oil(22600, 5371, [dated(200000, -3)])) === 'CRITICAL', 'nor does an overdue one');
  const rt = 5000, mn = Math.round(rt * 21 * 1.25);
  check(S(oil(mn, rt)) === 'HEALTHY' && S(oil(mn - 1, rt)) === 'LOW', 'at the minimum is Healthy, one mL under is Low');
  check(S(oil(rt * 21, rt)) === 'LOW' && S(oil(rt * 21 - 1, rt)) === 'CRITICAL', 'Critical starts below what the lead time uses (80% of the minimum)');
  check(S({ currentStock: 1, minStockLevel: 1000 }) === 'LOW', 'a typed minimum is never Critical — no rate to judge it by');
  check(isLowStock(oil(1000, rt)), 'Critical counts as low wherever low stock is listed');

  // 2026-10-15: the modal's alarm reads each open order's own date and quantity.
  console.log('\n12. The run-out alarm follows the orders already raised');
  const ordersWrong = oils.filter((p) => !Array.isArray(p.openOrders)
    || p.openOrders.reduce((s, o) => s + o.qty, 0) + 0.1 < p.incomingStock
    || p.openOrders.some((o) => !(o.qty > 0) || (o.date == null) !== (o.days == null)));
  check(ordersWrong.length === 0, 'every oil lists its open orders, together at least On Order, each with a date and days or neither',
    ordersWrong.slice(0, 3).map((p) => `${p.productCode}: ${JSON.stringify(p.openOrders)} vs ${p.incomingStock}`).join(' | '));
  const O = (qty, days) => ({ qty, days, date: days == null ? null : 'x' });
  const milagrito = shelfOutlook(100, 5.157, [O(200, 13)]);
  check(milagrito.next === null && milagrito.firstArrival?.days === 13, 'Milagrito: 200 L due in 13 days lands before 100 L runs out (~19)');
  const dream = shelfOutlook(21.6, 5.104, [O(200, 13)]);
  check(dream.next?.days === 13 && Math.abs(dream.gapDays - (13 - 21.6 / 5.104)) < 0.01, 'Dream: runs out at ~4 days, nine before its order');
  const small = shelfOutlook(10, 1, [O(5, 3), O(200, 60)]);
  check(small.next?.qty === 200 && Math.abs(small.runsOutIn - 15) < 0.001, 'a small early order does not vouch for the large late one');
  const undated = shelfOutlook(10, 1, [O(150, null), O(10, 5)]);
  check(undated.undatedQty === 150 && undated.firstArrival.qty === 10, 'an order with no date is named, not assumed to arrive');
  const late = shelfOutlook(10, 1, [O(50, -3)]);
  check(late.overdue.length === 1 && late.firstArrival === null && late.next === null, 'an overdue order is named, not counted');
  check(shelfOutlook(6, 1, [O(50, 6)]).next !== null, 'delivered the day it runs out still leaves a day with an empty shelf');

  // The order on the real calendar (code review, 2026-10-15). Rate 1/day,
  // lead 21, period 66 (lead + 45).
  const T = (stock, orders) => orderToCover(stock, 1, orders, 21, 66);
  check(T(30, []).qty === 36 && T(30, []).bindingDays === null, 'no orders: period × rate − shelf, as before');
  check(T(30, [O(100, null)]).qty === 0, 'an order with no date still counts toward the quantity (no buying it twice)');
  check(T(30, [O(10, 13)]).qty === 26 && T(30, [O(10, 13)]).bindingDays === null, 'an order landing before the lead time: exactly the old formula');
  check(T(30, [O(100, 40)]).qty === 10 && T(30, [O(100, 40)]).bindingDays === 40, 'shelf for 30 days, 100 due day 40: order 10 to last until it lands');
  check(T(30, [O(2, 40), O(50, 60)]).qty === 28 && T(30, [O(2, 40), O(50, 60)]).bindingDays === 60, 'two late orders: sized to the worse gap, not only the first');
  check(T(30, [O(100, 200)]).qty === 36, 'an order due after the period does not count toward it');
  check(T(39.5, [O(100, 40)]).bindingDays === null, 'a shortfall under a day of demand is not called a bridge');
  const d = orderToCover(22.6, 5.371, [O(200, 13)], 21, 81);
  check(Math.abs(d.qty - (5.371 * 81 - 222.6)) < 1e-9 && d.bindingDays === null, 'Dream: its order lands before the lead time — the old 212 L');

  // Live: wherever every dated order lands by the lead time and none after the
  // period, the quantity is exactly what the old formula gave.
  const ordinary = rated.filter((p) => (p.openOrders || []).every((o) => o.days == null || o.days <= p.leadTime)
    && p.recommendation.action !== 'count_first');
  const oldFormula = (p) => Math.max(0, p.recommendation.dailyRate * p.recommendation.coversDays - (p.realStock + p.incomingStock));
  const qtyDrift = ordinary.filter((p) => Math.abs(Math.max(p.recommendation.litres, 0) - Math.round(oldFormula(p))) > 1);
  check(qtyDrift.length === 0, `${ordinary.length} oils with no late order: the quantity is unchanged from the old formula`,
    qtyDrift.slice(0, 3).map((p) => `${p.productCode}: ${p.recommendation.litres} vs ${oldFormula(p).toFixed(1)}`).join(' | '));
  const bridged = oils.filter((p) => p.recommendation.bridge);
  check(bridged.every((p) => p.recommendation.action === 'order' && p.recommendation.litres >= 1
    && ['Attention', 'Critical'].includes(p.safetyStatus)),
    `${bridged.length} oils are ordered to bridge a late delivery — every one says order and is flagged`,
    bridged.filter((p) => p.recommendation.action !== 'order').map((p) => p.productCode).join(', '));
  const tooMuch = ordering.filter((p) => p.recommendation.litres > p.recommendation.dailyRate * p.recommendation.coversDays - p.realStock + 1);
  check(tooMuch.length === 0, 'no order is ever more than the whole period with nothing on order',
    tooMuch.slice(0, 3).map((p) => `${p.productCode}: ${p.recommendation.litres}`).join(' | '));
  // The screens' LOW is "order now, it still lands in time": Demand Planning must agree there is something to do.
  // Automatic minimums only: a typed minimum on an oil nothing draws on is not
  // a demand Demand Planning knows about (Gingerbread A: Low there, idle here).
  const lowButSafe = list.filter((p) => p.category === 'OILS' && rep.has(p.id) && p.minStockAuto != null && getStockStatus(p).key === 'LOW'
    && rep.get(p.id).safetyStatus === 'Safe');
  check(lowButSafe.length === 0, 'Low Stock on an automatic minimum is never "Safe" in Demand Planning',
    lowButSafe.slice(0, 5).map((p) => p.productCode).join(', '));

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /replenish|rror/i.test(l)).slice(-12).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ replenishment-recommendation: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  console.log('  ok    read-only against the live catalogue — no fixture to clean up');
  process.exit(failed === 0 ? 0 : 1);
}
