// H4 — Purchase Orders, one place for every order (PRD_H4_PURCHASE_ORDERS.md,
// owner 2–5 Nov 2026).
//
// Every new order is raised in Shopify (D3, owner 5 Nov: "não vai ser
// permitido, tudo deverá ser feito através do Shopify"). This file reads those
// orders against what the platform holds and puts both in one list. It accepts
// the clean lines by itself (R7, D6) and works out when an order has finished
// on both sides (R8, D7). It also owns the two acts H4 adds: correcting a
// receipt (R4) and cancelling a line with its reason (R5).
//
// Receiving stays where it was, in POST /purchase-orders/:poId/receive in
// index.js. H4 changes where things are done, not what they do to stock (R1).
import express from 'express';
import { saPool as pool } from '../db.js';
import { readIncomingPurchaseOrders, costPerMl, VARIANT_ML } from './shopify-purchase-orders.js';
import { registrationsByProduct, recordMovement, recordRefusal, errorBody, qtyText, balancesAfterCommit } from './sectors.js';
import { companyOf, sectorLabel, destinationByStock } from '../../shared/sectors.js';

export const router = express.Router();

const isAdmin = (req) => ['admin', 'root'].includes(req.user?.role);
const bad = (msg, extra) => Object.assign(new Error(msg), { status: 400, ...extra });
const json = (v) => {
  if (v == null) return {};
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};
const sydneyDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
// The digits of a PO number, so "#PO283", "PO283" and "po283" are one order.
// "PO" must start a word, so "SUPPO12" is not PO 12 (code review, 5 Nov; the
// hand-typed numbers in the data are "PO283" and "po283", both still matched).
export const poDigits = (s) => (String(s || '').match(/(?<![A-Za-z])PO\s*-?\s*(\d+)/i) || [])[1] || null;
export const AUTO_BY = 'Automatic (Shopify)';

export async function migratePurchaseOrders() {
  // Cancel and close short keep the row and say why (R5): nothing is deleted.
  await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
  await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT`);
  await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS closed_short BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS closed_short_reason TEXT`);
  // A receipt or a correction names its PO line, so a line's history never
  // depends on reading notes (R2). Older receipts are found by their note.
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS purchase_order_id INTEGER`);
  // The cut-off (R9) is the day this code first runs in a database. It is kept
  // in the database, so a restart or a redeploy never moves it.
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, set_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('po_auto_accept_since', $1) ON CONFLICT (key) DO NOTHING`,
    [sydneyDate(Date.now())]);
}

async function autoAcceptSince() {
  return (await pool.query(`SELECT value FROM app_settings WHERE key = 'po_auto_accept_since'`)).rows[0]?.value
    || sydneyDate(Date.now());
}

async function loadProducts() {
  return (await pool.query(
    `SELECT id, "productCode", name, "currentStock", unit, "shopifySkus", "skuMultipliers", "unitPerBox", status, category
       FROM products WHERE status = 'active'`)).rows
    .map((r) => ({ ...r, shopifySkus: json(r.shopifySkus), skuMultipliers: json(r.skuMultipliers) }));
}

async function loadRows(db = pool) {
  return (await db.query(`
    SELECT po.id, po.product_id, po.order_number, po.quantity::float AS q, po.quantity_received::float AS rec, po.status,
           po.closed_short, po.closed_short_reason, po.cancel_reason, po.cancelled_at, po.cancelled_by,
           po.supplier, po.notes, po.estimated_delivery_date AS eta, po.added_at, po.added_by, po.received_at, po.received_by,
           po.shopify_po_gid, po.shopify_line_id, po.shopify_missing_since, po.cost_per_unit::float AS cost, po.destination_stock,
           p.name AS product_name, p."productCode" AS product_code, p.unit, p.category, p."currentStock"::float AS current_stock
      FROM purchase_orders po JOIN products p ON p.id = po.product_id
     ORDER BY po.added_at`)).rows;
}

// ── Line and order states ────────────────────────────────────────────────

// Hand-typed orders by PO number and product. They block an automatic accept
// of the same oil (R7). On 4 Nov, #PO283 had Christmas (NEW) received as
// "po283" by hand, and its Shopify line was accepted on top of it.
function handTypedIndex(rows) {
  const map = new Map();
  for (const r of rows) {
    const digits = !r.shopify_line_id && r.status !== 'cancelled' && poDigits(r.order_number);
    if (!digits) continue;
    const key = `${digits}|${r.product_id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/**
 * Why a Shopify line that nobody has accepted is waiting, or null when it is
 * clean. A person may accept a clean line by hand. The platform accepts it by
 * itself only on an order raised on or after the cut-off and not yet received
 * in Shopify (R7).
 */
export function holdOf(o, l, ctx) {
  // An unrecognised code still tells whether it is meant to be an oil bottle.
  const oil = l.isOil || l.category === 'OILS' || Object.keys(VARIANT_ML).some((p) => (l.sku || '').startsWith(`${p}_`));
  if (!oil) {
    // Non-oil stock is SA's; MUSE's own components come in Stage 5 (O3). Lines
    // from before the cut-off are shown, never tracked (R9), so the old
    // labels, boxes and batteries do not all turn red at once.
    if (o.destinationStock && o.destinationStock !== 'SA') return { state: 'info', note: "MUSE's components are not tracked here yet" };
    if (o.dateCreatedLocal < ctx.since) return { state: 'info', note: 'Raised before Purchase Orders began tracking machines, spare parts and raw materials' };
  }
  if (!l.matched) return { state: 'unmatched', note: l.reason };
  if (!o.destinationStock) return { state: 'unknown_destination', note: o.destinationError };
  const hand = ctx.handTyped.get(`${poDigits(o.number)}|${l.productId}`);
  if (hand) return { state: 'by_hand', note: `Typed by hand as ${hand.map((h) => h.order_number).join(', ')}`, hand };
  if (!oil) return null;
  const company = companyOf(o.destinationStock);
  if (ctx.regs.get(l.productId)?.[company]?.active !== true) {
    return { state: 'not_registered', note: `Not registered in ${company} Fragrances`, registerCompany: company };
  }
  return null;
}

const rowState = (r) => (r.status === 'cancelled' ? 'cancelled'
  : r.status === 'received' ? (r.closed_short ? 'closed_short' : 'received')
  : r.rec > 0 ? 'part' : 'on_order');

const rowFields = (r) => {
  const state = rowState(r);
  return {
    poId: r.id, state, ordered: r.q, received: r.rec, due: ['on_order', 'part'].includes(state) ? Math.max(0, r.q - r.rec) : 0,
    cost: r.cost, addedBy: r.added_by, addedAt: r.added_at, automatic: r.added_by === AUTO_BY,
    receivedAt: r.received_at, receivedBy: r.received_by, eta: r.eta,
    cancelReason: r.cancel_reason, cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by,
    closedShortReason: r.closed_short_reason, missingSince: r.shopify_missing_since, notes: r.notes,
  };
};

const fromRow = (r) => ({
  productId: r.product_id, productCode: r.product_code, productName: r.product_name, unit: r.unit,
  category: r.category, isOil: r.category === 'OILS', currentStock: r.current_stock, ...rowFields(r),
});

const DONE = new Set(['received', 'closed_short', 'cancelled', 'info']);
const OPEN = new Set(['on_order', 'part']);
const PERSON = new Set(['unmatched', 'not_registered', 'unknown_destination']);
const isDone = (l) => DONE.has(l.state) || (l.state === 'by_hand' && l.handDone);

/**
 * An order's status and alert (R8), from its lines and, for a Shopify order
 * still in Shopify's list, from its transfers:
 *   every line finished + Transferred         → closed
 *   Transferred, a line still to do           → alert record_here (🔴)
 *   every line finished, transfer not done    → status received, alert finish_in_shopify (🟡)
 * An order with nothing tracked here (old non-oil lines, MUSE components) raises
 * no alert (R9) and closes when Shopify has it Transferred. An order not in
 * Shopify's list (archived, deleted, from before the integration) or typed by
 * hand closes when its lines are finished.
 */
export function finishOrder(o) {
  const { lines } = o;
  const allDone = lines.length > 0 && lines.every(isDone);
  const tracked = lines.some((l) => l.state !== 'info');
  if (lines.length && lines.every((l) => l.state === 'cancelled')) return { ...o, status: 'cancelled', alert: null, attention: false };
  let status;
  if (!tracked) status = o.arrivedInShopify ? 'closed' : 'info';
  else if (allDone) status = o.origin === 'shopify' && o.inShopify && !o.arrivedInShopify ? 'received' : 'closed';
  else if (lines.some((l) => OPEN.has(l.state))) status = lines.some((l) => l.received > 0) ? 'part' : 'on_order';
  else status = 'waiting';

  let alert = null;
  if (tracked && o.origin === 'shopify' && o.inShopify) {
    if (o.arrivedInShopify && !allDone) alert = 'record_here';
    else if (allDone && !o.arrivedInShopify) alert = 'finish_in_shopify';
  }
  const needsPerson = lines.some((l) => PERSON.has(l.state) || l.changedInShopify
    || (l.state === 'waiting' && !l.autoReady) || (l.state === 'by_hand' && !l.handDone)
    || (l.missing && OPEN.has(l.state)));
  return { ...o, status, alert, attention: status !== 'closed' && (!!alert || needsPerson) };
}

/**
 * One list of every order (R2): Shopify's open orders, line by line against
 * what has been accepted, plus everything the platform holds that Shopify's
 * list does not show. That covers accepted lines of an order since archived or
 * deleted there, and every order typed by hand before H4. `read` is null when
 * Shopify could not be read: the platform's own rows still show.
 */
export function buildOrders({ read, rows, regs, since }) {
  const ctx = { regs, since, handTyped: handTypedIndex(rows) };
  const byLine = new Map(rows.filter((r) => r.shopify_line_id).map((r) => [r.shopify_line_id, r]));
  const used = new Set();
  const orders = [];

  for (const o of read?.orders || []) {
    const autoReady = o.dateCreatedLocal >= since && !o.arrivedInShopify;
    const lines = o.lines.map((l) => {
      const base = {
        lineId: l.lineId, sku: l.sku, supplierSku: l.supplierSku, title: l.title, shopifyQty: l.quantity, unitCost: l.unitCost,
        productId: l.productId, productCode: l.productCode, productName: l.productName, unit: l.unit, category: l.category,
        isOil: l.isOil, currentStock: l.currentStock, incomingQty: l.incomingQty, perUnit: l.perUnit,
        bottles: l.bottles, bottleMl: l.bottleMl,
      };
      const r = byLine.get(l.lineId);
      if (r) {
        used.add(r.id);
        // Not on a line a person already cancelled or closed short: it would sit
        // in "Needs attention" for good, and taking the figure would reopen it.
        const settled = ['cancelled', 'closed_short'].includes(rowState(r));
        return { ...base, ...rowFields(r), changedInShopify: !settled && l.matched && Math.abs(r.q - l.incomingQty) > 0.001 };
      }
      const hold = holdOf(o, l, ctx);
      return {
        ...base, state: hold ? hold.state : 'waiting', note: hold?.note || null, registerCompany: hold?.registerCompany,
        handDone: hold?.hand ? hold.hand.every((h) => h.status === 'received') : undefined,
        autoReady: !hold && autoReady, ordered: l.incomingQty, received: 0, due: 0,
      };
    });
    // Accepted here, then taken off the order in Shopify.
    for (const r of rows) {
      if (r.shopify_po_gid === o.shopifyId && !used.has(r.id)) { used.add(r.id); lines.push({ ...fromRow(r), missing: true }); }
    }
    orders.push(finishOrder({
      key: o.shopifyId, origin: 'shopify', inShopify: true, shopifyId: o.shopifyId, number: o.number, supplier: o.supplier,
      destination: o.destination, destinationStock: o.destinationStock, destinationLabel: o.destinationLabel,
      destinationError: o.destinationError, date: o.dateCreated, dateLocal: o.dateCreatedLocal,
      transfers: o.transfers, arrivedInShopify: o.arrivedInShopify, lines,
    }));
  }

  const groups = new Map();
  for (const r of rows) {
    if (used.has(r.id)) continue;
    const key = r.shopify_po_gid || `manual:${String(r.order_number).trim().toUpperCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, rs] of groups) {
    const shopify = !!rs[0].shopify_po_gid;
    const stock = shopify ? rs[0].destination_stock || 'SA' : 'SA'; // a manual order is SA's (R3)
    orders.push(finishOrder({
      key, origin: shopify ? 'shopify' : 'manual', inShopify: false, shopifyId: rs[0].shopify_po_gid || null,
      number: rs[0].order_number, supplier: rs.find((r) => r.supplier)?.supplier || null,
      destinationStock: stock, destinationLabel: destinationByStock(stock)?.label || sectorLabel(stock),
      date: rs[0].added_at, dateLocal: sydneyDate(rs[0].added_at), transfers: [], arrivedInShopify: false,
      // Absent from a list Shopify did return: archived, deleted, or older than the integration.
      lines: rs.map((r) => ({ ...fromRow(r), missing: shopify && !!read })),
    }));
  }
  return orders.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ── Accepting ────────────────────────────────────────────────────────────

async function insertAccepted(client, o, l, addedBy, createdBy) {
  const how = l.isOil ? `${l.bottles} × ${l.bottleMl} mL`
    : `${l.quantity} × ${l.sku}${l.perUnit !== 1 ? ` (${l.perUnit} ${l.unit} each)` : ''}`;
  const r = await client.query(
    `INSERT INTO purchase_orders
       (product_id, order_number, quantity, supplier, notes, added_by, created_by,
        shopify_po_gid, shopify_line_id, cost_per_unit, destination_stock)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (shopify_line_id) WHERE shopify_line_id IS NOT NULL DO NOTHING
     RETURNING id`,
    // added_by is the label the screens show; created_by is the user id (null
    // for an automatic accept). cost_per_unit: per product unit, ex GST; a
    // Shopify cost of 0 is NULL, "No price on the PO", never $0 (S8).
    // destination_stock: whose it is (P6) — what the receipt may go into, and
    // whether it is SA's on order.
    [l.productId, o.number, l.incomingQty, o.supplier || null, `From Shopify ${o.number} — ${how}`,
     addedBy, createdBy, o.shopifyId, l.lineId, costPerMl(l.unitCost, l.perUnit), o.destinationStock]);
  return r.rows[0]?.id || null;
}

/**
 * R7: accept every clean line of an order raised on or after the cut-off and
 * not yet received in Shopify. It runs inside the read that the Purchase
 * Orders page and Demand Planning make (no background reading, D5). It is
 * idempotent: two reads at once insert each line once (the unique line id),
 * and the Activity row lists only what this read created.
 */
async function autoAccept(read, rows, regs, since, user) {
  const ctx = { regs, since, handTyped: handTypedIndex(rows) };
  const taken = new Set(rows.map((r) => r.shopify_line_id).filter(Boolean));
  const picks = [];
  for (const o of read.orders) {
    if (o.dateCreatedLocal < since || o.arrivedInShopify || !o.destinationStock) continue;
    for (const l of o.lines) if (!taken.has(l.lineId) && !holdOf(o, l, ctx)) picks.push({ o, l });
  }
  if (!picks.length) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const { o, l } of picks) {
      const poId = await insertAccepted(client, o, l, AUTO_BY, null);
      if (poId) created.push({ poId, number: o.number, productCode: l.productCode, name: l.productName, quantity: l.incomingQty, unit: l.unit });
    }
    if (created.length) {
      await client.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
         VALUES (NULL, 'po_auto_accepted', 'purchase_order', NULL, $1, $2)`,
        [[...new Set(created.map((c) => c.number))].join(', '), JSON.stringify({ lines: created, openedBy: user?.name || null })]);
    }
    await client.query('COMMIT');
    return created;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Accepted, then deleted in Shopify. Without this the platform would go on
// counting that stock as on its way for ever, and nobody would see it. This is
// a read that writes, deliberately and idempotently: it records a fact it has
// just established, and clears it if the order comes back.
async function markMissing(read, rows) {
  const open = rows.filter((r) => r.shopify_line_id && ['pending', 'partial'].includes(r.status));
  const gone = open.filter((r) => !read.liveLineIds.has(r.shopify_line_id) && !r.shopify_missing_since).map((r) => r.id);
  const back = rows.filter((r) => r.shopify_line_id && r.shopify_missing_since && read.liveLineIds.has(r.shopify_line_id)).map((r) => r.id);
  if (gone.length) await pool.query(`UPDATE purchase_orders SET shopify_missing_since = NOW() WHERE id = ANY($1::int[])`, [gone]);
  if (back.length) await pool.query(`UPDATE purchase_orders SET shopify_missing_since = NULL WHERE id = ANY($1::int[])`, [back]);
}

/** Read Shopify, accept what is clean, flag what vanished. read is null when Shopify could not be read. */
async function sync(user) {
  const [products, regs, since] = await Promise.all([loadProducts(), registrationsByProduct(), autoAcceptSince()]);
  let read = null;
  let shopifyError = null;
  try {
    read = await readIncomingPurchaseOrders(products);
  } catch (e) {
    shopifyError = e.message;
  }
  let autoAccepted = [];
  if (read) {
    const rows = await loadRows();
    autoAccepted = await autoAccept(read, rows, regs, since, user);
    await markMissing(read, rows);
  }
  return { read, regs, since, shopifyError, autoAccepted };
}

const notTechnician = (req, res) => {
  // The menu hides this from technicians; a menu is not a permission. Supplier
  // names, costs and stock positions are on it.
  if (req.user.role !== 'technician') return true;
  res.status(403).json({ error: 'Not available for technicians' });
  return false;
};

// ── GET /purchase-orders/overview — the Purchase Orders page.
router.get('/purchase-orders/overview', async (req, res) => {
  if (!notTechnician(req, res)) return;
  try {
    const { read, regs, since, shopifyError, autoAccepted } = await sync(req.user);
    const orders = buildOrders({ read, rows: await loadRows(), regs, since });
    res.json({
      ok: !!read, error: shopifyError, readAt: new Date().toISOString(), autoAcceptSince: since, autoAccepted, orders,
      attention: orders.filter((o) => o.attention).length,
    });
  } catch (e) {
    console.error('Purchase orders overview failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /purchase-orders/sync — Demand Planning calls this as it opens, so
// an order raised in Shopify is on order there without anybody opening
// Purchase Orders first (R7). Same read, without building the list.
router.post('/purchase-orders/sync', async (req, res) => {
  if (!notTechnician(req, res)) return;
  try {
    const { read, shopifyError, autoAccepted } = await sync(req.user);
    res.json({ ok: !!read, error: shopifyError, autoAccepted: autoAccepted.length });
  } catch (e) {
    console.error('Purchase orders sync failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /shopify-purchase-orders/accept — a person accepts an order's clean lines.
// The quantities are re-read from Shopify inside this request. The screen's
// numbers are never trusted: a tab left open for an hour would otherwise be
// able to accept a quantity that no longer exists. The client is taken AFTER
// Shopify has answered: holding one across a network call to somebody else's
// server starves a pool of ten.
router.post('/shopify-purchase-orders/accept', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admin or root can accept a purchase order' });
  let client;
  try {
    const { shopifyId } = req.body || {};
    if (!shopifyId) return res.status(400).json({ error: 'shopifyId is required' });
    const [products, regs, since] = await Promise.all([loadProducts(), registrationsByProduct(), autoAcceptSince()]);
    const fresh = (await readIncomingPurchaseOrders(products)).orders.find((o) => o.shopifyId === shopifyId);
    // Deleted, archived or put back to draft between the screen loading and the
    // click: a deleted PO vanishes from the API entirely, so absence is the only signal.
    if (!fresh) return res.status(409).json({ error: 'That purchase order is no longer in Shopify. Read again.' });
    if (!fresh.destinationStock) return res.status(400).json({ error: fresh.destinationError });

    const rows = await loadRows();
    const taken = new Set(rows.map((r) => r.shopify_line_id).filter(Boolean));
    const ctx = { regs, since, handTyped: handTypedIndex(rows) };
    const open = fresh.lines.filter((l) => !taken.has(l.lineId));
    const usable = open.filter((l) => !holdOf(fresh, l, ctx));
    const held = open.filter((l) => holdOf(fresh, l, ctx))
      .map((l) => ({ sku: l.sku, name: l.productName, ...(({ state, note }) => ({ state, note }))(holdOf(fresh, l, ctx)) }));
    if (!usable.length) {
      return res.status(400).json({
        error: held.length ? `Nothing to accept: ${held.map((h) => `${h.name || h.sku} — ${h.note}`).join('; ')}.` : 'Every line is already accepted.',
        held,
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const created = [];
    for (const l of usable) {
      if (await insertAccepted(client, fresh, l, req.user.name || 'shopify', req.user.id)) {
        created.push({ productCode: l.productCode, name: l.productName, quantity: l.incomingQty, unit: l.unit });
      }
    }
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'shopify_po_accepted', 'purchase_order', NULL, $2, $3)`,
      [req.user.id, fresh.number, JSON.stringify({ shopifyId, supplier: fresh.supplier, lines: created,
        destination: fresh.destination, destinationStock: fresh.destinationStock, held })]);
    await client.query('COMMIT');
    res.json({ ok: true, number: fresh.number, accepted: created.length, alreadyAccepted: usable.length - created.length, held });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Shopify PO accept failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (client) client.release();
  }
});

// ── PATCH /shopify-purchase-orders/line/:poId — take the quantity Shopify now
// says, for a line edited there after it was accepted here. It is its own small
// act rather than a re-accept: re-accepting would remove a row that may already
// be part-received, and lose the record of what arrived.
router.patch('/shopify-purchase-orders/line/:poId', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admin or root can change an accepted quantity' });
  try {
    const row = (await pool.query(
      `SELECT po.id, po.shopify_line_id, po.quantity::float q, po.quantity_received::float rec, po.order_number, p.unit,
              po.status, po.closed_short
         FROM purchase_orders po JOIN products p ON p.id = po.product_id
        WHERE po.id = $1 AND po.shopify_line_id IS NOT NULL`, [req.params.poId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not an accepted Shopify purchase order' });
    // A person cancelled or closed this line here, with a reason. A later edit in
    // Shopify must not quietly reopen it (code review, 5 Nov 2026).
    if (row.status === 'cancelled' || row.closed_short) {
      return res.status(409).json({ error: `This line was ${row.status === 'cancelled' ? 'cancelled' : 'closed short'} here. A change in Shopify does not reopen it.` });
    }
    const { orders } = await readIncomingPurchaseOrders(await loadProducts());
    const line = orders.flatMap((o) => o.lines).find((l) => l.lineId === row.shopify_line_id);
    if (!line) return res.status(409).json({ error: 'That line is no longer in Shopify. Cancel it instead.' });
    if (!line.matched) return res.status(400).json({ error: line.reason });
    // Never below what has already physically arrived: that stock is on the
    // shelf and recorded, and a purchase order cannot un-receive it.
    if (line.incomingQty < row.rec - 0.001) {
      return res.status(400).json({
        error: `Shopify now says ${qtyText(line.incomingQty, row.unit)}, but ${qtyText(row.rec, row.unit)} has already been received. Fix it in Shopify, or correct the receipt.`,
      });
    }
    const status = line.incomingQty <= row.rec + 0.001 ? 'received' : (row.rec > 0 ? 'partial' : 'pending');
    await pool.query(`UPDATE purchase_orders SET quantity = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [line.incomingQty, status, row.id]);
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'shopify_po_quantity_synced', 'purchase_order', $2, $3, $4)`,
      [req.user.id, row.id, row.order_number, JSON.stringify({ from: row.q, to: line.incomingQty, alreadyReceived: row.rec })]);
    res.json({ ok: true, from: row.q, to: line.incomingQty, status });
  } catch (e) {
    console.error('Shopify PO quantity sync failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── A line's history: its receipts and corrections ──────────────────────

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * What came in on a PO line, and what was taken back. New rows carry the
 * line's id. Older receipts carry only their note, "PO Received: <number> - …",
 * on the same product. Each comes with where it went: its sector movements,
 * or, before Stage 1, all of an oil to SA.
 */
// Known limit (code review, 5 Nov 2026): an older receipt is found by its note's
// order number and product, so when one PO has the same product on two lines,
// each line's history shows both lines' older receipts. In the data that is 3
// orders typed by hand (30.04.26 OIL_139; 2.06.26 OILS_17 and OIL_37), fully
// received before Stage 1, so everything went to SA. A correction stays capped by
// the line's OWN quantity received and comes off SA: it cannot move stock wrongly.
// Every receipt since H4 carries purchase_order_id and is exact.
async function lineHistory(db, po) {
  const txs = (await db.query(`
    SELECT t.id, t.type, t.quantity::float AS qty, t.reason, t.notes, u.name AS by,
           to_char(t.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
      FROM transactions t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.product_id = $2
       AND (t.purchase_order_id = $1 OR (t.purchase_order_id IS NULL AND t.notes LIKE $3 ESCAPE '\\'))
     ORDER BY t.created_at, t.id`,
  [po.id, po.product_id, `PO Received: ${likeEscape(po.order_number)} -%`])).rows;
  const moves = txs.length ? (await db.query(
    `SELECT transaction_id, from_sector, to_sector, quantity::float AS qty FROM sector_movements WHERE transaction_id = ANY($1::int[])`,
    [txs.map((t) => t.id)])).rows : [];
  return txs.map((t) => {
    const correction = t.reason === 'receipt_correction';
    const own = moves.filter((m) => m.transaction_id === t.id);
    return {
      at: t.at, kind: correction ? 'correction' : 'receipt', quantity: t.qty, by: t.by, note: t.notes,
      lines: own.map((m) => ({ stock: correction ? m.from_sector : m.to_sector, quantity: m.qty })),
    };
  });
}

/** stock → what this line put there, net of earlier corrections. An oil only. */
function netByStock(history) {
  const net = {};
  for (const h of history) {
    const lines = h.lines.length ? h.lines : [{ stock: 'SA', quantity: h.quantity }]; // before Stage 1: all to SA
    for (const l of lines) net[l.stock] = (net[l.stock] || 0) + (h.kind === 'correction' ? -l.quantity : l.quantity);
  }
  return Object.fromEntries(Object.entries(net).filter(([, v]) => v > 0.001));
}

// ── GET /purchase-orders/history?ids=1,2 — the order sheet's receipts.
router.get('/purchase-orders/history', async (req, res) => {
  if (!notTechnician(req, res)) return;
  try {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Number.isInteger).slice(0, 200);
    const rows = ids.length ? (await pool.query(
      `SELECT id, product_id, order_number FROM purchase_orders WHERE id = ANY($1::int[])`, [ids])).rows : [];
    const out = {};
    for (const r of rows) out[r.id] = await lineHistory(pool, r);
    res.json(out);
  } catch (e) {
    console.error('PO history failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /purchase-orders/:poId/correct — R4, owner 5 Nov ("pode ser").
// Takes back part of a receipt that never arrived. It comes off the stock(s)
// that receipt went into, under Adjust's limits: SA may go negative, a MUSE
// stock and the main store stop at zero. The person chooses what happens to
// the line: still due, or closed short. A reason is required. It writes one
// ledger row and the reversing movements, and Activity shows the ledger row.
// Nothing is deleted.
// Body: { quantity, reason, mode: 'still_due' | 'close_short', lines?: [{ from, quantity }] }
router.post('/purchase-orders/:poId/correct', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admin or root can correct a receipt' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { quantity, reason, mode, lines } = req.body || {};
    const qty = parseFloat(quantity);
    const why = String(reason || '').trim();
    if (!(qty > 0)) throw bad('The quantity must be more than zero');
    if (!why) throw bad('Say why the receipt is being corrected');
    if (!['still_due', 'close_short'].includes(mode)) throw bad('Choose whether the rest is still coming or the line closes short');

    const po = (await client.query(`SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [req.params.poId])).rows[0];
    if (!po) throw Object.assign(new Error('Purchase order line not found'), { status: 404 });
    if (po.status === 'cancelled') throw bad('A cancelled line has no receipt to correct');
    const product = (await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [po.product_id])).rows[0];
    const received = Number(po.quantity_received) || 0;
    if (qty > received + 0.001) {
      throw bad(`${po.order_number} has ${qtyText(received, product.unit)} received; a correction cannot take back more.`);
    }

    let take = [];
    if (product.category === 'OILS') {
      const net = netByStock(await lineHistory(client, po));
      const stocks = Object.keys(net);
      take = Array.isArray(lines) && lines.length
        ? lines.map((l) => ({ from: l?.from, quantity: parseFloat(l?.quantity) })).filter((l) => l.quantity > 0)
        : stocks.length === 1 ? [{ from: stocks[0], quantity: qty }] : [];
      // One entry per stock before any limit is checked: two entries for MUSE
      // would each pass "≤ what MUSE received" and together take more (code review, 5 Nov).
      take = Object.values(take.reduce((m, l) => {
        (m[l.from] ||= { from: l.from, quantity: 0 }).quantity += l.quantity;
        return m;
      }, {}));
      if (!take.length) {
        throw bad(`This line was received into ${stocks.map(sectorLabel).join(' and ')}. Say how much comes off each.`, { code: 'NEEDS_LINES', net });
      }
      const total = take.reduce((s, l) => s + l.quantity, 0);
      if (Math.abs(total - qty) > 0.001) {
        throw bad(`The lines add up to ${qtyText(total, product.unit)}; the correction is ${qtyText(qty, product.unit)}.`);
      }
      for (const l of take) {
        if (!(net[l.from] > 0)) throw bad(`${po.order_number} was not received into ${sectorLabel(l.from)}.`);
        if (l.quantity > net[l.from] + 0.001) {
          throw bad(`${sectorLabel(l.from)} received ${qtyText(net[l.from], product.unit)} on ${po.order_number}; a correction cannot take more out of it.`);
        }
        if (l.from === 'SA') continue; // SA may go negative (S3)
        const held = Number((await client.query(
          `SELECT ${l.from.toLowerCase()} AS v FROM sector_held WHERE product_id = $1`, [product.id])).rows[0]?.v || 0);
        if (l.quantity > Math.max(held, 0) + 0.001) {
          throw Object.assign(bad(
            `${sectorLabel(l.from)} holds ${qtyText(Math.max(held, 0), product.unit)} of ${product.name}. A correction can bring it to zero, not below: `
            + `it has used or moved the rest since. Correct ${qtyText(Math.max(held, 0), product.unit)} or less, and record what it used as Production.`), {
            refusal: { productId: product.id, productName: product.name, type: 'receipt_correction', reference: po.order_number,
              stock: l.from, quantity: l.quantity, held, unit: product.unit },
          });
        }
      }
    }

    const newStock = (parseFloat(product.currentStock) || 0) - qty;
    await client.query('UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
      [newStock, Math.floor(newStock / (product.unitPerBox || 1)), product.id]);
    const where = take.length ? ` — from ${take.map((l) => `${sectorLabel(l.from)} ${qtyText(l.quantity, product.unit)}`).join(', ')}` : '';
    const txId = (await client.query(
      `INSERT INTO transactions
         (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id, reason, purchase_order_id)
       VALUES ($1,$2,$3,$4,'remove',$5,$6,$7,$8,$9,'receipt_correction',$10) RETURNING id`,
      [product.id, product.productCode || product.tag, product.name, product.category, qty, product.unit || 'units', newStock,
       `Receipt corrected — ${po.order_number} — ${why}${where}`, req.user.id, po.id])).rows[0].id;
    for (const l of take) {
      await recordMovement(client, {
        productId: product.id, from: l.from, to: 'SUPPLIER', quantity: l.quantity, kind: 'reversal',
        reason: 'receipt_correction', reference: po.order_number, notes: why, transactionId: txId, userId: req.user.id,
        avgCost: po.cost_per_unit == null ? null : Number(po.cost_per_unit), // valued as it came in
      });
    }

    const rec = received - qty;
    const closeShort = mode === 'close_short';
    const status = closeShort ? 'received' : rec > 0.001 ? 'partial' : 'pending';
    await client.query(
      `UPDATE purchase_orders SET quantity_received = $1, status = $2, closed_short = $3, closed_short_reason = $4, updated_at = NOW() WHERE id = $5`,
      [rec, status, closeShort, closeShort ? why : null, po.id]);
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'po_receipt_corrected', 'product', $2, $3, $4)`,
      [req.user.id, product.id, product.name, JSON.stringify({
        orderNumber: po.order_number, quantity: qty, unit: product.unit, reason: why, mode, lines: take,
        productCode: product.productCode, category: product.category })]);
    await client.query('COMMIT');
    res.json({
      ok: true, status, received: rec, newStock,
      sectors: product.category === 'OILS' ? await balancesAfterCommit(product.id, newStock) : null,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await recordRefusal(req.user, e);
    if (e.status) return res.status(e.status).json({ ...errorBody(e), ...(e.net && { code: e.code, net: e.net }) });
    console.error('Receipt correction failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── POST /purchase-orders/:poId/cancel — R5. A line nothing has arrived on is
// cancelled. A line with receipts is closed short instead: what arrived stays
// recorded, and nothing more is expected. Either way the row stays, with the
// reason and who did it. Today's "Clear" deleted the row, which is how
// #PO283's two Christmas lines could be offered for accepting again.
router.post('/purchase-orders/:poId/cancel', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admin or root can cancel a purchase order line' });
  const why = String(req.body?.reason || '').trim();
  if (!why) return res.status(400).json({ error: 'Say why the line is cancelled' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const po = (await client.query(
      `SELECT po.*, p.name AS product_name, p."productCode" AS product_code, p.unit, p.category
         FROM purchase_orders po JOIN products p ON p.id = po.product_id WHERE po.id = $1 FOR UPDATE OF po`, [req.params.poId])).rows[0];
    if (!po) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Purchase order line not found' }); }
    if (!['pending', 'partial'].includes(po.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This line is already ${po.closed_short ? 'closed short' : po.status}.` });
    }
    const received = Number(po.quantity_received) || 0;
    const closeShort = received > 0.001;
    if (closeShort) {
      await client.query(`UPDATE purchase_orders SET status = 'received', closed_short = true, closed_short_reason = $1, updated_at = NOW() WHERE id = $2`, [why, po.id]);
    } else {
      await client.query(`UPDATE purchase_orders SET status = 'cancelled', cancel_reason = $1, cancelled_at = NOW(), cancelled_by = $2, updated_at = NOW() WHERE id = $3`,
        [why, req.user.name || null, po.id]);
    }
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, $2, 'product', $3, $4, $5)`,
      [req.user.id, closeShort ? 'po_closed_short' : 'po_cancelled', po.product_id, po.product_name, JSON.stringify({
        orderNumber: po.order_number, quantity: Number(po.quantity), received, unit: po.unit, reason: why,
        productCode: po.product_code, category: po.category })]);
    await client.query('COMMIT');
    res.json({ ok: true, status: closeShort ? 'closed_short' : 'cancelled' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PO cancel failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── No order is raised or deleted outside Shopify any more (D3, R5) ──────
// The routes answer with what to do instead, so an old screen or a bookmark
// meets a reason, not a 404.
const gone = (error) => (req, res) => res.status(410).json({ error });
const RAISE = 'Purchase orders are raised in Shopify. This platform reads them from there.';
router.post('/products/:id/incoming', gone(RAISE));
router.get('/po/template', gone(RAISE));
router.post('/po/import/preview', gone(RAISE));
router.post('/po/import/confirm', gone(RAISE));
router.delete('/purchase-orders/:poId', gone('Cancel the line in Purchase Orders: it asks why, and keeps the record.'));
