// Which refurbished machines each Refurb BOM variant covers.
//
// WHY THIS EXISTS (2026-09-15). Six refurbished machines are registered as
// products, and the BOM page knew only two refurb variants — both written into
// the page's source. The ScentPro 700 Medium (SA_RF00005, SA_RF00006) belonged
// to neither, and the page has no way to create a variant, so there was simply
// nowhere to record what it ships with. The owner found it the only way anybody
// could: by looking for it and not finding it.
//
// A hardcoded list is not the fault. The fault was that nothing compared the
// list against reality, so a machine could be registered and quietly have no
// BOM home for as long as nobody happened to look. This file is that
// comparison's input, and regression-refurb-bom-coverage.js is the comparison.
//
// Keys are the BOM `variant` values. `machines` are the product codes each one
// covers, and `bottle` is what a reconditioned unit ships with — the refurb BOM
// holds one line, the empty bottle, not the machine's parts list. (The parts
// list is the Diffuser BOM page, a different table.)
export const REFURB_MACHINE_COVERAGE = {
  REFURB_SCENTPRO: {
    label: 'ScentPro Smart Medium',
    machines: ['SA_RF00001', 'SA_RF00002'],
    bottle: 'SA_RM_00006',   // Empty PRO Bottle Oil Refill & Top Lid PRO
  },
  REFURB_SCENTPRO_700: {
    label: 'ScentPro 700 Medium',
    machines: ['SA_RF00005', 'SA_RF00006'],
    bottle: 'SA_RM_00004',   // Empty Oil Refill Bottle & Top Lid (700ml)
  },
  REFURB_SCENTLITE: {
    label: 'ScentLite Bathroom',
    machines: ['SA_RF00003', 'SA_RF00004'],
    bottle: 'SA_RM_00017',   // 500 Bathroom diffuser - EMPTY BOTTLE 400ML
  },
};

/** Every machine product code that some refurb variant claims. */
export const COVERED_REFURB_MACHINES =
  Object.values(REFURB_MACHINE_COVERAGE).flatMap((v) => v.machines);

/** The variant that covers a machine, or null when nothing does. */
export function refurbVariantFor(productCode) {
  const hit = Object.entries(REFURB_MACHINE_COVERAGE)
    .find(([, v]) => v.machines.includes(productCode));
  return hit ? hit[0] : null;
}
