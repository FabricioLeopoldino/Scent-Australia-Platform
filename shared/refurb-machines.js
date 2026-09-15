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

// Which row of `bom` a product's components hang off, or null for a product
// that has none. ONE answer, used by the sale and by the reversal, so the two
// can never disagree about what a sale consumed.
//
// WHY MACHINES ARE HERE NOW (2026-09-15). They were not: the webhook read
// "Machine — no BOM, direct debit" and took out the machine alone. The owner
// confirmed that is wrong in the real world — "sim sai junto com alguns outros
// spare parts" — so 2,447 machines have shipped with parts the system never
// deducted, 14 of them refurbished.
//
// Only refurbished machines are wired up. A new machine's parts list lives in
// the separate `diffuser_bom` table, keyed by its own type codes
// ('wifi_pro_black' and friends) that nothing maps to a product code — so there
// is no honest way to resolve one yet, and guessing at it would debit the wrong
// parts. Returning null leaves those exactly as they behave today.
export function bomVariantFor(product) {
  if (!product) return null;
  if (product.category === 'SA_SCENTED_PRODUCTS') return product.productCode;
  if (product.category === 'SCENT_MACHINES') return refurbVariantFor(product.productCode);
  return null;
}
