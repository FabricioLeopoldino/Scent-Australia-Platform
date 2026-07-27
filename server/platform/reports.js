import express from 'express';
import { saPool, smPool } from '../db.js';
import { requireRole } from './auth.js';

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

const SYSTEMS = ['SA', 'Scented Merchandise', 'MUSE'];
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
         t.quantity, t.unit, t.balance_after, t.notes, 'SA' AS system
  FROM transactions t LEFT JOIN users u ON t.user_id = u.id
  WHERE 1=1`;

const SM_TX = `
  SELECT t.id::text AS id, t.created_at, COALESCE(u.name, 'System') AS performed_by,
         t.type, t.category, t.product_name, t.product_code,
         t.quantity, t.unit, t.balance_after, t.notes,
         CASE WHEN p.segment = 'MUSE' THEN 'MUSE' ELSE 'Scented Merchandise' END AS system
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
function auditFilters(base, { from, to, action, search }, params) {
  let q = base;
  if (from)   { params.push(from);   q += ` AND (al.created_at AT TIME ZONE 'Australia/Sydney')::date >= $${params.length}::date`; }
  if (to)     { params.push(to);     q += ` AND (al.created_at AT TIME ZONE 'Australia/Sydney')::date <= $${params.length}::date`; }
  if (action) { params.push(action); q += ` AND al.action = $${params.length}`; }
  if (search) { params.push(`%${search}%`); q += ` AND (al.entity_name ILIKE $${params.length} OR al.action ILIKE $${params.length})`; }
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

async function fetchActivity({ system, from, to, action, search, limit }) {
  const lim = cap(limit, 2000, 10000);
  const wantSA = !system || system === 'ALL' || system === 'SA';
  const wantSM = !system || system === 'ALL' || system === 'SM' || system === 'MUSE' || system === 'Scented Merchandise';
  const jobs = [];
  if (wantSA) { const p = []; jobs.push(saPool.query(auditFilters(SA_AUDIT, { from, to, action, search }, p) + ` ORDER BY al.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
  if (wantSM) { const p = []; jobs.push(smPool.query(auditFilters(SM_AUDIT, { from, to, action, search }, p) + ` ORDER BY al.created_at DESC LIMIT ${lim}`, p).then(r => r.rows)); }
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
