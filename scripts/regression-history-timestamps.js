// Proves the audit report tells the truth about WHEN something happened.
//
// WHY THIS EXISTS (2026-09-15). The owner called History & Activity "cheio de
// bugs" after exporting it. Three defects, and two of them are the same root:
//
//   1. Every timestamp read ten hours early, on the screen AND in the CSV. A
//      MUSE fulfilment made at 10:17 in the morning showed as "12:17 am" — and
//      because it crosses midnight, on the wrong DAY.
//   2. The date filters put every row on the previous day. Asking for
//      11 September returned 0 rows; the real answer was 139. The warehouse
//      works 08:00–18:00 Sydney, which is 22:00–08:00 UTC, so nothing survived.
//   3. The CSV opened in Excel with "â€"" wherever a note had an em-dash.
//
// The root of 1 and 2: `created_at` is `timestamp WITHOUT time zone` holding
// UTC, and server/index.js sets process.env.TZ='Australia/Sydney'. The pg
// driver therefore parsed each value as Sydney local, and the SQL filters used
// `AT TIME ZONE 'Australia/Sydney'`, which INTERPRETS a naive timestamp as
// Sydney instead of converting a UTC one to it. Both directions of the same
// misunderstanding.
//
// This is a repeat offence. The same trap produced a wrong time quoted to the
// owner on 2026-08-24, and it is written down in the project memory. Knowing
// about a trap is not the same as being protected from it, which is what this
// file is for.
//
// READ-ONLY. Asserts against live rows; writes nothing.
//
// Run: node scripts/regression-history-timestamps.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3983;
const BASE = `http://127.0.0.1:${PORT}`;

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
  // A real row, and the truth about it computed in Postgres where the timezone
  // is known. Everything below is measured against this, not against a guess.
  const truth = (await pool.query(`
    SELECT t.id::text AS id, t.product_code,
           t.created_at::text AS utc_naive,
           to_char(t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney',
                   'YYYY-MM-DD HH24:MI') AS syd,
           (t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date::text AS syd_date
    FROM transactions t
    WHERE (t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::time < TIME '10:00'
      AND t.created_at > NOW() - INTERVAL '30 days'
    ORDER BY t.created_at DESC LIMIT 1`)).rows[0];
  if (!truth) throw new Error('no morning movement in the last 30 days to test against');
  // A morning row on purpose: those are the ones the bug moved to the previous
  // day. A 3pm row would pass even with the fault in place.
  console.log(`\n(probe: ${truth.product_code}, stored ${truth.utc_naive.slice(0, 16)} UTC `
    + `= ${truth.syd} Sydney)`);

  const sameDay = Number((await pool.query(`
    SELECT count(*)::int c FROM transactions
    WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date = $1::date`,
    [truth.syd_date])).rows[0].c);

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
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const get = async (path) => fetch(BASE + path, { ...auth, signal: AbortSignal.timeout(120000) });

  console.log('\n1. The API hands out an instant, not a local-looking string');
  const body = await (await get('/api/platform/history?limit=2000')).json();
  const rows = body.rows || body;
  const row = rows.find((r) => String(r.id) === truth.id);
  check(!!row, 'the probe row came back', `${rows.length} rows, looking for id ${truth.id}`);
  check(typeof row?.created_at === 'string' && /Z$/.test(row.created_at),
    'created_at carries an explicit UTC marker, so no reader has to guess',
    `got ${JSON.stringify(row?.created_at)}`);

  console.log('\n2. Rendered in Sydney, it is the time it actually happened');
  // This is the assertion that would have caught the ten-hour shift. It formats
  // the served value exactly as the screen does and compares against Postgres.
  const rendered = new Date(row.created_at).toLocaleString('sv-SE',
    { timeZone: 'Australia/Sydney' }).slice(0, 16).replace('T', ' ');
  check(rendered === truth.syd, `the screen would show ${truth.syd}`, `it would show ${rendered}`);

  console.log('\n3. A single-day filter returns that day, not the one before it');
  // The defect in its purest form: asking for 11 September returned 0 rows
  // against a real 139, because every warehouse hour in Sydney is the previous
  // date in UTC.
  const dayBody = await (await get(
    `/api/platform/history?from=${truth.syd_date}&to=${truth.syd_date}&limit=10000`)).json();
  const dayRows = dayBody.rows || dayBody;
  check(dayRows.length > 0, `filtering ${truth.syd_date} returns rows at all`, `${dayRows.length}`);
  check(dayRows.length === sameDay,
    `it returns exactly the ${sameDay} movements Postgres counts for that Sydney date`,
    `got ${dayRows.length}`);
  check(dayRows.some((r) => String(r.id) === truth.id),
    'including the morning movement — the kind the fault used to hide');
  // Both directions: the filter must not sweep in the neighbouring days either.
  const strayed = dayRows.filter((r) => new Date(r.created_at)
    .toLocaleString('sv-SE', { timeZone: 'Australia/Sydney' }).slice(0, 10) !== truth.syd_date);
  check(strayed.length === 0, 'and nothing from another day leaked in',
    strayed.slice(0, 3).map((r) => r.created_at).join(', '));

  console.log('\n4. The CSV opens as UTF-8 in Excel');
  const res = await get('/api/platform/history/export?limit=200');
  const buf = Buffer.from(await res.arrayBuffer());
  check(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF,
    'it starts with a UTF-8 BOM — without it Excel reads the system code page',
    `first bytes ${buf.slice(0, 3).toString('hex')}`);
  const text = buf.toString('utf8');
  check(!text.includes('â€'), 'and no note comes out mangled',
    text.split('\n').find((l) => l.includes('â€'))?.slice(0, 80) || '');

  console.log('\n5. The CSV agrees with the screen');
  // They are two renderings of one fact. When they disagree, the person
  // reconciling stock has no way to tell which one lied.
  const line = text.split('\r\n').find((l) => l.includes(truth.product_code));
  check(!!line, 'the probe product appears in the export');
  const dayInCsv = line?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const wantDay = truth.syd_date.split('-').reverse().map(Number);
  check(dayInCsv && Number(dayInCsv[1]) === wantDay[0] && Number(dayInCsv[2]) === wantDay[1],
    `the CSV dates it ${truth.syd_date}, same as the screen`, line?.slice(0, 70));

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /histor|report|rror/i.test(l)).slice(-10).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ history-timestamps: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
