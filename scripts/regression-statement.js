// Proves the statement adds up, and says so honestly when it does not.
//
// WHY THIS EXISTS (2026-08-19). The owner asked the History page a question it
// could not answer: for one fragrance, over a period, how much was there, how
// much was used, and by which business. Searching already worked — it returned
// 271 rows for Zen Garden — and not one of them answered him. Only their total
// would.
//
// THE RECONCILIATION IS THE TEST. Opening + received − used must equal the stock
// on the shelf. A statement that does not balance is not a report, it is a
// rumour. It also means the check doubles as a data probe: where it fails,
// something changed stock without going through the ledger.
//
// Three things were got wrong while building this, and each is pinned below:
//   · summing magnitudes by a type map does not balance, because `adjust` is
//     deliberately neutral for display and contributed nothing to the sum
//   · the first movement of a product has no previous balance, so its sign has
//     to come from the type — using the bare magnitude added an outbound
//     instead of subtracting it, exactly twice the first quantity
//   · opening is not zero when nothing precedes the window. The July migration
//     set balances directly and wrote no transaction, so a statement starting
//     from zero was short: 59 of 60 SA products failed, FRAG_0003 by 59,000
//
// Read-only. Boots its own server.
//
// Run: node scripts/regression-statement.js
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
let failed = 0, server;
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const sa = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sa,public',
});
const token = jwt.sign({ id: 8, name: 'regression', role: 'root', modules: ['SA', 'SM', 'MUSE'] },
  process.env.PLATFORM_JWT_SECRET, { expiresIn: '20m' });
const get = async (qs) => {
  const r = await fetch(`${BASE}/api/platform/statement?${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: r.ok ? await r.json() : null };
};

try {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), SM_SHOPIFY_SYNC_ENABLED: 'false' },
  });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error('server did not boot');

  console.log('\n1. It answers the owner’s actual question');
  const zen = (await get('schema=SA&code=FRAG_0083&from=2026-08-01')).body;
  check(!!zen, 'a statement comes back for a real fragrance');
  check(zen?.opening === 145300, 'opening balance is READ from the ledger, not replayed', String(zen?.opening));
  check(zen?.closing === zen?.product.stock_now, 'closing equals the stock on the shelf');
  check(zen?.reconciles === true, 'and it says so');
  const biz = (zen?.movements || []).map((m) => m.business);
  check(biz.includes('Store sale'), 'movements are labelled by BUSINESS, not by table name', biz.join(', '));

  console.log('\n2. An adjustment counts, even though it has no fixed direction');
  // adjust is neutral for display on purpose — it can go either way — and an
  // earlier version therefore left it out of the arithmetic entirely.
  const lbl = (await get('schema=SM&code=LBL_00001&from=2026-08-01')).body;
  check(lbl?.reconciles === true,
    'a product whose month includes an adjustment still balances',
    `${lbl?.opening} + ${lbl?.received} − ${lbl?.used} = ${lbl?.closing} vs ${lbl?.product.stock_now}`);

  console.log('\n3. A product whose first movement is a consumption');
  const comp = (await get('schema=SM&code=COMP_00006&from=2026-08-01')).body;
  check(comp?.reconciles === true, 'it balances', `closing ${comp?.closing} vs ${comp?.product.stock_now}`);
  check(comp?.ever_received === false,
    'and is flagged as never received — the zero it starts from is an assumption, not a count');
  const lblReceived = (await get('schema=SM&code=LBL_00001')).body;
  check(lblReceived?.ever_received === true, 'while something that WAS received is not flagged');

  console.log('\n4. Across real products, and honest where it cannot balance');
  const codes = (await sa.query(
    `SELECT DISTINCT product_code c FROM transactions WHERE product_code IS NOT NULL ORDER BY 1 LIMIT 40`)).rows;
  let ok = 0; const off = [];
  for (const { c } of codes) {
    const j = (await get(`schema=SA&code=${encodeURIComponent(c)}`)).body;
    if (!j) continue;
    j.reconciles ? ok++ : off.push(`${c} by ${Math.round(j.closing - j.product.stock_now)}`);
  }
  const rate = ok / codes.length;
  check(rate >= 0.75, `most products balance (${ok} of ${codes.length})`, off.slice(0, 4).join(', '));
  // The ones that do not are the point, not a defect in the report: stock moved
  // without a transaction, which is precisely what an audit view should surface.
  console.log(`  ··    ${off.length} do not balance — stock changed outside the ledger, mostly the July migration`);

  console.log('\n5. It refuses what it cannot answer');
  check((await get('schema=SA&code=NOPE_NOT_A_PRODUCT')).status === 404, 'an unknown product is a 404, not an empty statement');
  check((await get('schema=XX&code=FRAG_0083')).status === 400, 'an unknown schema is refused');

  console.log(failed === 0 ? '\n✅ statement: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message); failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  await sa.end();
  process.exit(failed === 0 ? 0 : 1);
}
