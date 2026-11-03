// Fragrance stock by company — who holds the oil (PRD_STAGE_1_FRAGRANCE_LIBRARY.md
// S1–S2, owner 26 Oct 2026). The one place for the stock keys and their labels.
//
// The oil's total is its stock (products."currentStock", unchanged meaning).
// Inside it, the main store and the four MUSE stocks are tracked by their own
// movements; SA is whatever is left. That is what lets every existing SA stock
// path keep working untouched: a sale, a removal or a stocktake moves the total,
// so it lands in SA by construction.
//
// The branch keys of 21–23 Oct (AWAITING, ATELIER, ARCHIVE, LIBRARY) never
// reached production and are gone: the main store replaces "awaiting split",
// and the MUSE units are named as MUSE's.
// `short` is for tight cells (the Stock column), `label` everywhere else.
export const SECTORS = [
  { key: 'MAIN',         label: 'Main store',       short: 'Main',    company: null },
  { key: 'SA',           label: 'SA',               short: 'SA',      company: 'SA' },
  { key: 'MUSE',         label: 'MUSE (shared)',    short: 'MUSE',    company: 'MUSE' },
  { key: 'MUSE_ATELIER', label: 'MUSE The Atelier', short: 'Atelier', company: 'MUSE' },
  { key: 'MUSE_LIBRARY', label: 'MUSE The Library', short: 'Library', company: 'MUSE' },
  { key: 'MUSE_ARCHIVE', label: 'MUSE The Archive', short: 'Archive', company: 'MUSE' },
];
export const SECTOR_KEYS = SECTORS.map((s) => s.key);

// Tracked by their own movements; SA = total − their positive balances.
export const HELD_SECTORS = SECTOR_KEYS.filter((k) => k !== 'SA');

export const COMPANIES = ['SA', 'MUSE'];
export const MUSE_STOCKS = SECTORS.filter((s) => s.company === 'MUSE').map((s) => s.key);
// The units a MUSE registration's "used by" tags name (not the shared stock).
export const MUSE_UNITS = ['MUSE_ATELIER', 'MUSE_LIBRARY', 'MUSE_ARCHIVE'];

// The outside world: where oil comes from or goes to when the total changes.
export const OUTSIDE = { SUPPLIER: 'Supplier', COUNT: 'Count', USED: 'Used' };

export const sectorLabel = (key) =>
  SECTORS.find((s) => s.key === key)?.label || OUTSIDE[key] || key;

/** The company a stock belongs to — 'SA' | 'MUSE' — or null (the main store, the outside world). */
export const companyOf = (key) => SECTORS.find((s) => s.key === key)?.company || null;

// The Shopify PO "Select destination" names the company (owner, 29–30 Oct 2026,
// HYPER_UPDATE_BACKLOG.md P6). ONE table, read by the PO read, its acceptance,
// the receipt, Demand Planning and the screens. `name` is the Shopify location
// exactly as Payal picks it; `stock` is where the order's oil is expected;
// `receiveInto` is every stock its receipt may go to — anything else is
// refused, recorded and explained (owner, 30 Oct). A location renamed in
// Shopify stops matching here and its POs show as "unknown destination",
// never silently dropped: rename it here too.
export const PO_DESTINATIONS = [
  { name: 'SA Warehouse', stock: 'SA', label: 'Scent Australia (SA Warehouse)', receiveInto: ['SA'] },
  // The Shopify name stays "SA Custom Orders" for now (the manager asked, 30 Oct).
  { name: 'SA Custom Orders', stock: 'MUSE_ATELIER', label: 'MUSE The Atelier', receiveInto: ['MUSE_ATELIER'] },
  // The Library and The Archive order together; Payal splits at receipt, or
  // leaves it in MUSE (shared) until she knows (rule of 25 Oct).
  { name: 'MUSE', stock: 'MUSE', label: 'MUSE (The Library and The Archive)', receiveInto: ['MUSE', 'MUSE_LIBRARY', 'MUSE_ARCHIVE'] },
];
export const destinationByName = (name) => PO_DESTINATIONS.find((d) => d.name === name) || null;
export const destinationByStock = (stock) => PO_DESTINATIONS.find((d) => d.stock === stock) || null;
