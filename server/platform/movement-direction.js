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

// ─────────────────────────────────────────────────────────────────────────────
// Which business a movement belongs to.
//
// Added 2026-08-19 for the statement. The owner's question was "was it SA, or
// MUSE?" and the answer is already in the data — the type says who consumed it.
// No new column, no backfill.
//
// Kept beside the direction map deliberately: they are read together on every
// row of a statement, and splitting them across two files is how a rule becomes
// two rules that disagree.
const BUSINESS = {
  shopify_sale:          'Store sale',
  shopify_reversal:      'Store sale reversed',
  muse_production:       'MUSE',
  sm_std_production:     'The Atelier',
  sm_major_production:   'Client work',
  production_debit:      'Production',
  production_in:         'Production',
  ready_formula_in:      'Production',
  return:                'Returned',
  add:                   'Entered by hand',
  remove:                'Entered by hand',
  adjust:                'Entered by hand',
  transfer_in:           'Transfer',
  transfer_out:          'Transfer',
  transfer_cancel_return:'Transfer cancelled',
  tech_transfer_in:      'Technicians',
  tech_transfer_out:     'Technicians',
  tech_remove:           'Technicians',
  tech_return_input:     'Technicians',
  tech_return_to_main:   'Technicians',
  tech_return_from_tech: 'Technicians',
};

/** A readable business label, or the raw type when we have not classified it. */
export function businessOf(type) {
  const t = String(type || '').trim();
  return BUSINESS[t] || t || 'Unknown';
}

export const BUSINESS_SQL = (col = 't.type') =>
  `CASE ${Object.entries(BUSINESS).map(([k, v]) => `WHEN ${col} = '${k}' THEN '${v.replace(/'/g, "''")}'`).join(' ')} ELSE ${col} END`;

export { BUSINESS };

// ─────────────────────────────────────────────────────────────────────────────
// A movement recorded in `sa` that ANOTHER business caused.
//
// WHY (2026-09-08). The owner filtered History & Activity by MUSE and found no
// fragrance at all. It was not a data fault: the report tags a row by the
// SCHEMA it sits in, and every oil movement sits in `sa`, so every one of them
// read "SA" — all 5,825. Filtering MUSE showed the finished product leaving and
// never the oil that made it, which is the half that costs money.
//
// His rule, and it is the right one: **show a movement wherever the stock
// actually moved.** The oil leaves SA's shelf, so it must stay visible in SA;
// the business that caused it must see it too. So these rows belong to BOTH,
// and the label says so — "SA · MUSE" is two facts, not a contradiction.
//
// A movement that only ever touches one side is untouched by this and already
// behaved correctly: a Travel Spray sale moves only MUSE stock, a B2B oil sale
// only SA's.
//
// Keyed on the transaction type because the type already carries the answer —
// `SEGMENT_MAP` in sm/services/fragrance-library.js chooses it at write time.
// No new column, no backfill. Kept beside BUSINESS for the same reason BUSINESS
// is kept beside the direction map: they are read together, and a rule split
// across two files becomes two rules that disagree.
const ALSO_VISIBLE_IN = {
  muse_production:     'MUSE',
  muse_reversal:       'MUSE',
  sm_std_production:   'Scented Merchandise',
  sm_std_reversal:     'Scented Merchandise',
  sm_major_production: 'Scented Merchandise',
  sm_major_reversal:   'Scented Merchandise',
};

/** The second system a movement is visible in, or null when it is only its own. */
export function alsoVisibleIn(type) {
  return ALSO_VISIBLE_IN[String(type || '').trim()] || null;
}

/**
 * The system label for a row that lives in `sa`: 'SA', or 'SA · <other>' when
 * another business caused it. Composite on purpose — the CSV then states both.
 */
export const SA_SYSTEM_SQL = (col = 't.type') =>
  `CASE ${Object.entries(ALSO_VISIBLE_IN)
    .map(([k, v]) => `WHEN ${col} = '${k}' THEN 'SA · ${v}'`).join(' ')} ELSE 'SA' END`;

/** Does a row's (possibly composite) system label satisfy a filter choice? */
export function systemMatches(rowSystem, wanted) {
  const s = String(rowSystem || '');
  return s === wanted || s.split(' · ').includes(wanted);
}

/**
 * The `sa` transaction types a given system can see, for pushing the filter
 * INTO the query. Filtering in JS after a LIMIT silently truncates: on 8 Sep
 * the cross-system rows sat at positions 19..2601 of sa ordered by date, and
 * the screen asks for 2000 — so the oldest were being dropped before the JS
 * filter ever saw them. 'SM' means both of its halves.
 */
export function typesVisibleIn(system) {
  const want = system === 'SM' ? ['MUSE', 'Scented Merchandise'] : [system];
  return Object.entries(ALSO_VISIBLE_IN).filter(([, v]) => want.includes(v)).map(([k]) => k);
}

export { ALSO_VISIBLE_IN };

