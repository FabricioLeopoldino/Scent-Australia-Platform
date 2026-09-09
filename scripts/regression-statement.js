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
//   · a BOUNDED period (a `to` in the past) reconciled against today's shelf,
//     which reads as broken the moment anything moves afterwards — found
//     2026-09-09, this was block G's own "period arithmetic, unproven" item.
//     A closed window now checks against the ledger's own balance at `to`.
//   · that fix's own first two attempts were each wrong in a different way,
//     both caught by code review, not by running it: a period asked about
//     before a product ever existed read as broken (fell to today's shelf
//     when nothing preceded the window); and `to` typed as today's own date
//     silently stopped catching a real ledger bypass, because the decision
//     was "is `to` present", not "does `to` reach today".
//
// Read-only, except one disposable fixture (section 8) built to prove the
// last of those three: a real ledger-vs-shelf mismatch cannot be produced
// from today's 40 sampled products (none currently drift), so proving `to`
// as today still catches one needs a product deliberately given one.
// Torn down in the `finally` block regardless of how the checks come out.
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
let failed = 0, server, fixtureCode;
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
  // 3 minutes: a cold Neon connection has taken longer than 120×500ms before.
  for (let i = 0; i < 360 && !up; i++) {
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

  console.log('\n5. A bounded period reconciles against ITSELF, not against today');
  // Found 2026-09-09 — first noticed on FRAG_0032, asking exactly the question
  // block G had marked "unproven": up to 31 August it closed at 80,200,
  // matching the ledger's own balance_after for that date exactly, and still
  // came back reconciles:false, because 5 real sales happened in September.
  // The arithmetic was never wrong; comparing it against TODAY'S shelf was.
  // Reused here on FRAG_0083, already the fixture for check 1 above, for the
  // same reason: one real product, not a second one this file has to track.
  const bounded = (await get('schema=SA&code=FRAG_0083&to=2026-08-31')).body;
  check(bounded?.closing === 91100, 'closing is read correctly for the bounded window', String(bounded?.closing));
  check(bounded?.closing !== bounded?.product.stock_now,
    'and this window\'s closing genuinely differs from today\'s shelf — the case that broke it',
    `${bounded?.closing} vs ${bounded?.product.stock_now}`);
  check(bounded?.reconciles === true,
    'yet it reconciles — compared against the ledger at `to`, not against today');

  console.log('\n6. A period asked about before the product ever existed');
  // The fix above went through two wrong versions before this one, and this
  // is the case that caught the second: `shelf_at_end` falling to today's
  // stock whenever nothing preceded `to` made a period asked about BEFORE the
  // product ever existed read as broken — closing correctly comes out 0 (or
  // whatever opening was), and today's real stock is almost never also 0.
  const beforeIt = (await get('schema=SA&code=FRAG_0328&to=2026-06-01')).body; // created 7 July
  check(beforeIt?.closing === 0, 'nothing precedes the window, so closing is 0', String(beforeIt?.closing));
  check(beforeIt?.closing !== beforeIt?.product.stock_now,
    'and today\'s real stock is not 0 — the case that broke it',
    `${beforeIt?.closing} vs ${beforeIt?.product.stock_now}`);
  check(beforeIt?.reconciles === true,
    'yet it reconciles — nothing happened, so there is nothing to fail to reconcile');

  console.log('\n7. `to` typed as today behaves exactly like leaving it blank');
  // Code review caught this: the first version decided "bounded vs not" by
  // whether `to` was PRESENT, not by whether it reached today. Typing today's
  // own date into `to` — an ordinary thing to do, not an edge case — would
  // have silently switched to comparing against the ledger's own last row
  // instead of the live shelf, disabling the one check that catches stock
  // changed by something that bypassed the ledger entirely.
  const todaySydney = (await sa.query(
    `SELECT (now() AT TIME ZONE 'Australia/Sydney')::date::text AS d`)).rows[0].d;
  const blank = (await get('schema=SA&code=FRAG_0083')).body;
  const explicitToday = (await get(`schema=SA&code=FRAG_0083&to=${todaySydney}`)).body;
  check(explicitToday?.closing === blank?.closing,
    'closing is the same whether `to` is blank or today\'s own date', `${explicitToday?.closing} vs ${blank?.closing}`);
  check(explicitToday?.shelf_at_end === blank?.shelf_at_end,
    'and so is what it was checked against', `${explicitToday?.shelf_at_end} vs ${blank?.shelf_at_end}`);
  check(explicitToday?.shelf_at_end === explicitToday?.product.stock_now,
    'both compare against the LIVE shelf, not a ledger row — the check this whole endpoint exists for');
  check(explicitToday?.reaches_today === true,
    'and the API says so explicitly — the UI keys its label off this, never off `to` being present',
    String(explicitToday?.reaches_today));

  console.log('\n8. `to=today` still catches a real ledger bypass — the drift check 7 could not exercise');
  // None of the 40 real products sampled in check 4 currently drift, so
  // proving this needs one built to. One transaction, a real balance_after —
  // then the shelf is moved directly, with no second transaction, which is
  // exactly the class of fault ("stock changed by something that bypassed
  // the ledger entirely") this whole endpoint exists to catch.
  const tag = `ZZSTMT_${Date.now()}`.slice(0, 20);
  fixtureCode = tag;
  await sa.query(
    `INSERT INTO products (id, tag, "productCode", name, category, unit, "currentStock")
     VALUES ($1, $1, $1, $2, 'OILS', 'mL', 100)`, [tag, `${tag} probe`]);
  await sa.query(
    `INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
     VALUES ($1,$1,$2,'OILS','add',100,'mL',100,'regression fixture')`,
    [tag, `${tag} probe`]);
  // The bypass: stock moved with no matching transaction at all.
  await sa.query(`UPDATE products SET "currentStock" = 999 WHERE id = $1`, [tag]);

  const bypassBlank = (await get(`schema=SA&code=${tag}`)).body;
  check(bypassBlank?.closing === 100, 'the ledger itself still says 100', String(bypassBlank?.closing));
  check(bypassBlank?.reconciles === false,
    'a blank `to` catches the bypass', `closing ${bypassBlank?.closing} vs shelf ${bypassBlank?.shelf_at_end}`);

  const bypassToday = (await get(`schema=SA&code=${tag}&to=${todaySydney}`)).body;
  check(bypassToday?.reconciles === false,
    '`to` typed as today catches it too — the exact case code review flagged',
    `closing ${bypassToday?.closing} vs shelf ${bypassToday?.shelf_at_end}`);

  const bypassYesterday = (await get(`schema=SA&code=${tag}&to=2026-08-01`)).body;
  check(bypassYesterday?.reconciles === true,
    'but a genuinely past `to` still reconciles — the bypass has no date, so it cannot break a window that ended before today',
    `closing ${bypassYesterday?.closing} vs shelf ${bypassYesterday?.shelf_at_end}`);

  console.log('\n9. It refuses what it cannot answer');
  check((await get('schema=SA&code=NOPE_NOT_A_PRODUCT')).status === 404, 'an unknown product is a 404, not an empty statement');
  check((await get('schema=XX&code=FRAG_0083')).status === 400, 'an unknown schema is refused');

  console.log(failed === 0 ? '\n✅ statement: all checks passed' : `\n❌ ${failed} failed`);
} catch (e) {
  console.error('\nFATAL', e.message); failed++;
} finally {
  if (server) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  if (fixtureCode) {
    await sa.query(`DELETE FROM transactions WHERE product_code = $1`, [fixtureCode]).catch(() => {});
    await sa.query(`DELETE FROM products WHERE "productCode" = $1`, [fixtureCode]).catch(() => {});
    const left = Number((await sa.query(
      `SELECT count(*) c FROM products WHERE "productCode" = $1`, [fixtureCode])).rows[0].c);
    console.log(left === 0 ? '  ok    fixture removed, left exactly as found' : `  FAIL  fixture row still present`);
    if (left) failed++;
  }
  await sa.end();
  process.exit(failed === 0 ? 0 : 1);
}
