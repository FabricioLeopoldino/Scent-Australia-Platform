// Proves the forecast import says what it could not do, instead of a row count.
//
// WHY THIS EXISTS (2026-09-11). The importer reported two numbers, inserted and
// skipped, and nothing else. A forecast landing on a code no product carries was
// accepted in silence — the live table was found holding a row literally coded
// "Not Found" worth 102.7 L/120d, three codes belonging to no product at all,
// and six on inactive ones. 191.9 L of B2B demand that no plan could ever reach,
// and nobody had done anything wrong: the screen simply never said.
//
// Found while auditing demand planning, alongside the double count. The owner's
// words: "seria bom quando alguém faz import saber qual erro e por quê".
//
// REPORTS, NEVER BLOCKS. A forecast can legitimately arrive before somebody
// creates the product, so every row is still imported — the defect was silence,
// not the row. Each check below therefore asserts BOTH that the row landed and
// that it was named.
//
// Builds one .xlsx carrying one of each problem, plus a clean row as the
// control, imports it through the real endpoint, and deletes every forecast row
// it created afterwards.
//
// Run: node scripts/regression-forecast-import-report.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const GOOD = `ZZFC_OK_${STAMP}`.slice(0, 20);
const GHOST = `ZZFC_GHOST_${STAMP}`.slice(0, 20);   // no product will exist
const DEAD = `ZZFC_DEAD_${STAMP}`.slice(0, 20);     // product exists, inactive
const ZERO = `ZZFC_ZERO_${STAMP}`.slice(0, 20);     // product exists, forecast is 0
const TEXTY = `ZZFC_TXT_${STAMP}`.slice(0, 20);     // product exists, value typed as text
const XLSX_PATH = join(ROOT, `_regression_forecast_${STAMP}.xlsx`);

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
  // Four disposable products. ZERO and TEXTY exist and are active on purpose:
  // without them their rows would ALSO be unknown codes, and the categories
  // could not be told apart in the assertions below.
  for (const [code, status] of [[GOOD, 'active'], [DEAD, 'inactive'], [ZERO, 'active'], [TEXTY, 'active']]) {
    await pool.query(
      `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", status)
       VALUES ($1,$1,$1,$2,'OILS','mL',0,$3)`, [code, `${code} probe`, status]);
  }

  // The sheet: header on row 2, blank row 1 — the shape the real Salesforce
  // export has, and the reason the importer hunts for its header row.
  const { utils, writeFile } = await import('xlsx');
  const rows = [
    [],
    ['productCode', 'Forecast 120 Days'],
    [GOOD, 12.5],          // clean — the control
    [GHOST, 102.7],        // no product carries this code ("Not Found" case)
    [DEAD, 8.0],           // product exists but is inactive
    [GOOD, 3.0],           // same code twice in one file
    [ZERO, 0],             // exists, but no usable number
    [TEXTY, '1,234.5'],    // typed as TEXT — parseFloat reads this as 1
    ['', 5.0],             // no code at all
  ];
  // book_append_sheet mutates and returns undefined — build, then write.
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), 'Sheet1');
  writeFile(wb, XLSX_PATH);

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

  const form = new FormData();
  const { readFileSync } = await import('node:fs');
  // The MIME type matters: multer's fileFilter refuses anything not on its
  // allowlist, and an untyped Blob arrives as application/octet-stream.
  form.append('file', new Blob([readFileSync(XLSX_PATH)],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'forecast.xlsx');
  form.append('imported_by', 'regression');
  const res = await fetch(`${BASE}/api/sa/forecast/import`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    signal: AbortSignal.timeout(60000),
  });
  const r = await res.json();

  console.log('\n1. The import runs and reports a count, as it always did');
  check(res.ok, 'the endpoint answers 200', `HTTP ${res.status} ${JSON.stringify(r).slice(0, 200)}`);
  check(r.inserted === 6, 'six codes imported (the blank-code row is the only skip)', `inserted=${r.inserted}`);
  check(r.skipped === 1, 'one row skipped', `skipped=${r.skipped}`);

  console.log('\n2. It now also reports WHAT it could not do');
  // Four things count as problems, because each one means a number the plan
  // will use is wrong or invisible: an unknown code, an inactive product, a
  // duplicate, and a value typed as text. The blank row and the legitimate
  // zero are reported separately as "noted" — the real export carries both
  // every single time, and an alarm that is always on is one nobody reads.
  check(r.problemCount === 4, 'four flags that actually need attention', `problemCount=${r.problemCount}`);
  check(r.rowsFlagged === 4, 'across four distinct rows — the number the screen shows', `rowsFlagged=${r.rowsFlagged}`);
  check(r.notedCount === 2, 'the blank row and the zero value are noted, not alarmed', `notedCount=${r.notedCount}`);
  const P = r.problems || {};
  check((P.unknown_product || []).some((x) => x.code === GHOST),
    'a code no product carries is named — the "Not Found" case', JSON.stringify(P.unknown_product));
  check((P.inactive_product || []).some((x) => x.code === DEAD && x.status === 'inactive'),
    'a code on an INACTIVE product is named separately', JSON.stringify(P.inactive_product));
  check((P.duplicate_in_file || []).some((x) => x.code === GOOD),
    'the same code twice in one file is named, with the row it first appeared on',
    JSON.stringify(P.duplicate_in_file));
  check((P.zero_value || []).length === 1, 'a row with no usable number is named', JSON.stringify(P.zero_value));
  check((P.blank_code || []).length === 1, 'a row with no code is named', JSON.stringify(P.blank_code));
  // The silent one: a TEXT cell goes through parseFloat and "1,234.5" lands as
  // 1 — a positive, perfectly ordinary-looking number that no other bucket
  // here would ever question. A thousand-fold understatement, reported.
  check((P.unreadable_value || []).some((x) => x.code === TEXTY && x.readAs === 1),
    'a value typed as text is named, with what it was actually read as',
    JSON.stringify(P.unreadable_value));

  console.log('\n3. The row numbers point at the real spreadsheet rows');
  // The sheet is: row 1 blank, row 2 header, row 3 GOOD, row 4 GHOST, row 5
  // DEAD, row 6 duplicate, row 7 zero, row 8 text-value, row 9 blank code. Without this check the
  // off-by-one found by code review shipped green: an empty first row is not
  // part of the sheet's used range, so counting from the array index alone
  // reports every row one too low, and a person cannot find the row named.
  check(P.unknown_product?.[0]?.row === 4, 'GHOST is reported on row 4', `row=${P.unknown_product?.[0]?.row}`);
  check(P.inactive_product?.[0]?.row === 5, 'the inactive one on row 5', `row=${P.inactive_product?.[0]?.row}`);
  check(P.duplicate_in_file?.[0]?.row === 6, 'the duplicate on row 6', `row=${P.duplicate_in_file?.[0]?.row}`);
  check(P.duplicate_in_file?.[0]?.firstSeenRow === 3, 'pointing back at row 3, where that code first appeared',
    `firstSeenRow=${P.duplicate_in_file?.[0]?.firstSeenRow}`);

  console.log('\n4. It quantifies the demand that landed out of reach');
  // 102.7 (no such product) + 8.0 (inactive) — the number that makes this worth reading.
  check(Math.abs((r.litresUnreachable || 0) - 110.7) < 0.01,
    'the litres on unreachable codes are added up', `${r.litresUnreachable} L`);

  console.log('\n5. Reporting is not rejecting — every row still landed');
  const stored = (await pool.query(
    `SELECT product_code FROM forecasts WHERE imported_by = 'regression'`)).rows.map((x) => x.product_code);
  check(stored.includes(GHOST), 'the unknown code was still imported, not dropped');
  check(stored.includes(DEAD), 'the inactive one too');
  check(stored.filter((c) => c === GOOD).length === 2, 'and both copies of the duplicate', `${stored.filter((c) => c === GOOD).length}`);

  console.log('\n6. The clean control row raises nothing');
  const flaggedCodes = Object.values(P).flat().map((x) => x.code).filter(Boolean);
  check(flaggedCodes.filter((c) => c === GOOD).length === 1,
    'the good code appears only for the duplicate, never for anything else',
    flaggedCodes.join(', '));

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /forecast|import|rror/i.test(l)).slice(-12).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ forecast-import-report: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  try { unlinkSync(XLSX_PATH); } catch { /* never written */ }
  await pool.query(`DELETE FROM forecasts WHERE imported_by = 'regression'`).catch(() => {});
  await pool.query(`DELETE FROM products WHERE "productCode" LIKE 'ZZFC\\_%'`).catch(() => {});
  const left = Number((await pool.query(
    `SELECT count(*) c FROM forecasts WHERE imported_by = 'regression'`)).rows[0].c)
    + Number((await pool.query(
      `SELECT count(*) c FROM products WHERE "productCode" LIKE 'ZZFC\\_%'`)).rows[0].c);
  console.log(left === 0 ? '  ok    left exactly as found' : `  FAIL  ${left} row(s) left behind`);
  if (left) failed++;
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
