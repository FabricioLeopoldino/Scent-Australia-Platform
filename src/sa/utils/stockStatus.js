// Single source of truth for "how healthy is this product's stock?" (QA #17).
//
// This used to be defined independently in 5 places with two different rules:
// Product Management / Machine Inventory / Dashboard used `currentStock <
// minStockLevel`, while BOM Viewer and Diffuser BOM used `<=` — so an item
// sitting exactly AT its reorder point showed as low on the BOM screens and
// healthy everywhere else. Unified on the `<` rule (the one the main stock
// screens and every Dashboard count already used) so no existing figure shifts.
//
// Negative is a real state platform-wide since the 2026-07-22 negative-stock
// policy (physical movements are always recorded, even when they overdraw), so
// it gets its own bucket instead of being lumped in with "low".

export const STOCK_STATUS = {
  NEGATIVE: { key: 'NEGATIVE', label: 'Negative Stock', color: 'red' },
  OUT:      { key: 'OUT',      label: 'Out of Stock',   color: 'red' },
  LOW:      { key: 'LOW',      label: 'Low Stock',      color: 'yellow' },
  HEALTHY:  { key: 'HEALTHY',  label: 'In Stock',       color: 'green' },
};

/** Full status for a SA product row (`currentStock` / `minStockLevel`). */
export function getStockStatus(product) {
  const stock = parseFloat(product?.currentStock) || 0;
  const min = parseFloat(product?.minStockLevel) || 0;
  if (stock < 0) return STOCK_STATUS.NEGATIVE;
  if (stock === 0) return STOCK_STATUS.OUT;
  if (stock < min) return STOCK_STATUS.LOW;
  return STOCK_STATUS.HEALTHY;
}

/** True only for the "low but still in stock" band — excludes 0 and negative. */
export function isLowStock(product) {
  return getStockStatus(product).key === 'LOW';
}

/** Multiplier above minStockLevel that still counts as "order it soon". */
export const REORDER_SOON_FACTOR = 1.5;

/**
 * Healthy, but within REORDER_SOON_FACTOR × minStockLevel — the early-warning
 * band Raw Materials shows. Kept here so the threshold isn't redefined per page.
 */
export function isReorderSoon(product) {
  if (getStockStatus(product).key !== 'HEALTHY') return false;
  const stock = parseFloat(product?.currentStock) || 0;
  const min = parseFloat(product?.minStockLevel) || 0;
  return min > 0 && stock <= min * REORDER_SOON_FACTOR;
}
