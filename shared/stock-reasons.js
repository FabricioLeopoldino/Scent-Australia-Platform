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
