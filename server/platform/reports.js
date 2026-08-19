import express from 'express';
import { saPool, smPool, platformPool } from '../db.js';
import { requireRole } from './auth.js';
import { DIRECTION_SQL, BUSINESS_SQL } from './movement-direction.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// Centralized History & Activity (owner 2026-07-28) — one place that unions
// stock history and audit events across SA + Scented Merchandise + MUSE, for
// accountability ("who used what, when") + CSV export. Admin/root only.
//
// SA and SM live in separate schemas (one Neon DB, saPool/smPool have their own
// search_path), and both schemas' `transactions` / `audit_log` tables share the
// same core columns — so we query each pool with a common projection and merge
// in JS. System tag: SA rows -> 'SA'; SM rows -> 'MUSE' or 'Scented Merchandise'
// by the product's segment (audit rows: SA vs SM, MUSE split where derivable).
// ═══════════════════════════════════════════════════════════════════════

const SYSTEMS = ['SA', 'Scented Merchandise', 'MUSE', 'Platform'];
const cap = (v, def, max) => Math.min(parseInt(v) || def, max);

// t.* date/type/search filters — Sydney-local date matches the SA module's own
// /transactions route. Mutates params, returns the extended query string.
function txFilters(base, { from, to, type, search }, params) {
  let q = base;
  if (from)   { params.push(from);   q += ` AND (t.created_at AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`; }
  if (to)     { params.push(to);     q += ` AND (t.created_at AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`; }
  if (type)   { params.push(type);   q += ` AND t.type = $${params.length}`; }
  if (search) { params.push(`%${search}%`); q += ` AND (t.product_name ILIKE $${params.length} OR t.product_code ILIKE $${params.length})`; }
  return q;
}

const SA_TX = `
  SELECT t.id::text AS id, t.created_at, COALESCE(u.name, 'System') AS performed_by,
         t.type, t.category, t.product_name, t.product_code,
         t.quantity, t.unit, t.balance_after, t.notes, 'SA' AS system,
         ${DIRECTION_SQL()} AS direction
  FROM transactions t LEFT JOIN users u ON t.user_id = u.id
  WHERE 1=1`;

const SM_TX = `
  SELECT t.id::text AS id, t.created_at, COALESCE(u.name, 'System') AS performed_by,
         t.type, t.category, t.product_name, t.product_code,
         t.quantity, t.unit, t.balance_after, t.notes,
         CASE WHEN p.segment = 'MUSE' THEN 'MUSE' ELSE 'Scented Merchandise' END AS system,
         ${DIRECTION_SQL()} AS direction
  FROM transactions t
  LEFT JOIN users u ON t.user_id = u.id
  LEFT JOIN products p ON t.product_id = p.id
  WHERE 1=1`;

async function fetchHistory({ system, from, to, type, search, limit }) {
  const lim = cap(limit, 2000, 10000);
  const wantSA = !system || system === 'ALL' || system === 'SA';
  const wantSM = !system || system === 'ALL' || system === 'SM' || system === 'MUSE' || system === 'Scented Merchandise';
  const jobs = [];
  if (wantSA) { const p = []; jobs.push(saPool.query(txFilters(SA_TX, { from, to, type, search }, p) + ` ORDER BY t.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
  if (wantSM) { const p = []; jobs.push(smPool.query(txFilters(SM_TX, { from, to, type, search }, p) + ` ORDER BY t.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
  let rows = (await Promise.all(jobs)).flat();
  if (system && system !== 'ALL' && system !== 'SM') rows = rows.filter(r => r.system === system);  // 'SM' keeps both Scented + MUSE  // MUSE/Scented split
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return rows.slice(0, lim);
}

// audit_log has identical columns in both schemas → one projection, no joins to
// products (audit rows aren't product-scoped). SM MUSE/Scented split isn't always
// derivable from the event, so SM audit is tagged 'Scented Merchandise' unless the
// details JSON carries an explicit segment.
// nameExpr: platform.audit_log has no entity_name column (SA and SM do), so the
// search filter has to point at whatever stands in for it. Passing it in keeps
// one filter function for all three schemas instead of a second copy — the kind
// of duplication that let the webhook topics and format lists drift apart.
function auditFilters(base, { from, to, action, search }, params, nameExpr = 'al.entity_name') {
  let q = base;
  if (from)   { params.push(from);   q += ` AND (al.created_at AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`; }
  if (to)     { params.push(to);     q += ` AND (al.created_at AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`; }
  if (action) { params.push(action); q += ` AND al.action = $${params.length}`; }
  if (search) { params.push(`%${search}%`); q += ` AND (${nameExpr} ILIKE $${params.length} OR al.action ILIKE $${params.length})`; }
  return q;
}

const SA_AUDIT = `
  SELECT al.id::text AS id, al.created_at, COALESCE(u.name, 'System') AS performed_by,
         al.action, al.entity_type, al.entity_name, al.details::text AS details, 'SA' AS system
  FROM audit_log al LEFT JOIN users u ON al.user_id = u.id
  WHERE 1=1`;

const SM_AUDIT = `
  SELECT al.id::text AS id, al.created_at, COALESCE(u.name, 'System') AS performed_by,
         al.action, al.entity_type, al.entity_name, al.details::text AS details,
         CASE WHEN al.details->>'segment' = 'MUSE' THEN 'MUSE' ELSE 'Scented Merchandise' END AS system
  FROM audit_log al LEFT JOIN users u ON al.user_id = u.id
  WHERE 1=1`;

// The platform schema holds the events that belong to no single business:
// sign-ins, module access grants, password changes, fragrance transfers between
// SA and SM, product links. 515 of them were invisible here until 2026-08-13 —
// fetchActivity queried saPool and smPool and never platformPool — on the one
// page whose stated purpose is "who used what, when".
//
// It has no entity_name column, so a readable label is derived from details;
// the keys below are the ones its writers actually use.
const PF_NAME = `COALESCE(al.details->>'name', al.details->>'fragrance', al.details->>'sm',
                          al.entity_type || ' #' || al.entity_id)`;
const PF_AUDIT = `
  SELECT al.id::text AS id, al.created_at, COALESCE(u.name, 'System') AS performed_by,
         al.action, al.entity_type, ${PF_NAME} AS entity_name,
         al.details::text AS details, 'Platform' AS system
  FROM platform.audit_log al LEFT JOIN platform.users u ON al.user_id = u.id
  WHERE 1=1`;

async function fetchActivity({ system, from, to, action, search, limit }) {
  const lim = cap(limit, 2000, 10000);
  const wantSA = !system || system === 'ALL' || system === 'SA';
  const wantSM = !system || system === 'ALL' || system === 'SM' || system === 'MUSE' || system === 'Scented Merchandise';
  const wantPF = !system || system === 'ALL' || system === 'Platform';
  const jobs = [];
  if (wantSA) { const p = []; jobs.push(saPool.query(auditFilters(SA_AUDIT, { from, to, action, search }, p) + ` ORDER BY al.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
  if (wantSM) { const p = []; jobs.push(smPool.query(auditFilters(SM_AUDIT, { from, to, action, search }, p) + ` ORDER BY al.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
  if (wantPF) { const p = []; jobs.push(platformPool.query(auditFilters(PF_AUDIT, { from, to, action, search }, p, PF_NAME) + ` ORDER BY al.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
  let rows = (await Promise.all(jobs)).flat();
  if (system && system !== 'ALL' && system !== 'SM') rows = rows.filter(r => r.system === system);  // 'SM' keeps both Scented + MUSE
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return rows.slice(0, lim);
}

// ── CSV export helpers ──────────────────────────────────────────────────
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const syd = (d) => d ? new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : '';
function sendCsv(res, name, header, cols, rows, dateCol) {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(cols.map(c => csvCell(c === dateCol ? syd(r[c]) : r[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\r\n'));
}


// ═══════════════════════════════════════════════════════════════════════
// STATEMENT (owner 2026-08-19) — the question the History list could not answer
// ═══════════════════════════════════════════════════════════════════════
// His words: *"eu penso no History e Activity como uma fonte de auditoria"*, and
// the test question was the spec: for Santal 33, from the start of the month to
// now — how much was there, how much was used, who used it, was it SA or MUSE?
//
// Searching the list already worked. It returned 271 rows for Zen Garden, and
// not one of them answered him; only their total would. So this is not another
// filter, it is the arithmetic: open, move, close, and check.
//
// OPENING BALANCE HAS TWO STATES, and they must never be shown as one:
//   known    the balance_after of the last movement before the period
//   unknown  no movement before it — nothing was ever received, so every figure
//            here is relative, not absolute
// Fourteen MUSE components are in the second state: the first movement of their
// lives was a consumption. A statement claiming they "reconcile" would be lying.
// The owner's analogy is exact — a car's odometer only moves when the car moves,
// and on those it was fitted after the car had already been driven.
//
// GENERIC ACROSS PRODUCT TYPES on purpose (owner decision): components, labels
// and ethanol ask the same question and the arithmetic is identical.
const POOL_FOR = { SA: () => saPool, SM: () => smPool };
const STOCK_COL = { SA: '"currentStock"', SM: 'current_stock' };
const CODE_COL  = { SA: '"productCode"', SM: 'product_code' };

router.get('/statement', requireRole('root', 'admin'), async (req, res) => {
  try {
    const schema = String(req.query.schema || 'SA').toUpperCase();
    const code = String(req.query.code || '').trim();
    const { from, to } = req.query;
    if (!POOL_FOR[schema]) return res.status(400).json({ error: 'schema must be SA or SM' });
    if (!code) return res.status(400).json({ error: 'code required' });
    const pool = POOL_FOR[schema]();

    const prod = (await pool.query(
      `SELECT name, unit, ${STOCK_COL[schema]}::float AS stock FROM products WHERE ${CODE_COL[schema]} = $1`,
      [code])).rows[0];
    if (!prod) return res.status(404).json({ error: 'product not found' });

    // Opening: the balance the ledger last recorded before the window. Read, not
    // computed — sa.transactions carries balance_after on every row, so there is
    // no need to replay history and no chance of drifting from it.
    const openRow = from ? (await pool.query(
      `SELECT balance_after::float b FROM transactions
        WHERE product_code = $1 AND (created_at AT TIME ZONE 'Australia/Sydney')::date < $2::date
        ORDER BY created_at DESC, id DESC LIMIT 1`, [code, from])).rows[0] : null;

    // When nothing precedes the window, the opening is NOT zero — it is whatever
    // the product held before its first recorded movement, which is that
    // movement's balance_after minus its own effect.
    //
    // Assuming zero broke every full-history statement: 59 of 60 SA products
    // came out short, because the July migration set balances directly and wrote
    // no transaction for them. FRAG_0003 was out by 59,000. The ledger starts
    // mid-life, and the first row still says what the shelf held before it.
    // The first movement INSIDE the window, not the first ever. Reading the
    // first of all time gave LBL_00001 an opening of −500 for August, because
    // its earliest movement is months old and has nothing to do with the period
    // being asked about.
    const firstRow = openRow ? null : (await pool.query(
      `SELECT balance_after::float b, quantity::float q, ${DIRECTION_SQL('type')} AS direction
         FROM transactions WHERE product_code = $1
           ${from ? "AND (created_at AT TIME ZONE 'Australia/Sydney')::date >= '" + String(from).replace(/'/g, '') + "'::date" : ''}
        ORDER BY created_at ASC, id ASC LIMIT 1`, [code])).rows[0];

    // Whether the product has EVER been received is the thing worth flagging —
    // not the opening figure, which is always computable.
    //
    // The first version of this reported "opening UNKNOWN" whenever nothing
    // preceded the window, and that was wrong twice over: it said UNKNOWN for a
    // label whose 500 were entered inside the window (opening was plainly 0),
    // and it dressed up the real problem as a missing number. The real problem
    // is that fourteen MUSE components have never had a receipt of any kind, so
    // their 0 is an assumption nobody made deliberately — there are bottles on
    // the shelf that the system has never been told about. The arithmetic still
    // works; it is the ground it starts from that is fiction.
    const receipts = Number((await pool.query(
      `SELECT count(*) c FROM transactions WHERE product_code = $1
         AND type IN ('add','transfer_in','incoming','ready_formula_in','production_in')`,
      [code])).rows[0].c);

    // Built with the alias it is used under. An earlier version wrote it for
    // `t.` and rewrote the prefix with a regex before use — one lost backslash
    // and `/t./g` would have mangled every word containing a t.
    const params = [code];
    let period = '';
    if (from) { params.push(from); period += ` AND (e.created_at AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`; }
    if (to)   { params.push(to);   period += ` AND (e.created_at AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`; }

    // Each movement's SIGNED EFFECT, taken from what the balance actually did —
    // not from the recorded magnitude and not from the type.
    //
    // Summing magnitudes by a type→direction map does not reconcile, and the
    // first version of this proved it: LBL_00001 came out at −84 against a real
    // 498, because `adjust` is deliberately neutral for DISPLAY (it can go
    // either way, so the row must not claim one) and a neutral type contributed
    // nothing to the arithmetic. An adjustment moves stock like anything else.
    //
    // balance_after is on every row, so the effect is knowable exactly. The type
    // still labels the row; it no longer decides the sum.
    const moves = (await pool.query(`
      WITH e AS (
        SELECT t.type, t.quantity::float AS qty, t.balance_after::float AS bal,
               t.balance_after::float - lag(t.balance_after::float)
                 OVER (PARTITION BY t.product_code ORDER BY t.created_at, t.id) AS effect,
               t.created_at,
               -- No previous row means no delta to read. The type map supplies
               -- the SIGN then — never the bare magnitude, which added an
               -- outbound instead of subtracting it and left every product whose
               -- first movement was a sale off by exactly twice that first
               -- quantity. LBL_00001 and COMP_00006 were each out by 4.
               CASE WHEN ${DIRECTION_SQL()} = 'out' THEN -t.quantity::float
                    ELSE t.quantity::float END AS signed_fallback
          FROM transactions t WHERE t.product_code = $1)
      SELECT e.type, ${BUSINESS_SQL('e.type')} AS business,
             sum(COALESCE(e.effect, e.signed_fallback))::float AS effect,
             sum(e.qty)::float AS recorded,
             count(*)::int AS movements
        FROM e WHERE true ${period}
       GROUP BY 1, 2 ORDER BY abs(sum(COALESCE(e.effect, e.signed_fallback))) DESC`, params)).rows;

    const ins  = moves.filter((m) => m.effect > 0).reduce((a, m) => a + m.effect, 0);
    const outs = moves.filter((m) => m.effect < 0).reduce((a, m) => a - m.effect, 0);

    // balance_after can be NULL — LBL_00001's very first row is the opening
    // delivery and carries none. `null - 500` is -500 in JavaScript, which is
    // how August came out at -500 instead of 0. A row with no recorded balance
    // says nothing about what came before it, so the honest reading is zero.
    const opening = openRow?.b != null ? openRow.b
      : firstRow?.b != null ? firstRow.b - (firstRow.direction === 'out' ? -firstRow.q : firstRow.q)
      : 0;
    const closing = opening + ins - outs;

    res.json({
      product: { schema, code, name: prod.name, unit: prod.unit, stock_now: prod.stock },
      period: { from: from || null, to: to || null },
      opening,
      // The caveat that matters, and it is not about the number above.
      ever_received: receipts > 0,
      received: ins,
      used: outs,
      closing,
      // The audit property: the ledger must add up to the shelf.
      reconciles: Math.abs(closing - prod.stock) < 0.001,
      movements: moves,
    });
  } catch (e) { console.error('[platform/statement]', e.message); res.status(500).json({ error: 'Failed to build statement' }); }
});

// Product picker for the statement. Searching "Santal" in the list returned 337
// rows across SEVEN different products with nothing saying so; this makes the
// choice explicit before any arithmetic is done on it.
router.get('/statement/products', requireRole('root', 'admin'), async (req, res) => {
  try {
    const q = `%${String(req.query.q || '').trim()}%`;
    const [sa, sm] = await Promise.all([
      saPool.query(`SELECT "productCode" AS code, name, category, unit, "currentStock"::float AS stock, 'SA' AS schema
                      FROM products WHERE name ILIKE $1 OR "productCode" ILIKE $1 ORDER BY name LIMIT 25`, [q]),
      smPool.query(`SELECT product_code AS code, name, category, unit, current_stock::float AS stock, 'SM' AS schema
                      FROM products WHERE (name ILIKE $1 OR product_code ILIKE $1)
                        AND COALESCE(archived,false) = false ORDER BY name LIMIT 25`, [q]),
    ]);
    res.json([...sa.rows, ...sm.rows]);
  } catch (e) { console.error('[platform/statement/products]', e.message); res.status(500).json({ error: 'Failed to search' }); }
});

// ── Routes ──────────────────────────────────────────────────────────────
router.get('/history', requireRole('root', 'admin'), async (req, res) => {
  try { res.json(await fetchHistory(req.query)); }
  catch (e) { console.error('[platform/history]', e.message); res.status(500).json({ error: 'Failed to load history' }); }
});

router.get('/history/export', requireRole('root', 'admin'), async (req, res) => {
  try {
    const rows = await fetchHistory({ ...req.query, limit: 10000 });
    sendCsv(res, 'history',
      ['Date (Sydney)', 'System', 'Performed By', 'Type', 'Category', 'Product', 'Code', 'Quantity', 'Unit', 'Balance After', 'Notes'],
      ['created_at', 'system', 'performed_by', 'type', 'category', 'product_name', 'product_code', 'quantity', 'unit', 'balance_after', 'notes'],
      rows, 'created_at');
  } catch (e) { console.error('[platform/history/export]', e.message); res.status(500).json({ error: 'Failed to export' }); }
});

router.get('/activity', requireRole('root', 'admin'), async (req, res) => {
  try { res.json(await fetchActivity(req.query)); }
  catch (e) { console.error('[platform/activity]', e.message); res.status(500).json({ error: 'Failed to load activity' }); }
});

router.get('/activity/export', requireRole('root', 'admin'), async (req, res) => {
  try {
    const rows = await fetchActivity({ ...req.query, limit: 10000 });
    sendCsv(res, 'activity',
      ['Date (Sydney)', 'System', 'Performed By', 'Action', 'Entity Type', 'Entity', 'Details'],
      ['created_at', 'system', 'performed_by', 'action', 'entity_type', 'entity_name', 'details'],
      rows, 'created_at');
  } catch (e) { console.error('[platform/activity/export]', e.message); res.status(500).json({ error: 'Failed to export' }); }
});

router.get('/reports/systems', requireRole('root', 'admin'), (_req, res) => res.json(SYSTEMS));

export default router;
