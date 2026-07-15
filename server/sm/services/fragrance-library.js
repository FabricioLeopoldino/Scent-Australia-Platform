// ═══════════════════════════════════════════════════════════════════════════
// FRAGRANCE LIBRARY — D14 (2026-07-15): the shared fragrance oil pool.
// ═══════════════════════════════════════════════════════════════════════════
// There is one physical cold room; SA, Scented Merchandise (B2B) and MUSE all
// draw fragrance oil from it. This module is how the SM side of the platform
// consumes that oil — it is the ONLY code outside the SA module that ever
// writes to sa.products / sa.transactions.
//
// SAFETY PRINCIPLE (see D14_FRAGRANCE_LIBRARY.md §6): SA does not change how
// it behaves and never needs to know this module exists. This code obeys the
// EXACT pattern SA's own stock-mutating routes already use in production —
// SELECT ... FOR UPDATE row lock, a non-negative guard, and an auditable
// sa.transactions row with balance_after (the same shape as the cross-system
// transfer's SEND side in platform/transfers.js and SA's own Tech Stock).
//
// No new database connection is needed: this file runs its queries through
// whatever `tq` (query function) the CALLER's transaction already uses — sm's
// pool has full access to the sa schema (same physical database, same role);
// only UNQUALIFIED table names resolve via search_path=sm, so every query here
// explicitly qualifies `sa.products` / `sa.transactions`.
// ═══════════════════════════════════════════════════════════════════════════

// segment (from the production order's master product) -> the exclusivity
// bucket it belongs to, and the transaction type pair it writes.
// STANDARD and MAJOR are both Scented Merchandise (B2B) for exclusivity
// purposes, but keep separate transaction types for the 4-bucket usage report
// (D14.5: SA · SM-Standard · SM-Major · MUSE).
const SEGMENT_MAP = {
  MUSE:     { exclusivityBucket: 'MUSE', debitType: 'muse_production',    reversalType: 'muse_reversal' },
  STANDARD: { exclusivityBucket: 'SM',   debitType: 'sm_std_production',  reversalType: 'sm_std_reversal' },
  MAJOR:    { exclusivityBucket: 'SM',   debitType: 'sm_major_production', reversalType: 'sm_major_reversal' },
}

function resolveSegment(segment) {
  const s = SEGMENT_MAP[segment]
  if (!s) throw new Error(`Unknown segment "${segment}" for Fragrance Library consumption (expected MUSE, STANDARD or MAJOR)`)
  return s
}

// Lock + validate an oil for consumption/restoration. Shared by both
// directions so the exclusivity/existence checks can never drift apart.
async function lockOil(tq, oilId, exclusivityBucket) {
  const r = await tq(
    `SELECT id, name, "productCode", "currentStock", unit, "unitPerBox", exclusivity
     FROM sa.products WHERE id = $1 AND category = 'OILS' FOR UPDATE`,
    [oilId]
  )
  const oil = r.rows[0]
  if (!oil) throw new Error(`Fragrance oil not found in the Fragrance Library: ${oilId}`)
  if (oil.exclusivity && oil.exclusivity !== exclusivityBucket) {
    throw new Error(`Fragrance oil "${oil.name}" is exclusive to ${oil.exclusivity} and cannot be used by ${exclusivityBucket} production`)
  }
  return oil
}

// sa.products has an AFTER UPDATE trigger (log_direct_stock_change) whose body
// references `direct_stock_changes` WITHOUT a schema prefix — it was written
// assuming the caller's session already has search_path=sa (true for every
// existing SA route). Called from the SM pool (search_path=sm,public) that
// unqualified name doesn't resolve. Rather than touch the SA trigger function
// (D14.4: SA is structurally untouched), the write is bracketed with a
// transaction-scoped SET LOCAL naming `sa` first, then restored to `sm` so any
// sibling sm.* statement elsewhere in the SAME caller transaction is
// unaffected. Fully qualified SELECTs (lockOil above) never needed this.
async function withSaSearchPath(tq, fn) {
  await tq(`SET LOCAL search_path TO sa, public`)
  try {
    return await fn()
  } finally {
    await tq(`SET LOCAL search_path TO sm, public`)
  }
}

/**
 * Consume (debit) fragrance oil from the shared Fragrance Library for an
 * SM/MUSE production. Atomic: row-locked, non-negative guard, auditable.
 *
 * @param tq       query function bound to the CALLER's transaction client
 * @param oilId    sa.products.id (e.g. "OIL_175")
 * @param qtyMl    quantity to deduct, in the oil's own unit (mL)
 * @param segment  'MUSE' | 'STANDARD' | 'MAJOR' — the production order's master segment
 * @param notes    free-text audit note (e.g. order number, product name)
 * @returns { oilId, name, code, qtyMl, newStock }
 */
async function consumeFragranceOil(tq, oilId, qtyMl, segment, notes) {
  const qty = parseFloat(qtyMl)
  if (!oilId || !(qty > 0)) throw new Error('consumeFragranceOil requires oilId and a positive qtyMl')
  const { exclusivityBucket, debitType } = resolveSegment(segment)

  const oil = await lockOil(tq, oilId, exclusivityBucket)
  const current = parseFloat(oil.currentStock) || 0
  if (qty > current) {
    throw new Error(`Insufficient Fragrance Library stock for "${oil.name}": available ${current} ${oil.unit || 'mL'}, requested ${qty}`)
  }

  const newStock = current - qty
  await withSaSearchPath(tq, () => tq(
    `UPDATE sa.products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3`,
    [newStock, Math.floor(newStock / (oil.unitPerBox || 1)), oil.id]
  ))
  await tq(
    `INSERT INTO sa.transactions
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
     VALUES ($1,$2,$3,'OILS',$4,$5,$6,$7,$8)`,
    [oil.id, oil.productCode || oil.tag, oil.name, debitType, qty, oil.unit || 'mL', newStock, notes || null]
  )
  return { oilId: oil.id, name: oil.name, code: oil.productCode, qtyMl: qty, newStock }
}

/**
 * Restore (credit) fragrance oil back to the Fragrance Library — the reversal
 * of consumeFragranceOil, for a cancelled/failed production.
 * Same signature and shape as consumeFragranceOil.
 */
async function restoreFragranceOil(tq, oilId, qtyMl, segment, notes) {
  const qty = parseFloat(qtyMl)
  if (!oilId || !(qty > 0)) throw new Error('restoreFragranceOil requires oilId and a positive qtyMl')
  const { exclusivityBucket, reversalType } = resolveSegment(segment)

  const oil = await lockOil(tq, oilId, exclusivityBucket)
  const current = parseFloat(oil.currentStock) || 0
  const newStock = current + qty

  await withSaSearchPath(tq, () => tq(
    `UPDATE sa.products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3`,
    [newStock, Math.floor(newStock / (oil.unitPerBox || 1)), oil.id]
  ))
  await tq(
    `INSERT INTO sa.transactions
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
     VALUES ($1,$2,$3,'OILS',$4,$5,$6,$7,$8)`,
    [oil.id, oil.productCode || oil.tag, oil.name, reversalType, qty, oil.unit || 'mL', newStock, notes || null]
  )
  return { oilId: oil.id, name: oil.name, code: oil.productCode, qtyMl: qty, newStock }
}

module.exports = { consumeFragranceOil, restoreFragranceOil, SEGMENT_MAP }
