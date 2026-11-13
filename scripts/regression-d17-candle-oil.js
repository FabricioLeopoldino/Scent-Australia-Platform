// D17 Blocks A + B — a candle's oil (PRD_D17_PRODUCTION_FLOW.md, 11 Nov 2026).
//
// The contract this protects:
//   · a candle is a line whose MASTER says so, not one of two legacy codes
//   · Start Production takes NOTHING for a candle line (the double debit)
//   · the oil leaves when the line goes to the filler, for the amount typed,
//     ONCE per record, and is the candle version where one exists
//   · it is drawn the ordinary way: the unit's own oil, then SA
//   · the surplus returns to the stocks the send drew from, SA first, and
//     never more than was sent
//   · a candle version is linked through one door and never offered in a picker
//   · only admin/root moves oil
//   · a line whose oil was taken at Start (before this release) is not debited
//     again when it is sent
//
// Boots its own server on a spare port and uses throwaway rows only.
// Run: node scripts/regression-d17-candle-oil.js
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';

// Test copy only: this suite boots a server, and a server runs its migrations.
if (!(process.env.PLATFORM_DATABASE_URL || '').includes('ep-old-water-') && process.env.REGRESSION_ALLOW_PRODUCTION !== '1') {
  console.error('Refusing: PLATFORM_DATABASE_URL is not the sectors-dev branch (ep-old-water-). Set REGRESSION_ALLOW_PRODUCTION=1 to override.');
  process.exit(1);
}
const { Pool } = pkg;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = String(Date.now()).slice(-7);
const TAG = `ZZC${STAMP}`;
const A = `ZZCA${STAMP}`;    // an ordinary oil that HAS a candle version
const AC = `ZZCC${STAMP}`;   // its candle version
const B = `ZZCB${STAMP}`;    // an ordinary oil with none

const pool = new Pool({
  connectionString: process.env.PLATFORM_DATABASE_URL.replace('-pooler.', '.'),
  ssl: { rejectUnauthorized: false }, options: '-c search_path=sm,public',
});

let failed = 0, server, log = '';
const check = (ok, label, detail = '') => {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};
const oil = async (id) => Number((await pool.query(`SELECT "currentStock" c FROM sa.products WHERE id=$1`, [id])).rows[0].c);
const held = async (id, col) => Number((await pool.query(`SELECT ${col} v FROM sa.sector_held WHERE product_id=$1`, [id])).rows[0]?.v || 0);
const orderIds = [];

try {
  // ── Fixtures: three oils, one candle master with two variants, an order ─────
  for (const [id, name, qty] of [[A, 'ordinary', 50000], [AC, 'candle version', 10000], [B, 'no candle version', 50000]]) {
    await pool.query(
      `INSERT INTO sa.products (id, tag, name, category, "productCode", "currentStock", unit, status)
       VALUES ($1,$1,$2,'OILS',$1,$3,'mL','active')`, [id, `[regression] candle ${name}`, qty]);
  }
  // 3 L of the candle version sits in The Archive's own stock; the other 7 L is SA's.
  await pool.query(
    `INSERT INTO sa.sector_movements (product_id, from_sector, to_sector, quantity, kind, notes) VALUES ($1,'SA','MUSE_ARCHIVE',3000,'transfer','regression fixture')`, [AC]);

  const masterId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, is_master, is_candle, segment, current_stock, volume_ml, default_oil_pct)
     VALUES ($1,$2,'FINISHED_GOOD','units',true,true,'MUSE',0,300,12) RETURNING id`, [`${TAG} candle master`, `${TAG}_M`])).rows[0].id;
  const waxId = (await pool.query(
    `INSERT INTO products (name, product_code, category, unit, current_stock) VALUES ($1,$2,'COMPONENT','units',100000) RETURNING id`,
    [`${TAG} glass`, `${TAG}_G`])).rows[0].id;
  await pool.query(
    `INSERT INTO product_bom (product_type, component_product_id, quantity_formula, quantity_per_unit, sort_order, component_group, is_active)
     VALUES ($1,$2,'fixed',1,0,'core',true)`, [`${TAG}_M`, waxId]);
  for (const [n, o] of [[1, A], [2, B]]) {
    await pool.query(
      `INSERT INTO products (name, product_code, sku, category, unit, master_product_id, segment, current_stock, oil_id, business_unit)
       VALUES ($1,$2,$2,'FINISHED_GOOD','units',$3,'MUSE',0,$4,'archive')`, [`${TAG} candle ${n}`, `${TAG}_V${n}`, masterId, o]);
  }

  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', SM_SHOPIFY_API_SECRET: '', MUSE_SHOPIFY_API_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {   // the test copy takes ~50 s to boot
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot\n${log.slice(-1200)}`);

  const u = (await pool.query(`SELECT id, name FROM platform.users WHERE role IN ('root','admin') AND COALESCE(active,true) LIMIT 1`)).rows[0];
  const jwt = (await import('jsonwebtoken')).default;
  const sign = (role) => jwt.sign({ id: u.id, name: u.name, role, modules: ['SA', 'SM', 'MUSE', 'OPS'], must_change_password: false },
    process.env.PLATFORM_JWT_SECRET, { expiresIn: '15m' });
  const call = (token) => async (m, p, b) => {
    const r = await fetch(`${BASE}${p}`, { method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const admin = call(sign('root')), plain = call(sign('user'));

  // ── A. The candle version: one door, and out of the pickers ──────────────
  {
    let r = await plain('PUT', `/api/sa/products/${AC}/candle-of`, { candle_of: A });
    check(r.status === 403, 'linking a candle version is admin/root only', `got ${r.status}`);
    r = await admin('PUT', `/api/sa/products/${AC}/candle-of`, { candle_of: A });
    check(r.status === 200, 'the candle version is linked to its ordinary oil', `${r.status} ${JSON.stringify(r.body)}`);
    r = await admin('PUT', `/api/sa/products/${B}/candle-of`, { candle_of: A });
    check(r.status === 400, 'an oil cannot get a second candle version', `${r.status} ${r.body?.error}`);
    r = await admin('PUT', `/api/sa/products/${A}/candle-of`, { candle_of: B });
    check(r.status === 400, 'an oil that has a candle version cannot become one', `${r.status} ${r.body?.error}`);
    r = await admin('PUT', `/api/sa/products/${B}/candle-of`, { candle_of: AC });
    check(r.status === 400, 'a candle version cannot have a candle version', `${r.status} ${r.body?.error}`);

    const picker = (await admin('GET', '/api/sm/fragrance-library?segment=MUSE')).body || [];
    check(picker.some((o) => o.id === A) && !picker.some((o) => o.id === AC), 'the pickers offer the ordinary oil and never its candle version');
    const shown = (await admin('GET', '/api/sm/fragrance-library?segment=MUSE&include_inactive=1')).body || [];
    check(shown.find((o) => o.id === AC)?.candle_of === A, 'the Fragrances page still shows it, marked as a candle version');
  }

  // ── The order: line 1 pours A (→ its candle version), line 2 pours B ──────
  const created = await admin('POST', '/api/sm/production-orders', {
    client_id: null, order_type: 'STANDARD', notes: `${TAG} candle order`,
    lines: [
      { product_type: `${TAG}_M`, oil_id: A, quantity: 100, oil_pct: 12 },
      { product_type: `${TAG}_M`, oil_id: B, quantity: 10, oil_pct: 12 },
    ],
  });
  if (created.status >= 300) throw new Error(`order not created: ${created.status} ${JSON.stringify(created.body)}`);
  const orderId = created.body.id; orderIds.push(orderId);
  const lines = (await pool.query(
    `SELECT id, line_number, is_candle, oil_qty_ml FROM production_order_lines WHERE production_order_id=$1 ORDER BY line_number`, [orderId])).rows;
  const [L1, L2] = lines;
  check(lines.length === 2 && lines.every((l) => l.is_candle === true), 'a line is a candle because its master says so (not a legacy code)', JSON.stringify(lines));
  check(Number(L1.oil_qty_ml) === 3600, 'the recipe: 100 × 300 g × 12% = 3,600 mL', String(L1.oil_qty_ml));

  // ── B3. Start takes nothing for a candle ─────────────────────────────────
  await admin('PUT', `/api/sm/production-orders/${orderId}/status`, { status: 'queued' });
  const queued = ((await admin('GET', '/api/sm/manufacturing/queue')).body || []).find((o) => o.id === orderId);
  check(Array.isArray(queued?.shortages) && queued.shortages.length === 0, 'queued: the warning checks the candle version (10 L held, 3.6 L needed) → no shortage', JSON.stringify(queued?.shortages));
  const st = await admin('POST', `/api/sm/manufacturing/${orderId}/start`);
  check(st.status === 200, 'production starts', `${st.status} ${JSON.stringify(st.body)}`);
  check(await oil(A) === 50000 && await oil(AC) === 10000 && await oil(B) === 50000, 'Start Production takes NO oil for candle lines',
    `A=${await oil(A)} AC=${await oil(AC)} B=${await oil(B)}`);

  // ── A4. Which oil the candle pours ───────────────────────────────────────
  const info1 = (await admin('GET', `/api/sm/manufacturing/${orderId}/lines/${L1.id}/candle-oil`)).body;
  check(info1?.oil_id === AC && info1.is_candle_version === true && info1.calculated_ml === 3600,
    'line 1 resolves to the candle version, with the calculated amount', JSON.stringify(info1));
  const info2 = (await admin('GET', `/api/sm/manufacturing/${orderId}/lines/${L2.id}/candle-oil`)).body;
  check(info2?.oil_id === B && info2.is_candle_version === false, 'line 2 has no candle version → its ordinary oil', JSON.stringify(info2));

  // ── B2. The send ─────────────────────────────────────────────────────────
  let r = await plain('POST', `/api/sm/manufacturing/${orderId}/lines/${L1.id}/send-for-filling`, { supplier: 'Eric', oil_sent_ml: 5000 });
  check(r.status === 403, 'someone who is not admin/root cannot send oil', `got ${r.status}`);
  check(await oil(AC) === 10000, 'and nothing moved');

  r = await admin('POST', `/api/sm/manufacturing/${orderId}/lines/${L1.id}/send-for-filling`, { supplier: 'Eric', oil_sent_ml: 5000 });
  check(r.status === 200 && r.body.oil_sent_ml === 5000, 'admin sends line 1 with 5 L (rounded up from 3.6 L)', `${r.status} ${JSON.stringify(r.body)}`);
  const ep1 = r.body?.external_processing_id;
  check(await oil(AC) === 5000 && await oil(A) === 50000, 'the CANDLE VERSION is debited 5,000 mL; the ordinary oil is untouched', `AC=${await oil(AC)} A=${await oil(A)}`);
  check(await held(AC, 'muse_archive') === 0, "drawn the ordinary way: The Archive's own 3 L first, the other 2 L from SA", `archive=${await held(AC, 'muse_archive')}`);
  const tx = (await pool.query(`SELECT type, quantity, notes FROM sa.transactions WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [AC])).rows[0];
  check(tx?.type === 'muse_production' && Number(tx.quantity) === 5000 && /Candle filling: EP #\d+ · SM-\d+ · Eric/.test(tx.notes || ''),
    'one ledger row, tagged with the record, the order and the filler', JSON.stringify(tx));
  const epRow = (await pool.query(`SELECT * FROM external_processing WHERE id=$1`, [ep1])).rows[0];
  check(epRow?.oil_id === AC && Number(epRow.oil_qty_sent_ml) === 5000 && epRow.status === 'sent' && Number(epRow.qty_sent) === 100,
    'the record of what is at the filler: 100 candles, 5 L of the candle oil', JSON.stringify({ oil: epRow?.oil_id, ml: epRow?.oil_qty_sent_ml, st: epRow?.status, qty: epRow?.qty_sent }));
  const st1 = (await pool.query(`SELECT status FROM production_orders WHERE id=$1`, [orderId])).rows[0].status;
  check(st1 === 'waiting_external', 'the order waits for the filler', st1);

  r = await admin('PUT', `/api/sm/external-processing/${ep1}/oil-sent`, { oil_sent_ml: 5000 });
  check(r.status === 400 && await oil(AC) === 5000, 'a second send on the same record is refused and moves nothing', `${r.status} AC=${await oil(AC)}`);
  r = await admin('POST', `/api/sm/manufacturing/${orderId}/lines/${L1.id}/send-for-filling`, { supplier: 'Eric', oil_sent_ml: 5000 });
  check(r.status === 400 && await oil(AC) === 5000, 'and a line already out cannot be sent again', `${r.status} AC=${await oil(AC)}`);

  // Line 2 goes out with NO oil recorded (as a non-admin would send it).
  r = await plain('POST', `/api/sm/manufacturing/${orderId}/lines/${L2.id}/send-for-filling`, { supplier: 'Eric' });
  check(r.status === 200 && await oil(B) === 50000, 'a line can go out with no oil recorded; nothing is taken', `${r.status} B=${await oil(B)}`);
  const ep2 = r.body?.external_processing_id;

  // ── B4. The return ───────────────────────────────────────────────────────
  r = await admin('PUT', `/api/sm/external-processing/${ep1}/return`, { oil_returned_ml: 99999 });
  check(r.status === 400 && await oil(AC) === 5000, 'more back than was sent is refused', `${r.status} ${r.body?.error}`);
  r = await plain('PUT', `/api/sm/external-processing/${ep1}/return`, { oil_returned_ml: 100 });
  check(r.status === 403, 'returning oil is admin/root only', `got ${r.status}`);
  r = await admin('PUT', `/api/sm/external-processing/${ep2}/return`, { oil_returned_ml: 100 });
  check(r.status === 400, 'no oil can come back on a record that sent none', `${r.status} ${r.body?.error}`);

  r = await admin('PUT', `/api/sm/external-processing/${ep1}/return`, { oil_returned_ml: 2500 });
  check(r.status === 200 && await oil(AC) === 7500, '2.5 L comes back on its own → +2,500 mL', `${r.status} AC=${await oil(AC)}`);
  check(await held(AC, 'muse_archive') === 500, "back where it came from, SA first: SA gets its 2 L, The Archive the other 0.5 L", `archive=${await held(AC, 'muse_archive')}`);
  const stillSent = (await pool.query(`SELECT status FROM external_processing WHERE id=$1`, [ep1])).rows[0].status;
  check(stillSent === 'sent', 'an oil-only return does not close the record: the candles are still out', stillSent);

  r = await admin('POST', `/api/sm/manufacturing/${orderId}/lines/${L1.id}/receive-from-filling`, { oil_returned_ml: 800 });
  check(r.status === 200 && await oil(AC) === 8300, 'the candles return with 0.8 L more → 8,300 mL (1.7 L stayed in the candles)', `${r.status} AC=${await oil(AC)}`);
  check(await held(AC, 'muse_archive') === 1300, "that 0.8 L is The Archive's (SA already has all it gave)", `archive=${await held(AC, 'muse_archive')}`);
  const closed = (await pool.query(`SELECT status, qty_returned, oil_qty_returned_ml FROM external_processing WHERE id=$1`, [ep1])).rows[0];
  check(closed.status === 'done' && Number(closed.qty_returned) === 100 && Number(closed.oil_qty_returned_ml) === 3300,
    'the record closes: 100 candles back, 3.3 L of oil back', JSON.stringify(closed));
  const rev = (await pool.query(`SELECT type, notes FROM sa.transactions WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [AC])).rows[0];
  check(rev?.type === 'muse_reversal' && /Candle filling return: EP #/.test(rev.notes || ''), 'the return is its own ledger row', JSON.stringify(rev));

  // ── B3 safety net: line 2 finishes with no oil on record ─────────────────
  await admin('POST', `/api/sm/manufacturing/${orderId}/lines/${L2.id}/receive-from-filling`, {});
  const done = await admin('POST', `/api/sm/manufacturing/${orderId}/complete`, { line_leftovers: [] });
  check(done.status === 200 && JSON.stringify(done.body?.candle_lines_without_oil) === '[2]',
    'completing says which candle line never had its oil recorded (line 2), without blocking', `${done.status} ${JSON.stringify(done.body)}`);

  // ── R6. A line whose oil was taken at Start (before this release) ────────
  {
    const o2 = await admin('POST', '/api/sm/production-orders', {
      client_id: null, order_type: 'STANDARD', notes: `${TAG} legacy candle order`,
      lines: [{ product_type: `${TAG}_M`, oil_id: B, quantity: 10, oil_pct: 12 }],
    });
    const id2 = o2.body.id; orderIds.push(id2);
    await admin('PUT', `/api/sm/production-orders/${id2}/status`, { status: 'queued' });
    await admin('POST', `/api/sm/manufacturing/${id2}/start`);
    const l = (await pool.query(`SELECT id FROM production_order_lines WHERE production_order_id=$1`, [id2])).rows[0];
    await pool.query(`UPDATE production_order_lines SET oil_debited_at = NOW() WHERE id=$1`, [l.id]);
    const before = await oil(B);
    r = await admin('POST', `/api/sm/manufacturing/${id2}/lines/${l.id}/send-for-filling`, { supplier: 'Eric', oil_sent_ml: 500 });
    check(r.status === 200 && r.body.oil_skipped === 'debited_at_start' && await oil(B) === before,
      'a line debited at Start is sent without taking its oil a second time', `${r.status} ${JSON.stringify(r.body)} B=${await oil(B)}`);
  }

  console.log(failed === 0 ? `\n✅ d17-candle-oil: all checks passed` : `\n❌ d17-candle-oil: ${failed} failed`);
} catch (e) {
  console.error(`\n❌ d17-candle-oil: ${e.message}`);
  failed++;
} finally {
  if (failed > 0) {
    const l = log.split('\n').filter((x) => /candle|rror/i.test(x)).slice(-25);
    console.log(`\n─── server log ───\n${l.join('\n') || '(nothing)'}`);
  }
  if (server) server.kill();
  const q = (sql, p) => pool.query(sql, p).catch((e) => console.log('cleanup:', e.message));
  const ids = [...new Set([...orderIds, ...(await pool.query(`SELECT id FROM production_orders WHERE notes LIKE $1`, [`${TAG}%`])).rows.map((x) => x.id)])];
  if (ids.length) {
    await q(`DELETE FROM audit_log WHERE entity_type='external_processing' AND entity_id IN (SELECT id FROM external_processing WHERE production_order_id = ANY($1::int[]))`, [ids]);
    await q(`DELETE FROM external_processing WHERE production_order_id = ANY($1::int[])`, [ids]);
    await q(`DELETE FROM audit_log WHERE entity_type='production_order' AND entity_id = ANY($1::int[])`, [ids]);
    for (const t of ['production_order_components', 'stock_reservations', 'production_order_lines', 'production_jobs'])
      await q(`DELETE FROM ${t} WHERE production_order_id = ANY($1::int[])`, [ids]);
    await q(`DELETE FROM production_orders WHERE id = ANY($1::int[])`, [ids]);
  }
  const pids = (await pool.query(`SELECT id FROM products WHERE product_code LIKE $1`, [`${TAG}%`])).rows.map((x) => x.id);
  if (pids.length) {
    await q(`DELETE FROM audit_log WHERE entity_type='product' AND entity_id = ANY($1::int[])`, [pids]);
    await q(`DELETE FROM transactions WHERE product_id = ANY($1::int[])`, [pids]);
  }
  await q(`DELETE FROM product_bom WHERE product_type = $1`, [`${TAG}_M`]);
  await q(`DELETE FROM products WHERE product_code LIKE $1 AND master_product_id IS NOT NULL`, [`${TAG}%`]);
  await q(`DELETE FROM products WHERE product_code LIKE $1`, [`${TAG}%`]);
  const oils = [A, AC, B];
  await q(`DELETE FROM sa.audit_log WHERE entity_type='product' AND entity_id = ANY($1)`, [oils]);
  await q(`DELETE FROM sa.sector_movements WHERE product_id = ANY($1)`, [oils]);
  await q(`DELETE FROM sa.direct_stock_changes WHERE product_id = ANY($1)`, [oils]);
  await q(`DELETE FROM sa.transactions WHERE product_id = ANY($1)`, [oils]);
  await q(`UPDATE sa.products SET candle_of = NULL WHERE id = ANY($1)`, [oils]);
  await q(`DELETE FROM sa.products WHERE id = ANY($1)`, [oils]);
  await pool.end();
}
process.exitCode = failed === 0 ? 0 : 1;
