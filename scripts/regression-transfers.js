// ═══════════════════════════════════════════════════════════════════════
// Phase 4 — Cross-system transfers regression (PRD §12 Phase 4 Verify)
//
//   (a) full transfer: SA −X, SM +X, ledgers/balances/attribution correct
//   (b) partial: reason required, SM credited by received qty, shortfall kept
//   (c) cancel: SA restored exactly (symmetric reversal)
//   (d) concurrency: two parallel sends cannot oversell (FOR UPDATE)
//   (e) SA CHECK constraint accepts the transfer types (FR-XFER-9)
//
// Self-reverting on the SA side; SM credits + link + history stay as dev data.
// Usage: node scripts/regression-transfers.js   (server must be running)
// ═══════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
const { Pool } = pkg;

const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';
const direct = (u) => u.replace('-pooler.', '.');

const saDb = new Pool({ connectionString: direct(process.env.PLATFORM_DATABASE_URL), ssl: { rejectUnauthorized: false }, options: '-c search_path=sa,public' });
const smDb = new Pool({ connectionString: direct(process.env.PLATFORM_DATABASE_URL), ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public' });

const results = [];
let TOKEN = null;

function record(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const near = (a, b, eps = 0.011) => Math.abs(parseFloat(a) - parseFloat(b)) < eps;
const saStock = async (id) => parseFloat((await saDb.query(`SELECT "currentStock" FROM products WHERE id = $1`, [id])).rows[0].currentStock);
const smStock = async (id) => parseFloat((await smDb.query(`SELECT current_stock FROM products WHERE id = $1`, [id])).rows[0].current_stock);

async function main() {
  console.log('══════════ TRANSFERS REGRESSION (Phase 4) ══════════\n');

  // setup user with BOTH modules
  const hash = bcrypt.hashSync('RegressionXf1!', 10);
  const u = await saDb.query(
    `INSERT INTO platform.users (name, password_hash, role, must_change_password)
     VALUES ('__regression_xf', $1, 'root', false)
     ON CONFLICT (name) DO UPDATE SET password_hash = $1, must_change_password = false RETURNING id`,
    [hash]
  );
  const uid = u.rows[0].id;
  await saDb.query(`INSERT INTO platform.user_modules (user_id, module) VALUES ($1,'SA'),($1,'SM') ON CONFLICT DO NOTHING`, [uid]);
  await saDb.query(`INSERT INTO users (id, name, password, role, must_change_password) VALUES ($1,'__regression_xf',$2,'root',false) ON CONFLICT (id) DO NOTHING`, [uid, hash]);
  await smDb.query(`INSERT INTO users (id, name, password_hash, role) VALUES ($1,'__regression_xf',$2,'root') ON CONFLICT (id) DO NOTHING`, [uid, hash]);
  const login = await api('POST', '/api/platform/auth/login', { name: '__regression_xf', password: 'RegressionXf1!' });
  TOKEN = login.json.token;

  const SA_ID = 'OIL_1';
  const smFrag = (await smDb.query(`SELECT id FROM products WHERE product_code = 'FRAG-SANTAL'`)).rows[0];
  if (!smFrag) throw new Error('Run regression-sm.js first (seeds FRAG-SANTAL)');
  const SM_ID = smFrag.id;

  try {
    // (e) CHECK constraint includes the transfer types
    const ck = await saDb.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'transactions_type_check' AND conrelid = 'sa.transactions'::regclass`
    );
    record('FR-XFER-9: CHECK includes transfer types', /transfer_out/.test(ck.rows[0]?.def) && /transfer_cancel_return/.test(ck.rows[0]?.def));

    // link (idempotent)
    await saDb.query(`DELETE FROM platform.product_links WHERE sa_product_id = $1 OR sm_product_id = $2`, [SA_ID, SM_ID]);
    const link = await api('POST', '/api/platform/product-links', { sa_product_id: SA_ID, sm_product_id: SM_ID });
    record('link: create OIL_1 ↔ FRAG-SANTAL', link.status === 201, `id=${link.json?.id}`);
    const linkId = link.json?.id;

    const dupe = await api('POST', '/api/platform/product-links', { sa_product_id: SA_ID, sm_product_id: SM_ID });
    record('link: duplicate rejected 409', dupe.status === 409);

    const suggest = await api('GET', '/api/platform/product-links/suggest?q=');
    record('link: suggest returns pickers', suggest.status === 200 && suggest.json.sa_products.length > 0 && suggest.json.sm_products.length > 0);

    // (a) FULL transfer 500 mL
    const sa0 = await saStock(SA_ID), sm0 = await smStock(SM_ID);
    const send = await api('POST', '/api/platform/transfers', { product_link_id: linkId, quantity_ml: 500, notes: '[xf-regression] full' });
    const tId = send.json?.id;
    record('full: send debits SA −500, in_transit', send.status === 201 && near(await saStock(SA_ID), sa0 - 500) && send.json.status === 'in_transit');

    const saTx = await saDb.query(`SELECT balance_after, user_id FROM transactions WHERE id = $1::int`, [send.json.sa_tx_out_id]);
    record('full: sa tx transfer_out w/ balance + user', near(saTx.rows[0]?.balance_after, sa0 - 500) && saTx.rows[0]?.user_id === uid);

    const recv = await api('POST', `/api/platform/transfers/${tId}/receive`, {});
    record('full: receive credits SM +500, received', recv.status === 200 && near(await smStock(SM_ID), sm0 + 500) && recv.json.status === 'received');

    const smTx = await smDb.query(`SELECT balance_after, user_id FROM transactions WHERE id = $1`, [recv.json.sm_tx_in_id]);
    record('full: sm tx transfer_in w/ balance + user', near(smTx.rows[0]?.balance_after, sm0 + 500) && smTx.rows[0]?.user_id === uid);

    record('full: ledger balances (SA loss == SM gain)', near(sa0 - (await saStock(SA_ID)), (await smStock(SM_ID)) - sm0));

    // (b) PARTIAL 300 sent → 250 received
    const sm1 = await smStock(SM_ID);
    const send2 = await api('POST', '/api/platform/transfers', { product_link_id: linkId, quantity_ml: 300, notes: '[xf-regression] partial' });
    const t2 = send2.json?.id;
    const noReason = await api('POST', `/api/platform/transfers/${t2}/receive`, { received_qty_ml: 250 });
    record('partial: shortfall without reason → 400', noReason.status === 400);
    const withReason = await api('POST', `/api/platform/transfers/${t2}/receive`, { received_qty_ml: 250, discrepancy_reason: 'bottle leaked in transit' });
    record('partial: receive 250/300 w/ reason', withReason.status === 200 && near(await smStock(SM_ID), sm1 + 250) && near(withReason.json.received_qty_ml, 250));

    // (c) CANCEL — symmetric restore
    const sa2 = await saStock(SA_ID);
    const send3 = await api('POST', '/api/platform/transfers', { product_link_id: linkId, quantity_ml: 200, notes: '[xf-regression] cancel' });
    const cancel = await api('POST', `/api/platform/transfers/${send3.json.id}/cancel`, { reason: 'not needed anymore' });
    record('cancel: SA restored exactly', cancel.status === 200 && near(await saStock(SA_ID), sa2) && cancel.json.status === 'cancelled');
    const revTx = await saDb.query(`SELECT COUNT(*) FROM transactions WHERE type = 'transfer_cancel_return' AND notes LIKE '%#${send3.json.id}%'`);
    record('cancel: transfer_cancel_return tx written', parseInt(revTx.rows[0].count) === 1);

    const dupCancel = await api('POST', `/api/platform/transfers/${send3.json.id}/cancel`, {});
    record('cancel: repeat cancel rejected (already cancelled)', dupCancel.status === 400);

    // (d) CONCURRENCY — two parallel sends that together exceed stock
    const avail = await saStock(SA_ID);
    const chunk = Math.floor(avail * 0.6);
    const [r1, r2] = await Promise.all([
      api('POST', '/api/platform/transfers', { product_link_id: linkId, quantity_ml: chunk, notes: '[xf-regression] race-1' }),
      api('POST', '/api/platform/transfers', { product_link_id: linkId, quantity_ml: chunk, notes: '[xf-regression] race-2' }),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 201);
    const fails = [r1, r2].filter((r) => r.status === 400);
    const saAfterRace = await saStock(SA_ID);
    record('concurrency: exactly one send wins, no oversell', oks.length === 1 && fails.length === 1 && near(saAfterRace, avail - chunk) && saAfterRace >= 0,
      `avail=${avail} chunk=${chunk} → ${saAfterRace}`);
    // cancel the winner to restore
    if (oks[0]) await api('POST', `/api/platform/transfers/${oks[0].json.id}/cancel`, { reason: 'race test cleanup' });

    // in-transit guard: no orphan in_transit rows for our tests
    const orphans = await saDb.query(`SELECT COUNT(*) FROM platform.stock_transfers WHERE status = 'in_transit' AND notes LIKE '[xf-regression]%'`);
    record('no orphan in_transit rows', orphans.rows[0].count === '0');

    // revert SA stock consumed by full(500) + partial(300) so the copy stays tidy
    await api('POST', '/api/sa/stock/add', { productId: SA_ID, quantity: 800, notes: '[xf-regression] revert' });
    record('cleanup: SA stock reverted', near(await saStock(SA_ID), sa0));
  } finally {
    // sa.transactions.user_id FK is RESTRICT — nullify test refs before delete
    await saDb.query(`UPDATE transactions SET user_id = NULL WHERE user_id = (SELECT id FROM users WHERE name = '__regression_xf')`);
    await smDb.query(`UPDATE transactions SET user_id = NULL WHERE user_id = (SELECT id FROM users WHERE name = '__regression_xf')`);
    await saDb.query(`DELETE FROM users WHERE name = '__regression_xf'`);
    await smDb.query(`DELETE FROM users WHERE name = '__regression_xf'`);
    await saDb.query(`DELETE FROM platform.users WHERE name = '__regression_xf'`);
    await saDb.end();
    await smDb.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n══════════ RESULT: ${failed.length === 0 ? '✅ ALL PASS' : `❌ ${failed.length} FAILED`} (${results.length} checks) ══════════`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Regression error:', e);
  process.exit(1);
});
