// What each business is CALLED. One place, because the last rename touched
// sixteen files and the one before it is still half-done in old comments.
//
// WHY THIS EXISTS (2026-09-15). The owner renamed Scented Merchandise to
// The Atelier. The name appeared in 40 places across the server and the UI, and
// on one line it appeared twice with two different meanings:
//
//     CASE WHEN p.segment = 'MUSE' THEN 'MUSE' ELSE 'Scented Merchandise' END
//                           ^stored data  ^label        ^label
//
// A find-and-replace would have rewritten the stored code as well and broken
// every MUSE comparison in the report. So the labels live here and the codes
// stay where they are.
//
// ── THE TWO AXES, and why they must not be mixed ────────────────────────────
// The owner's rule, 2026-08-14, enforced by integrity-sm:
//
//     segment        decides oil and production   MUSE | STANDARD | MAJOR
//     business_unit  decides reporting            library | archive | atelier
//
// A movement has a segment. A finished good has a business unit. A COMPONENT
// has neither division nor brand — "a bottle used on a Library order is Library
// consumption because of the ORDER, not because of the bottle". So the History
// system column is the production axis, and the division belongs on screens
// that list products. Putting a division on a movement would be a guess.

// ── Production axis: which system a movement belongs to.
// These strings are also the filter values on the wire. They are NEVER stored.
export const SYSTEM_NAMES = {
  SA: 'SA',
  SM: 'The Atelier',   // renamed from 'Scented Merchandise' 2026-09-15 — same
                       // business, new name, confirmed by the owner. It closes
                       // the question left open in server/sm/db.js on 14 Aug:
                       // "calling the legacy Scented Merchandise catalogue
                       // 'atelier' would be a guess".
  MUSE: 'MUSE',
  Platform: 'Platform',
};

// ── Reporting axis: Muse's three divisions, in the owner's own words.
//
//   The Atelier   customisation and bespoke — personalised labels through to
//                 fully developed commissions
//   The Archive   the permanent core collection — ten fragrances that form the
//                 recognisable heart of the brand
//   The Library   a broader exploration of the public catalogue, paired with a
//                 chosen product format
//
// Keys are the stored `business_unit` values. Do not rename the keys.
export const DIVISION_NAMES = {
  atelier: 'The Atelier',
  archive: 'The Archive',
  library: 'The Library',
};

/** Division label for a product, or null when it legitimately has none. */
export function divisionName(businessUnit) {
  return DIVISION_NAMES[businessUnit] || null;
}
