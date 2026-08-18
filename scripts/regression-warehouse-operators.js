// Proves a stock return records WHO did it in a way a report can group by.
//
// WHY THIS EXISTS (owner decision, 2026-08-18). Every one of the 893 returns in
// SA history named its people only inside free text — "Product return | Returned
// by: Gustavo" — typed by hand, so five people appeared under nine spellings and
// some rows named two people separated by a slash. Finance asks "who used this";
// it could be read, never filtered.
//
// The login does not answer it either: Gustavo and Wanderson have no account and
// work through somebody else's, so user_id records which ACCOUNT was used and
// for 81 returns that is not the person. Hence a separate operator list, and
// hence an ARRAY — "Fabricio/Joao" means both of them did it together.
//
// Uses a disposable SA product and removes it, along with every row it created.
// SA is a production system in daily use: this must leave it exactly as found.
//
// Run: node scripts/regression-warehouse-operators.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `ZZOP_${Date.now()}`;

const sa = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sa,public',
});

let failed = 0, server, productId;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const token = () => jwt.sign({ id: 8, name: 'FabricioL', role: 'root', modules: ['SA'] },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });
const api = (path, opts = {}) => fetch(`${BASE}/api/sa${path}`, {
  ...opts,
  headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  signal: AbortSignal.timeout(30000),
});

try {
  // sa.products.id is VARCHAR, so the id is supplied rather than generated.
  productId = TAG;
  await sa.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", "minStockLevel")
     VALUES ($1, $1, $1, $2, 'OILS', 'mL', 100, 0)`, [TAG, `${TAG} probe`]);

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

  console.log('\n1. The operator list is served, and is not the account list');
  const listRes = await api('/warehouse-operators');
  check(listRes.ok, 'GET /warehouse-operators answers', `HTTP ${listRes.status}`);
  const ops = listRes.ok ? await listRes.json() : [];
  check(ops.length >= 5, `it returns the operators (${ops.length})`);
  const gustavo = ops.find((o) => o.name === 'Gustavo');
  const joao = ops.find((o) => o.name === 'Joao Gabriel');
  check(!!gustavo && gustavo.user_id === null,
    'Gustavo is nameable although he has no login — the reason this list exists');
  check(!!joao && joao.user_id != null, 'and someone who does have one is linked to it');

  console.log('\n2. A return records both people, and both are filterable');
  const post = await api('/returns', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: TAG, quantity: 5 }],
      operatorIds: [gustavo.id, joao.id],   // two people, as "Fabricio/Joao" always meant
    }),
  });
  check(post.ok, 'POST /returns accepts operatorIds', `HTTP ${post.status} ${post.ok ? '' : (await post.text()).slice(0, 120)}`);

  const tx = (await sa.query(
    `SELECT operator_ids, user_id, notes, quantity::float q FROM transactions
      WHERE product_code = $1 AND type = 'return' ORDER BY created_at DESC LIMIT 1`, [TAG])).rows[0];
  check(!!tx, 'the return was written');
  check(Array.isArray(tx?.operator_ids) && tx.operator_ids.length === 2,
    'both operators are stored as an array', JSON.stringify(tx?.operator_ids));
  check(tx?.user_id === 8, 'and the account that entered it is recorded too', `user_id=${tx?.user_id}`);
  // The note must agree with the array, or the history and the report disagree.
  check(/Gustavo/.test(tx?.notes || '') && /Joao Gabriel/.test(tx?.notes || ''),
    'the note carries the same names, resolved server-side', tx?.notes);

  const byGustavo = Number((await sa.query(
    `SELECT count(*) c FROM transactions t JOIN sa.warehouse_operators o ON o.id = ANY(t.operator_ids)
      WHERE o.name = 'Gustavo' AND t.product_code = $1`, [TAG])).rows[0].c);
  check(byGustavo === 1, 'and "what did Gustavo do" finds it', `found ${byGustavo}`);

  console.log('\n3. An unknown operator is refused, not silently dropped');
  const bad = await api('/returns', {
    method: 'POST',
    body: JSON.stringify({ items: [{ productId: TAG, quantity: 1 }], operatorIds: [999999] }),
  });
  check(!bad.ok, 'a return naming somebody who does not exist fails', `HTTP ${bad.status}`);

  console.log(failed === 0 ? '\n✅ warehouse-operators: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  // SA is production. Everything this created goes, and the count is asserted.
  if (productId) {
    await sa.query('DELETE FROM transactions WHERE product_code = $1', [productId]).catch(() => {});
    await sa.query('DELETE FROM products WHERE id = $1', [productId]).catch(() => {});
    const left = Number((await sa.query(
      'SELECT count(*) c FROM transactions WHERE product_code = $1', [productId])).rows[0].c);
    console.log(left === 0 ? '  ok    SA left exactly as found' : `  FAIL  ${left} row(s) left behind in SA`);
    if (left) failed++;
  }
  await sa.end();
  process.exit(failed === 0 ? 0 : 1);
}
