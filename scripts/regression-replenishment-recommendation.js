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

  console.log('\n2. It takes the LARGER stream, never the sum — the double count');
  const both = oils.filter((p) => p.retailDailyAvg > 0 && p.b2bDaily > 0);
  check(both.length > 0, 'there are products where both streams are known', `${both.length}`);
  // Expected value is the larger of the two streams, THEN clamped at the
  // conservative rate — leaving the clamp out made this check fail exactly
  // when the cap engages, which is the one case it most needs to allow
  // (code review). Tolerance is proportional because trendMultiplier reaches
  // here rounded to 2dp, so the error scales with the rate.
  const tol = (p) => Math.max(0.02, p.retailDailyAvg * 0.01);
  const sums = both.filter((p) => {
    const larger = Math.max(p.retailDailyAvg * (p.trendMultiplier || 1), p.b2bDaily);
    const expected = Math.min(larger, p.scenarioConservativeRate);
    return Math.abs(p.recommendation.dailyRate - expected) > tol(p);
  });
  check(sums.length === 0, 'not one of them uses the sum',
    sums.slice(0, 3).map((p) => `${p.productCode}: rate ${p.recommendation.dailyRate} vs larger ${Math.max(p.retailDailyAvg, p.b2bDaily)}`).join(' | '));
  // And it must genuinely be SMALLER than the old expected rate wherever both
  // streams are real — otherwise the correction is doing nothing.
  const smaller = both.filter((p) => p.recommendation.dailyRate < p.scenarioExpectedRate - 0.001);
  check(smaller.length === both.length,
    'so its daily rate is below the old Expected rate on every one of them',
    `${smaller.length} of ${both.length}`);

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
  const bigger = ordering.filter((p) => p.recommendation.litres > p.safeOrder + 1);
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

  console.log('\n6. Each recommendation explains itself');
  check(ordering.every((p) => p.recommendation.note && p.recommendation.note.length > 20),
    'every order carries a plain-English reason');
  const agree = oils.filter((p) => p.recommendation.basis === 'both_agree');
  // The server applies 0.8–1.25 to full precision; the API rounds both rates to
  // 3dp before they reach here, and on small numbers that rounding alone moves
  // the ratio — FRAG_0089 is 0.0334/0.0417 = 0.801 on the server and reads as
  // 0.033/0.042 = 0.786 here. The tolerance below is that rounding, nothing
  // more: it is not slack in the rule, and the offenders are named rather than
  // the first three of the group, which is how this check first lied about
  // which products were failing.
  const outside = agree.filter((p) => {
    // Trended, because that is what the server compares — using the raw
    // average produced a false failure on any product with a trend
    // (code review).
    const ratio = (p.retailDailyAvg * (p.trendMultiplier || 1)) / p.b2bDaily;
    return !(ratio >= 0.75 && ratio <= 1.30);
  });
  check(outside.length === 0,
    '"both agree" is only claimed when the two streams really are within 25%',
    outside.slice(0, 3).map((p) => `${p.productCode}: ${((p.retailDailyAvg * (p.trendMultiplier || 1)) / p.b2bDaily).toFixed(3)}`).join(' | '));

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
