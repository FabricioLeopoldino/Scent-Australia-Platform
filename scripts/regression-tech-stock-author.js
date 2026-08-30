// Proves every fragrance movement made by a technician records who made it.
//
// WHY THIS EXISTS (2026-08-25). The scanner flow writes up to six stock
// movements per oil per batch, and one batch can carry hundreds of oils. None
// of those six inserts wrote a user_id, so all 386 technician movements in SA
// history — five months of them — read as "System" on the history screen.
//
// The batch DID leave a named record: one audit_log row per batch, naming the
// person. But it names the BATCH, not the movement, so it cannot answer the
// question the history screen exists to answer — "who moved this oil". A single
// row standing in for 349 movements is not an author, it is a receipt.
//
// This is one route. 22 of the 25 places that write a stock movement in
// server/sa/index.js still record nobody; that is with the owner as a decision,
// not fixed in bulk, because some of those paths have no user at all.
//
// All four scanner actions are exercised, because they are four separate code
// branches and instrumenting one is how a fix like this half-lands:
//
//   transfer      main → tech      two rows: out of main, into tech
//   remove        consumed in service, one row
//   return        tech → main      two rows: out of tech, back to main
//   return-input  found and put back into tech, one row
//
// SA IS A PRODUCTION SYSTEM IN DAILY USE. This creates one disposable oil and
// removes it along with every row it caused — transactions, tech stock and the
// batch records — and then FAILS if a single row is left behind.
//
// Run: node scripts/regression-tech-stock-author.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `ZZTECH_${Date.now()}`;
const USER = 8;                       // FabricioL, root — a real account, so the FK holds

const sa = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: true }, options: '-c search_path=sa,public',
});

let failed = 0, server, productId;
const batchRefs = [];
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const token = () => jwt.sign({ id: USER, name: 'FabricioL', role: 'root', modules: ['SA'] },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '10m' });

const batch = async (action, quantity) => {
  const r = await fetch(`${BASE}/api/sa/tech-stock/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, items: [{ productId: TAG, quantity }], notes: 'regression' }),
    signal: AbortSignal.timeout(30000),
  });
  const body = r.ok ? await r.json() : { error: (await r.text()).slice(0, 160) };
  if (body.batchRef) batchRefs.push(body.batchRef);
  return { ok: r.ok, status: r.status, body };
};

const rows = async () => (await sa.query(
  `SELECT type, quantity::float q, balance_after::float bal, user_id
     FROM transactions WHERE product_code = $1 ORDER BY id`, [TAG])).rows;

try {
  // sa.products.id is VARCHAR, so the id is supplied rather than generated.
  productId = TAG;
  await sa.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock", "minStockLevel")
     VALUES ($1, $1, $1, $2, 'OILS', 'mL', 100, 0)`, [TAG, `${TAG} probe`]);

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    // Tech Stock was retired on 31/08/2026 and its write endpoints refuse unless
    // this is set. The suite turns it ON deliberately: the author fix has to stay
    // proven for the day somebody restores the feature, or it comes back broken.
    // Section 4 asserts the retirement itself, on a server without the flag.
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_SYNC_ENABLED: 'false',
      SA_TECH_STOCK_ENABLED: 'true' },
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

  console.log('\n1. All four scanner actions run, and the stock lands where it should');
  // Asserted as well as performed: if the arithmetic were wrong the author
  // check below would still pass, and would be proving the wrong thing.
  const t = await batch('transfer', 40);
  check(t.ok, 'transfer 40 accepted', `HTTP ${t.status} ${JSON.stringify(t.body.error || '')}`);
  const rm = await batch('remove', 10);
  check(rm.ok, 'remove 10 accepted', `HTTP ${rm.status} ${JSON.stringify(rm.body.error || '')}`);
  const rt = await batch('return', 15);
  check(rt.ok, 'return 15 accepted', `HTTP ${rt.status} ${JSON.stringify(rt.body.error || '')}`);
  const ri = await batch('return-input', 5);
  check(ri.ok, 'return-input 5 accepted', `HTTP ${ri.status} ${JSON.stringify(ri.body.error || '')}`);

  const main = Number((await sa.query(
    `SELECT "currentStock"::float s FROM products WHERE id = $1`, [TAG])).rows[0].s);
  const tech = Number((await sa.query(
    `SELECT quantity::float q FROM tech_stock WHERE product_id = $1`, [TAG])).rows[0]?.q ?? -1);
  check(main === 75, 'main stock 100 → 60 → 75', `got ${main}`);
  check(tech === 20, 'tech stock 0 → 40 → 30 → 15 → 20', `got ${tech}`);

  console.log('\n2. Every movement names the person who made it');
  const tx = await rows();
  check(tx.length === 6, 'six movements were written', `got ${tx.length}`);

  const EXPECTED = [
    ['tech_transfer_out',     40, 60],
    ['tech_transfer_in',      40, 40],
    ['tech_remove',           10, 30],
    ['tech_return_from_tech', 15, 15],
    ['tech_return_to_main',   15, 75],
    ['tech_return_input',      5, 20],
  ];
  for (const [type, qty, bal] of EXPECTED) {
    const r = tx.find((x) => x.type === type);
    check(!!r && r.q === qty && r.bal === bal,
      `${type} recorded ${qty} leaving ${bal}`,
      r ? `qty=${r.q} balance=${r.bal}` : 'row missing');
    check(r?.user_id === USER, `${type} names who did it`,
      r ? `user_id=${r.user_id}` : 'row missing');
  }

  const anonymous = tx.filter((r) => r.user_id == null).length;
  check(anonymous === 0, 'not one movement is anonymous', `${anonymous} of ${tx.length}`);

  console.log('\n3. The batch receipt still exists alongside them');
  // The per-movement author replaces nothing: the batch row is what ties six
  // movements to one scan, and losing it would lose that grouping.
  const receipts = (await sa.query(
    `SELECT user_id, entity_name FROM audit_log
      WHERE action = 'tech_batch' AND entity_id = ANY($1::text[])`, [batchRefs])).rows;
  check(receipts.length === 4, 'one receipt per batch', `got ${receipts.length}`);
  check(receipts.every((r) => r.user_id === USER), 'each naming the same person');

  console.log('');
  console.log('4. With the feature retired, every write refuses');
  // A second server WITHOUT the flag. The retirement is what stops the second
  // ledger being re-created after the 28/08 stock take cleared it, so it earns a
  // test rather than trust in one middleware line.
  const off = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT + 1), NODE_ENV: 'test',
      SM_SHOPIFY_SYNC_ENABLED: 'false', SA_TECH_STOCK_ENABLED: 'false' },
  });
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${PORT + 1}/api/health`)).ok; } catch { /* booting */ }
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) throw new Error('the second server did not boot');
    const call = (path, method = 'POST') => fetch(`http://127.0.0.1:${PORT + 1}/api/sa${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'transfer', items: [{ productId: TAG, quantity: 1 }] }),
      signal: AbortSignal.timeout(20000),
    });
    for (const path of ['/tech-stock/transfer', '/tech-stock/remove', '/tech-stock/return',
      '/tech-stock/return-input', '/tech-stock/batch']) {
      const r = await call(path);
      check(r.status === 410, `${path} refuses`, `HTTP ${r.status}`);
    }
    const cfg = await call(`/tech-stock/${encodeURIComponent(TAG)}/config`, 'PUT');
    check(cfg.status === 410, '/tech-stock/:id/config refuses', `HTTP ${cfg.status}`);
    // Reading stays open on purpose: what they held must remain visible.
    const read = await fetch(`http://127.0.0.1:${PORT + 1}/api/sa/tech-stock`,
      { headers: { Authorization: `Bearer ${token()}` } });
    check(read.ok, 'but reading the history still works', `HTTP ${read.status}`);
  } finally {
    try { off.kill('SIGKILL'); } catch { /* gone */ }
  }

  if (failed) {
    console.log('\n--- server log ---');
    console.log(log.split('\n').filter((l) => /tech-stock|rror/i.test(l)).slice(-12).join('\n'));
  }
  console.log(failed === 0 ? '\n✅ tech-stock-author: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message);
  failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  // SA is production. Everything this created goes, and what is left is counted.
  if (productId) {
    await sa.query('DELETE FROM transactions WHERE product_code = $1', [productId]).catch(() => {});
    await sa.query('DELETE FROM tech_stock WHERE product_id = $1', [productId]).catch(() => {});
    if (batchRefs.length) {
      await sa.query(`DELETE FROM audit_log WHERE action = 'tech_batch' AND entity_id = ANY($1::text[])`,
        [batchRefs]).catch(() => {});
    }
    await sa.query('DELETE FROM products WHERE id = $1', [productId]).catch(() => {});

    const left =
      Number((await sa.query('SELECT count(*) c FROM transactions WHERE product_code = $1', [productId])).rows[0].c) +
      Number((await sa.query('SELECT count(*) c FROM tech_stock WHERE product_id = $1', [productId])).rows[0].c) +
      Number((await sa.query('SELECT count(*) c FROM products WHERE id = $1', [productId])).rows[0].c) +
      Number((await sa.query(
        `SELECT count(*) c FROM audit_log WHERE action = 'tech_batch' AND entity_id = ANY($1::text[])`,
        [batchRefs.length ? batchRefs : ['']])).rows[0].c);
    console.log(left === 0 ? '  ok    SA left exactly as found' : `  FAIL  ${left} row(s) left behind in SA`);
    if (left) failed++;
  }
  await sa.end();
  process.exit(failed === 0 ? 0 : 1);
}
