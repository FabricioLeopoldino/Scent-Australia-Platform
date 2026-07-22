// Single gate for every production_orders.status write (QA #7, phase 2).
//
// A state machine was added to PUT /production-orders/:id/status, but an audit
// found ELEVEN places writing `status` — only that one endpoint validated
// anything. The other ten wrote raw SQL, so the machine guarded one door out of
// eleven. This module is the one door.
//
// The whitelist below was rebuilt FROM the audit, not from theory: every
// transition listed here is one the code already performs today. Two entries the
// original whitelist was missing would have broken production had it been
// enforced as written:
//   · fulfilled ← in_production   (MUSE orders auto-fulfil straight from
//                                  manufacturing complete, skipping 'completed')
//   · cancelled ← *               (the key didn't exist at all)
// If a legitimate flow isn't listed here, this table is wrong — not the flow.
const STATUS_TRANSITIONS = {
  draft:            ['queued'],                                     // "Return to Orders" (nothing debited yet)
  confirmed:        ['draft'],                                      // Shopify draft order created
  queued:           ['draft', 'confirmed'],
  waiting_external: ['draft', 'confirmed', 'queued', 'in_production'],
  in_production:    ['queued', 'waiting_external'],                 // start, or resume after filling returns
  completed:        ['in_production'],
  ready_to_ship:    ['completed'],
  fulfilled:        ['in_production', 'completed', 'ready_to_ship'],
  // Deliberately permissive: a cancellation can arrive from Shopify at any point,
  // and dropping that signal is worse than recording a late cancel. Terminal
  // anyway, and reversible by the owner.
  cancelled:        ['draft', 'confirmed', 'queued', 'waiting_external', 'in_production', 'completed', 'ready_to_ship', 'fulfilled'],
}

class InvalidStatusTransition extends Error {
  constructor(from, to) {
    super(`Cannot move an order from '${from}' to '${to}'`)
    this.name = 'InvalidStatusTransition'
    this.from = from
    this.to = to
    this.statusCode = 400
  }
}

/**
 * Set a production order's status, validating the transition.
 *
 * @param orderId
 * @param next       target status
 * @param opts.tq    query fn bound to the caller's transaction (defaults to the pool)
 * @param opts.extra optional columns to set alongside, e.g. { external_type, external_supplier }
 * @param opts.force skip validation — for the rare path where the transition is
 *                   driven by an outside system and refusing would lose the event.
 *                   Must be justified at the call site; grep for it.
 * @returns the new status, or null if the order doesn't exist
 */
async function setOrderStatus(orderId, next, opts = {}) {
  const { tq, extra = {}, force = false } = opts
  const run = tq || require('../db').query

  const cur = await run(`SELECT status FROM production_orders WHERE id = $1`, [orderId])
  if (!cur.rows[0]) return null
  const from = cur.rows[0].status

  if (!force) {
    const allowedFrom = STATUS_TRANSITIONS[next]
    if (!allowedFrom) throw new InvalidStatusTransition(from, next)
    // Re-setting the same status is a harmless no-op (idempotent retries).
    if (from !== next && !allowedFrom.includes(from)) throw new InvalidStatusTransition(from, next)
  }

  const cols = ['status = $1', 'updated_at = NOW()']
  const params = [next]
  for (const [col, val] of Object.entries(extra)) {
    params.push(val)
    cols.push(`${col} = $${params.length}`)
  }
  params.push(orderId)
  await run(`UPDATE production_orders SET ${cols.join(', ')} WHERE id = $${params.length}`, params)
  return next
}

module.exports = { setOrderStatus, STATUS_TRANSITIONS, InvalidStatusTransition }
