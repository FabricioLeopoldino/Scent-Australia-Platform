// Proves that oil consumed for another business shows up under that business.
//
// WHY THIS EXISTS (2026-09-08). The owner filtered History & Activity by MUSE
// and found no fragrance at all. It was not a data fault — the report tagged
// each row by the SCHEMA it sat in, and every oil movement sits in `sa`, so all
// 5,825 of them read "SA". Filtering MUSE showed the finished product leaving
// and never the oil that made it: the half that costs money.
//
// The owner's rule, and the one encoded here: show a movement wherever the
// stock actually moved. `muse_production` takes oil off SA's shelf BECAUSE of a
// MUSE sale, so it must appear under both, and disappearing from SA would be a
// second blindness replacing the first.
//
// NO FIXTURE. The rows it asserts on are real movements that already exist, so
// it creates no test data and has nothing to tear down.
//
// It is NOT "writes nothing", and saying so would be exactly the unchecked
// claim this repo keeps getting caught by. Booting server/index.js runs the
// startup migrations and mirrors platform users into sm — as every suite here
// does. Those are idempotent and are the server's ordinary boot, but they are
// writes, against whatever database `.env` points at.
//
// It FAILS if the change is reverted: check 2 needs the composite label, and
// check 5 needs sa to be queried at all when MUSE is asked for.
//
// Run: node scripts/regression-history-cross-system.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { systemMatches, alsoVisibleIn } from '../server/platform/movement-direction.js';
import { SYSTEM_NAMES } from '../shared/business-names.js';
const { Pool } = pkg;

// Read straight from sa to know the TRUE count, independent of the report. The
// report's own answer cannot prove it is complete.
const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3989;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0, server;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const token = jwt.sign({ id: 8, name: 'FabricioL', role: 'root', modules: ['SA', 'SM'] },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
const history = async (params) => {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}/api/platform/history?${qs}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ?${qs}`);
  return r.json();
};

try {
  console.log('\n1. The rule itself, before any HTTP');
  check(alsoVisibleIn('muse_production') === 'MUSE', 'muse_production is also a MUSE movement');
  // Reads the constant rather than its own copy of the string. The rename of
  // 2026-09-15 (Scented Merchandise → The Atelier) broke this line precisely
  // because it held a copy — which is the reason the names now live in one file.
  check(alsoVisibleIn('sm_std_production') === SYSTEM_NAMES.SM,
    `${SYSTEM_NAMES.SM} production too`, alsoVisibleIn('sm_std_production'));
  check(alsoVisibleIn('shopify_sale') === null, 'an ordinary store sale belongs to one side only');
  check(systemMatches('SA · MUSE', 'MUSE'), 'a composite label satisfies MUSE');
  check(systemMatches('SA · MUSE', 'SA'), 'and still satisfies SA');
  check(!systemMatches('SA', 'MUSE'), 'a plain SA row does NOT satisfy MUSE');

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  // 3 minutes: this server runs its startup migrations before answering, and
  // 60s was not enough on a cold Neon connection (8 Sep).
  for (let i = 0; i < 360 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1200)}`);

  // A row is identified by system+id, never by id alone: sa.transactions.id and
  // sm.transactions.id are independent sequences that DO overlap (89 shared
  // values on 8 Sep). The screen already keys its rows this way.
  const keyOf = (r) => `${r.system}#${r.id}`;

  console.log('\n2. Filtering MUSE now returns fragrance movements');
  const muse = await history({ system: 'MUSE', limit: 2000 });
  const museOil = muse.filter((r) => r.type === 'muse_production');
  check(museOil.length > 0, 'oil consumed for MUSE appears under MUSE',
    `${museOil.length} of ${muse.length} rows`);
  // `.every()` on an empty list is true, which would let a broken filter look
  // healthy on these lines. Each one below asserts the list is non-empty first,
  // so a reverted fix reads as failures rather than as quiet passes.
  check(museOil.length > 0 && museOil.every((r) => systemMatches(r.system, 'MUSE')),
    'every one carries a label that includes MUSE',
    [...new Set(museOil.map((r) => r.system))].join(' | ') || 'no rows to label');
  check(museOil.length > 0 && museOil.every((r) => r.category === 'OILS'), 'and they are oil rows');

  console.log('\n3. It did NOT disappear from SA — the oil really left SA\'s shelf');
  const sa = await history({ system: 'SA', limit: 5000 });
  const saOilIds = new Set(sa.filter((r) => r.type === 'muse_production').map(keyOf));
  check(museOil.length > 0 && museOil.every((r) => saOilIds.has(keyOf(r))),
    'the same movements are still listed under SA',
    `${saOilIds.size} under SA vs ${museOil.length} under MUSE`);

  console.log('\n4. An ordinary SA movement is still NOT dragged into MUSE');
  // Asserting on the TYPE alone would be wrong, and this check caught me doing
  // it: `shopify_sale` is not an SA-only type. Selling a finished MUSE product
  // writes one in sm too, and 151 of those legitimately belong under MUSE.
  //
  // What must not happen is an SA-ONLY movement appearing under MUSE. So take
  // the rows SA returned that are labelled plain 'SA', and prove none of them
  // is in the MUSE result — by key, since ids repeat across the two schemas.
  // Not vacuous: relabelling every sa row composite would put them all here.
  const saOnlyKeys = new Set(sa.filter((r) => r.system === 'SA').map(keyOf));
  const museKeys = new Set(muse.map(keyOf));
  const leaked = [...saOnlyKeys].filter((k) => museKeys.has(k));
  check(saOnlyKeys.size > 0, 'there are SA-only movements to test with', `${saOnlyKeys.size}`);
  check(leaked.length === 0, 'not one SA-only movement appears under MUSE',
    `${leaked.length} leaked: ${leaked.slice(0, 3).join(', ')}`);
  check(muse.every((r) => r.system !== 'SA'), 'and nothing under MUSE is labelled SA alone');

  console.log('\n5. NONE of them is lost to the row limit');
  // The bug this guards against is silent and gets worse with time: sa is
  // ordered by date and capped at the limit, so filtering in JS afterwards
  // drops the OLDEST cross-system rows first. On 8 Sep they already spanned
  // positions 19..2601 of sa against a 2000-row screen. Counting from sa
  // directly is the only way to notice — the report agreeing with itself proves
  // nothing.
  const trueCount = Number((await pool.query(
    `SELECT count(*)::int n FROM transactions WHERE type = 'muse_production'`)).rows[0].n);
  check(museOil.length === trueCount,
    'the MUSE filter returns every muse_production row that exists',
    `report ${museOil.length} vs sa ${trueCount}`);

  console.log('\n6. Searching by the order number printed on the row');
  const withOrder = museOil.find((r) => /#(\d+)/.test(r.notes || ''));
  if (!withOrder) {
    check(false, 'a muse_production row carrying an order number exists to search for');
  } else {
    const num = withOrder.notes.match(/#(\d+)/)[1];
    const found = await history({ search: num, limit: 2000 });
    check(found.some((r) => keyOf(r) === keyOf(withOrder)),
      `searching "${num}" finds the movement whose note names it`,
      `${found.length} rows came back`);
  }

  console.log('\n7. ALL still shows everything, and nothing is double-counted');
  const all = await history({ limit: 8000 });
  const ids = all.map(keyOf);
  check(new Set(ids).size === ids.length, 'no row is returned twice', `${ids.length} rows`);
  const allKeys = new Set(ids);
  check(museOil.length > 0 && museOil.every((r) => allKeys.has(keyOf(r))),
    'the MUSE oil rows are in ALL too');

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /report|history|rror/i.test(l)).slice(-14).join('\n'));
  }
  console.log(failed === 0
    ? '\n✅ history-cross-system: all checks passed'
    : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  console.log('  ok    no fixture created, so nothing to clean up');
  await pool.end().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}
