// Which way a stock movement went. ONE definition, for every screen that shows
// one.
//
// WHY THIS EXISTS (2026-08-19). The History page printed a "+" whenever the
// quantity was greater than zero and coloured it green — and quantity is stored
// as a MAGNITUDE, with the direction living in the type. So every sale read as
// an addition: a 400 mL outbound showed as "+400 mL" in green. The owner spotted
// it and was right to: the screen was stating something untrue.
//
// The mapping is DERIVED FROM PRODUCTION, not assumed. For every type, the
// balance_after of each row was compared with the row before it for the same
// product, across all 13,690 SA and SM transactions. A type is only given a
// direction when at least 90% of its movements went that way.
//
// Two results are worth knowing:
//
//   tech_transfer_in LOWERS stock, in 92% of its rows. The name describes the
//   business event — stock moving INTO the technician area — while the row being
//   written is the main stock it left. Labels are not renamed here; the screen
//   shows what the number did.
//
//   adjust measured 95% upward, and is still neutral below. An adjustment is
//   bidirectional by definition, and a map claiming "in" would be wrong the day
//   somebody adjusts down. Where the concept is ambiguous the sample does not
//   get to decide.
//
// Anything not listed is neutral: no sign, no colour, no claim. A screen that
// says nothing is better than a screen that says the wrong thing — which is the
// defect this file exists to remove.
//
// regression-movement-direction re-derives all of this from live data and fails
// if the map and the database disagree, so it cannot quietly rot.

export const IN = new Set([
  'return',                 // goods came back
  'shopify_reversal',       // a sale undone
  'add',                    // received or entered
  'tech_return_input',      // returned from a technician into main stock
  'tech_return_to_main',
  'transfer_cancel_return', // a cancelled transfer coming back
  'ready_formula_in',       // pre-mixed formula received
]);

export const OUT = new Set([
  'shopify_sale',
  'remove',
  'tech_remove',
  'tech_transfer_in',       // yes, OUT — see the note above
  'tech_return_from_tech',
  'transfer_out',
  'muse_production',        // consumed making a MUSE product
  'sm_std_production',      // ...the Atelier
  'sm_major_production',    // ...client work
  'production_debit',
]);

// Listed explicitly rather than left to fall through, so a reader can see these
// were considered and judged genuinely two-way.
export const NEUTRAL = new Set([
  'adjust',
  'transfer_in',
  'production_in',
]);

/** 'in' · 'out' · null when the type does not commit to a direction. */
export function directionOf(type) {
  const t = String(type || '').trim();
  if (IN.has(t)) return 'in';
  if (OUT.has(t)) return 'out';
  return null;
}

/** SQL fragment for the same rule, so a query can group without a round trip. */
export const DIRECTION_SQL = (col = 't.type') => `
  CASE WHEN ${col} = ANY ('{${[...IN].join(',')}}'::text[])  THEN 'in'
       WHEN ${col} = ANY ('{${[...OUT].join(',')}}'::text[]) THEN 'out'
       ELSE NULL END`;

// The package is "type": "module" and this sits beside reports.js, which is
// ESM. server/sm is CommonJS; if it ever needs this, it imports rather than
// keeping a second copy — a rule written twice is how the webhook topics and
// the format lists drifted apart.
