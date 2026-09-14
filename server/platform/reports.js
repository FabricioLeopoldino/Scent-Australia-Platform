import express from 'express';
import { saPool, smPool, platformPool } from '../db.js';
import { requireRole } from './auth.js';
import { DIRECTION_SQL, BUSINESS_SQL, SA_SYSTEM_SQL, systemMatches, typesVisibleIn } from './movement-direction.js';
import { SYSTEM_NAMES } from '../../shared/business-names.js';

// ── Timestamps ───────────────────────────────────────────────────────────
// WHY THIS EXISTS (2026-09-15). `created_at` is `timestamp WITHOUT time zone`
// holding UTC, and server/index.js sets process.env.TZ='Australia/Sydney'. So
// the pg driver parsed each value as if it were already Sydney local, and every
// timestamp in this report came out TEN HOURS EARLY — on both the screen and
// the CSV. A Fig Tree movement made at 10:17 in the morning read "12:17 am",
// and because it crosses midnight it also showed on the wrong DAY.
//
// The date filters had the mirror of the same fault: `created_at AT TIME ZONE
// 'Australia/Sydney'` INTERPRETS a naive timestamp as Sydney rather than
// converting a UTC one to it. Asking for 11 September returned 0 rows; the real
// answer was 139. The warehouse works 08:00–18:00 Sydney, which is 22:00–08:00
// UTC, so every single movement landed on the previous day. The owner's words
// for the report were "cheio de bugs", and this is most of them: one root cause
// wearing three faces.
//
// Handing out an explicit UTC instant fixes both readers at once — the screen's
// fmt() already appends nothing when it sees a Z, and the CSV's Date parse gets
// the right moment. Nothing downstream has to know about the trap.
const UTC_ISO = (col) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`;


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

const SYSTEMS = ['SA', SYSTEM_NAMES.SM, 'MUSE', 'Platform'];
const cap = (v, def, max) => Math.min(parseInt(v) || def, max);

// t.* date/type/search filters — Sydney-local date matches the SA module's own
// /transactions route. Mutates params, returns the extended query string.
function txFilters(base, { from, to, type, search }, params) {
  let q = base;
  if (from)   { params.push(from);   q += ` AND (t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`; }
  if (to)     { params.push(to);     q += ` AND (t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`; }
  if (type)   { params.push(type);   q += ` AND t.type = $${params.length}`; }
  // Notes included deliberately: the Shopify order number ("Shopify Order
  // #1032.1") exists ONLY in the note, so without this, searching the very
  // number printed on the row finds nothing (owner, 8 Sep).
  if (search) { params.push(`%${search}%`); q += ` AND (t.product_name ILIKE $${params.length} OR t.product_code ILIKE $${params.length} OR t.notes ILIKE $${params.length})`; }
  return q;
}

const SA_TX = `
  SELECT t.id::text AS id, ${UTC_ISO('t.created_at')}, COALESCE(u.name, 'System') AS performed_by,
         t.type, t.category, t.product_name, t.product_code,
         t.quantity, t.unit, t.balance_after, t.notes, ${SA_SYSTEM_SQL()} AS system,
         ${DIRECTION_SQL()} AS direction
  FROM transactions t LEFT JOIN users u ON t.user_id = u.id
  WHERE 1=1`;

const SM_TX = `
  SELECT t.id::text AS id, ${UTC_ISO('t.created_at')}, COALESCE(u.name, 'System') AS performed_by,
         t.type, t.category, t.product_name, t.product_code,
         t.quantity, t.unit, t.balance_after, t.notes,
         CASE WHEN p.segment = 'MUSE' THEN 'MUSE' ELSE '${SYSTEM_NAMES.SM}' END AS system,
         ${DIRECTION_SQL()} AS direction
  FROM transactions t
  LEFT JOIN users u ON t.user_id = u.id
  LEFT JOIN products p ON t.product_id = p.id
  WHERE 1=1`;

async function fetchHistory({ system, from, to, type, search, limit }) {
  const lim = cap(limit, 2000, 10000);
  // sa is read for MUSE and Scented too: the oil they consume is recorded
  // there, and skipping it is what made the MUSE filter show no fragrance.
  const wantSA = !system || system === 'ALL' || system === 'SA'
    || system === 'SM' || system === 'MUSE' || system === SYSTEM_NAMES.SM;
  const wantSM = !system || system === 'ALL' || system === 'SM' || system === 'MUSE' || system === SYSTEM_NAMES.SM;
  const jobs = [];
  if (wantSA) {
    const p = [];
    let q = txFilters(SA_TX, { from, to, type, search }, p);
    // When only the other business is asked for, narrow sa IN THE QUERY. Doing
    // it in JS after the LIMIT drops the oldest cross-system rows before the
    // filter runs — on 8 Sep they sat at positions 19..2601 and the screen asks
    // for 2000, so some were already invisible.
    if (system && system !== 'ALL' && system !== 'SA') {
      p.push(typesVisibleIn(system));
      q += ` AND t.type = ANY($${p.length}::text[])`;
    }
    jobs.push(saPool.query(q + ` ORDER BY t.created_at DESC LIMIT ${lim}`, p).then(r => r.rows));
  }
  if (wantSM) { const p = []; jobs.push(smPool.query(txFilters(SM_TX, { from, to, type, search }, p) + ` ORDER BY t.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
  let rows = (await Promise.all(jobs)).flat();
  // 'SM' keeps both Scented + MUSE; a composite 'SA · MUSE' satisfies either half.
  if (system && system !== 'ALL' && system !== 'SM') rows = rows.filter(r => systemMatches(r.system, system));
  else if (system === 'SM') rows = rows.filter(r => r.system !== 'SA');  // sa-only rows are not SM's
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
  if (from)   { params.push(from);   q += ` AND (al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`; }
  if (to)     { params.push(to);     q += ` AND (al.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`; }
  if (action) { params.push(action); q += ` AND al.action = $${params.length}`; }
  if (search) { params.push(`%${search}%`); q += ` AND (${nameExpr} ILIKE $${params.length} OR al.action ILIKE $${params.length})`; }
  return q;
}

const SA_AUDIT = `
  SELECT al.id::text AS id, ${UTC_ISO('al.created_at')}, COALESCE(u.name, 'System') AS performed_by,
         al.action, al.entity_type, al.entity_name, al.details::text AS details, 'SA' AS system
  FROM audit_log al LEFT JOIN users u ON al.user_id = u.id
  WHERE 1=1`;

const SM_AUDIT = `
  SELECT al.id::text AS id, ${UTC_ISO('al.created_at')}, COALESCE(u.name, 'System') AS performed_by,
         al.action, al.entity_type, al.entity_name, al.details::text AS details,
         CASE WHEN al.details->>'segment' = 'MUSE' THEN 'MUSE' ELSE '${SYSTEM_NAMES.SM}' END AS system
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
  SELECT al.id::text AS id, ${UTC_ISO('al.created_at')}, COALESCE(u.name, 'System') AS performed_by,
         al.action, al.entity_type, ${PF_NAME} AS entity_name,
         al.details::text AS details, 'Platform' AS system
  FROM platform.audit_log al LEFT JOIN platform.users u ON al.user_id = u.id
  WHERE 1=1`;

async function fetchActivity({ system, from, to, action, search, limit }) {
  const lim = cap(limit, 2000, 10000);
  const wantSA = !system || system === 'ALL' || system === 'SA';
  const wantSM = !system || system === 'ALL' || system === 'SM' || system === 'MUSE' || system === SYSTEM_NAMES.SM;
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
  // The leading BOM is what makes Excel read this as UTF-8. The charset in the
  // header above does not reach it: a downloaded .csv is opened from disk, and
  // Excel on Windows then assumes the system code page. Every em-dash in the
  // notes — "Shopify Order #1035.1 — fulfilled" — arrived as "â€"".
  res.send('﻿' + lines.join('\r\n'));
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

// The last recorded balance at or around a date — one query, used for both the
// window's opening (before `from`) and its closing (at or before `to`). Code
// review caught these as two hand-written copies that would drift if one were
// fixed without the other (a timezone or tie-break change, say). `inclusive`
// is the one real difference: opening wants strictly BEFORE `from` — a
// movement ON that day belongs to the period, not before it — while closing
// wants AT OR BEFORE `to`, since a movement on the last day of a period is
// still part of it.
async function lastBalanceAsOf(pool, code, date, { inclusive, requireNonNull = false } = {}) {
  const op = inclusive ? '<=' : '<';
  const notNull = requireNonNull ? 'AND balance_after IS NOT NULL' : '';
  const r = await pool.query(
    `SELECT balance_after::float b FROM transactions
      WHERE product_code = $1 ${notNull}
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date ${op} $2::date
      ORDER BY created_at DESC, id DESC LIMIT 1`, [code, date]);
  return r.rows[0];
}

router.get('/statement', requireRole('root', 'admin'), async (req, res) => {
  try {
    const schema = String(req.query.schema || 'SA').toUpperCase();
    const code = String(req.query.code || '').trim();
    const { from, to } = req.query;
    if (!POOL_FOR[schema]) return res.status(400).json({ error: 'schema must be SA or SM' });
    if (!code) return res.status(400).json({ error: 'code required' });
    const pool = POOL_FOR[schema]();

    // Whether the window reaches today decides what "reconciles" is FOR, not
    // whether `to` happens to be present. Typing today's own date into `to`
    // is a bounded query by the crude test, and comparing it against the
    // ledger's own last row (rather than the live shelf) would silently stop
    // catching the fault this flag exists for — stock changed by something
    // that bypassed the ledger entirely — the moment someone picks "today" as
    // an end date instead of leaving it blank. Read from Postgres, in Sydney
    // time, the same way every other date on this endpoint is compared —
    // never from a local Date, which is how a wrong hour was quoted to the
    // owner once already (see memory: audit-timestamps-are-utc-naive).
    const reachesToday = !to || Boolean((await pool.query(
      `SELECT $1::date >= (now() AT TIME ZONE 'Australia/Sydney')::date AS reaches`, [to]
    )).rows[0].reaches);

    const prod = (await pool.query(
      `SELECT name, unit, ${STOCK_COL[schema]}::float AS stock FROM products WHERE ${CODE_COL[schema]} = $1`,
      [code])).rows[0];
    if (!prod) return res.status(404).json({ error: 'product not found' });

    // Opening: the balance the ledger last recorded before the window. Read, not
    // computed — sa.transactions carries balance_after on every row, so there is
    // no need to replay history and no chance of drifting from it.
    const openRow = from ? await lastBalanceAsOf(pool, code, from, { inclusive: false }) : null;

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
           ${from ? "AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date >= '" + String(from).replace(/'/g, '') + "'::date" : ''}
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
    if (from) { params.push(from); period += ` AND (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`; }
    if (to)   { params.push(to);   period += ` AND (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`; }

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
      SELECT ${BUSINESS_SQL('e.type')} AS business,
             string_agg(DISTINCT e.type, ', ' ORDER BY e.type) AS types,
             sum(COALESCE(e.effect, e.signed_fallback))::float AS effect,
             sum(e.qty)::float AS recorded,
             count(*)::int AS movements
        FROM e WHERE true ${period}
       GROUP BY 1 ORDER BY abs(sum(COALESCE(e.effect, e.signed_fallback))) DESC`, params)).rows;

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

    // What "reconciles" must compare against depends on whether the window
    // reaches today. Comparing a BOUNDED period (a `to` in the past) against
    // the CURRENT shelf made every closed period read as broken the moment
    // anything sold afterwards — found 2026-09-09 asking for FRAG_0032 up to
    // 31 August: closing computed 80,200, matched the ledger's own
    // balance_after for that date exactly, and still came back reconciles:
    // false, because five real sales happened in September. The arithmetic
    // was never wrong; the reference point was.
    //
    // A bounded period (reachesToday === false) reconciles against the
    // ledger's OWN balance_after at `to` — read directly, the same way
    // `openRow` reads the one before `from`. That still catches the fault
    // this flag exists for: a gap or a corrupt row breaking the delta chain
    // between `opening` and here. A period reaching today is the one case
    // that can catch a DIFFERENT fault — stock changed by something that
    // bypassed the ledger entirely — and for that the current shelf is still
    // the only honest answer, whether `to` was left blank or typed as today.
    const closeRow = reachesToday ? null
      : await lastBalanceAsOf(pool, code, to, { inclusive: true, requireNonNull: true });
    // No row found means one of two different things, and they need opposite
    // fallbacks:
    //   nothing exists before/at `to` at all (asked about a product before it
    //     ever moved) — `moves` is filtered by the same `to`, so it is
    //     necessarily empty too, closing === opening by construction, and
    //     `opening` IS the honest shelf: nothing happened, there is nothing to
    //     fail to reconcile. Tried `?? prod.stock` first and it was wrong —
    //     FRAG_0328 asked with to=2026-06-01, before it existed, came back
    //     closing 0 vs today's 13,000 and a false alarm that nothing caused.
    //   every row up to `to` has a null balance_after (the six LBL_ products'
    //     single first-ever row) — `opening` is no longer independent here,
    //     since a hidden non-zero movement could still be hiding behind
    //     signed_fallback. Unreachable today (every one of those six gets a
    //     real balance the same day, so closeRow always finds it in
    //     practice) — kept as a known, named gap rather than solved for,
    //     because the fix that closes it correctly would need to walk the
    //     delta chain forward from the nearest real balance, and nothing in
    //     six products' worth of real data can exercise it to prove that
    //     code path actually works.
    // `opening` is the right fallback ONLY for a genuinely bounded window that
    // found nothing before `to` — a window reaching today must keep comparing
    // against the real shelf, and collapsing both "closeRow is null" causes
    // into one fallback broke exactly that: it made every full-history
    // statement compare against `opening` instead of `prod.stock`, which is
    // wrong the instant anything has ever moved.
    const shelfAtEnd = reachesToday ? prod.stock : (closeRow?.b ?? opening);

    res.json({
      product: { schema, code, name: prod.name, unit: prod.unit, stock_now: prod.stock },
      period: { from: from || null, to: to || null },
      opening,
      // The caveat that matters, and it is not about the number above.
      ever_received: receipts > 0,
      received: ins,
      used: outs,
      closing,
      // What "reconciles" was actually checked against — NOT always
      // stock_now above. The UI must show this one next to `closing`, or a
      // bounded period reads as broken the moment anything sells afterwards.
      shelf_at_end: shelfAtEnd,
      // Whether shelf_at_end IS stock_now — never re-derived from `to` being
      // present, which is the mistake that put "Ledger balance, {date}" on
      // screen next to a number that was actually today's live stock (code
      // review, this same day). One computation, read by both ends.
      reaches_today: reachesToday,
      // The audit property: the ledger must add up to itself at `to`, or to
      // the shelf when the window reaches today.
      reconciles: Math.abs(closing - shelfAtEnd) < 0.001,
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
