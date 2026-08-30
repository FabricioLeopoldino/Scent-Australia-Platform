// Proves a manual stock adjustment records WHY, in a form you can add up.
//
// WHY THIS EXISTS (2026-08-31). The 28 August count found 830 litres the system
// did not have, concentrated on the oils the technicians handle. The
// investigation could only establish that by cross-referencing two ledgers after
// the fact, because the question that would have shown it months earlier —
// "how much oil did technicians consume in August" — had no answer. Consumption
// was recorded as free text: "tech oil" typed five times on 27 August, and
// "Manual remove adjustment" whenever nobody typed anything at all.
//
// So the reason is now a value from a fixed list rather than a sentence, and the
// person is chosen from the operator list rather than typed. The note survives
// alongside for the particulars.
//
// The headline check is the last one: after two technician withdrawals, asking
// the database how much technicians used returns the right number. That is the
// whole point of the change, and everything above it is scaffolding.
//
// SA IS A PRODUCTION SYSTEM. One disposable oil, removed along with every row it
// caused, and the suite FAILS if anything is left behind.
//
// Run: node scripts/regression-stock-reason.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3990;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `ZZWHY_${Date.now()}`;
const USER = 8;                    // FabricioL, root

const sa = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let failed = 0, server, productId;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const token = () => jwt.sign({ id: USER, name: 'FabricioL', role: 'root', modules: ['SA'] },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });

const adjust = async (body) => {
  const r = await fetch(`${BASE}/api/sa/stock/adjust`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: TAG, ...body }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  productId = TAG;
  await sa.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", "minStockLevel")
     VALUES ($1, $1, $1, $2, 'OILS', 'mL', 100000, 0)`, [TAG, `${TAG} probe`]);

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

  console.log('\n1. The reason is required, and says what is wrong');
  // Answering a validation failure with "Internal server error" is how a person
  // learns to distrust the screen. Each of these has to come back as advice.
  const noReason = await adjust({ quantity: 1000, type: 'remove' });
  check(noReason.status === 400, 'no reason is refused', `HTTP ${noReason.status}`);
  check(/why/i.test(noReason.body.error || ''), 'and the message says what to do',
    JSON.stringify(noReason.body.error));

  const madeUp = await adjust({ quantity: 1000, type: 'remove', reason: 'because_i_said_so' });
  check(madeUp.status === 400, 'a reason that is not on the list is refused', `HTTP ${madeUp.status}`);

  // A reason list without an escape hatch makes somebody pick a wrong reason to
  // get past the form, so "other" exists - and has to earn itself with a note.
  const bareOther = await adjust({ quantity: 1000, type: 'remove', reason: 'other' });
  check(bareOther.status === 400, '"other" with no note is refused', `HTTP ${bareOther.status}`);
  const other = await adjust({ quantity: 1000, type: 'remove', reason: 'other', note: 'spilled a drum' });
  check(other.status === 200, '"other" with a note is accepted', `HTTP ${other.status}`);

  // A reason from the OTHER list must not pass: stock does not arrive because of spillage.
  const wrongList = await adjust({ quantity: 1000, type: 'add', reason: 'loss' });
  check(wrongList.status === 400, 'a removal reason cannot be used on an addition',
    `HTTP ${wrongList.status}`);

  console.log('\n2. What gets written');
  const ops = await (await fetch(`${BASE}/api/sa/warehouse-operators`,
    { headers: { Authorization: `Bearer ${token()}` } })).json();
  const gustavo = ops.find((o) => o.name === 'Gustavo');
  check(!!gustavo, 'the operator list is there to choose from');

  const good = await adjust({
    quantity: 5000, type: 'remove', reason: 'technician',
    note: 'Hilton lobby', operatorIds: [gustavo.id],
  });
  check(good.status === 200, 'a proper adjustment is accepted', `HTTP ${good.status}`);

  const row = (await sa.query(
    `SELECT type, reason, operator_ids, user_id, notes, quantity::float q, balance_after::float bal
       FROM transactions WHERE product_code = $1 AND reason = 'technician'
      ORDER BY id DESC LIMIT 1`, [TAG])).rows[0];
  check(!!row, 'the movement was written');
  check(row?.reason === 'technician', 'the reason is stored as a value, not a sentence', row?.reason);
  check(Array.isArray(row?.operator_ids) && row.operator_ids[0] === gustavo.id,
    'the operator is stored as an id that can be filtered', JSON.stringify(row?.operator_ids));
  // The screen used to send userId in the body. The session already knows.
  check(row?.user_id === USER, 'the account comes from the session, not the request body',
    `user_id=${row?.user_id}`);
  check(/Technician service/.test(row?.notes || '') && /Hilton lobby/.test(row?.notes || '')
    && /Gustavo/.test(row?.notes || ''),
    'the note reads properly for a person: reason, particulars, who', row?.notes);
  check(row?.bal === 94000, 'and the stock actually moved', `balance=${row?.bal}`);

  const unknown = await adjust({
    quantity: 100, type: 'remove', reason: 'technician', operatorIds: [999999],
  });
  check(unknown.status === 400, 'an operator who does not exist is refused',
    `HTTP ${unknown.status}`);

  console.log('\n3. The question that had no answer');
  // This is the point of the whole change. Before it, the only way to total
  // technician consumption was to read notes and guess at spellings.
  await adjust({ quantity: 3000, type: 'remove', reason: 'technician', operatorIds: [gustavo.id] });
  await adjust({ quantity: 2000, type: 'remove', reason: 'sample' });

  const byReason = (await sa.query(
    `SELECT reason, sum(quantity)::float ml FROM transactions
      WHERE product_code = $1 AND type = 'remove' GROUP BY reason ORDER BY reason`, [TAG])).rows;
  const of = (r) => byReason.find((x) => x.reason === r)?.ml ?? null;
  check(of('technician') === 8000, '"how much did technicians use" answers 8000',
    JSON.stringify(byReason));
  check(of('sample') === 2000, 'and samples are counted apart from it', String(of('sample')));
  check(of('other') === 1000, 'and so is the one nobody had a category for', String(of('other')));

  const byPerson = Number((await sa.query(
    `SELECT COALESCE(sum(t.quantity),0)::float ml FROM transactions t
      JOIN sa.warehouse_operators o ON o.id = ANY(t.operator_ids)
     WHERE t.product_code = $1 AND o.name = 'Gustavo'`, [TAG])).rows[0].ml);
  check(byPerson === 8000, 'and "what did Gustavo take" answers 8000', String(byPerson));

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /adjust|rror/i.test(l)).slice(-12).join('\n'));
  }
  console.log(failed === 0 ? '\n✅ stock-reason: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  if (productId) {
    await sa.query('DELETE FROM transactions WHERE product_code = $1', [productId]).catch(() => {});
    await sa.query('DELETE FROM products WHERE id = $1', [productId]).catch(() => {});
    const left = Number((await sa.query(
      'SELECT count(*) c FROM transactions WHERE product_code = $1', [productId])).rows[0].c)
      + Number((await sa.query(
        'SELECT count(*) c FROM products WHERE id = $1', [productId])).rows[0].c);
    console.log(left === 0 ? '  ok    SA left exactly as found' : `  FAIL  ${left} row(s) left behind in SA`);
    if (left) failed++;
  }
  await sa.end();
  process.exit(failed === 0 ? 0 : 1);
}
