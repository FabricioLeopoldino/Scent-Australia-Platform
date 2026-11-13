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
// SELECT ... FOR UPDATE row lock and an auditable sa.transactions row with
// balance_after (the same shape as the cross-system transfer's SEND side in
// platform/transfers.js and SA's own Tech Stock).
//
// NEGATIVE STOCK IS ALLOWED HERE ON PURPOSE (owner, 2026-07-15). SA's own
// stock-mutating code carries the same choice in 4 places (each commented
// "Allow negative stock") — physical drum counts are inherently uncertain
// (a supplier's paperwork says 20 L, the drum holds 22 L; nobody weighs it
// until it runs low) and the warehouse process isn't fully precise yet. A
// hard block here could refuse a production run that is physically fine to
// do — worse than the discrepancy itself. The real safety net is
// operational: SA's existing "Negative Stock Alerts" dashboard already
// queries `currentStock <= 0` with no notion of which business caused it, so
// a Fragrance Library-driven negative surfaces there for free, and the owner
// resolves it the same way as any other negative: contact the warehouse,
// verify physically, correct manually.
//
// Exclusivity is a DIFFERENT kind of rule — not a quantity/measurement
// question but an access-control one ("this oil is not for your business at
// all") — so it still hard-blocks, unconditionally.
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
  // MAJOR has its own bucket (2026-08-14). It shared 'SM' with STANDARD, which
  // was harmless while exclusivity was a single-value comparison. When
  // EXCLUSIVITY_ALLOWS.MUSE was widened to ['MUSE','SM'] on 12 August so the
  // Atelier could reach the Archive oils, client work was carried through the
  // same door: a B2B client's product became able to consume a MUSE-exclusive
  // oil, which it could not do before. The Muse PLATFORM is retail plus the
  // Atelier; a client's own production is not part of it.
  //
  // No live exposure when this was found — there are no Major Clients migrated
  // yet — but two existing regressions had been asserting the old behaviour and
  // failing silently since the 12th, because a NEW test was written instead of
  // reconciling with the ones already there.
  MAJOR:    { exclusivityBucket: 'MAJOR', debitType: 'sm_major_production', reversalType: 'sm_major_reversal' },
}

// ONE definition of who may use an oil. Everything that asks the question --
// the consumption lock, the oil picker and the MUSE registration screen --
// calls this, so the three cannot drift apart the way the webhook topic lists
// and the format lists did.
//
// The values mirror how the business is actually split (staff deck, Aug 2026):
// Scent Australia is the B2B commercial side; the Muse PLATFORM is the consumer
// side, and the Atelier is one of its units. So "MUSE" is not "MUSE retail
// only" -- it means the Muse platform, which includes the Atelier (segment
// STANDARD, bucket SM). Reading it as retail-only is exactly the mistake the
// label invited, and it silently locked the Atelier out of the seven Archive
// oils on 2026-08-12.
//
// It does NOT include a client's own production. MAJOR has its own bucket for
// that reason -- see SEGMENT_MAP above.
//
//   null / ''  shared -- anyone, including client work
//   'MUSE'     the Muse platform: MUSE retail + the Atelier. Not clients, never SA.
//   'SA'       Scent Australia only. This is what protects a B2B client's
//              Signature Fragrance from being sold through Muse -- the deck's
//              firmest boundary, which until now had no way to be expressed.
//   'SM'       legacy, Atelier only. Kept working; no oil uses it.
const EXCLUSIVITY_ALLOWS = {
  MUSE: ['MUSE', 'SM'],
  SM: ['SM'],
  SA: [],            // nothing on the Muse side may consume it
}
function canUseOil(exclusivity, bucket) {
  const e = (exclusivity || '').trim()
  if (!e || e === 'SHARED') return true
  const allowed = EXCLUSIVITY_ALLOWS[e]
  // An unknown value is treated as a restriction, not as permission. A typo in
  // that column must never widen access.
  return allowed ? allowed.includes(bucket) : false
}

// Which MUSE stock production draws from (PRD_STAGE_1_FRAGRANCE_LIBRARY.md S4;
// keys in shared/sectors.js). MUSE retail by the product's unit; client work —
// the old Scented Merchandise, standard or major — is MUSE The Atelier. The
// keys of SECTOR_FOR_UNIT are the stored sm.products.business_unit values.
// Both callers pass the unit of the VARIANT sold or made, never its master's
// (every master is 'library'): the fulfilment webhook (the sold sm product)
// and the manufacturing route (the variant under the line's master carrying
// its oil). Unknown → The Library.
const SECTOR_FOR_UNIT = { atelier: 'MUSE_ATELIER', archive: 'MUSE_ARCHIVE', library: 'MUSE_LIBRARY' }
function productionSector(segment, businessUnit) {
  if (segment !== 'MUSE') return 'MUSE_ATELIER'
  return SECTOR_FOR_UNIT[businessUnit] || 'MUSE_LIBRARY'
}

// The stock side of a debit, linked to its ledger row: the unit's own oil,
// then MUSE (shared), then SA's shelf for that unit. The rule lives in ONE
// place, the sa.sector_draw database function (sa/sectors.js), shared with the
// SA screens — this file is CommonJS and cannot import the ESM one.
async function drawFromSector(tq, oilId, sector, qty, notes, transactionId) {
  await tq(`SELECT sa.sector_draw($1,$2,$3,'production',NULL,NULL,$4,$5,NULL)`,
    [oilId, sector, qty, notes || null, transactionId])
}

// D14: which usage bucket an order's oil lands in — MUSE (no client) or a B2B
// client, split by is_large_client into Major and Standard. One definition for
// the debit at Start, the candle send and /complete.
async function resolveOrderSegment(order, tq) {
  if (!order.client_id) return 'MUSE'
  const cli = await tq(`SELECT is_large_client FROM clients WHERE id = $1`, [order.client_id])
  return cli.rows[0]?.is_large_client ? 'MAJOR' : 'STANDARD'
}

// The oil a production line takes, with the unit of the VARIANT being made —
// which picks the MUSE stock it is drawn from. Not the master's unit: every
// master (TS10, RS100, RD200…) is 'library', and The Library and The Archive
// share masters. The variant is the sm product under that master carrying this
// line's oil; when several match, the one the line names first (variant_name,
// which the MUSE webhook writes from the sold variant), then a live one before
// an archived one, then the oldest. None → The Library (productionSector).
// ONE query text for the debit at Start, the shortage warning and the candle
// send, so they can never look at different stocks. Callers add the WHERE.
const LINE_OIL_SELECT =
  `SELECT pol.id, pol.production_order_id, pol.oil_id, pol.oil_qty_ml, pol.is_candle, pol.oil_debited_at, pol.quantity,
          (SELECT v.business_unit FROM products v
             JOIN products m ON m.id = v.master_product_id
            WHERE m.product_code = pol.product_type AND m.category = 'FINISHED_GOOD' AND v.oil_id = pol.oil_id
            ORDER BY (v.name IS DISTINCT FROM pol.variant_name), (v.archived IS TRUE), v.id LIMIT 1) AS business_unit
     FROM production_order_lines pol`

// D17 Block A — which oil a CANDLE pours (owner, 11 Nov 2026). Any Library
// fragrance may be chosen for a candle and is poured from its ordinary oil;
// where a candle version of that oil exists (a purchased, candle-grade record:
// sa.products.candle_of), the candle uses it instead. Existence decides WHICH
// oil; stock never does — a candle version that has run out is not swapped
// for the ordinary oil, it goes negative like everything else. A retired
// (inactive) candle version no longer counts. Never rejects: no candle version
// is the normal case.
async function resolveCandleOil(tq, oilId) {
  const r = await tq(
    `SELECT id FROM sa.products WHERE candle_of = $1 AND category = 'OILS' AND COALESCE(status, 'active') <> 'inactive'`, [oilId])
  return r.rows[0]?.id || oilId
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
  if (!canUseOil(oil.exclusivity, exclusivityBucket)) {
    throw new Error(`Fragrance oil "${oil.name}" is restricted to ${oil.exclusivity} and cannot be used by ${exclusivityBucket} production`)
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
 * SM/MUSE production. Atomic: row-locked, auditable. Deliberately allowed to
 * go negative (see the note at the top of this file) — only the exclusivity
 * rule can refuse a consumption, never the quantity.
 *
 * @param tq       query function bound to the CALLER's transaction client
 * @param oilId    sa.products.id (e.g. "OIL_175")
 * @param qtyMl    quantity to deduct, in the oil's own unit (mL)
 * @param segment  'MUSE' | 'STANDARD' | 'MAJOR' — the production order's master segment
 * @param notes    free-text audit note (e.g. order number, product name)
 * @param businessUnit  the MUSE product's unit (atelier/archive/library) — picks the sector
 * @returns { oilId, name, code, qtyMl, newStock }
 */
async function consumeFragranceOil(tq, oilId, qtyMl, segment, notes, businessUnit) {
  const qty = parseFloat(qtyMl)
  if (!oilId || !(qty > 0)) throw new Error('consumeFragranceOil requires oilId and a positive qtyMl')
  const { exclusivityBucket, debitType } = resolveSegment(segment)

  const oil = await lockOil(tq, oilId, exclusivityBucket)
  const current = parseFloat(oil.currentStock) || 0
  const newStock = current - qty
  await withSaSearchPath(tq, () => tq(
    `UPDATE sa.products SET "currentStock" = $1, "stockBoxes" = $2 WHERE id = $3`,
    [newStock, Math.floor(newStock / (oil.unitPerBox || 1)), oil.id]
  ))
  const tx = await tq(
    `INSERT INTO sa.transactions
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
     VALUES ($1,$2,$3,'OILS',$4,$5,$6,$7,$8) RETURNING id`,
    [oil.id, oil.productCode || oil.tag, oil.name, debitType, qty, oil.unit || 'mL', newStock, notes || null]
  )
  await drawFromSector(tq, oil.id, productionSector(segment, businessUnit), qty, notes, tx.rows[0].id)
  return { oilId: oil.id, name: oil.name, code: oil.productCode, qtyMl: qty, newStock, transactionId: tx.rows[0].id }
}

/**
 * Restore (credit) fragrance oil back to the Fragrance Library — the reversal
 * of consumeFragranceOil, for a cancelled/failed production.
 * Same signature and shape as consumeFragranceOil.
 *
 * @param draw  optional { txId, returnedBefore } — the ledger row of the debit
 *              this undoes and how much of it has already come back. With it,
 *              the oil returns to the stocks that debit drew from (D17 R2).
 */
async function restoreFragranceOil(tq, oilId, qtyMl, segment, notes, draw) {
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
  const tx = await tq(
    `INSERT INTO sa.transactions
       (product_id, product_code, product_name, category, type, quantity, unit, balance_after, notes)
     VALUES ($1,$2,$3,'OILS',$4,$5,$6,$7,$8) RETURNING id`,
    [oil.id, oil.productCode || oil.tag, oil.name, reversalType, qty, oil.unit || 'mL', newStock, notes || null]
  )
  // Where the oil goes back to. A return that names its draw (the candle
  // filler's surplus, D17 R2) goes back to the stocks that draw took from, the
  // last one drawn first — SA covered the shortfall, so the surplus is SA's
  // before it is the unit's — each up to what it gave, skipping what earlier
  // returns already put back. A return with no draw goes onto the shelf, i.e.
  // to SA (the remainder): nothing says which stock it came from.
  const back = async (sector, ml) => tq(
    `INSERT INTO sa.sector_movements (product_id, from_sector, to_sector, quantity, kind, notes, transaction_id, cost_per_unit)
     VALUES ($1,'USED',$2,$3,'reversal',$4,$5, sa.sector_avg_cost($1))`, [oil.id, sector, ml, notes || null, tx.rows[0].id])
  let left = qty
  if (draw?.txId) {
    const drawn = (await tq(
      `SELECT from_sector, quantity FROM sa.sector_movements
        WHERE transaction_id = $1 AND product_id = $2 AND to_sector = 'USED' ORDER BY id DESC`, [draw.txId, oil.id])).rows
    let skip = parseFloat(draw.returnedBefore) || 0
    for (const m of drawn) {
      let room = parseFloat(m.quantity)
      const skipped = Math.min(skip, room); skip -= skipped; room -= skipped
      const part = Math.min(left, room)
      if (part > 0) { await back(m.from_sector, part); left -= part }
    }
  }
  if (left > 0) await back('SA', left)
  return { oilId: oil.id, name: oil.name, code: oil.productCode, qtyMl: qty, newStock, transactionId: tx.rows[0].id }
}

module.exports = { consumeFragranceOil, restoreFragranceOil, SEGMENT_MAP, canUseOil, EXCLUSIVITY_ALLOWS, SECTOR_FOR_UNIT, productionSector,
  resolveOrderSegment, resolveCandleOil, LINE_OIL_SELECT }
