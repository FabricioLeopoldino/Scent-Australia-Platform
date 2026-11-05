// Regression — fragrance stock by company (PRD_STAGE_1_FRAGRANCE_LIBRARY.md).
//
// Walks disposable oils through the ten worked cases of PRD §4 and the rules
// behind them: the six balances (main store, SA, MUSE and its three units)
// with SA = total − what the others hold; receipts split between stocks;
// registration per company; the main store never below zero and fed only by
// purchase orders (D2); the use rule (unit → MUSE shared → SA, never another
// unit); the order number on every MUSE use; cost 0 = no price; Demand
// Planning = SA's own movements on SA's balance, with the main store and MUSE
// beside it as information and the D1 warning; History & Activity.
//
// Runs against a SERVER at REGRESSION_BASE and REFUSES any database but the
// Neon branch sectors-dev (endpoint ep-old-water-): there is no override.
// The server's database is checked too: the test users are written here and
// then log in THROUGH the server, so a server on another database fails the
// login before anything is written.
//   PLATFORM_DATABASE_URL=<sectors-dev> REGRESSION_BASE=http://localhost:3101 node scripts/regression-sectors.js
// Everything it creates — fixture oils and every row they caused (movements,
// ledger, purchase orders, audit, registrations, trigger log) and the test
// users — is removed at the end, and a residue check says so.
import 'dotenv/config';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Pool } = pkg;

const DB_URL = process.env.PLATFORM_DATABASE_URL || '';
if (!DB_URL.includes('ep-old-water-')) {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the sectors-dev branch (ep-old-water-).');
  process.exit(1);
}
const BASE = process.env.REGRESSION_BASE || 'http://localhost:3000';
const db = new Pool({
  connectionString: DB_URL.replace('-pooler.', '.').replace(/[?&]channel_binding=require/, ''),
  ssl: { rejectUnauthorized: true },
  options: '-c search_path=sa,public',
});

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;
const L = 1000; // the oils are in mL

const TOKENS = {};
async function api(who, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKENS[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// sa.users allows user / admin / root only: the technician reads, so it needs
// no SA mirror row.
const USERS = [['__regression_sec', 'root'], ['__regression_sec_user', 'user'], ['__regression_sec_tech', 'technician']];
const UIDS = [];
async function setup() {
  for (const [name, role] of USERS) {
    const hash = bcrypt.hashSync('RegressionSec1!', 10);
    const uid = (await db.query(
      `INSERT INTO platform.users (name, password_hash, role, must_change_password) VALUES ($1,$2,$3,false)
       ON CONFLICT (name) DO UPDATE SET password_hash = $2, role = $3, must_change_password = false RETURNING id`,
      [name, hash, role])).rows[0].id;
    UIDS.push(uid);
    await db.query(`INSERT INTO platform.user_modules (user_id, module) VALUES ($1,'SA') ON CONFLICT DO NOTHING`, [uid]);
    if (role !== 'technician') {
      await db.query(`INSERT INTO users (id, name, password, role, must_change_password) VALUES ($1,$2,$3,$4,false) ON CONFLICT (id) DO NOTHING`,
        [uid, name, hash, role]);
    }
    if (role === 'root') {
      // The production-route test starts an order through /api/sm: SM access and its user mirror.
      await db.query(`INSERT INTO platform.user_modules (user_id, module) VALUES ($1,'SM') ON CONFLICT DO NOTHING`, [uid]);
      await db.query(`INSERT INTO sm.users (id, name, password_hash, role) VALUES ($1,$2,$3,'root') ON CONFLICT (id) DO NOTHING`, [uid, name, hash]);
    }
    const login = await fetch(`${BASE}/api/platform/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password: 'RegressionSec1!' }),
    });
    TOKENS[role] = (await login.json()).token;
    if (!TOKENS[role]) throw new Error(`login failed for ${name}`);
  }
}

const PIDS = [];
async function cleanup() {
  try {
    // The production-route test's order (its lines and job cascade) and audit, then the MUSE products.
    const mos = (await db.query(`SELECT id FROM sm.production_orders WHERE order_number LIKE 'TESTREG-SEC-%'`)).rows.map((x) => x.id);
    await db.query(`DELETE FROM sm.audit_log WHERE entity_type = 'production_order' AND entity_id = ANY($1::int[])`, [mos]);
    await db.query(`DELETE FROM sm.stock_reservations WHERE production_order_id = ANY($1::int[])`, [mos]);
    await db.query(`DELETE FROM sm.production_orders WHERE id = ANY($1::int[])`, [mos]);
    await db.query(`DELETE FROM sm.products WHERE product_code LIKE 'TESTREG-SEC-%' AND master_product_id IS NOT NULL`);
    await db.query(`DELETE FROM sm.products WHERE product_code LIKE 'TESTREG-SEC-%'`);
    if (PIDS.length) {
      for (const t of ['sector_movements', 'transactions', 'purchase_orders', 'direct_stock_changes']) {
        await db.query(`DELETE FROM ${t} WHERE product_id = ANY($1::text[])`, [PIDS]);
      }
      await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[])`, [PIDS]);
      await db.query(`DELETE FROM products WHERE id = ANY($1::text[])`, [PIDS]); // registrations go with it (ON DELETE CASCADE)
    }
  } finally {
    if (UIDS.length) {
      await db.query(`DELETE FROM audit_log WHERE user_id = ANY($1::int[])`, [UIDS]);
      await db.query(`DELETE FROM sm.audit_log WHERE user_id = ANY($1::int[])`, [UIDS]);
      // platform.audit_log's FK is ON DELETE SET NULL: the login rows would stay behind, unowned.
      await db.query(`DELETE FROM platform.audit_log WHERE user_id = ANY($1::int[])`, [UIDS]);
    }
    for (const [name] of USERS) {
      for (const t of ['users', 'sm.users', 'platform.users']) await db.query(`DELETE FROM ${t} WHERE name = $1`, [name]).catch((e) => console.error(t, e.message));
    }
  }
}

async function createOil(name, extra = {}) {
  const r = await api('root', 'POST', '/api/sa/products', { name: `[regression] Sector Oil ${name}`, category: 'OILS', unit: 'mL', currentStock: 0, ...extra });
  if (!r.json?.id) throw new Error(`fixture oil ${name} not created (${r.status} ${r.json?.error || ''})`);
  PIDS.push(r.json.id);
  return r.json.id;
}
const adjust = (pid, type, litres, reason) =>
  api('root', 'POST', '/api/sa/stock/adjust', { productId: pid, quantity: litres * L, type, reason, note: `[regression] ${reason}` });
const move = (who, pid, body) => api(who, 'POST', '/api/sa/sectors/move', { productId: pid, ...body });
// One stock of an oil (PRD_H2 §2.4): counts and uses are adjustments since H2 (D3).
const adjustIn = (who, pid, body) => api(who, 'POST', '/api/sa/sectors/adjust', { productId: pid, note: '[regression]', ...body });
const refusalsOf = (pid) => db.query(`SELECT details FROM audit_log WHERE action = 'stock_refused' AND entity_id = $1 ORDER BY id`, [pid])
  .then((r) => r.rows.map((x) => (typeof x.details === 'string' ? JSON.parse(x.details) : x.details)));
const register = (pid, company, extra = {}) => api('root', 'POST', '/api/sa/fragrance-registrations', { productId: pid, company, ...extra });
// The row an accepted line stores. No route raises an order any more (H4 D3),
// and accepting needs Shopify, which is blanked here.
async function addPo(pid, orderNumber, litres, cost = null) {
  return (await db.query(
    `INSERT INTO purchase_orders (product_id, order_number, quantity, notes, added_by, cost_per_unit)
     VALUES ($1, $2, $3, '[regression]', 'regression', $4) RETURNING id`, [pid, orderNumber, litres * L, cost])).rows[0].id;
}
const receive = (poId, body) => api('root', 'POST', `/api/sa/purchase-orders/${poId}/receive`, { notes: '[regression]', ...body });

async function oil(pid) {
  return ((await api('root', 'GET', '/api/sa/products?category=OILS')).json || []).find((p) => p.id === pid);
}
async function dpRow(pid) {
  return ((await api('root', 'GET', '/api/sa/dashboard/replenishment')).json?.products || []).find((p) => p.id === pid);
}
async function demandL(pid) {
  const rows = (await api('root', 'GET', `/api/sa/products/${pid}/transactions?days=30`)).json?.dailySales || [];
  return { total: rows.reduce((a, d) => a + d.volume_l, 0), rows };
}
// Every step: the six balances in litres, SA = total − the positive others, saStock = SA.
async function check(step, pid, want) {
  const p = await oil(pid);
  const s = p?.sectors || {};
  const full = { MAIN: 0, SA: 0, MUSE: 0, MUSE_ATELIER: 0, MUSE_LIBRARY: 0, MUSE_ARCHIVE: 0, ...want };
  const wrong = Object.entries(full).filter(([k, v]) => !near(s[k], v * L)).map(([k, v]) => `${k}=${(s[k] ?? NaN) / L} (want ${v})`);
  const total = Object.values(full).reduce((a, v) => a + Math.max(0, v), 0) + Math.min(0, full.SA);
  record(`${step}: balances`, wrong.length === 0, wrong.join(', ') || JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v / L]))));
  const held = Object.entries(s).filter(([k]) => k !== 'SA').reduce((a, [, v]) => a + Math.max(0, v), 0);
  record(`${step}: total = SA + what the others hold, saStock = SA`,
    near(p?.currentStock, total * L) && near(p?.currentStock - held, s.SA) && near(p?.saStock, s.SA),
    `total=${p?.currentStock / L} saStock=${p?.saStock / L}`);
  return p;
}
const movementsOfTx = (txId) => db.query(
  `SELECT from_sector, to_sector, quantity::float AS q, used_for, kind FROM sector_movements WHERE transaction_id = $1 ORDER BY id`, [txId]).then((r) => r.rows);
const lastTx = (pid) => db.query(`SELECT id FROM transactions WHERE product_id = $1 ORDER BY id DESC LIMIT 1`, [pid]).then((r) => r.rows[0]?.id);

async function run() {
  // ── Registration on create (S6): SA by default; registerIn says otherwise.
  const A = await createOil('A');
  const E = await createOil('E', { registerIn: [] });
  let r = await api('root', 'POST', '/api/sa/products', { name: '[regression] Sector Oil bad', category: 'OILS', unit: 'mL', registerIn: ['XX'] });
  record('create: registerIn with an unknown company is refused', r.status === 400, `status=${r.status}`);
  let p = await oil(A);
  record('create: a new oil is registered in SA by default', p?.registrations?.SA?.active === true && !p.registrations.MUSE, JSON.stringify(p?.registrations));
  record('create: registerIn [] registers nowhere', JSON.stringify((await oil(E))?.registrations) === '{}');
  r = await register(A, 'MUSE', { commercialName: 'Regression Santal', usedBy: ['MUSE_ATELIER', 'MUSE_LIBRARY'], binLocation: 'M-1' });
  record('register: MUSE registration created, its fields returned', r.status === 200 && r.json?.created === true
    && r.json?.registrations?.MUSE?.commercialName === 'Regression Santal' && r.json.registrations.MUSE.usedBy.length === 2
    && r.json.registrations.MUSE.binLocation === 'M-1' && r.json.registrations.SA?.active === true, JSON.stringify(r.json));
  r = await register(A, 'SA', { binLocation: 'X' });
  record('register: SA keeps its bin on the oil — a bin on an SA registration is refused', r.status === 400, r.json?.error);
  r = await api('user', 'POST', '/api/sa/fragrance-registrations', { productId: A, company: 'SA' });
  record('register: a user who is not admin/root is refused', r.status === 403, `status=${r.status}`);
  const list = (await api('user', 'GET', '/api/sa/fragrance-registrations?company=MUSE')).json || [];
  record('registrations: everyone with access sees the list, by company', list.some((x) => x.productId === A && x.company === 'MUSE') && list.every((x) => x.company === 'MUSE'));
  await check('day one', A, {});

  // ── Case 1: an accepted PO is on order in Demand Planning, as today.
  const po1 = await addPo(A, 'TESTREG-SEC-PO1', 100, 0.05); // $50 a litre ex GST
  let row = await dpRow(A);
  record('case 1: a pending PO is "on order" in Demand Planning', near(row?.incomingStock, 100, 0.06) && near(row?.realStock, 0, 0.06),
    `incoming=${row?.incomingStock} realStock=${row?.realStock}`);

  // ── Case 3: lines that do not add up are refused, nothing written.
  r = await receive(po1, { quantityReceived: 100 * L, lines: [{ to: 'SA', quantity: 60 * L }, { to: 'MUSE_ATELIER', quantity: 50 * L }] });
  record('case 3: "The lines add up to 110 L; 100 L arrived."', r.status === 400 && r.json?.error === 'The lines add up to 110 L; 100 L arrived.', `${r.status} ${r.json?.error}`);
  r = await receive(po1, { quantityReceived: 1 * L, lines: [{ to: 'NOWHERE', quantity: 1 * L }] });
  record('receive: a line to an unknown stock is refused', r.status === 400, `${r.status} ${r.json?.error}`);
  await check('case 3: nothing moved', A, {});

  // ── Case 2: received split 50 SA / 25 The Atelier / 25 The Library.
  r = await receive(po1, { quantityReceived: 100 * L, lines: [{ to: 'SA', quantity: 50 * L }, { to: 'MUSE_ATELIER', quantity: 25 * L }, { to: 'MUSE_LIBRARY', quantity: 25 * L }] });
  record('case 2: receive and split accepted, balances returned', r.status === 200 && r.json?.status === 'received' && near(r.json?.sectors?.MUSE_ATELIER, 25 * L), `${r.status} ${r.json?.error || ''}`);
  await check('case 2', A, { SA: 50, MUSE_ATELIER: 25, MUSE_LIBRARY: 25 });
  row = await dpRow(A);
  record('case 2: Demand Planning — SA stock 50 L, nothing on order, MUSE 50 L beside it',
    near(row?.realStock, 50, 0.06) && near(row?.incomingStock, 0, 0.06) && near(row?.museTotal, 50, 0.06) && near(row?.mainStore, 0) && row?.mainStoreWarning === null,
    `realStock=${row?.realStock} incoming=${row?.incomingStock} muse=${row?.museTotal} main=${row?.mainStore}`);
  const rcpt = await movementsOfTx(await lastTx(A));
  record('case 2: one ledger row, one SUPPLIER movement per line (the SA line too)',
    rcpt.length === 3 && rcpt.every((m) => m.from_sector === 'SUPPLIER' && m.kind === 'receipt'), JSON.stringify(rcpt));

  // ── Case 8: cost 0 is no price; a receipt without a price is ignored by the average.
  const { costPerMl } = await import('../server/sa/shopify-purchase-orders.js');
  record('case 8: Shopify cost 0 (or none) is "No price on the PO", never $0', costPerMl(0, 1000) === null && costPerMl(null, 1000) === null && near(costPerMl(50, 1000), 0.05, 1e-9));
  const po2 = await addPo(A, 'TESTREG-SEC-PO2', 20, null);
  r = await receive(po2, { quantityReceived: 20 * L }); // no lines: all to SA, as for every caller before
  record('receive with no lines: all of it to SA (old callers)', r.status === 200 && r.json?.lines?.length === 1 && r.json.lines[0].to === 'SA', JSON.stringify(r.json?.lines));
  r = await move('root', A, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE', quantity: 1 * L }] });
  const hist = (await api('root', 'GET', `/api/sa/sectors/${A}/movements`)).json || [];
  const t1 = hist.find((m) => m.kind === 'transfer');
  record('case 8: a transfer is valued at the average of the PRICED receipts (the unpriced one ignored)', near(t1?.costPerUnit, 0.05, 1e-9), `cost=${t1?.costPerUnit}`);
  record('case 8: the unpriced receipt says so (null)', hist.find((m) => m.reference === 'TESTREG-SEC-PO2')?.costPerUnit === null);
  await check('PO2 into SA, 1 L to MUSE (shared)', A, { SA: 69, MUSE: 1, MUSE_ATELIER: 25, MUSE_LIBRARY: 25 });

  // ── Case 10: all of it into the main store — out of on order, not SA's, the D1 warning.
  const po3 = await addPo(A, 'TESTREG-SEC-PO3', 100, 0.05);
  r = await receive(po3, { lines: [{ to: 'MAIN', quantity: 100 * L }] }); // quantity taken from the lines
  record('case 10: received into the main store (no registration needed)', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  await check('case 10', A, { MAIN: 100, SA: 69, MUSE: 1, MUSE_ATELIER: 25, MUSE_LIBRARY: 25 });
  row = await dpRow(A);
  record('case 10: Demand Planning — SA unchanged, nothing on order, main store beside it',
    near(row?.realStock, 69, 0.06) && near(row?.incomingStock, 0, 0.06) && near(row?.mainStore, 100, 0.06) && near(row?.museTotal, 51, 0.06),
    `realStock=${row?.realStock} incoming=${row?.incomingStock} main=${row?.mainStore} muse=${row?.museTotal}`);
  record('D1: "100 L in the main store — split it before ordering."', row?.mainStoreWarning === '100 L in the main store — split it before ordering.', row?.mainStoreWarning);

  // ── D2: the main store never below zero, and nothing goes INTO it but a receipt.
  r = await move('root', A, { kind: 'transfer', lines: [{ from: 'MAIN', to: 'SA', quantity: 120 * L }] });
  record('D2: more out of the main store than it holds is refused', r.status === 400 && r.json?.error === 'That takes 120 L out of the main store, which holds 100 L.', r.json?.error);
  r = await move('root', A, { kind: 'transfer', lines: [{ from: 'MAIN', to: 'SA', quantity: 60 * L }, { from: 'MAIN', to: 'MUSE_LIBRARY', quantity: 60 * L }] });
  record('D2: summed over the lines', r.status === 400, r.json?.error);
  let refused = await refusalsOf(A);
  record('A12: both refused main store transfers are recorded in Activity, with what it held',
    refused.length === 2 && refused.every((d) => d.stock === 'MAIN' && near(d.held, 100 * L)) && near(refused[0].quantity, 120 * L), JSON.stringify(refused));
  r = await move('root', A, { kind: 'transfer', lines: [{ from: 'SA', to: 'MAIN', quantity: 1 * L }] });
  record('D2: no transfer into the main store', r.status === 400, r.json?.error);
  r = await adjustIn('root', A, { stock: 'MAIN', type: 'add', quantity: 1 * L, reason: 'found' });
  record('D4: the main store is never adjusted (it is corrected on its receipt)', r.status === 400, r.json?.error);
  record('A12: a form refusal is not recorded', (await refusalsOf(A)).length === 2);
  r = await move('root', A, { kind: 'transfer', reference: 'TESTREG-SEC-PO3', lines: [{ from: 'MAIN', to: 'SA', quantity: 60 * L }, { from: 'MAIN', to: 'MUSE_LIBRARY', quantity: 40 * L }] });
  record('the main store split: 60 SA, 40 The Library', r.status === 200 && near(r.json?.sectors?.MAIN, 0), `${r.status} ${r.json?.error || ''}`);
  await check('main store split', A, { SA: 129, MUSE: 1, MUSE_ATELIER: 25, MUSE_LIBRARY: 65 });
  row = await dpRow(A);
  record('D1: the warning goes once the main store is split', row?.mainStoreWarning === null && near(row?.realStock, 129, 0.06), `${row?.mainStoreWarning}`);

  // ── Refusals (typing errors, S7) and who may act (S10).
  r = await move('user', A, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE', quantity: 1 * L }] });
  record('refused: a user who is not admin/root', r.status === 403, `status=${r.status}`);
  r = await move('root', A, { kind: 'split', lines: [{ from: 'MAIN', to: 'SA', quantity: 1 * L }] });
  record('refused: an unknown kind (split is a transfer from the main store now)', r.status === 400);
  r = await move('root', A, { kind: 'transfer', lines: [{ from: 'SA', to: 'SA', quantity: 1 * L }] });
  record('refused: the same stock both ends', r.status === 400);
  r = await move('root', A, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE', quantity: 0 }] });
  record('refused: zero quantity', r.status === 400);
  r = await move('root', A, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE', quantity: 5 * L }, { from: 'SA', to: 'NOWHERE', quantity: 5 * L }] });
  record('refused: a bad line rolls back the good one', r.status === 400);
  r = await move('root', A, { kind: 'count', lines: [{ to: 'MUSE', quantity: 1 * L }] });
  record('D3: a count is no longer a move — it is Adjust stock', r.status === 400 && r.json?.error === 'Counts and uses are made with Adjust stock', r.json?.error);
  r = await move('root', A, { kind: 'use', reference: '#TESTREG-1', lines: [{ from: 'MUSE', quantity: 1 * L, reason: 'production' }] });
  record('D3: nor is a use', r.status === 400, r.json?.error);
  r = await adjustIn('root', A, { stock: 'MAIN', type: 'remove', quantity: 1 * L, reason: 'correction' });
  record('D4: no removal from the main store either', r.status === 400, r.json?.error);
  r = await adjustIn('root', A, { stock: 'MUSE_LIBRARY', type: 'remove', quantity: 1 * L, reason: 'production' });
  record('S9: a MUSE use without its order number is refused', r.status === 400 && /order number/.test(r.json?.error || ''), r.json?.error);
  r = await adjustIn('root', A, { stock: 'MUSE_LIBRARY', type: 'remove', quantity: 1 * L, reason: 'technician' });
  record('§2.4: Technician is not a reason on a MUSE stock', r.status === 400, r.json?.error);
  r = await adjustIn('root', A, { stock: 'MUSE_LIBRARY', type: 'add', quantity: 1 * L, reason: 'delivery' });
  record('§2.4: nor is Supplier delivery', r.status === 400, r.json?.error);
  r = await adjustIn('user', A, { stock: 'MUSE_LIBRARY', type: 'add', quantity: 1 * L, reason: 'found' });
  record('refused: a user adjusting', r.status === 403, `status=${r.status}`);
  r = await move('technician', A, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE', quantity: 1 * L }] });
  record('refused: a technician moving oil', r.status === 403, `status=${r.status}`);
  r = await api('technician', 'POST', '/api/sa/fragrance-registrations', { productId: A, company: 'MUSE' });
  record('refused: a technician registering', r.status === 403, `status=${r.status}`);
  // Formula ready stock (owner, 5 Nov): a technician may not SET it (Adjust), but
  // Receive stays open because Returns adds through it. Quantity 0 is refused as
  // invalid (400), past the role check, so nothing is written.
  {
    const fid = (await db.query(`SELECT id FROM sa.formulas ORDER BY id LIMIT 1`)).rows[0]?.id;
    r = await api('technician', 'PUT', `/api/sa/formulas/${fid}/ready-stock/adjust`, { quantityMl: 0 });
    record('refused: a technician setting a formula\'s ready stock', r.status === 403, `status=${r.status}`);
    r = await api('technician', 'POST', `/api/sa/formulas/${fid}/ready-stock/receive`, { quantityMl: 0 });
    record('a technician still reaches formula Receive (Returns uses it)', r.status === 400, `status=${r.status}`);
  }
  r = await api('root', 'GET', '/api/sa/sectors/movements?limit=abc');
  record('movements: a limit that is not a number falls back to the default', r.status === 200 && Array.isArray(r.json));
  await check('after the refusals nothing moved', A, { SA: 129, MUSE: 1, MUSE_ATELIER: 25, MUSE_LIBRARY: 65 });
  const dA = await demandL(A);
  record('receipts and transfers are not demand', dA.rows.length === 0, JSON.stringify(dA.rows));

  // ── Fix round 1 (26 Oct).
  // V4: two receipts of the same PO at once never over-receive.
  const poRace = await addPo(A, 'TESTREG-SEC-PORACE', 10);
  const race = await Promise.all([receive(poRace, { quantityReceived: 10 * L }), receive(poRace, { quantityReceived: 10 * L })]);
  const raced = (await db.query(`SELECT quantity_received::float AS q FROM purchase_orders WHERE id = $1`, [poRace])).rows[0].q;
  record('V4: two parallel receipts of one PO — one lands, the other is refused', race.map((x) => x.status).sort().join() === '200,400' && near(raced, 10 * L),
    `statuses=${race.map((x) => x.status)} received=${raced}`);
  await check('V4: only one 10 L receipt reached SA', A, { SA: 139, MUSE: 1, MUSE_ATELIER: 25, MUSE_LIBRARY: 65 });
  // V5: an oil outside SA cannot start with stock; R5: a MUSE use is never refused for registration.
  r = await api('root', 'POST', '/api/sa/products', { name: '[regression] Sector Oil bad2', category: 'OILS', unit: 'mL', currentStock: 5 * L, registerIn: ['MUSE'] });
  record('V5: registerIn without SA and an opening stock is refused',
    r.status === 400 && r.json?.error === 'An oil not registered in SA cannot start with stock — register it in SA, or receive its stock through a purchase order.', r.json?.error);
  r = await adjustIn('root', E, { stock: 'MUSE_LIBRARY', type: 'remove', quantity: 1 * L, reason: 'production', reference: '#TESTREG-SEC-R5' });
  record('R5: a MUSE use on an oil not registered in MUSE is allowed', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  await check('R5: it came off SA\'s shelf, for The Library', E, { SA: -1 });
  r = await adjustIn('root', E, { stock: 'MUSE_ARCHIVE', type: 'add', quantity: 1 * L, reason: 'found' });
  record('A9: any other adjustment in a company where the oil is not registered is refused',
    r.status === 400 && r.json?.code === 'NOT_REGISTERED' && r.json?.company === 'MUSE', JSON.stringify(r.json));
  // S1 / V1 through the SEED: an oil inactive on day one is registered by the
  // seed — written here, not by the create endpoint, so the test fails on the
  // old rule (inactive oil → inactive registration → its PO refused).
  const F = await createOil('F', { registerIn: [] });
  await api('root', 'PATCH', `/api/sa/products/${F}/status`, { status: 'inactive' });
  // V3: MUSE used by the units of the products that point at the oil.
  await db.query(`INSERT INTO sm.products (name, product_code, category, oil_id, segment, business_unit) VALUES
    ('[regression] Sector SM archive', 'TESTREG-SEC-SM1', 'FINISHED_GOOD', $1, 'MUSE', 'archive'),
    ('[regression] Sector SM client', 'TESTREG-SEC-SM2', 'FINISHED_GOOD', $1, 'STANDARD', NULL)`, [F]);
  const { seedRegistrations } = await import('../server/sa/sectors.js');
  const seed = await seedRegistrations({ only: [F] });
  record('seed (dry run): an inactive oil is registered in SA, active; MUSE used by its products\' units',
    JSON.stringify(seed.rows.map((x) => [x.company, x.active, x.used_by])) === JSON.stringify([['MUSE', true, ['MUSE_ARCHIVE', 'MUSE_ATELIER']], ['SA', true, []]]),
    JSON.stringify(seed.rows));
  const applied = await seedRegistrations({ only: [F], apply: true });
  const regF = (await api('root', 'GET', `/api/sa/fragrance-registrations?productId=${F}`)).json || [];
  record('seed (apply): both written, SA active though the oil is inactive; ?productId= returns that oil\'s rows only',
    applied.inserted === 2 && regF.length === 2 && regF.every((x) => x.productId === F && x.active) && regF.some((x) => x.company === 'SA'), JSON.stringify(regF));
  await api('root', 'PATCH', `/api/sa/products/${F}/status`, { status: 'active' });
  const poF = await addPo(F, 'TESTREG-SEC-POF', 2);
  r = await receive(poF, { quantityReceived: 2 * L });
  record('V1: the seeded oil, reactivated, receives its PO into SA (no lines)', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  // S7: a tiny main-store quantity never reads 0 (on F: Demand Planning lists SA's oils only, R6).
  const poF2 = await addPo(F, 'TESTREG-SEC-POF2', 0.04);
  await receive(poF2, { lines: [{ to: 'MAIN', quantity: 0.04 * L }] });
  row = await dpRow(F);
  record('S7: 40 mL in the main store reads 0.04 L, never 0', row?.mainStore === 0.04 && row?.mainStoreWarning === '0.04 L in the main store — split it before ordering.',
    `mainStore=${row?.mainStore} warning=${row?.mainStoreWarning}`);

  // ── Case 6: into a company where the oil is not registered — refused, then allowed.
  const D = await createOil('D');
  await adjust(D, 'add', 20, 'delivery');
  r = await move('root', D, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE_ARCHIVE', quantity: 10 * L }] });
  record('case 6: refused with the message and a machine-readable code',
    r.status === 400 && r.json?.error === 'Please register the fragrance in MUSE Fragrances first.'
    && r.json?.code === 'NOT_REGISTERED' && r.json?.company === 'MUSE' && r.json?.productId === D, JSON.stringify(r.json));
  r = await register(D, 'MUSE', { usedBy: ['MUSE_ARCHIVE'] });
  record('case 6: "Register now"', r.status === 200 && r.json?.registrations?.MUSE?.active === true, JSON.stringify(r.json));
  r = await move('root', D, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE_ARCHIVE', quantity: 10 * L }] });
  record('case 6: allowed once registered', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  // ── Case 7: oil MUSE The Atelier holds that the system did not know.
  r = await adjustIn('root', D, { stock: 'MUSE_ATELIER', type: 'add', quantity: 90 * L, reason: 'found' });
  record('case 7: Adjust · Add · Found accepted', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  await check('case 7: total +90, The Atelier +90, SA unchanged', D, { SA: 10, MUSE_ARCHIVE: 10, MUSE_ATELIER: 90 });
  record('case 7: a count is not demand', (await demandL(D)).rows.length === 0);
  r = await register(D, 'MUSE', { active: false });
  record('register: active false retires the registration', r.status === 200 && r.json?.registrations?.MUSE?.active === false && r.json.created === false);
  r = await move('root', D, { kind: 'transfer', lines: [{ from: 'SA', to: 'MUSE', quantity: 1 * L }] });
  record('guard: an inactive registration refuses again', r.status === 400 && r.json?.code === 'NOT_REGISTERED');
  r = await register(D, 'MUSE', { binLocation: 'M-9' });
  record('R2: editing only the bin of a retired registration leaves it retired',
    r.status === 200 && r.json?.registrations?.MUSE?.active === false && r.json.registrations.MUSE.binLocation === 'M-9'
    && r.json.registrations.MUSE.usedBy.join() === 'MUSE_ARCHIVE', JSON.stringify(r.json?.registrations?.MUSE));
  // The receipt guard, on an oil registered nowhere — through the old caller's path (no lines → SA).
  const poE = await addPo(E, 'TESTREG-SEC-POE', 1);
  r = await receive(poE, { quantityReceived: 1 * L });
  record('guard: a receipt into SA for an oil not registered in SA is refused',
    r.status === 400 && r.json?.code === 'NOT_REGISTERED' && r.json?.company === 'SA' && r.json?.error === 'Please register the fragrance in SA Fragrances first.', JSON.stringify(r.json));

  // ── Case 4 and the use rule: own unit → MUSE (shared) → SA, never another unit.
  const B = await createOil('B');
  await register(B, 'MUSE', { usedBy: ['MUSE_LIBRARY'] });
  await adjust(B, 'add', 50, 'delivery');
  await adjustIn('root', B, { stock: 'MUSE_LIBRARY', type: 'add', quantity: 1.5 * L, reason: 'found' });
  await check('case 4 set-up: The Library 1.5 L, MUSE (shared) 0, SA 50 L', B, { SA: 50, MUSE_LIBRARY: 1.5 });
  r = await adjustIn('root', B, { stock: 'MUSE_LIBRARY', type: 'remove', quantity: 2 * L, reason: 'production', reference: '#TESTREG-SEC-4' });
  record('case 4: use accepted', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  await check('case 4: 1.5 L from The Library, 0.5 L from SA — SA reads 49.5 L', B, { SA: 49.5 });
  let parts = await movementsOfTx(await lastTx(B));
  record('case 4: the SA part is recorded "used by MUSE The Library"',
    parts.length === 2 && parts[0].from_sector === 'MUSE_LIBRARY' && near(parts[0].q, 1.5 * L) && parts[0].used_for === null
    && parts[1].from_sector === 'SA' && near(parts[1].q, 0.5 * L) && parts[1].used_for === 'MUSE_LIBRARY', JSON.stringify(parts));
  for (const [stock, l] of [['MUSE', 3], ['MUSE_ATELIER', 5], ['MUSE_LIBRARY', 2]]) {
    await adjustIn('root', B, { stock, type: 'add', quantity: l * L, reason: 'found' });
  }
  r = await adjustIn('root', B, { stock: 'MUSE_LIBRARY', type: 'remove', quantity: 6 * L, reason: 'production', reference: '#TESTREG-SEC-5' });
  parts = await movementsOfTx(await lastTx(B));
  record('use rule: The Library 2 → MUSE (shared) 3 → SA 1, never The Atelier',
    parts.map((m) => `${m.from_sector}:${m.q / L}:${m.used_for}`).join(' ') === 'MUSE_LIBRARY:2:null MUSE:3:MUSE_LIBRARY SA:1:MUSE_LIBRARY', JSON.stringify(parts));
  await check('use rule', B, { SA: 48.5, MUSE_ATELIER: 5 });
  // A7 (D2): MUSE (shared) holding none — a removal that is not production stops
  // at zero: blocked, alerted (the message gives both figures and the right
  // path) and recorded; nothing moves.
  const txBefore = await lastTx(B);
  r = await adjustIn('root', B, { stock: 'MUSE', type: 'remove', quantity: 1 * L, reason: 'other', note: '[regression] collab' });
  record('A7: a MUSE removal below zero is refused, with both figures and the right path',
    r.status === 400 && r.json?.error === "MUSE (shared) holds 0 L. A removal can bring it to zero, not below. If MUSE (shared) used oil from SA's shelf, record it as Production with the order number.", r.json?.error);
  refused = await refusalsOf(B);
  record('A12: and recorded in Activity: the stock, what was typed, what it held, the reason',
    refused.length === 1 && refused[0].stock === 'MUSE' && near(refused[0].quantity, 1 * L) && near(refused[0].held, 0) && refused[0].reason === 'other', JSON.stringify(refused));
  record('A7: nothing moved', (await lastTx(B)) === txBefore);
  // The same as production: straight to SA, for MUSE (S4).
  r = await adjustIn('root', B, { stock: 'MUSE', type: 'remove', quantity: 1 * L, reason: 'production', reference: '#TESTREG-SEC-6' });
  parts = await movementsOfTx(await lastTx(B));
  record('use rule: MUSE (shared) holding none takes from SA, for MUSE', r.status === 200 && parts.length === 1 && parts[0].from_sector === 'SA' && parts[0].used_for === 'MUSE', JSON.stringify(parts));
  // The MUSE side (CommonJS) draws through the same function, by the product's unit.
  const { consumeFragranceOil, restoreFragranceOil, SECTOR_FOR_UNIT } = require('../server/sm/services/fragrance-library.js');
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const tq = (sql, params) => c.query(sql, params);
    await consumeFragranceOil(tq, B, 2 * L, 'MUSE', '[regression] atelier sale', 'atelier');
    await consumeFragranceOil(tq, B, 1 * L, 'STANDARD', '[regression] client order');
    await consumeFragranceOil(tq, B, 1 * L, 'MUSE', '[regression] archive sale', 'archive');
    await restoreFragranceOil(tq, B, 1 * L, 'MUSE', '[regression] reversal');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  // Atelier 5 − 2 − 1 (client work is The Atelier's) = 2; The Archive holds none,
  // MUSE (shared) none, so its 1 L is SA's, for it; the reversal goes back to SA.
  await check('MUSE side: by unit, client work is The Atelier, a reversal back to SA', B, { SA: 47.5, MUSE_ATELIER: 2 });
  // A7 / A8: a MUSE removal that is not production comes off that stock only.
  // Reason "other": it would show in Demand Planning's "manual" figure (checked
  // below) if the exclusion missed it.
  r = await adjustIn('root', B, { stock: 'MUSE_ATELIER', type: 'remove', quantity: 0.5 * L, reason: 'other', note: '[regression] collab sample' });
  parts = await movementsOfTx(await lastTx(B));
  record('A7: a MUSE removal within what it holds comes off that stock only, kind adjust',
    r.status === 200 && parts.length === 1 && parts[0].from_sector === 'MUSE_ATELIER' && parts[0].kind === 'adjust' && parts[0].used_for === null,
    `${r.status} ${r.json?.error || ''} ${JSON.stringify(parts)}`);
  await check('A7: The Atelier 1.5 L, SA unchanged', B, { SA: 47.5, MUSE_ATELIER: 1.5 });
  const forArchive = (await db.query(`SELECT from_sector, used_for FROM sector_movements WHERE product_id = $1 AND kind = 'production' AND used_for = 'MUSE_ARCHIVE'`, [B])).rows;
  record('MUSE side: The Archive\'s SA oil is marked used for it', forArchive.length === 1 && forArchive[0].from_sector === 'SA');
  const { DIVISION_NAMES } = await import('../shared/business-names.js');
  record('every MUSE unit maps to a MUSE stock, and only those',
    JSON.stringify(Object.keys(DIVISION_NAMES).sort()) === JSON.stringify(Object.keys(SECTOR_FOR_UNIT).sort())
    && Object.values(SECTOR_FOR_UNIT).every((k) => k.startsWith('MUSE_')), JSON.stringify(SECTOR_FOR_UNIT));

  // R1, through the PRODUCTION ROUTE: an Archive variant under a 'library'
  // master draws from MUSE The Archive first, never from The Library.
  // F2 (fix round 3): an OLDER live Library variant of the same master carries
  // the same oil, so only the line's variant_name can pick the Archive one —
  // live-first-then-lowest-id alone would choose The Library and fail here.
  const G = await createOil('G');
  await register(G, 'MUSE', { usedBy: ['MUSE_ARCHIVE', 'MUSE_LIBRARY'] });
  await adjust(G, 'add', 10, 'delivery');
  await adjustIn('root', G, { stock: 'MUSE_ARCHIVE', type: 'add', quantity: 3 * L, reason: 'found' });
  await adjustIn('root', G, { stock: 'MUSE_LIBRARY', type: 'add', quantity: 5 * L, reason: 'found' });
  const master = (await db.query(`INSERT INTO sm.products (name, product_code, category, is_master, segment, business_unit)
    VALUES ('[regression] Sector master', 'TESTREG-SEC-MST', 'FINISHED_GOOD', true, 'MUSE', 'library') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO sm.products (name, product_code, category, master_product_id, oil_id, segment, business_unit)
    VALUES ('[regression] Sector library variant', 'TESTREG-SEC-VAR0', 'FINISHED_GOOD', $1, $2, 'MUSE', 'library')`, [master, G]);
  await db.query(`INSERT INTO sm.products (name, product_code, category, master_product_id, oil_id, segment, business_unit)
    VALUES ('[regression] Sector archive variant', 'TESTREG-SEC-VAR', 'FINISHED_GOOD', $1, $2, 'MUSE', 'archive')`, [master, G]);
  const mo = (await db.query(`INSERT INTO sm.production_orders (order_number, status) VALUES ('TESTREG-SEC-MO1', 'queued') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO sm.production_order_lines (production_order_id, line_number, product_type, quantity, oil_id, oil_qty_ml, variant_name)
    VALUES ($1, 1, 'TESTREG-SEC-MST', 1, $2, $3, '[regression] Sector archive variant')`, [mo, G, 4 * L]);
  r = await api('root', 'POST', `/api/sm/manufacturing/${mo}/start`);
  record('R1: the production order starts', r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
  await check('R1: The Archive 3 L, then SA 1 L for it — The Library untouched', G, { SA: 9, MUSE_LIBRARY: 5 });
  parts = await movementsOfTx(await lastTx(G));
  record('R1: the draw started in MUSE_ARCHIVE and never took MUSE_LIBRARY',
    parts.map((m) => `${m.from_sector}:${m.q / L}:${m.used_for}:${m.kind}`).join(' ') === 'MUSE_ARCHIVE:3:null:production SA:1:MUSE_ARCHIVE:production',
    JSON.stringify(parts));
  const dB = await demandL(B);
  record('S5: MUSE uses typed by hand and MUSE production are not SA demand', dB.rows.length === 0, JSON.stringify(dB.rows));
  row = await dpRow(B);
  record('S5: nor in Demand Planning\'s "manual" figure beside the rate', near(row?.outsideAverage?.manual, 0) && near(row?.realStock, 47.5, 0.06),
    `manual=${row?.outsideAverage?.manual} realStock=${row?.realStock}`);
  record('S5: nor in the portfolio daily rate (30-day sales stream)', near(row?.totalSold30d, 0) && near(row?.retailDailyAvg, 0, 1e-6),
    `sold30=${row?.totalSold30d} retail=${row?.retailDailyAvg}`);
  // A7 race (PRD_H2 §7): The Atelier holds 1.5 L; two removals of 1 L at the
  // same moment — the row lock checks them one after the other.
  const raced2 = await Promise.all([1, 2].map(() => adjustIn('root', B, { stock: 'MUSE_ATELIER', type: 'remove', quantity: 1 * L, reason: 'correction' })));
  record('A7 race: one removal lands, the other is refused and recorded',
    raced2.map((x) => x.status).sort().join() === '200,400' && (await refusalsOf(B)).length === 2, `statuses=${raced2.map((x) => x.status)}`);
  await check('A7 race: The Atelier 0.5 L, never below zero', B, { SA: 47.5, MUSE_ATELIER: 0.5 });

  // ── Case 5: an SA debit beyond SA's oil — SA negative, MUSE untouched, SA demand.
  // (A sale and a removal are both SA ledger debits with no stock movement; the
  // removal stands in for the Shopify sale, which needs the store.)
  const C = await createOil('C');
  await register(C, 'MUSE', { usedBy: ['MUSE_LIBRARY'] });
  await adjust(C, 'add', 3, 'delivery');
  await adjustIn('root', C, { stock: 'MUSE', type: 'add', quantity: 25 * L, reason: 'found' });
  r = await adjust(C, 'remove', 5, 'sample');
  record('case 5: the SA debit is accepted', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  await check('case 5: SA reads −2 L, MUSE untouched', C, { SA: -2, MUSE: 25 });
  const dC = await demandL(C);
  record('case 5: SA demand +5 L', near(dC.total, 5) && dC.rows.length === 1, JSON.stringify(dC.rows));
  row = await dpRow(C);
  record('Demand Planning stock is SA\'s balance (−2 L), MUSE beside it', near(row?.realStock, -2, 0.06) && near(row?.museTotal, 25, 0.06), `realStock=${row?.realStock} muse=${row?.museTotal}`);
  record('case 5: the SA debit IS in the portfolio daily rate', near(row?.totalSold30d, 5, 0.06), `sold30=${row?.totalSold30d}`);
  p = await oil(C);
  const { getStockStatus } = await import('../src/sa/utils/stockStatus.js');
  record('case 5: the status is SA\'s — Negative Stock, though MUSE holds 25 L', getStockStatus(p).key === 'NEGATIVE');
  // ── Case 9: a stocktake on SA's Stock page changes SA only.
  await adjust(C, 'add', 1, 'correction');
  await check('case 9: the stocktake lands in SA, MUSE does not move', C, { SA: -1, MUSE: 25 });
  // A4: the same adjustment, made in the Fragrance Library with the stock named SA.
  r = await adjustIn('root', C, { stock: 'SA', type: 'remove', quantity: 1 * L, reason: 'correction' });
  const saTx = await lastTx(C);
  const saRow = (await db.query(`SELECT type, reason, notes FROM transactions WHERE id = $1`, [saTx])).rows[0];
  record('A4: an SA adjustment in the Fragrance Library writes the Stock page\'s ledger row, no stock movement',
    r.status === 200 && saRow?.type === 'remove' && saRow?.reason === 'correction' && saRow?.notes === 'Correcting a count — Adjusted in SA — [regression]'
    && (await movementsOfTx(saTx)).length === 0, `${r.status} ${r.json?.error || ''} ${JSON.stringify(saRow)}`);
  await check('A4: it lands in SA', C, { SA: -2, MUSE: 25 });
  const museNote = (await db.query(`SELECT notes FROM transactions WHERE product_id = $1 AND type = 'add' AND reason = 'found' ORDER BY id DESC LIMIT 1`, [C])).rows[0]?.notes;
  record('A10: the ledger row names the stock it was made in', museNote === 'Found in the warehouse — Adjusted in MUSE (shared) — [regression]', museNote);

  // ── P6 (owner, 29–30 Oct): the Shopify PO destination names the company.
  // An accepted Shopify line is an ordinary PO row plus its destination_stock
  // (accepting needs Shopify, blanked here), so that is what is written.
  const P = await createOil('P');
  await register(P, 'MUSE', { usedBy: ['MUSE_ATELIER', 'MUSE_LIBRARY', 'MUSE_ARCHIVE'] });
  const poFor = async (num, litres, stock) => {
    const id = await addPo(P, num, litres);
    await db.query(`UPDATE purchase_orders SET destination_stock = $1 WHERE id = $2`, [stock, id]);
    return id;
  };
  const poMuse = await poFor('TESTREG-SEC-P6M', 10, 'MUSE');
  const poAtelier = await poFor('TESTREG-SEC-P6A', 5, 'MUSE_ATELIER');
  const poSa = await poFor('TESTREG-SEC-P6S', 4, 'SA');
  row = await dpRow(P);
  record('P6: only the SA Warehouse PO is SA\'s on order in Demand Planning (4 L of 19 L)', near(row?.incomingStock, 4, 0.06), `incoming=${row?.incomingStock}`);
  p = await oil(P);
  record('P6: every open PO is listed on the oil, each with its company stock',
    p?.incomingOrders?.map((o) => o.stock).sort().join() === 'MUSE,MUSE_ATELIER,SA', JSON.stringify(p?.incomingOrders?.map((o) => o.stock)));
  const { incomingQty } = await import('../src/sa/utils/stockStatus.js');
  record('P6: and SA\'s status counts SA\'s order only (4 L)', near(incomingQty(p), 4 * L), `incoming=${incomingQty(p) / L}`);
  // Blocked, recorded, explained (owner, 30 Oct).
  r = await receive(poMuse, { quantityReceived: 2 * L, lines: [{ to: 'SA', quantity: 2 * L }] });
  record('P6: a MUSE PO received into SA is refused, with the fix',
    r.status === 400 && r.json?.code === 'WRONG_STOCK'
    && r.json?.error === 'TESTREG-SEC-P6M is a purchase order for MUSE (The Library and The Archive). It can only be received into MUSE (shared), MUSE The Library, MUSE The Archive, not into SA.'
    && /then move that part with a Transfer/.test(r.json?.fix || ''), JSON.stringify(r.json));
  const refusedP = (await db.query(`SELECT details FROM audit_log WHERE action = 'stock_refused' AND entity_id = $1`, [P])).rows
    .map((x) => (typeof x.details === 'string' ? JSON.parse(x.details) : x.details));
  record('P6: the attempt is recorded in Activity: the PO, the stock, the quantity, who it is for',
    refusedP.length === 1 && refusedP[0].type === 'receipt' && refusedP[0].reference === 'TESTREG-SEC-P6M' && refusedP[0].stock === 'SA'
    && near(refusedP[0].quantity, 2 * L) && refusedP[0].destination === 'MUSE (The Library and The Archive)', JSON.stringify(refusedP));
  await check('P6: the refusal moved nothing', P, {});
  r = await receive(poMuse, { quantityReceived: 10 * L, lines: [{ to: 'MAIN', quantity: 10 * L }] });
  record('P6: nor into the main store', r.status === 400 && r.json?.code === 'WRONG_STOCK', r.json?.error);
  r = await receive(poMuse, { quantityReceived: 10 * L, lines: [{ to: 'MUSE_LIBRARY', quantity: 6 * L }, { to: 'MUSE_ARCHIVE', quantity: 4 * L }] });
  record('P6: a MUSE PO split between The Library and The Archive is accepted', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  r = await receive(poAtelier, { quantityReceived: 5 * L });
  record('P6: with no lines, an Atelier PO goes to MUSE The Atelier, not SA', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  r = await receive(poSa, { quantityReceived: 4 * L, lines: [{ to: 'MUSE', quantity: 4 * L }] });
  record('P6: an SA Warehouse PO received into MUSE is refused too', r.status === 400 && r.json?.code === 'WRONG_STOCK', r.json?.error);
  r = await receive(poSa, { quantityReceived: 4 * L });
  record('P6: and goes to SA', r.status === 200, `${r.status} ${r.json?.error || ''}`);
  await check('P6: each PO in its company\'s stocks', P, { SA: 4, MUSE_LIBRARY: 6, MUSE_ARCHIVE: 4, MUSE_ATELIER: 5 });
  row = await dpRow(P);
  record('P6: nothing left on order', near(row?.incomingStock, 0, 0.06), `incoming=${row?.incomingStock}`);
  // A manual order (+ Incoming) has no destination: received anywhere, as before.
  const poManual = await addPo(P, 'TESTREG-SEC-P6X', 1);
  r = await receive(poManual, { quantityReceived: 1 * L, lines: [{ to: 'MAIN', quantity: 1 * L }] });
  record('P6: a manual order is unchanged — the main store still takes it', r.status === 200, `${r.status} ${r.json?.error || ''}`);

  // ── Seeing (R4) and costs (S10).
  const all = (await api('technician', 'GET', '/api/sa/sectors/movements?limit=500')).json || [];
  const mine = all.filter((m) => PIDS.includes(m.productId));
  record('movements: every oil\'s recent movements, with the oil named, readable by a technician',
    mine.length > 0 && mine.every((m) => m.productName?.startsWith('[regression] Sector Oil')), `n=${mine.length}`);
  record('movements: no cost for a technician (S10)', mine.every((m) => !('costPerUnit' in m)));
  const rootList = (await api('root', 'GET', '/api/sa/sectors/movements?limit=500')).json || [];
  record('movements: costs for admin/root', rootList.filter((m) => PIDS.includes(m.productId)).every((m) => 'costPerUnit' in m));
  r = await api('user', 'GET', `/api/sa/sectors/${A}/movements`);
  record('movements: one oil\'s history readable by a user', r.status === 200 && r.json.length > 0);

  // ── History & Activity (§2.5).
  // V6: MUSE production from before Stage 1 — a ledger row with no stock movement.
  await db.query(`INSERT INTO transactions (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
    SELECT id, "productCode", name, 'OILS', 'muse_production', 500, 'mL', "currentStock", '[regression] old MUSE production' FROM products WHERE id = $1`, [C]);
  const hq = (q) => api('root', 'GET', `/api/platform/history?system=ALL&search=${encodeURIComponent('[regression] Sector Oil')}${q}`).then((x) => x.json || []);
  const rows = await hq('');
  const r1 = rows.find((x) => x.type === 'add' && x.notes?.includes('TESTREG-SEC-PO1'));
  record('History: one receipt row with its split and its value ($50/L × 100 L)',
    r1?.sector === '50 L SA · 25 L MUSE The Atelier · 25 L MUSE The Library' && near(r1?.value, 5000) && r1?.unpriced === false,
    `sector=${r1?.sector} value=${r1?.value}`);
  const r2 = rows.find((x) => x.type === 'add' && x.notes?.includes('TESTREG-SEC-PO2'));
  record('History: an unpriced receipt is flagged', r2?.sector === '20 L SA' && r2?.unpriced === true, `sector=${r2?.sector} unpriced=${r2?.unpriced}`);
  record('History: a transfer names both stocks', rows.some((x) => x.type === 'sector_transfer' && x.sector === 'SA → MUSE (shared)'));
  record('History: SA oil given for a MUSE use says who it was for',
    rows.some((x) => x.type === 'remove' && x.sector === '1.5 L MUSE The Library · 0.5 L SA (for MUSE The Library)'));
  const atelier = await hq('&stock=MUSE_ATELIER');
  record('History filter stock=MUSE_ATELIER: the split receipt, not the SA-only one',
    atelier.some((x) => x.notes?.includes('TESTREG-SEC-PO1')) && !atelier.some((x) => x.notes?.includes('TESTREG-SEC-PO2')), `n=${atelier.length}`);
  const main = await hq('&stock=MAIN');
  record('History filter stock=MAIN: the main-store receipt and its split',
    main.some((x) => x.notes?.includes('TESTREG-SEC-PO3')) && main.some((x) => x.type === 'sector_transfer' && x.sector === 'Main store → SA'), `n=${main.length}`);
  const muse = await hq('&company=MUSE');
  record('History filter company=MUSE: a count into MUSE, not the SA removal',
    muse.some((x) => x.product_name.endsWith(' C') && x.type === 'add' && x.sector === '25 L MUSE (shared)')
    && !muse.some((x) => x.product_name.endsWith(' C') && x.type === 'remove'), `n=${muse.length}`);
  const saRows = await hq('&stock=SA');
  record('History filter stock=SA: the SA removal (no stock movement = SA\'s)', saRows.some((x) => x.product_name.endsWith(' C') && x.type === 'remove'));
  r = await api('root', 'GET', '/api/platform/history?stock=NOWHERE');
  record('History filter: an unknown stock is refused', r.status === 400);
  const csv = await (await fetch(`${BASE}/api/platform/history/export?system=ALL&stock=MUSE_ATELIER&search=${encodeURIComponent('[regression] Sector Oil')}`, { headers: { Authorization: `Bearer ${TOKENS.root}` } })).text();
  record('History CSV: Stock and Value ex GST columns, filtered by stock', csv.includes('Stock,Value ex GST (AUD)') && csv.includes('TESTREG-SEC-PO1') && !csv.includes('TESTREG-SEC-PO2'));
  // Fix round 1: kind, price wording (S6), SA filters (S8), old MUSE production (V6).
  record('History: a receipt row says kind receipt, a transfer kind transfer',
    r1?.kind === 'receipt' && rows.some((x) => x.type === 'sector_transfer' && x.kind === 'transfer'), `kind=${r1?.kind}`);
  const dTransfer = rows.find((x) => x.type === 'sector_transfer' && x.product_name.endsWith(' D'));
  record('S6: an unpriced receipt says "No price on the PO", any other unpriced movement "Unpriced"',
    r2?.price_note === 'No price on the PO' && dTransfer?.unpriced === true && dTransfer?.price_note === 'Unpriced' && r1?.price_note === null,
    `po2=${r2?.price_note} transfer=${dTransfer?.price_note}`);
  const csvAll = await (await fetch(`${BASE}/api/platform/history/export?system=ALL&search=${encodeURIComponent('[regression] Sector Oil')}`, { headers: { Authorization: `Bearer ${TOKENS.root}` } })).text();
  record('S6: the CSV says the same', csvAll.includes('No price on the PO') && csvAll.includes('Unpriced') && !csvAll.includes('no price on the PO'));
  const saCo = await hq('&company=SA');
  record('S8: company=SA includes SA\'s own debits (no stock movement)', saCo.some((x) => x.product_name.endsWith(' C') && x.type === 'remove'));
  const oldMuse = (list) => list.find((x) => x.type === 'muse_production' && x.notes === '[regression] old MUSE production');
  record('V6: old MUSE production reads "SA (for MUSE)", listed under company=MUSE and under stock=SA',
    oldMuse(rows)?.sector === 'SA (for MUSE)' && !!oldMuse(muse) && !!oldMuse(saRows) && !oldMuse(atelier),
    `sector=${oldMuse(rows)?.sector} muse=${!!oldMuse(muse)} sa=${!!oldMuse(saRows)}`);
  const oldLine = csvAll.split('\n').find((l) => l.includes('[regression] old MUSE production'));
  record('R4: old MUSE production says "Unpriced", on the screen and in the CSV',
    oldMuse(rows)?.price_note === 'Unpriced' && oldMuse(rows)?.unpriced === true && /,"?Unpriced"?,/.test(oldLine || ''), oldLine);

  // R6: Demand Planning lists only oils with an active SA registration.
  const H = await createOil('H', { registerIn: ['MUSE'] });
  await adjustIn('root', H, { stock: 'MUSE_LIBRARY', type: 'add', quantity: 5 * L, reason: 'found' });
  const rep = (await api('root', 'GET', '/api/sa/dashboard/replenishment')).json;
  record('R6: an oil that is only MUSE\'s is not in Demand Planning; an SA one is',
    !rep?.products?.some((x) => x.id === H) && rep?.products?.some((x) => x.id === C), `rows=${rep?.products?.length}`);

  // ── P7: publishing an oil to Shopify checks the oil first, before Shopify is
  // asked (Shopify is blanked here, so a check that passes stops at "not connected").
  r = await api('root', 'POST', `/api/sa/shopify/publish/${E}`, { costPerLitre: 42.4 });
  record('P7: an oil not registered in SA is not published to the SA store', r.status === 400 && /not registered in SA Fragrances/.test(r.json?.error || ''), r.json?.error);
  const X = await createOil('X', { exclusivity: 'MUSE' });
  r = await api('root', 'POST', `/api/sa/shopify/publish/${X}`, { costPerLitre: 42.4 });
  record('P7: nor one exclusive to MUSE (D15 §10)', r.status === 400 && /exclusive to MUSE/.test(r.json?.error || ''), r.json?.error);
  r = await api('root', 'POST', `/api/sa/shopify/publish/${A}`, { costPerLitre: -1 });
  record('P7: a negative cost per litre is refused', r.status === 400 && /cost per litre/.test(r.json?.error || ''), r.json?.error);
  r = await api('root', 'POST', `/api/sa/shopify/publish/${A}`, { costPerLitre: 42.4 });
  record('P7: an SA oil passes the checks and reaches Shopify (not connected here)', r.status === 400 && /Shopify is not connected/.test(r.json?.error || ''), r.json?.error);
  r = await api('user', 'POST', `/api/sa/shopify/publish/${A}`, { costPerLitre: 42.4 });
  record('P7: a user cannot publish', r.status === 403, `status=${r.status}`);

  // ── Purchase Orders (H4): the list still shows what the platform holds when
  // Shopify cannot be read, and nothing is raised outside Shopify (D3).
  r = await api('root', 'GET', '/api/sa/purchase-orders/overview');
  record('H4: the overview answers with Shopify unread, and lists the platform\'s own orders',
    r.status === 200 && r.json?.ok === false && (r.json.orders || []).some((o) => o.number === 'TESTREG-SEC-PO2'), `status=${r.status} ok=${r.json?.ok}`);
  r = await api('root', 'POST', `/api/sa/products/${A}/incoming`, { orderNumber: 'TESTREG-SEC-MANUAL', quantity: L });
  record('H4 D3: a manual order is refused — raise it in Shopify', r.status === 410 && /raised in Shopify/.test(r.json?.error || ''), `status=${r.status}`);
  r = await api('technician', 'GET', '/api/sa/purchase-orders/overview');
  record('H4: technicians do not see purchase orders', r.status === 403, `status=${r.status}`);
  await runH4();
}

// ── H4 (PRD_H4_PURCHASE_ORDERS.md §4): correct a receipt (R4), cancel a line (R5).
const correct = (poId, body) => api('root', 'POST', `/api/sa/purchase-orders/${poId}/correct`, body);
async function runH4() {
  const H = await createOil('H');
  await register(H, 'MUSE', { usedBy: ['MUSE_LIBRARY'] });

  // Cases 3 and 4: an SA line, 100 L received, 10 L that never came.
  const s1 = await addPo(H, 'TESTREG-SEC-H4-SA', 100, 0.05);
  await db.query(`UPDATE purchase_orders SET destination_stock = 'SA' WHERE id = $1`, [s1]);
  let r = await receive(s1, { quantityReceived: 100 * L });
  const rcptTx = (await db.query(`SELECT purchase_order_id FROM transactions WHERE id = $1`, [await lastTx(H)])).rows[0];
  record('H4 R2: a receipt names its PO line', r.status === 200 && rcptTx?.purchase_order_id === s1, JSON.stringify(rcptTx));
  r = await correct(s1, { quantity: 5 * L, reason: 'short delivery', mode: 'still_due' });
  record('H4 case 3: correct 5 L, still due → part received, 95 L', r.status === 200 && r.json?.status === 'partial' && near(r.json?.received, 95 * L), JSON.stringify(r.json));
  await check('H4 case 3: SA −5 L', H, { SA: 95 });
  const tx = (await db.query(`SELECT type, reason, purchase_order_id, notes FROM transactions WHERE id = $1`, [await lastTx(H)])).rows[0];
  record('H4 case 3: one ledger row — a remove for receipt_correction, naming the line and the reason',
    tx?.type === 'remove' && tx?.reason === 'receipt_correction' && tx?.purchase_order_id === s1
    && /Receipt corrected — TESTREG-SEC-H4-SA — short delivery/.test(tx?.notes || ''), JSON.stringify(tx));
  const mv = await movementsOfTx(await lastTx(H));
  record('H4 case 3: the reversing movement is off SA, back to the supplier',
    mv.length === 1 && mv[0].from_sector === 'SA' && mv[0].to_sector === 'SUPPLIER' && mv[0].kind === 'reversal', JSON.stringify(mv));
  let row = await dpRow(H);
  record('H4 case 3: Demand Planning sees the 5 L on order again', near(row?.incomingStock, 5, 0.06), `incoming=${row?.incomingStock}`);
  r = await correct(s1, { quantity: 5 * L, reason: 'supplier will not send it', mode: 'close_short' });
  record('H4 case 4: 5 L more, close short → received (90 of 100), closed short',
    r.status === 200 && r.json?.status === 'received' && near(r.json?.received, 90 * L), JSON.stringify(r.json));
  row = await dpRow(H);
  record('H4 case 4: nothing on order', near(row?.incomingStock, 0, 0.06), `incoming=${row?.incomingStock}`);
  // The oil never arrived, so the shelf lost nothing: taking it back is not
  // consumption (shared/stock-reasons.js), or Demand Planning would buy for it.
  const dH = await demandL(H);
  record('H4: a receipt correction is not demand', dH.rows.length === 0 && dH.total === 0, JSON.stringify(dH.rows));
  r = await receive(s1, { quantityReceived: 1 * L });
  record('H4: a closed-short line receives nothing more', r.status === 400 && /closed short/.test(r.json?.error || ''), r.json?.error);
  r = await correct(s1, { quantity: 91 * L, reason: 'x', mode: 'still_due' });
  record('H4: a correction cannot take back more than was received', r.status === 400, r.json?.error);
  r = await correct(s1, { quantity: 1 * L, reason: ' ', mode: 'still_due' });
  record('H4: a correction needs a reason', r.status === 400, r.json?.error);
  r = await api('user', 'POST', `/api/sa/purchase-orders/${s1}/correct`, { quantity: L, reason: 'x', mode: 'still_due' });
  record('H4: a user cannot correct a receipt', r.status === 403, `status=${r.status}`);

  // Case 5: a MUSE receipt the stock has since used most of.
  const m1 = await addPo(H, 'TESTREG-SEC-H4-MUSE', 10, 0.05);
  await db.query(`UPDATE purchase_orders SET destination_stock = 'MUSE' WHERE id = $1`, [m1]);
  await receive(m1, { quantityReceived: 10 * L, lines: [{ to: 'MUSE_LIBRARY', quantity: 10 * L }] });
  await adjustIn('root', H, { stock: 'MUSE_LIBRARY', type: 'remove', quantity: 8 * L, reason: 'production', reference: 'TESTREG-SEC-H4-ORDER' });
  await check('H4 case 5: The Library received 10 L and used 8 L', H, { SA: 90, MUSE_LIBRARY: 2 });
  r = await correct(m1, { quantity: 5 * L, reason: 'short', mode: 'still_due' });
  record('H4 case 5: refused — The Library holds 2 L', r.status === 400 && /holds 2 L/.test(r.json?.error || ''), r.json?.error);
  const refused = (await refusalsOf(H)).find((x) => x.type === 'receipt_correction');
  record('H4 case 5: the refusal is recorded in Activity', refused?.stock === 'MUSE_LIBRARY' && refused?.reference === 'TESTREG-SEC-H4-MUSE', JSON.stringify(refused));
  r = await correct(m1, { quantity: 2 * L, reason: 'short', mode: 'still_due' });
  record('H4 case 5: 2 L can come back, out of The Library', r.status === 200 && r.json?.status === 'partial', JSON.stringify(r.json));
  await check('H4 case 5: The Library at zero, SA untouched', H, { SA: 90, MUSE_LIBRARY: 0 });

  // A receipt split between two stocks: the correction says how much from each.
  const m2 = await addPo(H, 'TESTREG-SEC-H4-SPLIT', 10, null);
  await db.query(`UPDATE purchase_orders SET destination_stock = 'MUSE' WHERE id = $1`, [m2]);
  await receive(m2, { quantityReceived: 10 * L, lines: [{ to: 'MUSE_LIBRARY', quantity: 6 * L }, { to: 'MUSE', quantity: 4 * L }] });
  r = await correct(m2, { quantity: 3 * L, reason: 'short', mode: 'still_due' });
  record('H4: a receipt split in two stocks asks how much comes off each',
    r.status === 400 && r.json?.code === 'NEEDS_LINES' && near(r.json?.net?.MUSE_LIBRARY, 6 * L) && near(r.json?.net?.MUSE, 4 * L), JSON.stringify(r.json));
  r = await correct(m2, { quantity: 3 * L, reason: 'short', mode: 'still_due', lines: [{ from: 'MUSE_LIBRARY', quantity: 1 * L }, { from: 'MUSE', quantity: 2 * L }] });
  record('H4: … and takes it from each, as told', r.status === 200, JSON.stringify(r.json));
  await check('H4: the split correction', H, { SA: 90, MUSE_LIBRARY: 5, MUSE: 2 });
  // Code review, 5 Nov: the same stock twice. Each 2 L entry is ≤ the 2 L MUSE
  // received, but together they are 4 L: refused, nothing moves.
  r = await correct(m2, { quantity: 4 * L, reason: 'short', mode: 'still_due', lines: [{ from: 'MUSE', quantity: 2 * L }, { from: 'MUSE', quantity: 2 * L }] });
  record('H4: one stock named twice is added up before the limit — refused', r.status === 400 && /MUSE/.test(r.json?.error || ''), JSON.stringify(r.json));
  await check('H4: … and nothing moved', H, { SA: 90, MUSE_LIBRARY: 5, MUSE: 2 });
  const hist = (await api('root', 'GET', `/api/sa/purchase-orders/history?ids=${m2}`)).json?.[m2] || [];
  record('H4: the line history lists the receipt and the correction, with their stocks',
    hist.length === 2 && hist[0].kind === 'receipt' && hist[0].lines.length === 2 && hist[1].kind === 'correction' && near(hist[1].quantity, 3 * L),
    JSON.stringify(hist));

  // R5: a cancelled line keeps its row and its reason; one with receipts closes short.
  const c1 = await addPo(H, 'TESTREG-SEC-H4-CANCEL', 50, null);
  r = await api('root', 'POST', `/api/sa/purchase-orders/${c1}/cancel`, { reason: '' });
  record('H4 R5: cancelling needs a reason', r.status === 400, `status=${r.status}`);
  r = await api('root', 'POST', `/api/sa/purchase-orders/${c1}/cancel`, { reason: 'ordered twice' });
  const c1row = (await db.query(`SELECT status, cancel_reason, cancelled_by FROM purchase_orders WHERE id = $1`, [c1])).rows[0];
  record('H4 R5: nothing received → cancelled, the row kept with its reason and who',
    r.status === 200 && r.json?.status === 'cancelled' && c1row?.status === 'cancelled' && c1row?.cancel_reason === 'ordered twice'
    && c1row?.cancelled_by === '__regression_sec', JSON.stringify(c1row));
  r = await receive(c1, { quantityReceived: 1 * L });
  record('H4 R5: a cancelled line receives nothing', r.status === 400 && /cancelled/.test(r.json?.error || ''), r.json?.error);
  // Code review, 5 Nov: "Take the new figure" must not reopen it. Made a Shopify
  // line here so the route reaches its check; it refuses before reading Shopify.
  await db.query(`UPDATE purchase_orders SET shopify_line_id = 'TESTREG-SEC-H4-LINE' WHERE id = $1`, [c1]);
  r = await api('root', 'PATCH', `/api/sa/shopify-purchase-orders/line/${c1}`);
  const c1after = (await db.query(`SELECT status FROM purchase_orders WHERE id = $1`, [c1])).rows[0];
  record('H4 R5: a change in Shopify does not reopen a cancelled line',
    r.status === 409 && c1after?.status === 'cancelled', `status=${r.status} row=${c1after?.status}`);
  r = await api('root', 'POST', `/api/sa/purchase-orders/${m2}/cancel`, { reason: 'the rest is not coming' });
  record('H4 R5: a line with receipts is closed short instead', r.status === 200 && r.json?.status === 'closed_short', JSON.stringify(r.json));
  r = await api('root', 'DELETE', `/api/sa/purchase-orders/${c1}`);
  record('H4 R5: nothing deletes a line any more (410)',
    r.status === 410 && (await db.query(`SELECT 1 FROM purchase_orders WHERE id = $1`, [c1])).rowCount === 1, `status=${r.status}`);

  const orders = (await api('root', 'GET', '/api/sa/purchase-orders/overview')).json?.orders || [];
  const st = (n) => orders.find((o) => o.number === n)?.status;
  record('H4: the list — closed short and cancelled close, a part-received line is "part"',
    st('TESTREG-SEC-H4-SA') === 'closed' && st('TESTREG-SEC-H4-SPLIT') === 'closed' && st('TESTREG-SEC-H4-CANCEL') === 'cancelled'
    && st('TESTREG-SEC-H4-MUSE') === 'part', ['SA', 'SPLIT', 'CANCEL', 'MUSE'].map((k) => `${k}=${st(`TESTREG-SEC-H4-${k}`)}`).join(' '));
}

async function main() {
  console.log('══════════ STOCK BY COMPANY REGRESSION (Stage 1) ══════════\n');
  try {
    await setup();
    await run();
  } catch (e) {
    record('run completed', false, e.stack || e.message);
  } finally {
    await cleanup();
  }
  const left = (await db.query(`SELECT
      (SELECT COUNT(*) FROM products WHERE name LIKE '[regression] Sector Oil%')::int AS products,
      (SELECT COUNT(*) FROM sector_movements WHERE product_id = ANY($1::text[]))::int AS movements,
      (SELECT COUNT(*) FROM transactions WHERE product_id = ANY($1::text[]))::int AS ledger,
      (SELECT COUNT(*) FROM fragrance_registrations WHERE product_id = ANY($1::text[]))::int AS registrations,
      (SELECT COUNT(*) FROM purchase_orders WHERE order_number LIKE 'TESTREG-SEC-%')::int AS pos,
      (SELECT COUNT(*) FROM sm.products WHERE product_code LIKE 'TESTREG-SEC-%')::int AS sm_products,
      (SELECT COUNT(*) FROM sm.production_orders WHERE order_number LIKE 'TESTREG-SEC-%')::int AS sm_orders,
      (SELECT COUNT(*) FROM platform.users WHERE name LIKE '\\_\\_regression\\_sec%')::int AS users`, [PIDS])).rows[0];
  record('residue: fixture oils, their rows and the test users removed', Object.values(left).every((n) => n === 0), JSON.stringify(left));
  await db.end();
  const failed = results.filter((x) => !x.pass);
  console.log(`\n══════════ RESULT: ${failed.length === 0 ? '✅ ALL PASS' : `❌ ${failed.length} FAILED`} (${results.length} checks) ══════════`);
  process.exit(failed.length === 0 ? 0 : 1);
}
main();
