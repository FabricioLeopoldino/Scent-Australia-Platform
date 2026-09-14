// Proves the forecast is a snapshot: the newest file is the whole truth, and a
// code that stops appearing stops counting.
//
// WHY THIS EXISTS (2026-09-14). Two failures, found the same afternoon.
//
// The first was silence. The Salesforce feed stopped when the person running it
// left and nobody noticed for three months. The dashboard was not hiding it — it
// showed the import date the whole time, and a date that stops moving only looks
// wrong to somebody who remembers what it said last month.
//
// The second was worse, and it was the owner who named it: "pode acontecer estar
// usando um óleo hoje com um client apenas e do nada acabar contrato, aí vai
// ficar constando lá." The plan used to take the newest row per product code
// across every import ever run, so a code that stopped appearing kept its last
// figure for ever. FRAG_0060 was carrying 825.5 L of contract from 2 July,
// had consumed nothing in ninety days, and was the single largest line on the
// Critical list — asking to buy 332 L of an oil whose contract had ended.
//
// The data says the export is a snapshot and says it plainly: the files of 11
// and 14 September carry an IDENTICAL set of 167 codes, and across every import
// since July 102 codes have left and not one has entered. So a new upload
// replaces the old one outright.
//
// THE RISK THAT COMES WITH THAT, and what actually guards it. A contract that
// ended and a half-finished export look exactly alike from inside the database.
// Nothing here can tell them apart, and a grace period only delays the same
// guess. So the guard is not delay, it is visibility: the import names every
// product that just lost its forecast at the moment of upload, and the count
// stays on the dashboard afterwards. Checks 4 and 5 are that guard.
//
// NON-DISRUPTIVE BY CONSTRUCTION. The probes attach to import timestamps that
// already exist rather than creating a newer one. A probe with its own fresher
// timestamp would become the entire snapshot for as long as the suite ran, and
// every real oil would briefly lose its forecast on a live screen.
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
const IN = `ZZFF_IN_${STAMP}`.slice(0, 20);     // in the newest file
const OUT = `ZZFF_OUT_${STAMP}`.slice(0, 20);   // in the one before, and not since
const NEVER = `ZZFF_NIL_${STAMP}`.slice(0, 20); // never in any file

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
  const stamps = (await pool.query(
    `SELECT DISTINCT import_date FROM forecasts ORDER BY import_date DESC LIMIT 2`)).rows;
  if (stamps.length < 2) throw new Error('needs at least two forecast imports to test against');
  const [latest, prior] = stamps.map((r) => r.import_date);

  for (const code of [IN, OUT, NEVER]) {
    await pool.query(
      `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", status)
       VALUES ($1,$1,$1,$2,'OILS','mL',50000,'active')`, [code, `${code} probe`]);
  }
  // Same figure, same product, same everything — only WHICH FILE they are in
  // differs. Anything that separates them downstream is the snapshot rule.
  await pool.query(
    `INSERT INTO forecasts (product_code, forecast_120_days, import_date, imported_by)
     VALUES ($1, 120, $2, 'regression')`, [IN, latest]);
  await pool.query(
    `INSERT INTO forecasts (product_code, forecast_120_days, import_date, imported_by)
     VALUES ($1, 120, $2, 'regression')`, [OUT, prior]);

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
  const inP = byCode.get(IN), outP = byCode.get(OUT), nilP = byCode.get(NEVER);

  console.log('\n1. The screen can say how old the forecast file is');
  check(typeof meta.forecastAgeDays === 'number',
    'the age is served, not left for the browser to work out', `${meta.forecastAgeDays}`);
  // The ten-hour trap: import_date is stored naive-UTC, so computing this in JS
  // on a Sydney machine reads a day out either side of midnight.
  const trueAge = Number((await pool.query(
    `SELECT ((NOW() AT TIME ZONE 'Australia/Sydney')::date - $1::date) a`, [latest])).rows[0].a);
  check(meta.forecastAgeDays === trueAge,
    `and it matches Postgres in Sydney time (${trueAge} days), not the driver's shifted one`,
    `served ${meta.forecastAgeDays}`);
  check(meta.forecastStaleDays === 35,
    'the threshold is published so the screen and the order maths cannot drift apart');
  check(typeof meta.lastForecastImport?.import_date_syd === 'string',
    'the date is sent as text, so it cannot disagree with the age beside it',
    JSON.stringify(meta.lastForecastImport?.import_date_syd));

  console.log('\n2. A code in the newest file counts');
  check(inP?.hasForecast === true, 'the probe in the latest import has a forecast',
    `hasForecast=${inP?.hasForecast}`);
  check(inP?.b2bDaily > 0, 'and it drives a demand figure', `b2bDaily=${inP?.b2bDaily}`);

  console.log('\n3. A code the newest file dropped does NOT — this is the FRAG_0060 fix');
  // The whole point. Same product, same 120 L, sitting in the previous file
  // instead of this one. Under the old rule it kept its figure for ever.
  check(outP?.hasForecast === false, 'the probe left out of the latest import has no forecast',
    `hasForecast=${outP?.hasForecast}`);
  check(!(outP?.b2bDaily > 0), 'and drives no demand at all', `b2bDaily=${outP?.b2bDaily}`);
  check(inP?.b2bDaily > 0 && !(outP?.b2bDaily > 0),
    'the two probes are identical apart from which file they are in — only that separates them');

  console.log('\n4. The drop is counted where somebody will see it');
  check(typeof meta.forecastDropped === 'number' && meta.forecastDropped >= 1,
    'the dashboard reports how many oils the latest file dropped',
    `forecastDropped=${meta.forecastDropped}`);
  const named = (meta.forecastDroppedTop || []).map((t) => t.code);
  check(Array.isArray(meta.forecastDroppedTop),
    'and names the biggest of them rather than only counting', named.join(', '));

  console.log('\n5. A code no file ever mentioned is not reported as a loss');
  // The half that stops the count becoming noise: never having had a forecast
  // is not the same as having lost one, and 103 products are in that position.
  check(nilP?.hasForecast === false, 'the never-forecast probe has no forecast');
  check(!named.includes(NEVER), 'and is not listed among what was dropped');

  console.log('\n6. The old per-product staleness cannot happen any more');
  // Under snapshot semantics every forecast comes from the same file, so no
  // product can sit on its own private old figure. If this ever fails, the
  // endpoint has gone back to reading the newest row per code.
  const withFc = body.products.filter((p) => p.hasForecast);
  const ages = new Set(withFc.map((p) => p.forecastAgeDays));
  check(ages.size <= 1, `all ${withFc.length} forecasts share one age — they come from one file`,
    `distinct ages: ${[...ages].join(', ')}`);

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
