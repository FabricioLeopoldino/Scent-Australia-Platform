// Why stock moved by hand. ONE definition, read by the screen and by the server.
//
// WHY THIS EXISTS (2026-08-31). Manual adjustments recorded their reason as free
// text, so "tech oil" was typed five times on 27 August and "Manual remove
// adjustment" is what the box fills in when nobody types anything. That is the
// same disease the returns form had: four people under twelve spellings,
// readable and impossible to count.
//
// It matters more than tidiness. The 28 August count found 830 litres the system
// did not have, concentrated on the oils the technicians handle. Nobody could
// answer "how much oil did technicians consume in August" — the figure that
// would have shown the drift in July instead of in a physical count in August.
// A reason you can group by is that figure.
//
// "Other" is here on purpose, and it demands a note. Leaving it out does not
// remove the awkward case, it makes somebody pick a wrong reason to get past the
// form, which is worse than an honest "other".
//
// The two lists differ because adding and removing are different questions.
// Stock does not arrive because of spillage.

export const REMOVE_REASONS = [
  { id: 'technician',  label: 'Technician service' },
  { id: 'production',  label: 'Used in production' },
  { id: 'sample',      label: 'Sample' },
  { id: 'loss',        label: 'Loss, spillage or damage' },
  { id: 'correction',  label: 'Correcting a count' },
  { id: 'other',       label: 'Other (say why)' },
];

export const ADD_REASONS = [
  { id: 'delivery',    label: 'Supplier delivery' },
  { id: 'found',       label: 'Found in the warehouse' },
  { id: 'correction',  label: 'Correcting a count' },
  { id: 'other',       label: 'Other (say why)' },
];

// Which hand-made removals are NOT consumption, and so must not feed demand.
//
// WHY (2026-10-09). A stocktake correction is the book being reconciled to the
// shelf, not a litre anybody used — but demand planning counted it as one.
// Myrrh & Tonka took a removal of 127.8 L reading "Correcting a count — Stock
// Take 02/10/2026" and it went straight into the daily rate. Across 90 days,
// 329 of the 1,073 litres removed by hand were corrections.
//
// Only `correction` is listed, deliberately. Loss and spillage ARE consumption:
// the oil is gone and has to be replaced. A sample is consumption too. The test
// is not "did somebody mean to use it" but "did the shelf really lose it" — and
// in a correction the shelf lost nothing, the number did.
export const NON_DEMAND_REMOVE_REASONS = ['correction'];

// Hand-made removals that are real but not a pattern: kept OUT of the daily
// rate and shown beside it instead. '' is a removal with no reason at all.
//
// WHY (2026-10-12, the owner's call). "Other" mixes collab orders — real oil,
// but unpredictable — with stocktakes typed under the wrong reason (Special
// Santal's 28 L on 23 Sep said so in its own note). Neither may drive an order:
// "manuais tipo ajuste de stock essas coisas não pode … se for pego fora de
// ordem eu reclamo." Shown beside the prediction, the planner still sees them.
export const UNPATTERNED_REMOVE_REASONS = ['other', ''];

export function reasonsFor(type) {
  return type === 'add' ? ADD_REASONS : REMOVE_REASONS;
}

// Validated on the server rather than trusted from the screen: a reason that
// can hold anything is the free-text box again, wearing a different name.
export function isValidReason(type, reason) {
  return reasonsFor(type).some((r) => r.id === reason);
}

export function reasonLabel(type, reason) {
  return reasonsFor(type).find((r) => r.id === reason)?.label || reason || '';
}
