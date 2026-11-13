// D17 Block B — the oil a candle filler holds (PRD_D17_PRODUCTION_FLOW.md,
// revised 11 Nov 2026).
//
// A candle is filled outside (Eric). The oil goes out in litres with the
// glasses, the candles come back, and whatever oil is left comes back with
// them. So a candle line's oil is NOT taken at Start Production like every
// other line's (D17.3): it is debited when it physically leaves, for the amount
// that actually left (always rounded up to whole containers, so more than the
// recipe), and credited when the surplus returns. In between, the cold room's
// number is true and the difference is what the candles consumed.
//
// The external_processing record is the ledger: which oil, how much went, how
// much came back, and the ledger row of the send (oil_tx_id) so a return goes
// back to the stocks that send drew from. Both doors write it — "Send for
// Filling" in the Manufacturing Queue and the External Processing screens.
//
// Nothing here blocks on stock: an oil that is short goes negative, as
// everywhere else (owner, 11 Nov 2026).
const {
  consumeFragranceOil, restoreFragranceOil, resolveOrderSegment, resolveCandleOil, LINE_OIL_SELECT,
} = require('./fragrance-library')

// A mistake by the person at the screen, not a fault: answered with 400.
class CandleOilError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// Moving oil is admin/root only (D17.14) — the same rule on every door.
function requireOilRole(user) {
  if (!['admin', 'root'].includes(user?.role)) {
    throw new CandleOilError('Only admin or root can record oil sent to or returned from the filler', 403)
  }
}

// What a candle line pours and what its recipe asks for. The oil is the candle
// version of the line's oil where one exists (Block A), else the line's oil.
// null when the line names no Fragrance Library oil.
async function candleOilFor(tq, lineId) {
  const line = (await tq(`${LINE_OIL_SELECT} WHERE pol.id = $1`, [lineId])).rows[0]
  if (!line?.oil_id) return null
  const oilId = await resolveCandleOil(tq, line.oil_id)
  const oil = (await tq(`SELECT id, "productCode" AS code, name, unit FROM sa.products WHERE id = $1`, [oilId])).rows[0]
  if (!oil) return null
  return {
    line,
    oil_id: oil.id, code: oil.code, name: oil.name,
    is_candle_version: oil.id !== line.oil_id,
    calculated_ml: parseFloat(line.oil_qty_ml) || 0,
    // The old model took a candle line's oil at Start. A line started before
    // this release must not be debited a second time when it is sent (R6).
    debited_at_start: !!line.oil_debited_at,
  }
}

const tag = (ep, orderNumber) => `EP #${ep.id}${orderNumber ? ` · ${orderNumber}` : ''}${ep.supplier ? ` · ${ep.supplier}` : ''}`

async function lockEp(tq, epId) {
  const ep = (await tq(`SELECT * FROM external_processing WHERE id = $1 FOR UPDATE`, [epId])).rows[0]
  if (!ep) throw new CandleOilError('External processing record not found', 404)
  if (ep.processing_type !== 'candle_filling') throw new CandleOilError('Oil is recorded on candle filling records only')
  const order = ep.production_order_id
    ? (await tq(`SELECT * FROM production_orders WHERE id = $1`, [ep.production_order_id])).rows[0] : null
  if (!order) throw new CandleOilError('This record is not linked to a production order, so its oil cannot be recorded')
  return { ep, order }
}

// The oil leaves for the filler: one debit per record, for the actual amount.
// Returns { oil, ml } or { skipped: 'debited_at_start' }.
async function sendCandleOil(tq, { epId, ml }) {
  const qty = parseFloat(ml)
  if (!(qty > 0)) throw new CandleOilError('Oil sent must be more than zero')
  const { ep, order } = await lockEp(tq, epId)
  // Idempotent: a second send on the same record would be the double debit this
  // whole block exists to prevent.
  if (ep.oil_qty_sent_ml !== null) throw new CandleOilError('The oil sent is already recorded on this record')
  if (!ep.production_order_line_id) throw new CandleOilError('This record is not linked to a candle line, so there is no oil to take')
  const info = await candleOilFor(tq, ep.production_order_line_id)
  if (!info) throw new CandleOilError('This candle line names no Fragrance Library oil')
  if (info.debited_at_start) return { skipped: 'debited_at_start', oil: info }

  const segment = await resolveOrderSegment(order, tq)
  const debit = await consumeFragranceOil(tq, info.oil_id, qty, segment,
    `Candle filling: ${tag(ep, order.order_number)}`, info.line.business_unit)
  await tq(
    `UPDATE external_processing SET oil_id = $1, oil_qty_sent_ml = $2, oil_qty_returned_ml = 0, oil_tx_id = $3 WHERE id = $4`,
    [info.oil_id, qty, debit.transactionId, ep.id])
  return { oil: info, ml: qty, stock_after: debit.newStock }
}

// Surplus oil comes back. The user never picks the oil: it is the one this
// record sent (D17.12). Partial returns add up; less than was sent is the
// normal case (the rest is in the candles); more than was sent is a typo.
async function returnCandleOil(tq, { epId, ml }) {
  const qty = parseFloat(ml)
  if (!(qty > 0)) throw new CandleOilError('Oil returned must be more than zero')
  const { ep, order } = await lockEp(tq, epId)
  if (!ep.oil_id || ep.oil_qty_sent_ml === null) throw new CandleOilError('No oil was recorded as sent on this record, so none can come back on it')
  const sent = parseFloat(ep.oil_qty_sent_ml)
  const before = parseFloat(ep.oil_qty_returned_ml) || 0
  if (before + qty > sent + 0.0005) {
    throw new CandleOilError(`Only ${sent.toLocaleString()} mL was sent and ${before.toLocaleString()} mL is already back — ${qty.toLocaleString()} mL more cannot return`)
  }
  const segment = await resolveOrderSegment(order, tq)
  const credit = await restoreFragranceOil(tq, ep.oil_id, qty, segment,
    `Candle filling return: ${tag(ep, order.order_number)}`, { txId: ep.oil_tx_id, returnedBefore: before })
  await tq(`UPDATE external_processing SET oil_qty_returned_ml = $1 WHERE id = $2`, [before + qty, ep.id])
  return { oil_id: ep.oil_id, ml: qty, returned_total: before + qty, stock_after: credit.newStock }
}

module.exports = { candleOilFor, sendCandleOil, returnCandleOil, requireOilRole, CandleOilError }
