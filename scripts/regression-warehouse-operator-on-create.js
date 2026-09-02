// Proves the "Warehouse operator" checkbox on user creation, end to end.
//
// WHY THIS EXISTS (2026-09-02). Adding a new hire to the Returns picker had no
// self-service path — only a direct database insert, which is exactly what a
// new employee's first day ran into today. The fix moves the step onto the
// form that already creates their login, rather than a second screen.
//
// Two cases matter:
//   a brand-new name         → a fresh row, linked to the new login
//   a name that already      → LINKED, not duplicated. Gustavo and Wanderson
//     exists with no login       are in the operator list today with no
//                                account; the day either gets one, ticking
//                                this same box must attach to their existing
//                                record, not create a second "Gustavo".
//
// Creates one disposable platform user (which mirrors into sa/sm) and one
// pre-existing no-login operator sharing a name with a second disposable user,
// to prove the link case without touching the real Gustavo/Wanderson rows.
// Removes everything afterwards and fails if anything is left over.
//
// Run: node scripts/regression-warehouse-operator-on-create.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3988;
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const FRESH_NAME = `ZZOP_${STAMP}`;
const LINK_NAME = `ZZOP_LINK_${STAMP}`;

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true },
});

let failed = 0, server, freshUserId, linkUserId, preexistingOpId;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const rootToken = () => jwt.sign({ id: 8, name: 'FabricioL', role: 'root', modules: ['SA', 'SM'] },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
const createUser = (body) => fetch(`${BASE}/api/platform/users`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${rootToken()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(20000),
});

try {
  // The case a real name collision looks like: Gustavo already has a no-login
  // row today. Simulated here under a disposable name so the real one is
  // never touched.
  const pre = await pool.query(
    `INSERT INTO sa.warehouse_operators (name, user_id, active) VALUES ($1, NULL, true) RETURNING id`,
    [LINK_NAME]);
  preexistingOpId = pre.rows[0].id;

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1200)}`);

  console.log('\n1. Ticking the box on a brand-new name creates a fresh operator');
  const r1 = await createUser({ name: FRESH_NAME, role: 'user', modules: ['SA'], is_warehouse_operator: true });
  check(r1.ok, 'user created', `HTTP ${r1.status}`);
  freshUserId = (await r1.json()).user.id;

  const op1 = (await pool.query(
    `SELECT id, user_id, active FROM sa.warehouse_operators WHERE name = $1`, [FRESH_NAME])).rows[0];
  check(!!op1, 'a matching operator row exists');
  check(op1?.user_id === freshUserId, 'linked to the new login', `${op1?.user_id} vs ${freshUserId}`);
  check(op1?.active === true, 'and active');

  console.log('\n2. Ticking the box on an EXISTING no-login name links it, not duplicates it');
  const r2 = await createUser({ name: LINK_NAME, role: 'user', modules: ['SA'], is_warehouse_operator: true });
  check(r2.ok, 'user created', `HTTP ${r2.status}`);
  linkUserId = (await r2.json()).user.id;

  const rows = (await pool.query(
    `SELECT id, user_id, active FROM sa.warehouse_operators WHERE name = $1`, [LINK_NAME])).rows;
  check(rows.length === 1, 'still exactly one row for this name — no duplicate "Gustavo"',
    `found ${rows.length}`);
  check(rows[0]?.id === preexistingOpId, 'it is the SAME row that existed before, not a new one',
    `${rows[0]?.id} vs ${preexistingOpId}`);
  check(rows[0]?.user_id === linkUserId, 'now carrying the new login', `${rows[0]?.user_id}`);

  console.log('\n3. Not ticking the box creates no operator at all');
  const r3 = await createUser({ name: `${FRESH_NAME}_NO`, role: 'user', modules: ['SA'] });
  check(r3.ok, 'user created without the flag', `HTTP ${r3.status}`);
  const noOp = (await pool.query(
    `SELECT count(*) c FROM sa.warehouse_operators WHERE name = $1`, [`${FRESH_NAME}_NO`])).rows[0];
  check(Number(noOp.c) === 0, 'and no row was created for them', noOp.c);

  console.log('\n4. The picker a real return would use shows the new operator');
  const list = await (await fetch(`${BASE}/api/sa/warehouse-operators`,
    { headers: { Authorization: `Bearer ${rootToken()}` } })).json();
  check(list.some((o) => o.name === FRESH_NAME && o.user_id === freshUserId),
    'the fresh operator is there', JSON.stringify(list.find((o) => o.name === FRESH_NAME)));

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /users\/create|warehouse|rror/i.test(l)).slice(-14).join('\n'));
  }
  console.log(failed === 0 ? '\n✅ warehouse-operator-on-create: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  await pool.query(`DELETE FROM sa.warehouse_operators WHERE name LIKE 'ZZOP_%'`).catch(() => {});
  for (const id of [freshUserId, linkUserId]) {
    if (!id) continue;
    await pool.query('DELETE FROM sm.users WHERE id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM sa.users WHERE id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM platform.user_modules WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM platform.users WHERE id = $1', [id]).catch(() => {});
  }
  const noFlagUser = (await pool.query(
    `SELECT id FROM platform.users WHERE name = $1`, [`${FRESH_NAME}_NO`])).rows[0];
  if (noFlagUser) {
    await pool.query('DELETE FROM sm.users WHERE id = $1', [noFlagUser.id]).catch(() => {});
    await pool.query('DELETE FROM sa.users WHERE id = $1', [noFlagUser.id]).catch(() => {});
    await pool.query('DELETE FROM platform.user_modules WHERE user_id = $1', [noFlagUser.id]).catch(() => {});
    await pool.query('DELETE FROM platform.users WHERE id = $1', [noFlagUser.id]).catch(() => {});
  }

  const left = Number((await pool.query(
    `SELECT count(*) c FROM sa.warehouse_operators WHERE name LIKE 'ZZOP_%'`)).rows[0].c);
  console.log(left === 0 ? '  ok    left exactly as found' : `  FAIL  ${left} row(s) left behind`);
  if (left) failed++;

  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}
