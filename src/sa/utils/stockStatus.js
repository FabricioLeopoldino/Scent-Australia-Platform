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

/**
 * The minimum that decides "low". For an oil with a demand signal the server
 * sends `minStockAuto` — the Demand Planning safety stock — and it wins over
 * the typed value, which was a guess (owner, 2026-10-14). Everything else keeps
 * its typed `minStockLevel`.
 */
export function effectiveMin(product) {
  const auto = product?.minStockAuto;
  return auto != null ? auto : (parseFloat(product?.minStockLevel) || 0);
}

/** Still to arrive on open purchase orders (`incomingOrders` from /api/products). */
export function incomingQty(product) {
  return (product?.incomingOrders || []).reduce((sum, o) =>
    sum + Math.max(0, (parseFloat(o.quantity) || 0) - (parseFloat(o.quantityReceived) || 0)), 0);
}

/**
 * Full status for a SA product row.
 *
 * LOW counts what is already ordered (2026-10-14): a product with a purchase
 * order that brings it back over its minimum is not something to raise again —
 * the owner assumed it already worked this way, and Demand Planning has since
 * 14 Sep. Empty and negative stay empty and negative whatever is on the way:
 * that is what is on the shelf today.
 */
export function getStockStatus(product) {
  const stock = parseFloat(product?.currentStock) || 0;
  if (stock < 0) return STOCK_STATUS.NEGATIVE;
  if (stock === 0) return STOCK_STATUS.OUT;
  if (stock + incomingQty(product) < effectiveMin(product)) return STOCK_STATUS.LOW;
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
  const stock = (parseFloat(product?.currentStock) || 0) + incomingQty(product);
  const min = effectiveMin(product);
  return min > 0 && stock <= min * REORDER_SOON_FACTOR;
}
