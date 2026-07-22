// ═══════════════════════════════════════════════════════════════════════════
// ORDER STATUS MACHINE — every write goes through one validated gate
// ═══════════════════════════════════════════════════════════════════════════
// A state machine was added to PUT /production-orders/:id/status, but an audit
// found ELEVEN places writing production_orders.status — ten of them raw SQL
// that never validated anything. The machine guarded one door out of eleven.
//
// setOrderStatus() (services/order-status.js) is now the only door. This gate
// asserts the table itself: that it accepts every transition the app legitimately
// performs, and rejects the ones that would corrupt an order's history.
//
// The two entries the ORIGINAL whitelist was missing are asserted explicitly —
// enforcing it as first written would have broken MUSE order completion and all
// cancellation.
//
// Pure logic test against the exported table: no DB, no server needed.
//
// Usage: node scripts/regression-status-machine.cjs
// ═══════════════════════════════════════════════════════════════════════════
const { STATUS_TRANSITIONS } = require('../server/sm/services/order-status');

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`PASS  ${m}${d ? ' — ' + d : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`FAIL  ${m}${d ? ' — ' + d : ''}`); };

const allows = (to, from) => (STATUS_TRANSITIONS[to] || []).includes(from);

// ── Every transition the code actually performs today (from the audit) ───────
const MUST_ALLOW = [
  ['draft', 'confirmed', 'Shopify draft order created'],
  ['draft', 'queued', 'Queue without Shopify'],
  ['confirmed', 'queued', 'Queue a confirmed order'],
  ['queued', 'in_production', 'Start production'],
  ['queued', 'waiting_external', 'EP requested before start'],
  ['in_production', 'waiting_external', 'Send candles for filling mid-production'],
  ['waiting_external', 'in_production', 'Filling returned — resume'],
  ['in_production', 'completed', 'Complete a B2B order'],
  ['in_production', 'fulfilled', 'MUSE auto-fulfils straight from production'],
  ['completed', 'ready_to_ship', 'Shipping flow'],
  ['completed', 'fulfilled', 'Fulfil a completed order'],
  ['ready_to_ship', 'fulfilled', 'Fulfil after shipping'],
  ['queued', 'draft', 'Return to Orders (nothing debited yet)'],
  ['draft', 'cancelled', 'Cancel a draft'],
  ['confirmed', 'cancelled', 'Cancel a confirmed order'],
  ['in_production', 'cancelled', 'Shopify cancellation mid-production'],
];

for (const [from, to, why] of MUST_ALLOW) {
  allows(to, from)
    ? ok(`allows ${from} → ${to}`, why)
    : bad(`BLOCKS a real flow: ${from} → ${to}`, why);
}

// ── Transitions that must stay refused (they'd corrupt order history) ────────
const MUST_REJECT = [
  ['fulfilled', 'queued', 'a delivered order cannot re-enter the queue'],
  ['fulfilled', 'draft', 'a delivered order cannot become a draft again'],
  ['completed', 'in_production', 'production already finished and debited'],
  ['in_production', 'draft', 'stock is already debited — Return to Orders is queued-only'],
  ['waiting_external', 'draft', 'work is out at a supplier'],
  ['in_production', 'confirmed', "commercial step cannot rewind past production"],
  ['waiting_external', 'confirmed', 'publishing must not reset a dispatched order'],
];

for (const [from, to, why] of MUST_REJECT) {
  !allows(to, from)
    ? ok(`rejects ${from} → ${to}`, why)
    : bad(`ALLOWS a corrupting transition: ${from} → ${to}`, why);
}

// ── The two gaps that would have broken production if enforced as first written ──
allows('fulfilled', 'in_production')
  ? ok('regression: fulfilled ← in_production is present (MUSE completion)')
  : bad('regression: MUSE completion would break — fulfilled ← in_production missing');

STATUS_TRANSITIONS.cancelled && STATUS_TRANSITIONS.cancelled.length > 0
  ? ok('regression: a cancelled entry exists (cancellation would 400 without it)')
  : bad('regression: cancelled key missing — all cancellation would fail');

console.log(`\n══════ ORDER STATUS MACHINE: ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} (${pass} pass / ${fail} fail) ══════`);
process.exit(fail === 0 ? 0 : 1);
