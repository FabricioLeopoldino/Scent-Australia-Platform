// Fragrance stock by company — PRD_STAGE_1_FRAGRANCE_LIBRARY.md (owner, 26 Oct
// 2026), reworking the sectors of PRD_LIBRARY_SECTORS.md (21–23 Oct).
//
// One table of movements. The main store and the four MUSE stocks are the sum
// of their own movements; SA is the oil's total minus what those actually hold.
// So no existing stock path changes: anything that moves the total without
// naming a stock — a Shopify sale, a technician removal, a stocktake — lands in
// SA by construction, and SA plus the stocks holding oil add up to the total.
//
// Real movements are never blocked (R5): oil a MUSE stock USES beyond what it
// holds is recorded as coming off SA's shelf, for that stock (sector_draw), and
// a TRANSFER beyond what a company stock holds leaves it negative — a debt,
// shown in red, which is what the history is for. Typing errors are refused
// (S7): lines that do not add up, more out of the main store than it holds,
// oil sent into a company where it is not registered.
import express from 'express';
import { saPool as pool } from '../db.js';
import { SECTOR_KEYS, HELD_SECTORS, MUSE_STOCKS, MUSE_UNITS, COMPANIES, sectorLabel, companyOf } from '../../shared/sectors.js';
import { isValidReason, reasonLabel } from '../../shared/stock-reasons.js';

export const router = express.Router();

const sqlList = (list) => list.map((k) => `'${k}'`).join(', ');
// The view's column for a held stock: MUSE_ATELIER → muse_atelier.
const col = (key) => key.toLowerCase();

export async function migrateSectors() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sector_movements (
      id              SERIAL PRIMARY KEY,
      product_id      TEXT NOT NULL REFERENCES products(id),
      from_sector     TEXT NOT NULL,
      to_sector       TEXT NOT NULL,
      quantity        NUMERIC NOT NULL CHECK (quantity > 0),
      kind            TEXT NOT NULL,            -- receipt | transfer | count | use | production | reversal
      reason          TEXT,
      reference       TEXT,                     -- PO number, order number
      cost_per_unit   NUMERIC,                  -- per product unit (mL for oils); NULL = no price
      notes           TEXT,
      transaction_id  INTEGER,                  -- the ledger row, when the total changed
      user_id         INTEGER,
      created_at      TIMESTAMP DEFAULT NOW(),
      CHECK (from_sector <> to_sector)
    )`);
  // Set when a stock covered oil a MUSE stock used but did not hold: the
  // movement is from the stock that gave it, and this says who it was for.
  await pool.query(`ALTER TABLE sector_movements ADD COLUMN IF NOT EXISTS used_for TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sector_movements_product ON sector_movements(product_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sector_movements_tx ON sector_movements(transaction_id) WHERE transaction_id IS NOT NULL`);
  // The average cost, once: what every non-receipt movement is valued at — the
  // receipts that carried a Shopify price, weighted by quantity (owner, 23 Oct).
  // A receipt with no price (NULL — Shopify's 0 is stored as NULL, S8) is left
  // out, never averaged in as $0.
  await pool.query(`
    CREATE OR REPLACE FUNCTION sa.sector_avg_cost(p_product TEXT) RETURNS NUMERIC LANGUAGE sql STABLE AS $fn$
      SELECT SUM(quantity * cost_per_unit) / NULLIF(SUM(quantity), 0) FROM sa.sector_movements
       WHERE product_id = p_product AND kind = 'receipt' AND cost_per_unit IS NOT NULL $fn$`);
  // The use rule (S3–S4), in ONE function so the SA screens and the MUSE side
  // (CommonJS, sm/services/fragrance-library.js) cannot apply two versions of it:
  //   for SA            → all from SA (SA may go negative; it takes from nobody);
  //   for a MUSE unit   → its own oil, then MUSE (shared), then SA;
  //   for MUSE (shared) → its own oil, then SA.
  // Never another unit's oil, never the main store's. Oil a stock gives for
  // another is marked used_for that stock ("SA, for MUSE The Library"). The
  // caller holds the product row lock. Returns the part SA covered. Valued at
  // the oil's average receipt cost.
  await pool.query(`
    CREATE OR REPLACE FUNCTION sa.sector_draw(p_product TEXT, p_sector TEXT, p_qty NUMERIC, p_kind TEXT,
      p_reason TEXT, p_reference TEXT, p_notes TEXT, p_tx INTEGER, p_user INTEGER)
    RETURNS NUMERIC LANGUAGE plpgsql AS $fn$
    DECLARE remaining NUMERIC := p_qty; have NUMERIC; part NUMERIC; src TEXT; cost NUMERIC;
    BEGIN
      IF p_sector IS NULL OR p_sector NOT IN (${sqlList(['SA', ...MUSE_STOCKS])}) THEN
        RAISE EXCEPTION 'sector_draw: a use is never drawn for stock %', p_sector;
      END IF;
      cost := sa.sector_avg_cost(p_product);
      FOREACH src IN ARRAY CASE WHEN p_sector = 'SA' THEN ARRAY[]::TEXT[]
                                WHEN p_sector = 'MUSE' THEN ARRAY['MUSE']
                                ELSE ARRAY[p_sector, 'MUSE'] END LOOP
        SELECT GREATEST(COALESCE(SUM(CASE WHEN to_sector = src THEN quantity ELSE -quantity END), 0), 0) INTO have
          FROM sa.sector_movements WHERE product_id = p_product AND (to_sector = src OR from_sector = src);
        part := LEAST(remaining, have);
        IF part > 0 THEN
          INSERT INTO sa.sector_movements (product_id, from_sector, to_sector, quantity, kind, reason, reference, cost_per_unit, notes, transaction_id, user_id, used_for)
          VALUES (p_product, src, 'USED', part, p_kind, p_reason, p_reference, cost, p_notes, p_tx, p_user, NULLIF(p_sector, src));
          remaining := remaining - part;
        END IF;
      END LOOP;
      IF remaining > 0 THEN
        INSERT INTO sa.sector_movements (product_id, from_sector, to_sector, quantity, kind, reason, reference, cost_per_unit, notes, transaction_id, user_id, used_for)
        VALUES (p_product, 'SA', 'USED', remaining, p_kind, p_reason, p_reference, cost, p_notes, p_tx, p_user, NULLIF(p_sector, 'SA'));
      END IF;
      RETURN remaining;
    END $fn$`);
  // Shopify's "cost per item" ÷ the bottle size, stored when a Shopify PO is accepted.
  await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cost_per_unit NUMERIC`);
  // The company stock a Shopify PO is for, from its destination (P6,
  // shared/sectors.js PO_DESTINATIONS). NULL = a manual order (+ Incoming, the
  // Excel import): no destination, received anywhere, SA's on order, as before.
  // Every Shopify line accepted before P6 came from "SA Warehouse", the only
  // destination then read, so it is SA's — once, idempotent.
  await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS destination_stock TEXT`);
  await pool.query(`UPDATE purchase_orders SET destination_stock = 'SA'
                     WHERE shopify_line_id IS NOT NULL AND destination_stock IS NULL`);
  // Held balances per oil. SA is not here: it is the total minus these.
  // `held` counts only what a stock actually has. A stock below zero used oil
  // it did not hold, and that oil physically came off the shared shelf — SA's.
  // Counting the negative would push SA ABOVE the oil's total (100 L all SA,
  // The Library sells 20 L with none of its own: SA would read 80 − (−20) =
  // 100 L of 80 L that exist). So SA = total − the positive balances, and a
  // negative reads as "owes SA": settling it later with a transfer from SA
  // moves nothing physical and leaves SA where it is (code review, 23 Oct).
  // One definition, read by the products API, Demand Planning and the connector.
  // The view of 21–23 Oct had other columns (awaiting, atelier, …), and
  // CREATE OR REPLACE cannot rename a view's columns: dropped once, where that
  // old shape exists — only the sectors-dev branch ever had it.
  // The columns follow SECTORS' order: renaming, adding or reordering a key
  // needs a DROP of this view first (like the one below), or CREATE OR REPLACE
  // fails — not caught, so the server will not start.
  await pool.query(`DO $do$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'sa' AND table_name = 'sector_held' AND column_name = 'awaiting') THEN
      DROP VIEW sa.sector_held;
    END IF; END $do$`);
  await pool.query(`
    CREATE OR REPLACE VIEW sector_held AS
    SELECT product_id, ${HELD_SECTORS.map(col).join(', ')},
      ${HELD_SECTORS.map((k) => `GREATEST(${col(k)}, 0)`).join(' + ')} AS held
    FROM (SELECT product_id, ${HELD_SECTORS.map((k) =>
        `SUM(CASE WHEN to_sector = '${k}' THEN quantity WHEN from_sector = '${k}' THEN -quantity ELSE 0 END) AS ${col(k)}`).join(',\n      ')}
      FROM sector_movements GROUP BY product_id) s`);

  // An oil registered per company (S6, R1): one oil record, never a copy. SA
  // keeps its bin on the oil (products.bin_location, D3); a MUSE registration
  // carries its own, and the MUSE units that use the oil. ON DELETE CASCADE: an
  // oil that never moved can still be deleted (DELETE /products/:id refuses one
  // with history), and its registrations are part of it, not history.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fragrance_registrations (
      id               SERIAL PRIMARY KEY,
      product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      company          TEXT NOT NULL CHECK (company IN (${sqlList(COMPANIES)})),
      commercial_name  TEXT,
      bin_location     TEXT,
      used_by          TEXT[] NOT NULL DEFAULT '{}' CHECK (used_by <@ ARRAY[${sqlList(MUSE_UNITS)}]::TEXT[]),
      active           BOOLEAN NOT NULL DEFAULT true,
      created_by       INTEGER,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_at       TIMESTAMP DEFAULT NOW(),
      UNIQUE (product_id, company),
      CHECK (company = 'MUSE' OR (bin_location IS NULL AND used_by = '{}'))
    )`);
  // Once, on an empty table: a release can never open SA Fragrances empty.
  if (!(await pool.query(`SELECT 1 FROM fragrance_registrations LIMIT 1`)).rowCount) {
    const { plan, inserted } = await seedRegistrations({ apply: true });
    console.log(`[sectors] Day-one registrations: ${inserted} written (${plan.map((p) => `${p.company} ${p.usedBy.join('+') || ''} ${p.oils}`).join(', ')})`);
  }
}

/**
 * Day one (PRD Stage 1 §5). A registration's `active` is membership of the
 * company — "this oil is SA's / MUSE's" — not whether the oil is in use, which
 * stays products.status as live (orchestrator, fix round 1, 26 Oct). So:
 *   SA   — every oil, active or not, registered and active;
 *   MUSE — every oil an sm product points at (that IS MUSE's use of it),
 *          used by the units of the products that point at it: library → The
 *          Library, archive → The Archive, atelier or client work (STANDARD /
 *          MAJOR) → The Atelier, anything else → The Library.
 * ONE function, run by the startup migration and by
 * scripts/stage1-registrations.mjs, so the dry run reviewed before release is
 * what the release writes. `only` limits it to some oils (the regression).
 * Returns { plan: [{ company, usedBy, oils, already }], rows (dry run with
 * `only`), inserted }.
 */
export async function seedRegistrations({ apply = false, db = pool, only = null } = {}) {
  // sm is created after sa at boot; on a database without it there is nothing for MUSE yet.
  const { sm, regs } = (await db.query(
    `SELECT to_regclass('sm.products') IS NOT NULL AS sm, to_regclass('sa.fragrance_registrations') IS NOT NULL AS regs`)).rows[0];
  const params = only ? [only] : [];
  const oils = `sa.products p WHERE p.category = 'OILS'${only ? ' AND p.id = ANY($1::TEXT[])' : ''}`;
  const seed = `
    SELECT p.id AS product_id, 'SA'::TEXT AS company, true AS active, '{}'::TEXT[] AS used_by FROM ${oils}
    ${sm ? `UNION ALL
    SELECT p.id, 'MUSE', true, ARRAY(
        SELECT DISTINCT CASE WHEN s.segment IN ('STANDARD', 'MAJOR') OR s.business_unit = 'atelier' THEN 'MUSE_ATELIER'
                             WHEN s.business_unit = 'archive' THEN 'MUSE_ARCHIVE'
                             ELSE 'MUSE_LIBRARY' END
          FROM sm.products s WHERE s.oil_id = p.id ORDER BY 1)
      FROM ${oils} AND EXISTS (SELECT 1 FROM sm.products s WHERE s.oil_id = p.id)` : ''}`;
  const plan = (await db.query(`
    SELECT s.company, s.used_by AS "usedBy", COUNT(*)::int AS oils, ${regs ? 'COUNT(r.id)' : '0'}::int AS already
      FROM (${seed}) s ${regs ? 'LEFT JOIN sa.fragrance_registrations r USING (product_id, company)' : ''}
     GROUP BY 1, 2 ORDER BY 1 DESC, 2`, params)).rows;
  if (!apply) return { plan, inserted: 0, ...(only && { rows: (await db.query(`${seed} ORDER BY 1, 2`, params)).rows }) };
  if (!regs) throw new Error('sa.fragrance_registrations does not exist yet — start the server once on this database first');
  // One statement, so it lands whole or not at all.
  const inserted = (await db.query(`
    INSERT INTO sa.fragrance_registrations (product_id, company, active, used_by)
    SELECT product_id, company, active, used_by FROM (${seed}) s
    ON CONFLICT (product_id, company) DO NOTHING`, params)).rowCount;
  return { plan, inserted };
}

// ponytail: sector_held re-aggregates every movement on each read — fine at a
// few hundred rows a year; turn it into a balance table kept by sector_draw /
// recordMovement if the products page or Demand Planning slows down.
/** productId → { MAIN, MUSE, MUSE_ATELIER, MUSE_LIBRARY, MUSE_ARCHIVE, held } in the product's unit. */
export async function heldByProduct(productId = null) {
  const rows = (await pool.query(
    `SELECT * FROM sector_held ${productId ? 'WHERE product_id = $1' : ''}`, productId ? [productId] : [])).rows;
  return new Map(rows.map((r) => [r.product_id, {
    ...Object.fromEntries(HELD_SECTORS.map((k) => [k, Number(r[col(k)])])), held: Number(r.held),
  }]));
}

/** All six balances for one oil, given its total: { MAIN, SA, MUSE, MUSE_ATELIER, MUSE_LIBRARY, MUSE_ARCHIVE }. */
export function sectorBalances(total, h) {
  return Object.fromEntries(SECTOR_KEYS.map((k) => [k, k === 'SA' ? total - (h?.held || 0) : (h?.[k] || 0)]));
}

/**
 * The balances to hand back after a write has COMMITTED. Failing to read them
 * must not turn a saved movement into an error — the person would do it twice
 * (fix round 2, R8): null, logged; the screens reload anyway.
 */
export async function balancesAfterCommit(productId, total) {
  try {
    return sectorBalances(total, (await heldByProduct(productId)).get(productId));
  } catch (e) {
    console.error(`[sectors] saved, but the balances of ${productId} could not be read back:`, e.message);
    return null;
  }
}

/**
 * productId → { SA?: reg, MUSE?: reg }, reg = { id, active, commercialName, binLocation, usedBy }.
 * A company is present only where a registration row exists (active or not).
 */
export async function registrationsByProduct(productId = null) {
  const rows = (await pool.query(`SELECT * FROM fragrance_registrations ${productId ? 'WHERE product_id = $1' : ''}`,
    productId ? [productId] : [])).rows;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, {});
    map.get(r.product_id)[r.company] = {
      id: r.id, active: r.active, commercialName: r.commercial_name, binLocation: r.bin_location, usedBy: r.used_by || [],
    };
  }
  return map;
}

/** For messages people read: an oil (stored in mL) in litres, anything else in its unit. */
export const qtyText = (v, unit) =>
  unit === 'mL' ? `${Math.round(v) / 1000} L` : `${Math.round(v * 1000) / 1000} ${unit || 'units'}`;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * The registration guard (S6): oil received, transferred or counted INTO a
 * company's stock needs the oil registered, active, in that company. The main
 * store needs none. A use is never checked: a MUSE sale cannot be refused (R5).
 * Throws a 400 carrying { code: 'NOT_REGISTERED', company, productId }, so any
 * window can offer "Register now" for that oil — see errorBody.
 */
export async function requireRegistered(db, productId, to) {
  const company = companyOf(to);
  if (!company) return;
  const ok = (await db.query(
    `SELECT 1 FROM fragrance_registrations WHERE product_id = $1 AND company = $2 AND active`, [productId, company])).rowCount;
  if (!ok) {
    throw Object.assign(new Error(`Please register the fragrance in ${company} Fragrances first.`),
      { status: 400, code: 'NOT_REGISTERED', company, productId });
  }
}

/** The JSON body of a refused request: the message, and the code when there is one. */
export const errorBody = (e) => ({
  error: e.message,
  ...(e.code && { code: e.code, company: e.company, productId: e.productId }),
  // How to put it right, for the pop-up a refused receipt opens (P6).
  ...(e.fix && { fix: e.fix, allowed: e.refusal?.allowed }),
});

/** Register an oil in each of `companies` (no-op where it already is). Inside the caller's client or pool. */
export async function registerOil(db, productId, companies, userId) {
  for (const company of companies) {
    await db.query(
      `INSERT INTO fragrance_registrations (product_id, company, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, company) DO NOTHING`, [productId, company, userId || null]);
  }
}

// Average cost per unit of an oil, from the receipts that carried a price.
async function averageCost(client, productId) {
  const r = await client.query(`SELECT sector_avg_cost($1) AS avg`, [productId]);
  return r.rows[0].avg == null ? null : Number(r.rows[0].avg);
}

/**
 * Write one movement inside the caller's transaction. Receipts are valued at
 * their PO cost; everything else at the oil's average cost.
 */
export async function recordMovement(client, m) {
  const cost = m.kind === 'receipt' ? (m.costPerUnit ?? null)
    : m.avgCost !== undefined ? m.avgCost : await averageCost(client, m.productId);
  const r = await client.query(
    `INSERT INTO sector_movements
       (product_id, from_sector, to_sector, quantity, kind, reason, reference, cost_per_unit, notes, transaction_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [m.productId, m.from, m.to, m.quantity, m.kind, m.reason || null, m.reference || null,
     cost, m.notes || null, m.transactionId || null, m.userId || null]);
  return r.rows[0].id;
}

/**
 * A stock adjustment by hand — PRD_H2_STOCK_MANAGEMENT.md A4–A12. ONE function
 * for every screen that adjusts stock (POST /stock/adjust for any product,
 * POST /sectors/adjust for one stock of an oil), so the rule has one version.
 *   SA, or any non-oil product: moves the total, so an oil's change lands in
 *     SA (S2), which may go negative (S3) — the ledger row the Stock page wrote.
 *   a MUSE stock, add: the total and that stock rise (a count).
 *   a MUSE stock, remove for production: a use (S4, S9) — sector_draw, with the
 *     order number.
 *   a MUSE stock, any other removal: that stock falls, never below zero (A7).
 *     Physical oil cannot be below zero, and letting the book go there would
 *     quietly lower SA, which is the total minus what the others hold.
 * Never the main store (D4): a wrong receipt is corrected on the receipt.
 * Inside the caller's transaction; it locks the product row, so two people
 * adjusting the same oil at once are checked one after the other. A stock-rule
 * refusal carries `refusal`, for recordRefusal (A12).
 */
export async function adjustStock(client, user, { productId, stock = 'SA', type, quantity, reason, reference, note, operatorIds }) {
  if (!productId || !quantity || !type) throw bad('Missing required fields: productId, quantity, type');
  if (!['add', 'remove'].includes(type)) throw bad('Type must be either "add" or "remove"');
  if (stock === 'MAIN') throw bad('The main store is not adjusted: a wrong receipt is corrected on the receipt');
  if (!SECTOR_KEYS.includes(stock)) throw bad('Choose the stock');
  const muse = MUSE_STOCKS.includes(stock);
  // The reason is what turns "how much did technicians use last month" into a
  // question with an answer (shared/stock-reasons.js).
  if (!isValidReason(type, reason, { muse })) throw bad('Choose why the stock is being adjusted');
  const noteText = String(note || '').trim();
  if (reason === 'other' && !noteText) throw bad('Say why, when the reason is Other');
  const qty = parseFloat(quantity);
  if (!(qty > 0)) throw bad('The quantity must be more than zero');
  const ref = String(reference || '').trim();
  const use = muse && type === 'remove' && reason === 'production';
  if (use && !ref) throw bad('Type the order number — every MUSE use needs one');

  // Who physically did it, from the operator list — separate from the login,
  // because some people work through somebody else's account (owner, 18/08/2026).
  let opIds = Array.isArray(operatorIds) ? operatorIds.map(Number).filter(Boolean) : [];
  let opNames = [];
  if (opIds.length) {
    const found = (await client.query(
      `SELECT id, name FROM sa.warehouse_operators WHERE id = ANY($1::int[]) AND active`, [opIds])).rows;
    if (found.length !== opIds.length) throw bad('One or more operators are unknown or inactive');
    opIds = found.map((r) => r.id);
    opNames = found.map((r) => r.name);
  }

  const product = (await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId])).rows[0];
  if (!product) throw bad('Product not found');
  if (product.category !== 'OILS' && stock !== 'SA') throw bad('Only fragrance oils are held by stock');
  // A use is never refused for registration (R5), as in sector_draw's callers.
  if (product.category === 'OILS' && !use) await requireRegistered(client, product.id, stock);
  if (muse && type === 'remove' && !use) {
    const held = Number((await client.query(
      `SELECT ${col(stock)} AS v FROM sector_held WHERE product_id = $1`, [product.id])).rows[0]?.v || 0);
    if (qty > Math.max(held, 0) + 0.001) {
      throw Object.assign(bad(`${sectorLabel(stock)} holds ${qtyText(Math.max(held, 0), product.unit)}. A removal can bring it to zero, not below. If ${sectorLabel(stock)} used oil from SA's shelf, record it as Production with the order number.`),
        { refusal: { productId: product.id, productName: product.name, stock, type, quantity: qty, held, reason, unit: product.unit } });
    }
  }

  const stockNow = (parseFloat(product.currentStock) || 0) + (type === 'add' ? qty : -qty);
  await client.query('UPDATE products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3',
    [stockNow, Math.floor(stockNow / (product.unitPerBox || 1)), product.id]);
  // The note carries the particulars beside the reason; operator names are
  // resolved here, so the note and the array cannot disagree.
  const where = stock === 'SA' ? '' : `${use ? 'Used by' : 'Adjusted in'} ${sectorLabel(stock)}`;
  const txId = (await client.query(
    `INSERT INTO transactions
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes, user_id, reason, operator_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [product.id, product.productCode || product.tag, product.name, product.category, type, qty, product.unit || 'units', stockNow,
     [reasonLabel(type, reason), where, ref ? `Ref ${ref}` : '', noteText, opNames.length ? `By: ${opNames.join(' / ')}` : '']
       .filter(Boolean).join(' — '),
     user.id, reason, opIds.length ? opIds : null])).rows[0].id;
  if (use) {
    await client.query(`SELECT sector_draw($1,$2,$3,'use',$4,$5,$6,$7,$8)`,
      [product.id, stock, qty, reason, ref, noteText || null, txId, user.id]);
  } else if (muse) {
    await recordMovement(client, {
      productId: product.id, from: type === 'add' ? 'COUNT' : stock, to: type === 'add' ? stock : 'USED',
      quantity: qty, kind: type === 'add' ? 'count' : 'adjust', reason, reference: ref, notes: noteText,
      transactionId: txId, userId: user.id,
    });
  }
  await client.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
     VALUES ($1, 'stock_adjust', 'product', $2, $3, $4)`,
    [user.id, product.id, product.name, JSON.stringify({
      productCode: product.productCode, unit: product.unit, stock, type, quantity: qty, reason,
      reference: ref || null, operators: opNames, balanceAfter: stockNow })]);
  return { product, newStock: stockNow };
}

/**
 * A refused stock-rule attempt, in Activity (H2 A12; P6, owner 30 Oct:
 * "registrar e bloquear e alertar"): who, when, the oil, the stock, what was
 * typed and what the stock held — for a receipt, the PO and who it is for.
 * Written after the ROLLBACK, so it stands on its own; stock and the ledger are
 * untouched. Failing to write it must not hide the refusal from the person:
 * logged, never thrown.
 */
export async function recordRefusal(user, e) {
  if (!e?.refusal) return;
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, 'stock_refused', 'product', $2, $3, $4)`,
      [user?.id || null, e.refusal.productId, e.refusal.productName, JSON.stringify({ ...e.refusal, message: e.message })]);
  } catch (err) {
    console.error('[sectors] refusal not recorded:', err.message);
  }
}

const isAdmin = (req) => ['admin', 'root'].includes(req.user?.role);

// ── POST /sectors/adjust — one stock of one oil, admin and root only (A1, S10).
router.post('/sectors/adjust', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admin or root can adjust stock' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = (await client.query(`SELECT category FROM products WHERE id = $1`, [req.body?.productId])).rows[0];
    if (product && product.category !== 'OILS') throw bad('Only fragrance oils are adjusted by stock here');
    const { newStock } = await adjustStock(client, req.user, req.body || {});
    await client.query('COMMIT');
    const sectors = await balancesAfterCommit(req.body.productId, newStock);
    res.json({ ok: true, total: newStock, sectors, saStock: sectors ? sectors.SA : null });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await recordRefusal(req.user, e);
    if (e.status) return res.status(e.status).json(errorBody(e));
    console.error('Sector adjust error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── GET /sectors/movements[?productId=&limit=] — recent movements, every oil or
//    one; GET /sectors/:productId/movements — one oil's. Newest first.
// Everyone with access sees them (R4); costs follow the Shopify POs page: not
// to technicians (S10).
router.get(['/sectors/movements', '/sectors/:productId/movements'], async (req, res) => {
  try {
    const productId = req.params.productId || req.query.productId || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500);
    const showCost = req.user?.role !== 'technician';
    const rows = (await pool.query(
      // created_at is naive UTC; said so explicitly, or a Sydney-time reader is 10 h off.
      `SELECT m.*, (m.created_at AT TIME ZONE 'UTC') AS created_utc, u.name AS user_name,
              p.name AS product_name, p."productCode" AS product_code, p.unit
         FROM sector_movements m JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
        ${productId ? 'WHERE m.product_id = $2' : ''}
        ORDER BY m.created_at DESC, m.id DESC LIMIT $1`, productId ? [limit, productId] : [limit])).rows;
    res.json(rows.map((r) => ({
      id: r.id, kind: r.kind, from: r.from_sector, to: r.to_sector,
      fromLabel: sectorLabel(r.from_sector), toLabel: sectorLabel(r.to_sector),
      productId: r.product_id, productCode: r.product_code, productName: r.product_name, unit: r.unit,
      quantity: Number(r.quantity), reason: r.reason, reference: r.reference, notes: r.notes,
      usedFor: r.used_for || null, transactionId: r.transaction_id,
      ...(showCost && { costPerUnit: r.cost_per_unit == null ? null : Number(r.cost_per_unit) }),
      user: r.user_name || null, createdAt: r.created_utc,
    })));
  } catch (e) {
    console.error('Sector movements error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /sectors/move — admin and root only (S10).
 *   kind 'transfer' : lines [{ from, to, quantity }]  any stock → any stock but the main
 *                     store; no change to the total, no ledger row
 * Counts and uses are adjustments since H2 (D3): POST /sectors/adjust, one rule
 * for every change to a stock.
 * `reference` and `notes` may be given per line or once for the call. Several
 * lines in one transaction: it lands whole or not at all.
 */
router.post('/sectors/move', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admin or root can move fragrance stock' });
  const client = await pool.connect();
  try {
    const { productId, kind, reference, notes } = req.body || {};
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [req.body];
    if (kind === 'count' || kind === 'use') throw bad('Counts and uses are made with Adjust stock');
    if (kind !== 'transfer') throw bad('Unknown movement');
    if (!lines.length) throw bad('Nothing to move');

    await client.query('BEGIN');
    const product = (await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [productId])).rows[0];
    if (!product) throw bad('Oil not found');
    if (product.category !== 'OILS') throw bad('Only fragrance oils are held by stock');

    // The main store never goes below zero (D2): it only holds received oil
    // waiting for its split, so taking out more than it holds is a typing
    // error, not a stock question. Summed over the lines, or two lines of
    // 60 L each out of 100 L would both pass.
    const outOfMain = lines.filter((l) => l.from === 'MAIN')
      .reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
    if (outOfMain > 0) {
      const main = Number((await client.query(`SELECT main FROM sector_held WHERE product_id = $1`, [product.id])).rows[0]?.main || 0);
      if (outOfMain > main + 0.001) {
        throw Object.assign(bad(`That takes ${qtyText(outOfMain, product.unit)} out of the main store, which holds ${qtyText(main, product.unit)}.`),
          { refusal: { productId: product.id, productName: product.name, stock: 'MAIN', type: 'transfer', quantity: outOfMain, held: main, unit: product.unit } });
      }
    }
    // Once per move, not per line.
    const avgCost = await averageCost(client, product.id);
    const stock = parseFloat(product.currentStock) || 0;
    const done = [];
    for (const l of lines) {
      const qty = parseFloat(l.quantity);
      if (!(qty > 0)) throw bad('Each quantity must be more than zero');
      const { from, to } = l;
      const ref = String(l.reference ?? reference ?? '').trim();
      const noteText = String(l.notes ?? notes ?? '').trim();
      if (!SECTOR_KEYS.includes(from)) throw bad('Choose where the oil comes from');
      if (!SECTOR_KEYS.includes(to)) throw bad('Choose where the oil goes');
      if (from === to) throw bad('From and to are the same stock');
      // It receives only from purchase orders (D2).
      if (to === 'MAIN') throw bad('The main store receives oil only from a purchase order');
      await requireRegistered(client, product.id, to);
      await recordMovement(client, {
        productId: product.id, from, to, quantity: qty, kind,
        reference: ref, notes: noteText, userId: req.user.id, avgCost,
      });
      done.push({ from, to, quantity: qty, reference: ref || null });
    }

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, $2, 'product', $3, $4, $5)`,
      [req.user.id, `sector_${kind}`, product.id, product.name,
       JSON.stringify({ productCode: product.productCode, unit: product.unit, reference: reference || null, lines: done })]);
    await client.query('COMMIT');

    const sectors = await balancesAfterCommit(product.id, stock);
    res.json({ ok: true, total: stock, sectors, saStock: sectors ? sectors.SA : null });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await recordRefusal(req.user, e);
    if (e.status) return res.status(e.status).json(errorBody(e));
    console.error('Sector move error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── Registrations (S6). Everyone with access sees them; admin and root register and edit.

const registrationView = (r) => ({
  id: r.id, productId: r.product_id, productCode: r.product_code, productName: r.product_name,
  company: r.company, commercialName: r.commercial_name, binLocation: r.bin_location, usedBy: r.used_by || [],
  active: r.active, createdBy: r.created_by_name || null, createdAt: r.created_utc, updatedAt: r.updated_utc,
});
const REGISTRATION_SELECT = `
  SELECT r.*, p.name AS product_name, p."productCode" AS product_code, u.name AS created_by_name,
         (r.created_at AT TIME ZONE 'UTC') AS created_utc, (r.updated_at AT TIME ZONE 'UTC') AS updated_utc
    FROM fragrance_registrations r JOIN products p ON p.id = r.product_id
    LEFT JOIN users u ON u.id = r.created_by`;

// What a registration request may set, validated against the company. Only
// the fields sent: an edit that does not mention a field leaves it alone.
function registrationFields(body, company) {
  const f = {};
  if ('commercialName' in body) f.commercial_name = String(body.commercialName ?? '').trim() || null;
  if ('binLocation' in body) {
    f.bin_location = String(body.binLocation ?? '').trim() || null;
    if (f.bin_location && company !== 'MUSE') throw bad('SA keeps its bin location on the oil itself');
  }
  if ('usedBy' in body) {
    if (!Array.isArray(body.usedBy) || body.usedBy.some((u) => !MUSE_UNITS.includes(u))) {
      throw bad('Used by is one or more of MUSE The Atelier, MUSE The Library and MUSE The Archive');
    }
    if (body.usedBy.length && company !== 'MUSE') throw bad('Only a MUSE registration says which MUSE units use the oil');
    f.used_by = [...new Set(body.usedBy)];
  }
  return f;
}

// ── GET /fragrance-registrations[?company=SA|MUSE][&productId=]
router.get('/fragrance-registrations', async (req, res) => {
  try {
    const company = req.query.company || null;
    if (company && !COMPANIES.includes(company)) return res.status(400).json({ error: 'company is SA or MUSE' });
    const rows = (await pool.query(
      `${REGISTRATION_SELECT} WHERE ($1::TEXT IS NULL OR r.company = $1) AND ($2::TEXT IS NULL OR r.product_id = $2)
        ORDER BY p.name, r.company`, [company, req.query.productId || null])).rows;
    res.json(rows.map(registrationView));
  } catch (e) {
    console.error('Registrations error:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /fragrance-registrations { productId, company, commercialName?, binLocation?, usedBy?, active? }
// Register and edit in one: the oil's registration in that company is created
// or updated with the fields sent; every field NOT sent keeps its value —
// `active` too (fix round 2: an edit of the bin must never reactivate a
// retired registration). A new registration is active unless `active: false`
// says otherwise (the column default).
// Returns { registrations } — every company's registration of that oil, the
// shape GET /products carries — and whether it was created.
router.post('/fragrance-registrations', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admin or root can register a fragrance' });
  const client = await pool.connect();
  let product, created;
  try {
    const body = req.body || {};
    const { productId, company } = body;
    if (!COMPANIES.includes(company)) throw bad('Choose SA or MUSE');
    const f = { ...registrationFields(body, company), ...('active' in body && { active: !!body.active }) };
    product = (await client.query(`SELECT id, name, category FROM products WHERE id = $1`, [productId])).rows[0];
    if (!product) throw bad('Oil not found');
    if (product.category !== 'OILS') throw bad('Only fragrance oils are registered');
    // The registration and its audit row land together or not at all (fix round 3, F1).
    await client.query('BEGIN');
    const before = (await client.query(
      `SELECT * FROM fragrance_registrations WHERE product_id = $1 AND company = $2 FOR UPDATE`, [product.id, company])).rows[0];
    const keys = Object.keys(f); // may be empty: then an existing row only gets updated_at
    // One statement: two people registering the same oil at once both land, never a 500.
    created = (await client.query(
      `INSERT INTO fragrance_registrations (${['product_id', 'company', 'created_by', ...keys].join(', ')})
       VALUES (${['$1', '$2', '$3', ...keys.map((_, i) => `$${i + 4}`)].join(', ')})
       ON CONFLICT (product_id, company) DO UPDATE SET ${[...keys.map((k) => `${k} = EXCLUDED.${k}`), 'updated_at = NOW()'].join(', ')}
       RETURNING (xmax = 0) AS created`,
      [product.id, company, req.user.id, ...keys.map((k) => f[k])])).rows[0].created;
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, entity_name, details)
       VALUES ($1, $2, 'product', $3, $4, $5)`,
      [req.user.id, created ? 'fragrance_registered' : 'fragrance_registration_updated', product.id, product.name,
       JSON.stringify(created
         ? { company, ...f, active: f.active ?? true }
         : { company, changes: Object.fromEntries(keys.map((k) => [k, { from: before?.[k] ?? null, to: f[k] }])) })]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (e.status) return res.status(e.status).json(errorBody(e));
    console.error('Register fragrance error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
  client.release();
  // Saved. Failing to read it back must not turn it into an error (R8): null, logged; the screens reload.
  let registrations = null;
  try {
    registrations = (await registrationsByProduct(product.id)).get(product.id) || {};
  } catch (e) {
    console.error(`[sectors] registered, but the registrations of ${product.id} could not be read back:`, e.message);
  }
  res.json({ registrations, created });
});
