// Which MUSE collection the open tile shows (17 Nov 2026, step 5).
//
// The tile IS the collection: The Library, The Archive and The Atelier open the
// same MUSE screens, each listing only its own products. A product's collection
// is sm.products.business_unit, and a variant's always equals its master's
// (integrity-sm). The same tile already decides whose oil is "own" on these
// screens (OWN_STOCK_BY_MODULE in sa/components/StockBreakdown.jsx).
export const COLLECTION_BY_MODULE = { MUSE: 'library', ARCHIVE: 'archive', SM: 'atelier' }
export const COLLECTION_NAMES = { library: 'The Library', archive: 'The Archive', atelier: 'The Atelier' }

export const activeCollection = () =>
  COLLECTION_BY_MODULE[typeof localStorage !== 'undefined' ? localStorage.getItem('platform_active_module') : null] || null

// With no collection (the hidden OPS view, History) nothing is left out. A MUSE
// product with no unit stored is shown in The Library: that is where every MUSE
// product lived before units existed, and the server's start-up backfill gives
// it that unit anyway.
export const inCollection = (row, collection = activeCollection()) =>
  !collection || (row?.business_unit || 'library') === collection
