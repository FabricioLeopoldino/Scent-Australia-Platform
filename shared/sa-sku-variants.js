// Single source of truth for SA's five oil sale-variant SKUs (QA #16).
//
// These five keys and their volumes were previously redeclared in FOUR places
// (server/sa/index.js, BOMViewer, SkuMapping, utils/shopifyExport) with
// independently-written labels — nothing kept them in sync, so a renamed or
// resized variant had to be remembered in four files or the UI would disagree
// with what actually publishes to Shopify.
//
// Only the FACTS live here (key, display label, volume in mL). Deliberately NOT
// here: Shopify price (commercial data, server-side only) and chart colours
// (pure styling, used by one page) — those stay where they're used.
//
// The project is ESM ("type": "module") end to end, so both the Express server
// and the Vite bundle import this same file.

export const SA_SKU_VARIANTS = {
  SA_CA:    { label: 'Oil Cartridge (400ml)',    volumeMl: 400 },
  SA_HF:    { label: '500ml Refill Bottle',      volumeMl: 500 },
  SA_CDIFF: { label: 'Oil Refill (700ml)',       volumeMl: 700 },
  SA_1L:    { label: '1L Refill Bottle',         volumeMl: 1000 },
  SA_PRO:   { label: '1L PRO Bottle',            volumeMl: 1000 },
};

/** The five sale-variant keys, in the canonical display order. */
export const SA_SKU_KEYS = Object.keys(SA_SKU_VARIANTS);

/** Short size label for a variant key, e.g. 'SA_PRO' → '1000ml PRO'. */
export function skuSizeLabel(key) {
  const v = SA_SKU_VARIANTS[key];
  if (!v) return key;
  return key === 'SA_PRO' ? `${v.volumeMl}ml PRO` : `${v.volumeMl}ml`;
}
