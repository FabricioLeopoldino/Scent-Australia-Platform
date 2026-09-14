// Proves the screen says how old the forecast is, and names the products the
// recent imports left behind.
//
// WHY THIS EXISTS (2026-09-14). The Salesforce feed stopped when the person
// running it left, and nobody noticed for three months. The dashboard was not
// broken and nothing was hidden: it showed the import date the entire time. A
// date that stops moving is not a warning — it only reads as one to somebody
// who remembers what it said last month.
//
// The order maths already knew. A `stalenessFactor` has been quietly inflating
// the conservative scenario past 35 days for as long as it has existed. A
// penalty nobody can see is not a warning either, so both now read one named
// constant and the screen says what the maths is already doing.
//
// The second, quieter failure is the one live today: an import can RUN and
// still leave products behind. Four oils carry a forecast from 2 July holding
// 833 L between them, and FRAG_0060 — the largest single line on the Critical
// list, asking for 332 L — is one of them. The portfolio card is green, the
// import is three days old, and that number is eleven weeks stale.
//
// TWO DIRECTIONS. A warning that is always on gets ignored, so this asserts
// both that stale products are named AND that fresh ones are left alone.
//
// READ-ONLY apart from one disposable product and one forecast row for it,
// both removed in the finally block. Everything else asserts against the live
// catalogue, because the property being proved is arithmetic over real dates.
//
// Run: node scripts/regression-forecast-freshness.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3984;
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const OLD = `ZZFF_OLD_${STAMP}`.slice(0, 20);   // forecast deliberately ancient
const NEW = `ZZFF_NEW_${STAMP}`.slice(0, 20);   // forecast dated today
const ZERO = `ZZFF_ZER_${STAMP}`.slice(0, 20);  // forecast ancient AND worth zero

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let failed = 0, server;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  // Two probes, identical but for the age of their forecast. Anything that
  // separates them in the answer is the staleness rule and nothing else.
  for (const code of [OLD, NEW, ZERO]) {
    await pool.query(
      `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", status)
       VALUES ($1,$1,$1,$2,'OILS','mL',50000,'active')`, [code, `${code} probe`]);
  }
  await pool.query(
    `INSERT INTO forecasts (product_code, forecast_120_days, import_date, imported_by)
     VALUES ($1, 120, NOW() - INTERVAL '200 days', 'regression')`, [OLD]);
  await pool.query(
    `INSERT INTO forecasts (product_code, forecast_120_days, import_date, imported_by)
     VALUES ($1, 120, NOW(), 'regression')`, [NEW]);
  await pool.query(
    `INSERT INTO forecasts (product_code, forecast_120_days, import_date, imported_by)
     VALUES ($1, 0, NOW() - INTERVAL '200 days', 'regression')`, [ZERO]);

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
  const meta = body.meta || {};
  const byCode = new Map(body.products.map((p) => [p.productCode, p]));
  const oldP = byCode.get(OLD), newP = byCode.get(NEW), zeroP = byCode.get(ZERO);

  console.log('\n1. The portfolio card can say how old the newest import is');
  check(typeof meta.forecastAgeDays === 'number',
    'the age of the newest import is served, not left for the browser to work out',
    `forecastAgeDays=${meta.forecastAgeDays}`);
  // The ten-hour trap: import_date is stored naive-UTC, so computing this in JS
  // on a Sydney machine reads a day late. The probe inserted at NOW() must
  // therefore be 0 days old, never 1 and never -1.
  check(meta.forecastAgeDays === 0,
    'and it is 0 today — proving it was computed in Sydney time, not shifted by the driver',
    `got ${meta.forecastAgeDays}`);
  check(meta.forecastStaleDays === 35,
    'the threshold is published so the screen and the order maths cannot drift apart',
    `forecastStaleDays=${meta.forecastStaleDays}`);

  console.log('\n2. A product the recent imports left behind is named');
  check(!!oldP, 'the stale probe came back at all');
  check(oldP?.forecastStale === true, 'it is flagged stale', `forecastStale=${oldP?.forecastStale}`);
  check(oldP?.forecastAgeDays >= 199 && oldP?.forecastAgeDays <= 201,
    'and its age is reported accurately, so a person can judge how bad it is',
    `forecastAgeDays=${oldP?.forecastAgeDays}`);
  check((meta.staleForecastProducts || 0) >= 1,
    'the count on the card includes it', `staleForecastProducts=${meta.staleForecastProducts}`);

  console.log('\n3. A fresh one is left alone — the half that keeps the warning worth reading');
  check(newP?.forecastStale === false, 'today\'s forecast is not flagged',
    `forecastStale=${newP?.forecastStale}`);
  check(newP?.forecastAgeDays === 0, 'and reads as 0 days old', `${newP?.forecastAgeDays}`);
  // Both probes hold identical stock and an identical forecast figure. If the
  // flag tracked anything other than the date, they would not differ.
  check(oldP?.b2bDaily === newP?.b2bDaily,
    'both probes carry the same forecast figure, so only the DATE separates them',
    `${oldP?.b2bDaily} vs ${newP?.b2bDaily}`);

  console.log('\n4. Every flagged product really is past the published threshold');
  const flagged = body.products.filter((p) => p.forecastStale);
  const wrong = flagged.filter((p) => !(p.forecastAgeDays > meta.forecastStaleDays));
  check(wrong.length === 0, `all ${flagged.length} flagged products are older than ${meta.forecastStaleDays} days`,
    wrong.slice(0, 4).map((p) => `${p.productCode}=${p.forecastAgeDays}d`).join(', '));
  // The `b2bDaily > 0` term is part of the definition, not an oversight — see
  // section 5. Without it this check would demand the wallpaper back.
  const missed = body.products.filter((p) => p.hasForecast && p.b2bDaily > 0
    && p.forecastAgeDays > meta.forecastStaleDays && !p.forecastStale);
  check(missed.length === 0, 'and nothing past it, that drives a number, escaped the flag',
    missed.slice(0, 4).map((p) => `${p.productCode}=${p.forecastAgeDays}d`).join(', '));

  console.log('\n5. An old forecast that drives nothing is not worth a warning');
  // 79 oils carry a forecast row past the threshold. 75 of those rows say zero:
  // old, and moving no number at all. Flagging all 79 would put an amber mark
  // on a quarter of the screen in order to point at the four that matter, and a
  // warning that is everywhere is not a warning.
  check(zeroP?.forecastStale === false,
    'a 200-day-old forecast worth 0 L is NOT flagged — it changes no number',
    `forecastStale=${zeroP?.forecastStale} b2bDaily=${zeroP?.b2bDaily}`);
  check(zeroP?.forecastAgeDays >= 199,
    'though its age is still reported honestly, for anyone who looks',
    `${zeroP?.forecastAgeDays}`);
  check(body.products.filter((p) => p.forecastStale).every((p) => p.b2bDaily > 0),
    'every flagged product has a forecast that is actually driving its demand');

  console.log('\n6. A product with no forecast is not accused of having an old one');
  const noFc = body.products.filter((p) => !p.hasForecast);
  check(noFc.every((p) => p.forecastStale === false),
    `${noFc.length} products carry no forecast — none is flagged stale`,
    noFc.filter((p) => p.forecastStale).slice(0, 4).map((p) => p.productCode).join(', '));

  console.log('\n7. The silent order penalty and the visible warning agree');
  // They read one constant. Before today the penalty existed and the screen
  // said nothing, which is how a number can be inflated for three months
  // without anybody being told.
  check(oldP && oldP.safeOrder >= oldP.suggestedOrder,
    'the stale probe still carries the inflated conservative order',
    `safe=${oldP?.safeOrder} exp=${oldP?.suggestedOrder}`);

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /forecast|replenish|rror/i.test(l)).slice(-12).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ forecast-freshness: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  await pool.query(`DELETE FROM forecasts WHERE imported_by = 'regression'`).catch(() => {});
  await pool.query(`DELETE FROM products WHERE "productCode" LIKE 'ZZFF\\_%'`).catch(() => {});
  const left = Number((await pool.query(
    `SELECT count(*) c FROM forecasts WHERE imported_by = 'regression'`)).rows[0].c)
    + Number((await pool.query(
      `SELECT count(*) c FROM products WHERE "productCode" LIKE 'ZZFF\\_%'`)).rows[0].c);
  console.log(left === 0 ? '  ok    left exactly as found' : `  FAIL  ${left} row(s) left behind`);
  if (left) failed++;
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
