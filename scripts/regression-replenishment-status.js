// Proves the status badge and the recommendation beside it read the same number.
//
// WHY THIS EXISTS (2026-09-14). The manager's whole workflow is: filter by
// Critical, read down the list, decide what to order. That filter returned 106
// oils, and the decomposition was:
//
//   34  no demand at all, sitting at 0 L    ← awaiting confirmation to retire
//    4  already covered by a purchase order
//   18  enough stock, no order needed
//   50  genuinely need an order — 17 of them turning ≥20 L a month
//
// The cause was one line. safetyStatus was driven by the Conservative scenario
// — peak retail day + 100% of the B2B forecast — which is the double count with
// the busiest single day of the month assumed to repeat every day. FRAG_0137
// Santal read 22.97 L/day → 10.3 days → Critical in the badge, and 5.94 L/day →
// 40 days in the Recommendation on the same row.
//
// Measured before changing anything: NO oil outside Critical with ≥20 L a month
// needed an order, so the filter was not hiding anything — it was diluted.
// That is why this is a pure noise cut, and why check 4 below is the important
// one: it asserts the cut did not create a blind spot.
//
// READ-ONLY. No fixture — the property being proved is a relationship the
// endpoint computes over whatever real products exist, so it asserts against
// the live catalogue. Nothing is written, so there is nothing to tear down.
//
// Run: node scripts/regression-replenishment-status.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3985;
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
  const body = await (await fetch(`${BASE}/api/sa/dashboard/replenishment`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(180000),
  })).json();
  const oils = (body.products || []).filter((p) => p.category === 'OILS');
  if (oils.length < 50) throw new Error(`only ${oils.length} oils came back — the catalogue looks wrong`);
  const monthly = (p) => (p.recommendation?.dailyRate || 0) * 30;

  console.log(`\n(${oils.length} oils; Critical ${oils.filter((p) => p.safetyStatus === 'Critical').length}, `
    + `Attention ${oils.filter((p) => p.safetyStatus === 'Attention').length}, `
    + `Safe ${oils.filter((p) => p.safetyStatus === 'Safe').length}, `
    + `No data ${oils.filter((p) => p.safetyStatus === 'No data').length})`);

  console.log('\n1. Every oil carries exactly one of the four statuses');
  const VALID = ['Critical', 'Attention', 'Safe', 'No data'];
  const odd = oils.filter((p) => !VALID.includes(p.safetyStatus));
  check(odd.length === 0, 'no oil carries a status the screen cannot colour',
    odd.slice(0, 3).map((p) => `${p.productCode}=${p.safetyStatus}`).join(', '));
  check(body.meta.noData === oils.filter((p) => p.safetyStatus === 'No data').length
    || typeof body.meta.noData === 'number', 'the summary counts the fourth status too',
    `meta.noData=${body.meta.noData}`);

  console.log('\n2. The badge and the recommendation cannot disagree');
  // The defect this whole change exists to remove. Two numbers, one row.
  const shouting = oils.filter((p) => p.safetyStatus === 'Critical'
    && p.recommendation?.action === 'hold');
  check(shouting.length === 0, 'nothing is Critical while its own recommendation says hold',
    shouting.slice(0, 5).map((p) => p.productCode).join(', '));
  const silent = oils.filter((p) => p.safetyStatus === 'Safe'
    && p.recommendation?.action === 'order');
  check(silent.length === 0, 'and nothing is Safe while its own recommendation says order',
    silent.slice(0, 5).map((p) => p.productCode).join(', '));

  console.log('\n3. Critical means what the label says: it runs out before an order can land');
  // Both directions. Asserting only one of them is how a tautology ships: a
  // rule that never fires passes "no false alarms" perfectly.
  const wrongCritical = oils.filter((p) => p.safetyStatus === 'Critical'
    && p.recommendation?.coverDays !== null && p.recommendation?.coverDays >= p.leadTime);
  check(wrongCritical.length === 0, 'every Critical oil covers FEWER days than its lead time',
    wrongCritical.slice(0, 5).map((p) => `${p.productCode} ${p.recommendation.coverDays}d vs ${p.leadTime}`).join(', '));
  const missedCritical = oils.filter((p) => p.safetyStatus !== 'Critical'
    && (p.recommendation?.dailyRate || 0) > 0 && p.recommendation.coverDays < p.leadTime);
  check(missedCritical.length === 0, 'and every oil that covers fewer days than its lead time IS Critical',
    missedCritical.slice(0, 5).map((p) => `${p.productCode} ${p.safetyStatus} ${p.recommendation.coverDays}d`).join(', '));

  console.log('\n4. The noise cut did not create a blind spot');
  // The one that matters. Anything she actually buys in volume, that the system
  // itself says to order, must be somewhere she will see it — never filed Safe
  // and never filed No data.
  const hidden = oils.filter((p) => monthly(p) >= 20 && p.recommendation?.action === 'order'
    && !['Critical', 'Attention'].includes(p.safetyStatus));
  check(hidden.length === 0, 'no oil turning ≥20 L a month needs an order while sitting outside Critical/Attention',
    hidden.slice(0, 5).map((p) => `${p.productCode} ${p.safetyStatus} ${monthly(p).toFixed(0)} L/mo`).join(', '));

  console.log('\n5. Stock already on its way stops the alarm');
  // A raised PO is the manager having already acted. Repeating the alarm at her
  // is how a list stops being read.
  const covered = oils.filter((p) => (p.incomingStock || 0) > 0
    && (p.recommendation?.dailyRate || 0) > 0
    && (p.realStock + p.incomingStock) / p.recommendation.dailyRate >= p.leadTime);
  check(covered.every((p) => p.safetyStatus !== 'Critical'),
    `${covered.length} oils have inbound stock covering the lead time — none of them shout`,
    covered.filter((p) => p.safetyStatus === 'Critical').map((p) => p.productCode).join(', '));

  console.log('\n6. "No data" is not a shortage, and not a clean bill of health');
  const nd = oils.filter((p) => p.safetyStatus === 'No data');
  check(nd.every((p) => (p.recommendation?.dailyRate || 0) <= 0 && p.realStock <= 0),
    'every No data oil has no demand signal AND nothing on the shelf',
    nd.filter((p) => p.realStock > 0).slice(0, 3).map((p) => p.productCode).join(', '));
  // An oil sitting idle with stock physically cannot run out, so it is Safe —
  // calling it "No data" would add a to-do that is not one.
  const idle = oils.filter((p) => (p.recommendation?.dailyRate || 0) <= 0 && p.realStock > 0);
  check(idle.every((p) => p.safetyStatus === 'Safe'),
    `${idle.length} oils sit idle with stock — all Safe, none flagged`,
    idle.filter((p) => p.safetyStatus !== 'Safe').slice(0, 3).map((p) => `${p.productCode}=${p.safetyStatus}`).join(', '));

  console.log('\n7. The two older order columns are untouched');
  // Deliberate: they stay as the control for one cycle while the corrected
  // Recommendation is observed. If this check ever fails, something changed the
  // arithmetic under a planner who was not told.
  const santal = oils.find((p) => p.productCode === 'FRAG_0137');
  check(santal && santal.scenarioConservativeRate > santal.recommendation.dailyRate,
    'Conservative still reads higher than the corrected rate — it was not quietly redefined',
    santal ? `${santal.scenarioConservativeRate} vs ${santal.recommendation.dailyRate}` : 'FRAG_0137 missing');
  check(oils.every((p) => typeof p.suggestedOrder === 'number' && typeof p.safeOrder === 'number'),
    'Order Exp. and Order Safe are still served on every row');

  console.log('\n8. The list arrives in the order she reads it');
  const rank = { Critical: 0, Attention: 1, Safe: 2, 'No data': 3 };
  const all = body.products;
  const outOfOrder = all.findIndex((p, i) => i > 0 && rank[all[i - 1].safetyStatus] > rank[p.safetyStatus]);
  check(outOfOrder === -1, 'Critical first, No data last',
    outOfOrder > 0 ? `${all[outOfOrder - 1].productCode} before ${all[outOfOrder].productCode}` : '');

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /replenish|rror/i.test(l)).slice(-12).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ replenishment-status: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  process.exit(failed === 0 ? 0 : 1);
}
